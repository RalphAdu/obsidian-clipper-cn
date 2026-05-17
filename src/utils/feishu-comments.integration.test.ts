import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import browser from './browser-polyfill';

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
});
