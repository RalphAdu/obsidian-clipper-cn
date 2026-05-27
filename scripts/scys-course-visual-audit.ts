// scripts/scys-course-visual-audit.ts
//
// Full-content audit for scys.com /course/detail/<id>?chapterId=<X>. Thin
// wrapper around visual-audit-framework.
//
// rootSelector='.feishu-doc-content': probe found .course-content-container
// at 178 blocks but includes the reply/comment section (avatar imgs +
// reply <p> are false-positive mismatches). Narrowing to .feishu-doc-content
// (65 blocks) excludes comments while keeping the chapter body.
//
// imageAssert=() => true: same reason as scys-article — extractor inlines
// base64 images into markdown. Image fidelity is checked by the e2e test
// at a separate markdown image-count assertion.

import { readFileSync } from 'node:fs';
import { runVisualAudit, formatReport, AuditConfig, AuditReport } from './visual-audit-framework';

export const scysCourseAuditConfig: AuditConfig = {
	rootSelector: '.feishu-doc-content',
	imageAssert: () => true,
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
