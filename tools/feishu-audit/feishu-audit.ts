#!/usr/bin/env node
import { writeFileSync, readFileSync } from 'node:fs';
import { fetchDoc } from './openapi-fetcher';
import { renderToMarkdown } from './render-pipeline';
import { deriveExpected } from './expectations';
import { audit, printReport } from './audit-buckets';

async function main() {
	const docUrl = process.argv[2];
	if (!docUrl) {
		console.error('usage: feishu-audit.ts <feishu-doc-url> [--vault-md <path>]');
		process.exit(2);
	}
	const vaultMdIdx = process.argv.indexOf('--vault-md');
	const vaultMd = vaultMdIdx > 0 && process.argv[vaultMdIdx + 1]
		? readFileSync(process.argv[vaultMdIdx + 1], 'utf8')
		: undefined;

	console.log(`[audit] fetching ${docUrl}`);
	const r = await fetchDoc(docUrl);
	console.log(`[audit] fetched ${r.blocks.length} blocks, ${r.comments.length} comments, ${r.commentImages.size} comment image(s)`);

	const md = renderToMarkdown(r);
	writeFileSync('/tmp/feishu-audit-output.md', md);
	console.log(`[audit] rendered ${md.length} bytes → /tmp/feishu-audit-output.md`);

	const expected = deriveExpected(r.blocks, r.comments);
	const buckets = audit(expected, md, vaultMd);
	printReport(buckets);

	const total = buckets.reduce((s, b) => s + b.misses.length, 0);
	process.exit(total === 0 ? 0 : 1);
}

main().catch((e) => {
	console.error('[audit] error:', e);
	process.exit(2);
});
