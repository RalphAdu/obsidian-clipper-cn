// src/utils/scys-extractor.e2e.test.ts
//
// True end-to-end test for scys.com: real chrome + dist/ extension + real
// network + real extractor + real markdown. Asserts produced .md matches
// hydration-time DOM ground truth (full-content visual audit, 0 mismatch).
//
// Excluded from `npm test` (vitest.config.ts exclude: ['**/*.e2e.test.ts']).
// Run: npm run test:e2e  OR  npx vitest run --config vitest.e2e.config.ts src/utils/scys-extractor.e2e.test.ts
//
// Login state: scys article URLs force-redirect to WeChat QR scan; cookies
// cannot be read via pycookiecheat (httpOnly + token not persisted by
// Chrome to disk reliably). Persistent playwright profile workaround:
// scripts/scys-login-persist.ts (one-time QR scan) writes login state to
// .scys-pw-profile/ which all e2e runs reuse via runRealClip({ userDataDir }).

import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { runRealClip } from '../../scripts/e2e-clip-runner';
import { auditScysArticle } from '../../scripts/scys-article-visual-audit';
import { auditScysDocx } from '../../scripts/scys-docx-visual-audit';
import { auditScysCourse } from '../../scripts/scys-course-visual-audit';
import { formatReport } from '../../scripts/visual-audit-framework';

const PAYWALL_MIN_BYTES = 200;
const SCYS_PROFILE = resolve(__dirname, '..', '..', '.scys-pw-profile');

if (!existsSync(SCYS_PROFILE)) {
	throw new Error(
		`scys persistent profile missing at ${SCYS_PROFILE}. ` +
		`Run one-time: npx ts-node --project scripts/tsconfig.json scripts/scys-login-persist.ts`
	);
}

describe('scys article — 4 形态 e2e', () => {
	const cases = [
		{ name: 'A docBlocks (55188248452852824)', url: 'https://scys.com/articleDetail/xq_topic/55188248452852824' },
		{ name: 'B Quill HTML (418444442181248)', url: 'https://scys.com/articleDetail/xq_topic/418444442181248' },
		{ name: 'C 纯文本+<e>+附件 (22255855424524441)', url: 'https://scys.com/articleDetail/xq_topic/22255855424524441' },
		{ name: 'D image-only+<e> (2852488814854211)', url: 'https://scys.com/articleDetail/xq_topic/2852488814854211' },
		{ name: 'E docBlocks {3,4,5,6,7} 5-level heading (5125541242454854)', url: 'https://scys.com/articleDetail/xq_topic/5125541242454854' },
	];

	for (const c of cases) {
		it(`${c.name} — full content audit 0 mismatch`, async () => {
			const { markdown, hydratedHtml, durationMs } = await runRealClip(c.url, { userDataDir: SCYS_PROFILE });
			console.log(`[e2e] ${c.name} clip ${durationMs}ms markdown=${markdown.length}B html=${hydratedHtml.length}B`);
			expect(markdown.length, `paywall or login failed: ${c.url}`).toBeGreaterThan(PAYWALL_MIN_BYTES);

			const report = auditScysArticle(hydratedHtml, markdown);
			console.log(formatReport(report));
			expect(report.mismatches).toEqual([]);
		}, 90_000);
	}

	// Task 5: dedicated 5125541 数学校验
	// docBlocks 用 {3,4,5,6,7} → dynamic rewrite 5 类型，floor 提到 H2,
	// 验证 H1=0 / H2=4 / H3=8 / H4=14 / H5=12 / H6=3 + image=23（含 GRID
	// children_blocks 内嵌 image 递归 emit）
	it('article 5125541: dynamic heading rewrite + GRID/callout children → 文档体无 H1, 数学校验', async () => {
		const url = 'https://scys.com/articleDetail/xq_topic/5125541242454854';
		const { markdown } = await runRealClip(url, { userDataDir: SCYS_PROFILE });

		// docBlocks 用 {3,4,5,6,7} → dynamic: 3→H2(3 个), 4→H3(8), 5→H4(14), 6→H5(12), 7→H6(3)
		const h1 = (markdown.match(/^# [^\n]+$/gm) || []).length;
		const h2 = (markdown.match(/^## [^\n]+$/gm) || []).length;
		const h3 = (markdown.match(/^### [^\n]+$/gm) || []).length;
		const h4 = (markdown.match(/^#### [^\n]+$/gm) || []).length;
		const h5 = (markdown.match(/^##### [^\n]+$/gm) || []).length;
		const h6 = (markdown.match(/^###### [^\n]+$/gm) || []).length;

		// 文档体内不应有 H1（title 在 frontmatter）
		expect(h1).toBe(0);
		// H2 = type=3 (3 个 "做个自我介绍/前言/正文") + 1 个评论标题 `## 💬 评论（...）` = 4
		expect(h2).toBe(4);
		// H3 = type=4 (8 个 "第一部分..." 等)
		expect(h3).toBe(8);
		// H4 = type=5 (14)
		expect(h4).toBe(14);
		// H5 = type=6 (12)
		expect(h5).toBe(12);
		// H6 = type=7 (3)
		expect(h6).toBe(3);

		// image 数量 = 23（docBlocks 含 GRID 内嵌的 grid_column children image，递归 emit 后 23）
		const imgCount = (markdown.match(/!\[[^\]]*\]\([^)]+\)/g) || []).length;
		expect(imgCount).toBe(23);
	}, 120_000);
});

describe('scys docx — e2e', () => {
	it('QSn2dD6QnoYlDxxiYItcudnPnZg — full content audit 0 mismatch', async () => {
		const url = 'https://scys.com/view/docx/QSn2dD6QnoYlDxxiYItcudnPnZg';
		const { markdown, hydratedHtml, durationMs } = await runRealClip(url, { userDataDir: SCYS_PROFILE });
		console.log(`[e2e] docx clip ${durationMs}ms markdown=${markdown.length}B html=${hydratedHtml.length}B`);
		expect(markdown.length, `paywall or login failed: ${url}`).toBeGreaterThan(PAYWALL_MIN_BYTES);
		const report = auditScysDocx(hydratedHtml, markdown);
		console.log(formatReport(report));
		expect(report.mismatches).toEqual([]);
	}, 90_000);
});

describe('scys course chapter — e2e', () => {
	it('course 172 / chapter 11408 — full content audit 0 mismatch', async () => {
		const url = 'https://scys.com/course/detail/172?chapterId=11408';
		const { markdown, hydratedHtml, durationMs } = await runRealClip(url, { userDataDir: SCYS_PROFILE });
		console.log(`[e2e] course clip ${durationMs}ms markdown=${markdown.length}B html=${hydratedHtml.length}B`);
		expect(markdown.length, `paywall or login failed: ${url}`).toBeGreaterThan(PAYWALL_MIN_BYTES);
		const report = auditScysCourse(hydratedHtml, markdown);
		console.log(formatReport(report));
		expect(report.mismatches).toEqual([]);
	}, 90_000);
});
