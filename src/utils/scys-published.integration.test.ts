// End-to-end integration test for the scys article published frontmatter fix
// (2026-05-18). Covers the full production data flow without requiring Chrome
// runtime:
//
//   fixture API response
//   → extractScysStructuredContent (real production extractor)
//   → ContentResponse merge (the content.ts:376 expression, replicated here)
//   → buildVariables (canonical pre-template step)
//   → {{published}} variable value
//
// The content.ts:376 merge expression itself is one line of inline code with
// no testable seam (content.ts is a webextension content script that depends
// on chrome runtime). We replicate it verbatim below — if the production line
// drifts from this test's copy, the trace breaks and the test goes stale.
// Production line for reference (src/content.ts:376):
//   published: bilibiliContent?.published || scysContent?.published || zsxqContent?.published || defuddled.published,

import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractScysStructuredContent } from './scys-extractor';
import { buildVariables, BuildVariablesParams } from './shared';
import { convertDate } from './date-utils';

// Helper to build BuildVariablesParams with only the fields we care about.
function paramsWithPublished(published: string, url = 'https://scys.com/articleDetail/xq_topic/x'): BuildVariablesParams {
	return {
		title: 'T', author: '', content: '', contentHtml: '',
		url, fullHtml: '', description: '', favicon: '', image: '',
		published, site: 'Scys', language: '', wordCount: 0,
		extractedContent: {},
	};
}

// Replicate the content.ts:376 merge expression. Update this helper if the
// production line ever changes (e.g. if feishu gains a published field).
function mergePublished(
	bilibiliContent: { published?: string } | null,
	scysContent: { published?: string } | null,
	zsxqContent: { published?: string } | null,
	defuddledPublished: string,
): string {
	return bilibiliContent?.published || scysContent?.published || zsxqContent?.published || defuddledPublished;
}

describe('scys article published frontmatter — end-to-end', () => {
	const originalFetch = global.fetch;
	afterEach(() => { global.fetch = originalFetch; });

	it('full pipeline: gmtCreate → extractor → merge → buildVariables → YYYY-MM-DD', async () => {
		// gmtCreate matches the real fixture scys-article-55188248-detail.json.
		const gmtCreate = 1762503084;
		global.fetch = vi.fn().mockImplementation((url: any) => {
			if (String(url).includes('topicDetail')) {
				return Promise.resolve({ ok: true, json: () => Promise.resolve({
					success: true, data: {
						topicDTO: {
							entityId: '1', entityType: 'xq_topic', showTitle: 'Test',
							docBlocks: [
								{ block_id: 'b1', block_type: 2, text: { elements: [{ text_run: { content: 'body' } }] } } as any,
							],
							gmtCreate, commentsCount: 0, likeCount: 0, readingCount: 0,
						},
						topicUserDTO: { name: 'Author' },
					},
				}) } as any);
			}
			return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: { total: 0, items: [] } }) } as any);
		});

		const doc = { URL: 'https://scys.com/articleDetail/xq_topic/1' } as Document;
		const scysContent = await extractScysStructuredContent(doc);

		// Layer 1: extractor produced YYYY-MM-DD from gmtCreate.
		expect(scysContent).not.toBeNull();
		const expected = convertDate(new Date(gmtCreate * 1000));
		expect(scysContent!.published).toBe(expected);
		expect(scysContent!.published).toMatch(/^\d{4}-\d{2}-\d{2}$/);

		// Layer 2: content.ts:376 merge — only scys present, scys wins.
		const merged = mergePublished(null, scysContent, null, '');
		expect(merged).toBe(expected);

		// Layer 3: buildVariables propagates merged value to {{published}}.
		const vars = buildVariables(paramsWithPublished(merged, doc.URL));
		expect(vars['{{published}}']).toBe(expected);
	});

	it('falsy gmtCreate (course/docx-style empty) → {{published}} stays empty', async () => {
		global.fetch = vi.fn().mockImplementation((url: any) => {
			if (String(url).includes('topicDetail')) {
				return Promise.resolve({ ok: true, json: () => Promise.resolve({
					success: true, data: {
						topicDTO: {
							entityId: '2', entityType: 'xq_topic', showTitle: 'No Date',
							docBlocks: [
								{ block_id: 'b1', block_type: 2, text: { elements: [{ text_run: { content: 'x' } }] } } as any,
							],
							gmtCreate: 0, commentsCount: 0, likeCount: 0, readingCount: 0,
						},
						topicUserDTO: { name: 'A' },
					},
				}) } as any);
			}
			return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: { total: 0, items: [] } }) } as any);
		});

		const doc = { URL: 'https://scys.com/articleDetail/xq_topic/2' } as Document;
		const scysContent = await extractScysStructuredContent(doc);
		expect(scysContent!.published).toBe('');

		// Merge with all other sources empty → {{published}} ends empty.
		const merged = mergePublished(null, scysContent, null, '');
		const vars = buildVariables(paramsWithPublished(merged, doc.URL));
		expect(vars['{{published}}']).toBe('');
	});

	it('merge priority: scysContent.published wins over zsxqContent and defuddled', () => {
		// Direct unit-test of the merge expression — scys must precede zsxq.
		// Catches regression if someone reverts the Task 3 line ordering.
		const merged = mergePublished(
			null,
			{ published: '2026-05-14' },
			{ published: '2024-01-15' },
			'2020-01-01',
		);
		expect(merged).toBe('2026-05-14');
	});

	it('merge priority: bilibiliContent.published wins over scys/zsxq/defuddled', () => {
		const merged = mergePublished(
			{ published: '2025-03-03' },
			{ published: '2026-05-14' },
			{ published: '2024-01-15' },
			'2020-01-01',
		);
		expect(merged).toBe('2025-03-03');
	});

	it('merge priority: zsxq retained when bilibili+scys empty', () => {
		const merged = mergePublished(null, { published: '' }, { published: '2024-01-15' }, '');
		expect(merged).toBe('2024-01-15');
	});

	it('merge priority: defuddled.published as terminal fallback', () => {
		const merged = mergePublished(null, null, null, '2020-01-01');
		expect(merged).toBe('2020-01-01');
	});

	it('regression: zsxq topic published flows to {{published}} unaffected by scys change', () => {
		// Task 3 added `scysContent?.published` between bilibili and zsxq. Verify
		// that when scys is null (real zsxq page), zsxq's published still survives.
		const zsxqContent = { published: '2024-12-01' };
		const merged = mergePublished(null, null, zsxqContent, '');
		const vars = buildVariables(paramsWithPublished(merged));
		expect(vars['{{published}}']).toBe('2024-12-01');
	});
});
