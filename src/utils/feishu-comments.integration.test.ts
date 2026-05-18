import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import browser from './browser-polyfill';
import { convertDate } from './date-utils';

describe('feishu-comments integration — production IPC path', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('fetchFeishuComments unwraps background response correctly (Bug 1 regression guard)', async () => {
		// Real background.ts wraps OpenAPI response as { success, data: <FULL OpenAPI body> }
		// where the full body is { code: 0, data: { items, has_more, page_token }, msg }.
		// fetchFeishuComments must access result.data.items, NOT resp.data.items.
		const cannedResp = {
			success: true,
			data: {
				code: 0,
				data: {
					items: [
						{
							comment_id: 'c1',
							create_time: 1700000000,
							is_solved: false,
							is_whole: true,
							user_id: 'ou_aaaaaaaaaaaaaaaaaaaaaaaaaaaa1111',
							solver_user_id: null,
							reply_list: {
								replies: [
									{
										reply_id: 'r1',
										create_time: 1700000000,
										user_id: 'ou_aaaaaaaaaaaaaaaaaaaaaaaaaaaa1111',
										content: { elements: [{ type: 'text_run', text_run: { text: 'first comment' } }] },
										extra: { image_list: [] },
									},
								],
							},
						},
						{
							comment_id: 'c2',
							create_time: 1700000100,
							is_solved: true,
							is_whole: true,
							user_id: 'ou_bbbbbbbbbbbbbbbbbbbbbbbbbbbb2222',
							solver_user_id: 'ou_solver',
							reply_list: {
								replies: [
									{
										reply_id: 'r2',
										create_time: 1700000100,
										user_id: 'ou_bbbbbbbbbbbbbbbbbbbbbbbbbbbb2222',
										content: { elements: [{ type: 'text_run', text_run: { text: 'second comment' } }] },
										extra: { image_list: [] },
									},
								],
							},
						},
					],
					has_more: false,
					page_token: '',
				},
				msg: 'Success',
			},
		};
		vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue(cannedResp as any);

		const { fetchFeishuComments } = await import('./feishu-comments');
		const got = await fetchFeishuComments('doc-id');
		expect(got).toHaveLength(2);
		expect(got[0].comment_id).toBe('c1');
		expect(got[1].is_solved).toBe(true);
	});

	it('extractFeishuStructuredContent surfaces commentsMarkdown as a separate field, not inside content HTML (Bug 2 regression guard)', async () => {
		// Mock sendMessage routes by inspecting request shape:
		//  - { action: 'fetchFeishuApi', url } where url contains "/blocks?" → blocks response
		//  - { action: 'fetchFeishuApi', url } where url contains "/comments?" → comments response
		//  - { action: 'fetchFeishuApi', url } otherwise (e.g. /documents/{id}) → meta response
		vi.spyOn(browser.runtime, 'sendMessage').mockImplementation(async (req: any) => {
			if (req?.action === 'fetchFeishuApi' && typeof req.url === 'string') {
				if (req.url.includes('/blocks?')) {
					return {
						success: true,
						data: {
							code: 0,
							data: {
								items: [
									{ block_id: 'p', block_type: 1, page: { elements: [] }, children: ['t'] },
									{ block_id: 't', block_type: 2, parent_id: 'p', text: { elements: [{ text_run: { content: '正文段落' } }] } },
								],
								has_more: false,
								page_token: '',
							},
							msg: 'Success',
						},
					};
				}
				if (req.url.includes('/comments?')) {
					return {
						success: true,
						data: {
							code: 0,
							data: {
								items: [
									{
										comment_id: 'c1',
										create_time: 1700000000,
										is_solved: false,
										is_whole: true,
										user_id: 'ou_xxxxxxxxxxxxxxxxxxxxxxxxxxxxabcd1234',
										solver_user_id: null,
										reply_list: {
											replies: [
												{
													reply_id: 'r1',
													create_time: 1700000000,
													user_id: 'ou_xxxxxxxxxxxxxxxxxxxxxxxxxxxxabcd1234',
													content: { elements: [{ type: 'text_run', text_run: { text: 'a comment' } }] },
													extra: { image_list: [] },
												},
											],
										},
									},
								],
								has_more: false,
								page_token: '',
							},
							msg: 'Success',
						},
					};
				}
				// Fall-through for the meta endpoint /documents/{id} (no /blocks suffix)
				return {
					success: true,
					data: {
						code: 0,
						data: { document: { title: 'fake doc', owner_id: 'ou_owner' } },
						msg: 'Success',
					},
				};
			}
			return { success: true };
		});

		const { extractFeishuStructuredContent } = await import('./feishu-extractor');
		const fakeDoc = { URL: 'https://x.feishu.cn/docx/abc', title: '' } as any;
		const result = await extractFeishuStructuredContent(fakeDoc);

		expect(result).not.toBeNull();
		expect(result!.commentsMarkdown).toBeDefined();
		expect(result!.commentsMarkdown).toMatch(/## 评论/);
		expect(result!.commentsMarkdown).toMatch(/> \[!quote\]\+ 评论者 abcd1234 ·/);
		// Critical separation: the HTML content must NOT contain comment markdown.
		expect(result!.content).not.toMatch(/## 评论/);
		expect(result!.content).not.toMatch(/\[!quote\]/);
	});

	it('extractFeishuStructuredContent surfaces author (real name) and published (latest_modify_time as YYYY-MM-DD) when contact API succeeds', async () => {
		vi.spyOn(browser.runtime, 'sendMessage').mockImplementation(async (req: any) => {
			if (req?.action !== 'fetchFeishuApi' || typeof req.url !== 'string') return { success: true };

			if (req.url.includes('/blocks?')) {
				return {
					success: true,
					data: {
						code: 0,
						data: {
							items: [
								{ block_id: 'p', block_type: 1, page: { elements: [] }, children: ['t'] },
								{ block_id: 't', block_type: 2, parent_id: 'p', text: { elements: [{ text_run: { content: 'body' } }] } },
							],
							has_more: false,
							page_token: '',
						},
						msg: 'Success',
					},
				};
			}

			if (req.url.includes('/drive/v1/metas/batch_query')) {
				return {
					success: true,
					data: {
						code: 0,
						data: {
							metas: [{
								doc_token: 'abc',
								doc_type: 'docx',
								title: 'fake doc',
								owner_id: 'ou_2352e49a08126a24b5a6e03ad065f814',
								create_time: '1761226054',
								latest_modify_time: '1762012415',
								latest_modify_user: 'ou_2352e49a08126a24b5a6e03ad065f814',
							}],
						},
						msg: 'Success',
					},
				};
			}

			if (req.url.includes('/contact/v3/users/')) {
				return {
					success: true,
					data: {
						code: 0,
						data: { user: { name: '刘智行', open_id: 'ou_2352e49a08126a24b5a6e03ad065f814' } },
						msg: 'Success',
					},
				};
			}

			if (req.url.includes('/comments?')) {
				return { success: true, data: { code: 0, data: { items: [], has_more: false, page_token: '' }, msg: 'Success' } };
			}

			return { success: true };
		});

		const { extractFeishuStructuredContent } = await import('./feishu-extractor');
		const fakeDoc = { URL: 'https://x.feishu.cn/docx/abc', title: '' } as any;
		const result = await extractFeishuStructuredContent(fakeDoc);

		expect(result).not.toBeNull();
		// fakeDoc has no .docs-info-avatar-name-text (no DOM) → DOM scrape returns '';
		// falls back to contact API which returns "刘智行". No "创建者" prefix per
		// 2026-05-18 user feedback ("不要展示飞书ID").
		expect(result!.author).toBe('刘智行');
		// Don't hardcode '2025-11-01' — CI timezone may differ. Use convertDate() to match impl path.
		expect(result!.published).toBe(convertDate(new Date(1762012415 * 1000)));
		expect(result!.title).toBe('fake doc');
	});

	it('extractFeishuStructuredContent falls back to empty author when both DOM scrape and contact API fail (Bug 2 regression guard)', async () => {
		vi.spyOn(browser.runtime, 'sendMessage').mockImplementation(async (req: any) => {
			if (req?.action !== 'fetchFeishuApi' || typeof req.url !== 'string') return { success: true };

			if (req.url.includes('/blocks?')) {
				return {
					success: true,
					data: {
						code: 0,
						data: { items: [{ block_id: 'p', block_type: 1, page: { elements: [] }, children: [] }], has_more: false, page_token: '' },
						msg: 'Success',
					},
				};
			}

			if (req.url.includes('/drive/v1/metas/batch_query')) {
				return {
					success: true,
					data: {
						code: 0,
						data: {
							metas: [{
								doc_token: 'abc',
								doc_type: 'docx',
								title: 'fake doc',
								owner_id: 'ou_2352e49a08126a24b5a6e03ad065f814',
								create_time: '1761226054',
								latest_modify_time: '1762012415',
							}],
						},
						msg: 'Success',
					},
				};
			}

			if (req.url.includes('/contact/v3/users/')) {
				return {
					success: false,
					error: 'Feishu API error 41050: no user authority error (https://open.feishu.cn/...)',
				};
			}

			if (req.url.includes('/comments?')) {
				return { success: true, data: { code: 0, data: { items: [], has_more: false, page_token: '' }, msg: 'Success' } };
			}

			return { success: true };
		});

		const { extractFeishuStructuredContent } = await import('./feishu-extractor');
		const fakeDoc = { URL: 'https://x.feishu.cn/docx/abc', title: '' } as any;
		const result = await extractFeishuStructuredContent(fakeDoc);

		expect(result).not.toBeNull();
		// No DOM author + contact API fails (41050) → author is empty string.
		// Per 2026-05-18 user feedback, we don't surface "创建者 <open_id last 8>"
		// — feishu open_id is internal noise, useless to a human reader.
		expect(result!.author).toBe('');
		expect(result!.published).toBe(convertDate(new Date(1762012415 * 1000)));
	});
});
