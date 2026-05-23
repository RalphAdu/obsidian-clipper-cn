// scripts/scys-article-visual-audit.ts
//
// Full-content audit for scys.com /articleDetail/<type>/<id> (4 forms:
// docBlocks / Quill HTML / 纯文本+<e> / image-only). Thin wrapper around
// visual-audit-framework with scys-article-specific rootSelector.
//
// rootSelector='main': probe (scripts/find-scys-root-selector.ts) confirmed
// 4/4 article URLs hit, blocks 8/49/254/275. `main` is the broadest cover
// (includes title-line + content-container + label-box + interaction-zone);
// Task 7 will decide whether to narrow to `.content-container` if comment
// section blocks cause irreducible mismatches.

import { readFileSync } from 'node:fs';
import { runVisualAudit, formatReport, AuditConfig, AuditReport } from './visual-audit-framework';

export const scysArticleAuditConfig: AuditConfig = {
	rootSelector: 'main',
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
