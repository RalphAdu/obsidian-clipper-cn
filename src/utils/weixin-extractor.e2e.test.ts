// src/utils/weixin-extractor.e2e.test.ts
//
// True end-to-end test: real chrome + dist/ extension + real network + real
// extractor + real markdown generation. Asserts the produced .md matches
// what hydration-time DOM ground truth implies.
//
// Excluded from `npm test` by vitest.config.ts (exclude: ['**/*.e2e.test.ts']).
// Run via `npm run test:e2e` (ship gate) or `npx vitest run src/utils/weixin-extractor.e2e.test.ts`.

import { describe, it, expect, beforeAll } from 'vitest';
import { parseHTML } from 'linkedom';
import { runRealClip, type ClipResult } from '../../scripts/e2e-clip-runner';
import { auditWeixinClip, formatReport } from '../../scripts/weixin-visual-audit';

const URL = 'https://mp.weixin.qq.com/s/SPLTD-hFAsyYAA7V1lU8OA';

describe('weixin e2e (real chrome + real extension)', () => {
	let clip: ClipResult;

	beforeAll(async () => {
		clip = await runRealClip(URL, {
			wait: '#publish_time',
			timeout: 90_000,
		});
	}, 180_000);

	it('clip succeeded (markdown + hydratedHtml non-empty)', () => {
		expect(clip.markdown.length).toBeGreaterThan(1000);
		expect(clip.hydratedHtml.length).toBeGreaterThan(10_000);
		console.log(`[e2e] clip duration: ${clip.durationMs}ms, markdown ${clip.markdown.length}B, html ${clip.hydratedHtml.length}B`);
	});

	it('frontmatter published matches DOM #publish_time text', () => {
		const { document } = parseHTML(clip.hydratedHtml);
		const text = document.querySelector('#publish_time')?.textContent?.trim() ?? '';
		const m = text.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
		const expected = m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : '';
		expect(expected, 'DOM #publish_time should yield YYYY-MM-DD').toBeTruthy();
		expect(clip.markdown).toMatch(new RegExp(`^published: ${expected}$`, 'm'));
	});

	it('body contains PARA folder structure verbatim', () => {
		for (const folder of ['Vault/', '1-Projects/', '2-Areas/', '3-Resources/', '4-Archives/']) {
			expect(clip.markdown, `markdown should contain "${folder}"`).toContain(folder);
		}
		expect(clip.markdown).toContain('├── 1-Projects/');
	});

	it('no backslash-escaped backtick leakage in markdown', () => {
		expect(clip.markdown).not.toMatch(/\\`/);
	});

	it('no leftover <span> in markdown body', () => {
		expect(clip.markdown).not.toMatch(/<span/);
	});

	it('full content audit: every visible block in #js_content appears in markdown (0 mismatch)', () => {
		const report = auditWeixinClip(clip.hydratedHtml, clip.markdown);
		console.log(formatReport(report));
		expect(report.mismatches, `${report.mismatches.length} blocks from web source missing in markdown`).toHaveLength(0);
		expect(report.totalBlocks, 'audit must scan a non-trivial number of blocks').toBeGreaterThan(100);
	});
});
