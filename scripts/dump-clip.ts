// scripts/dump-clip.ts
//
// One-shot dumper: runRealClip + write markdown + hydratedHtml to /tmp.
// Run via: npx ts-node --project scripts/tsconfig.json scripts/dump-clip.ts <URL>
//
// Used during weixin-visual-audit dev to inspect raw clip outputs.

import { runRealClip } from './e2e-clip-runner';
import { writeFileSync } from 'node:fs';

async function main() {
	const url = process.argv[2];
	if (!url) {
		console.error('Usage: dump-clip.ts <URL>');
		process.exit(2);
	}

	console.log(`[dump] clipping ${url} ...`);
	const clip = await runRealClip(url, { wait: '#publish_time', timeout: 90_000 });

	writeFileSync('/tmp/clip-md.txt', clip.markdown, 'utf-8');
	writeFileSync('/tmp/clip-html.txt', clip.hydratedHtml, 'utf-8');

	console.log(`[dump] markdown: ${clip.markdown.length}B → /tmp/clip-md.txt`);
	console.log(`[dump] hydratedHtml: ${clip.hydratedHtml.length}B → /tmp/clip-html.txt`);
	console.log(`[dump] duration: ${clip.durationMs}ms`);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
