// E2E test for the scys article comment <e type="web"> entity decoding fix
// (2026-05-19). Covers the full extractor path without requiring chrome runtime:
//
//   fixture topicDetail + pageTopicComment JSON
//   → extractScysStructuredContent (real production extractor with mocked fetch)
//   → assert returned HTML contains <a href="…"> for the GitHub link that
//     would otherwise be lost when Defuddle drops the <e /> self-closing tag.
//
// fixture: src/utils/fixtures/scys-article-22255845818825821-{detail,comments}.json
// captured 2026-05-19 from live API (pycookiecheat + chrome cookies).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractScysStructuredContent } from './scys-extractor';
import detailFixture from './fixtures/scys-article-22255845818825821-detail.json';
import commentsFixture from './fixtures/scys-article-22255845818825821-comments.json';

const ENTITY_ID = '22255845818825821';
const URL = `https://scys.com/articleDetail/xq_topic/${ENTITY_ID}`;

describe('scys article comment <e type="web"> entity — e2e', () => {
	const originalFetch = global.fetch;
	afterEach(() => { global.fetch = originalFetch; });

	it('decodes <e> entity in comment content into <a> tag', async () => {
		const commentPages = commentsFixture as any[];
		let commentPageIdx = 0;
		global.fetch = vi.fn(async (input: any) => {
			const url = typeof input === 'string' ? input : input.url;
			if (url.includes('/homePage/topicDetail')) {
				return new Response(JSON.stringify(detailFixture), { status: 200 });
			}
			if (url.includes('/homePage/pageTopicComment')) {
				const page = commentPages[commentPageIdx++] ?? { data: { items: [], total: 0 } };
				return new Response(JSON.stringify(page), { status: 200 });
			}
			// Image L1 fetches — return 404 so unresolved tokens stay in place.
			// We don't care about base64 inlining here, only that the comment HTML
			// emits the <a> tag from the decoded <e> entity.
			return new Response('', { status: 404 });
		}) as any;

		const doc = { URL } as unknown as Document;

		const result = await extractScysStructuredContent(doc);

		expect(result).not.toBeNull();
		const content = result!.content;
		// Positive assertion: GitHub URL is now a proper anchor.
		expect(content).toContain('<a href="https://github.com/garrytan/gstack">');
		// Negative assertion: the raw <e type="web" tag is gone (decoded away).
		expect(content).not.toMatch(/<e\s+type="web"/);
	});
});
