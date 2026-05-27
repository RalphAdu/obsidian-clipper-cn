// scripts/scys-docx-visual-audit.ts
//
// Full-content audit for scys.com /view/docx/<token>. Thin wrapper around
// visual-audit-framework.
//
// rootSelector='.contentMain': probe (scripts/find-scys-root-selector.ts)
// found 101 blocks under .contentMain; .docx-page / .wrap have blocks=0
// (they nest .contentMain but children don't match BLOCK_SELECTORS directly).

import { readFileSync } from 'node:fs';
import { runVisualAudit, formatReport, AuditConfig, AuditReport } from './visual-audit-framework';

export const scysDocxAuditConfig: AuditConfig = {
	rootSelector: '.contentMain',
};

export function auditScysDocx(hydratedHtml: string, markdown: string): AuditReport {
	return runVisualAudit(hydratedHtml, markdown, scysDocxAuditConfig);
}

async function main() {
	const mdFile = process.argv[2] || '/tmp/clip-md.txt';
	const htmlFile = process.argv[3] || '/tmp/clip-html.txt';
	const md = readFileSync(mdFile, 'utf-8');
	const html = readFileSync(htmlFile, 'utf-8');
	const report = auditScysDocx(html, md);
	console.log(formatReport(report));
	process.exit(report.mismatches.length === 0 ? 0 : 1);
}

if (require.main === module) {
	main().catch((e) => {
		console.error(e);
		process.exit(2);
	});
}
