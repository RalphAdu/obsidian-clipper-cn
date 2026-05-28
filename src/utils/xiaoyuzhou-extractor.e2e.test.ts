// src/utils/xiaoyuzhou-extractor.e2e.test.ts
//
// True end-to-end test: real chrome + dist/ extension + real network.
// Excluded from `npm test`; run via `npm run test:e2e`.

import { describe, it, expect, beforeAll } from 'vitest';
import { runRealClip, type ClipResult } from '../../scripts/e2e-clip-runner';
import { auditXiaoyuzhouClip, formatReport } from '../../scripts/xiaoyuzhou-visual-audit';

const URL = 'https://www.xiaoyuzhoufm.com/episode/6850d2ed4abe6e29cb814160';

describe('xiaoyuzhou e2e — episode 6850d2ed', () => {
	let clip: ClipResult;

	beforeAll(async () => {
		clip = await runRealClip(URL, {
			// Wait for the shownote article container to appear (SSR rendered)
			wait: 'article',
			timeout: 90_000,
		});
	}, 180_000);

	it('clip succeeded (markdown + hydratedHtml non-empty)', () => {
		expect(clip.markdown.length).toBeGreaterThan(500);
		expect(clip.hydratedHtml.length).toBeGreaterThan(10_000);
		console.log(`[e2e-xiaoyuzhou] clip ${clip.durationMs}ms md ${clip.markdown.length}B`);
	});

	it('frontmatter contains podcast metadata', () => {
		expect(clip.markdown).toMatch(/^audioUrl: https:\/\/media\.xyzcdn\.net\/.+\.m4a$/m);
		expect(clip.markdown).toMatch(/^duration: \d{2}:\d{2}:\d{2}$/m);
		expect(clip.markdown).toMatch(/^podcast: 面基$/m);
		expect(clip.markdown).toMatch(/^episodeNumber: E112$/m);
	});

	it('body has audio embed at top', () => {
		expect(clip.markdown).toMatch(/!\[\]\(https:\/\/media\.xyzcdn\.net\/.+\.m4a\)/);
	});

	it('timestamps are markdown links to audio#t=N', () => {
		const timestampLinks =
			clip.markdown.match(
				/\[\d{1,2}:\d{2}(?::\d{2})?\]\(https:\/\/media\.xyzcdn\.net\/[^)]+#t=\d+\)/g,
			) || [];
		expect(timestampLinks.length).toBeGreaterThan(10);
	});

	it('comments section present with nested blockquote', () => {
		expect(clip.markdown).toContain('## 评论');
		const blockquoteLines = clip.markdown.match(/^>\s.+/gm) || [];
		expect(blockquoteLines.length).toBeGreaterThan(5);
	});

	it('no empty markdown links leaked from unhandled anchors', () => {
		// 排除前导 `!` 的 image embed —— `![](url)` (alt 为空的 image) 是合法 markdown，
		// 此处只断言"裸链接" `[](url)`（外层 <a> 包裹被 turndown 出空 alt 的产物）
		expect(clip.markdown).not.toMatch(/(?<!!)\[\]\([^)]*\)/);
	});

	it('full content audit: shownote + comments (0 mismatch)', () => {
		const report = auditXiaoyuzhouClip(clip.hydratedHtml, clip.markdown);
		console.log(formatReport(report));
		expect(report.mismatches.length, formatReport(report)).toBe(0);
	});
});
