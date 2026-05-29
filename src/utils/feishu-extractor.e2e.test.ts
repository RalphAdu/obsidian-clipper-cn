import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { runRealClip } from '../../scripts/e2e-clip-runner';

// X0nq fixture — driven by user 2026-05-29 audit request. If extractor
// regresses (frontmatter break, image placeholder leak, missing H1),
// this fails and tells us before manual audit catches it.
const URL = 'https://pcn5ogco2cwh.feishu.cn/docx/X0nqdaz4Fo7GYNx0JbLcvhHln6b';
const CREDS_PATH = 'docs/superpowers/feishu.md';

function readCreds(): { appId: string; appSecret: string } | null {
	if (!existsSync(CREDS_PATH)) return null;
	const text = readFileSync(CREDS_PATH, 'utf-8');
	const idMatch = text.match(/^id:\s*(\S+)/m);
	const secretMatch = text.match(/^secret:\s*(\S+)/m);
	if (!idMatch || !secretMatch) return null;
	return { appId: idMatch[1].trim(), appSecret: secretMatch[1].trim() };
}

const creds = readCreds();

(creds ? describe : describe.skip)('feishu docx X0nq e2e', () => {
	it('clips and produces non-empty markdown with frontmatter', async () => {
		const clip = await runRealClip(URL, {
			feishuSettings: creds!,
			timeout: 120_000,
		});
		expect(clip.markdown.length).toBeGreaterThan(500);
		expect(clip.markdown).toMatch(/^---\n/);
		expect(clip.markdown).toMatch(/\nsource: "https:\/\/pcn5ogco2cwh\.feishu\.cn\/docx\/X0nq/);
		expect(clip.markdown).toMatch(/\ntags:/);
		expect(clip.markdown).not.toMatch(/feishu-image:\/\//);
		// Body has at least one markdown structural element (heading / bold /
		// list / image / link). Some feishu docx start with a bold callout
		// instead of H1 — title lives in frontmatter, not body.
		expect(clip.markdown).toMatch(/\n(#+ |\*\*|[-*] |!\[)/);
	}, 180_000);
});
