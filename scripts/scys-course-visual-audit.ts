// scripts/scys-course-visual-audit.ts
//
// Full-content audit for scys.com /course/detail/<id>?chapterId=<X>. Thin
// wrapper around visual-audit-framework.
//
// rootSelector='.course-content-container': probe found 178 blocks under
// .course-content-container (broadest non-noisy cover). .feishu-doc-content
// / .document-container / .content-container all hit 65 blocks (these are
// nested inside .course-content-container — narrower view).

import { readFileSync } from 'node:fs';
import { runVisualAudit, formatReport, AuditConfig, AuditReport } from './visual-audit-framework';

export const scysCourseAuditConfig: AuditConfig = {
	rootSelector: '.course-content-container',
};

export function auditScysCourse(hydratedHtml: string, markdown: string): AuditReport {
	return runVisualAudit(hydratedHtml, markdown, scysCourseAuditConfig);
}

async function main() {
	const mdFile = process.argv[2] || '/tmp/clip-md.txt';
	const htmlFile = process.argv[3] || '/tmp/clip-html.txt';
	const md = readFileSync(mdFile, 'utf-8');
	const html = readFileSync(htmlFile, 'utf-8');
	const report = auditScysCourse(html, md);
	console.log(formatReport(report));
	process.exit(report.mismatches.length === 0 ? 0 : 1);
}

if (require.main === module) {
	main().catch((e) => {
		console.error(e);
		process.exit(2);
	});
}
