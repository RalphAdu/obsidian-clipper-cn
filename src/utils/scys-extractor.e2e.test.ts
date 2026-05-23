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
