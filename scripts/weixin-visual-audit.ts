// scripts/weixin-visual-audit.ts
//
// Full-content audit for mp.weixin.qq.com. Thin wrapper around
// visual-audit-framework with weixin-specific config (rootSelector = #js_content).
//
// Used as ship gate (T5-4) — must report 0 mismatch before "请验收".
//
// Usage as CLI:
//   npx ts-node --project scripts/tsconfig.json scripts/weixin-visual-audit.ts <md-file> <html-file>
// Used as library from vitest:
//   import { auditWeixinClip } from '../../scripts/weixin-visual-audit';

import { readFileSync } from 'node:fs';
import { runVisualAudit, formatReport, AuditConfig, AuditReport, AuditMismatch } from './visual-audit-framework';

export type { AuditReport, AuditMismatch };
export { formatReport };

export const weixinAuditConfig: AuditConfig = {
	rootSelector: '#js_content',
};

export function auditWeixinClip(hydratedHtml: string, markdown: string): AuditReport {
	return runVisualAudit(hydratedHtml, markdown, weixinAuditConfig);
}

async function main() {
	const mdFile = process.argv[2] || '/tmp/clip-md.txt';
	const htmlFile = process.argv[3] || '/tmp/clip-html.txt';

	const md = readFileSync(mdFile, 'utf-8');
	const html = readFileSync(htmlFile, 'utf-8');

	const report = auditWeixinClip(html, md);
	console.log(formatReport(report));
	process.exit(report.mismatches.length === 0 ? 0 : 1);
}

if (require.main === module) {
	main().catch((e) => {
		console.error(e);
		process.exit(2);
	});
}
