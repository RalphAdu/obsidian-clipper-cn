// scripts/scys-article-visual-audit.ts
//
// Full-content audit for scys.com /articleDetail/<type>/<id> (4 forms:
// docBlocks / Quill HTML / 纯文本+<e> / image-only). Thin wrapper around
// visual-audit-framework with scys-article-specific overrides.
//
// rootSelector='.content-container': narrows from `main` to exclude
// .article-interaction-zone (comments) which would otherwise pull in
// avatar imgs + reply <p> as false-positive mismatches.
//
// blockSelectors adds `.post-content`: URL 3/4 (纯文本+<e> / image-only)
// have content directly inside `<div class="post-content">` with no
// <p>/<h>/<li>/<img> children, so the default BLOCK_SELECTORS would
// trivially scan 0 blocks (false PASS). `.post-content` block-level catches
// these as a single textContent assertion; URL 2 (Quill HTML) has both
// `<p>` blocks AND `.post-content` ancestor (extra block harmless).
//
// imageAssert=() => true: scys-extractor inlines images as base64 data URIs
// into markdown (for Obsidian offline use), so hydration's `/doc/<token>`
// or `https://search01.../upload/...` URLs can never match. Image fidelity
// is checked separately by the e2e test asserting markdown.match(/!\[\]/g)
// count >= hydration img count.

import { readFileSync } from 'node:fs';
import { runVisualAudit, formatReport, AuditConfig, AuditReport } from './visual-audit-framework';

export const scysArticleAuditConfig: AuditConfig = {
	rootSelector: '.content-container',
	blockSelectors: ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote', 'pre', 'td', 'th', 'img', '.post-content'],
	imageAssert: () => true,
};

export function auditScysArticle(hydratedHtml: string, markdown: string): AuditReport {
	return runVisualAudit(hydratedHtml, markdown, scysArticleAuditConfig);
}

async function main() {
	const mdFile = process.argv[2] || '/tmp/clip-md.txt';
	const htmlFile = process.argv[3] || '/tmp/clip-html.txt';

	const md = readFileSync(mdFile, 'utf-8');
	const html = readFileSync(htmlFile, 'utf-8');

	const report = auditScysArticle(html, md);
	console.log(formatReport(report));
	process.exit(report.mismatches.length === 0 ? 0 : 1);
}

if (require.main === module) {
	main().catch((e) => {
		console.error(e);
		process.exit(2);
	});
}
