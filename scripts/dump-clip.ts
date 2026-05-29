// scripts/dump-clip.ts
//
// One-shot dumper: runRealClip + write markdown + hydratedHtml to /tmp.
// Run via: npx ts-node --project scripts/tsconfig.json scripts/dump-clip.ts <URL>
//
// Used during weixin-visual-audit dev to inspect raw clip outputs.

import { runRealClip } from './e2e-clip-runner';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function parseFeishuCreds(path: string): { appId: string; appSecret: string } | null {
	if (!existsSync(path)) {
		console.warn(`[dump] feishu creds file not found: ${path}`);
		return null;
	}
	const text = readFileSync(path, 'utf-8');
	const idMatch = text.match(/^id:\s*(\S+)/m);
	const secretMatch = text.match(/^secret:\s*(\S+)/m);
	if (!idMatch || !secretMatch) {
		console.warn(`[dump] feishu creds file missing id/secret lines: ${path}`);
		return null;
	}
	return { appId: idMatch[1].trim(), appSecret: secretMatch[1].trim() };
}

async function main() {
	const args = process.argv.slice(2);
	const url = args.find((a) => !a.startsWith('--'));
	const profileIdx = args.indexOf('--profile');
	const profileArg = profileIdx >= 0 ? args[profileIdx + 1] : undefined;
	const credsIdx = args.indexOf('--feishu-creds');
	const credsPath = credsIdx >= 0 ? args[credsIdx + 1] : 'docs/superpowers/feishu.md';

	if (!url) {
		console.error('Usage: dump-clip.ts <URL> [--profile <dir>] [--feishu-creds <path>]');
		process.exit(2);
	}

	let userDataDir: string | undefined;
	if (profileArg) {
		userDataDir = resolve(process.cwd(), profileArg);
		if (!existsSync(userDataDir)) {
			console.error(`[dump] profile not found: ${userDataDir}`);
			process.exit(2);
		}
		console.log(`[dump] using persistent profile: ${userDataDir}`);
	}

	const feishuSettings = parseFeishuCreds(credsPath) ?? undefined;
	if (feishuSettings) {
		console.log(`[dump] feishu creds loaded: appId=${feishuSettings.appId.slice(0, 14)}...`);
	}

	// If a profile is supplied (scys/zsxq/feishu) skip the weixin-specific
	// '#publish_time' wait — those sites don't have that selector.
	const wait = userDataDir ? undefined : '#publish_time';

	console.log(`[dump] clipping ${url} ...`);
	const clip = await runRealClip(url, { wait, timeout: 90_000, userDataDir, feishuSettings });

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
