// Task 8 step 3 sanity check (mutation form, not half-truncation).
//
// Plan §3 wanted "half markdown audit must report ≥1 mismatch". This is
// degenerate for base64-image-dominant markdown (scys article URL 1 is
// 10.59MB with only 64KB / 0.6% actual text — half-truncation either keeps
// all text or loses an image only, both audit pass). Mutation is sharper:
// pluck the first hydration block's leading text out of markdown and
// confirm audit catches it.
//
// Run: npx ts-node --project scripts/tsconfig.json scripts/sanity-half-audit.ts

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseHTML } from 'linkedom';
import { runVisualAudit, defaultNormalizeText } from './visual-audit-framework';
import { scysArticleAuditConfig } from './scys-article-visual-audit';
import { scysDocxAuditConfig } from './scys-docx-visual-audit';
import { scysCourseAuditConfig } from './scys-course-visual-audit';

const DUMP_DIR = '/var/folders/zp/j98c57kd5299mqs8mhtcsb_w0000gn/T/scys-probe-hydrated';

const CASES = [
	{ label: 'article-A (55188)', slug: 'https-scys-com-articleDetail-xq-topic-55188248452852824', cfg: scysArticleAuditConfig },
	{ label: 'article-B (418444)', slug: 'https-scys-com-articleDetail-xq-topic-418444442181248', cfg: scysArticleAuditConfig },
	{ label: 'article-C (22255)', slug: 'https-scys-com-articleDetail-xq-topic-22255855424524441', cfg: scysArticleAuditConfig },
	{ label: 'article-D (28524)', slug: 'https-scys-com-articleDetail-xq-topic-2852488814854211', cfg: scysArticleAuditConfig },
	{ label: 'docx (QSn2)', slug: 'https-scys-com-view-docx-QSn2dD6QnoYlDxxiYItcudnPnZg', cfg: scysDocxAuditConfig },
	{ label: 'course (172/11408)', slug: 'https-scys-com-course-detail-172-chapterId-11408', cfg: scysCourseAuditConfig },
];

let anyFailure = false;
for (const c of CASES) {
	const mdPath = join(DUMP_DIR, c.slug + '.md');
	const htmlPath = join(DUMP_DIR, c.slug + '.html');
	if (!existsSync(mdPath) || !existsSync(htmlPath)) {
		console.log(`${c.label}: SKIP (dump missing — re-run find-scys-root-selector.ts first)`);
		continue;
	}
	const md = readFileSync(mdPath, 'utf-8');
	const html = readFileSync(htmlPath, 'utf-8');
	// Mutation: find the first hydration text block's leading 40 chars
	// in the markdown and delete that substring. Audit should now report
	// at least 1 mismatch for that block.
	const blockSelectors = c.cfg.blockSelectors ?? ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote', 'pre', 'td', 'th', 'img'];
	const { document } = parseHTML(html);
	const root = document.querySelector(c.cfg.rootSelector);
	let firstAnchor: string | null = null;
	if (root) {
		for (const block of Array.from(root.querySelectorAll(blockSelectors.join(',')))) {
			const text = defaultNormalizeText(block.textContent || '');
			// Need a substring that exists *contiguously* in raw markdown
			// (audit normalizes both sides, but indexOf below works on raw md).
			// Use first 10 chars: that's the prefix before any inline entity
			// (text_bold becomes **...** in markdown, splitting longer anchors).
			if (text.length >= 10) {
				firstAnchor = text.slice(0, 10);
				break;
			}
		}
	}
	let mutatedMd = md;
	if (firstAnchor) {
		const idx = md.indexOf(firstAnchor);
		if (idx >= 0) mutatedMd = md.slice(0, idx) + md.slice(idx + firstAnchor.length);
	}
	const reportFull = runVisualAudit(html, md, c.cfg);
	const reportHalf = runVisualAudit(html, mutatedMd, c.cfg);
	const sensitive = reportHalf.mismatches.length > 0;
	console.log(
		`${c.label.padEnd(22)}  full=${reportFull.mismatches.length} mutated=${reportHalf.mismatches.length}` +
		`  blocks=${reportFull.totalBlocks}` +
		`  anchor=${firstAnchor ? firstAnchor.slice(0, 20) + '...' : '(none)'}` +
		`  ${sensitive ? '✓ audit sensitive' : '✗ INSENSITIVE — fix audit'}`
	);
	if (!sensitive) anyFailure = true;
}
process.exit(anyFailure ? 1 : 0);
