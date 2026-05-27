// Offline audit test using dumped hydratedHtml + markdown to iterate
// rootSelector / normalize without paying chrome relaunch cost.
//
// Run: npx ts-node --project scripts/tsconfig.json scripts/test-audit-offline.ts

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runVisualAudit, AuditConfig } from './visual-audit-framework';

const DUMP_DIR = '/var/folders/zp/j98c57kd5299mqs8mhtcsb_w0000gn/T/scys-probe-hydrated';

const URLS: Array<{ name: string; slug: string; configCandidates: AuditConfig[] }> = [
	{
		name: 'article-1 (55188)',
		slug: 'https-scys-com-articleDetail-xq-topic-55188248452852824',
		configCandidates: [
			{ rootSelector: 'main' },
			{ rootSelector: '.content-container' },
		],
	},
	{
		name: 'article-2 (418444)',
		slug: 'https-scys-com-articleDetail-xq-topic-418444442181248',
		configCandidates: [
			{ rootSelector: 'main' },
			{ rootSelector: '.content-container' },
		],
	},
	{
		name: 'article-3 (22255)',
		slug: 'https-scys-com-articleDetail-xq-topic-22255855424524441',
		configCandidates: [
			{ rootSelector: 'main' },
			{ rootSelector: '.content-container' },
		],
	},
	{
		name: 'article-4 (28524)',
		slug: 'https-scys-com-articleDetail-xq-topic-2852488814854211',
		configCandidates: [
			{ rootSelector: 'main' },
			{ rootSelector: '.content-container' },
		],
	},
	{
		name: 'course (172/11408)',
		slug: 'https-scys-com-course-detail-172-chapterId-11408',
		configCandidates: [
			{ rootSelector: '.course-content-container' },
			{ rootSelector: '.feishu-doc-content' },
		],
	},
];

for (const u of URLS) {
	const md = readFileSync(join(DUMP_DIR, u.slug + '.md'), 'utf-8');
	const html = readFileSync(join(DUMP_DIR, u.slug + '.html'), 'utf-8');
	console.log(`\n=== ${u.name} === md=${md.length}B html=${html.length}B`);
	for (const config of u.configCandidates) {
		const report = runVisualAudit(html, md, config);
		const byTag = new Map<string, number>();
		for (const m of report.mismatches) {
			byTag.set(m.tag, (byTag.get(m.tag) || 0) + 1);
		}
		const tagSummary = [...byTag.entries()].map(([t, c]) => `${t}=${c}`).join(' ');
		console.log(`  ${config.rootSelector.padEnd(34)} blocks=${report.totalBlocks} mismatch=${report.mismatches.length}  (${tagSummary || '0'})`);
	}
}
