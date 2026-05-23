// scripts/find-scys-root-selector.ts
//
// One-shot tool: for each scys URL (article 4 forms + docx + course),
// fetch hydratedHtml via runRealClip and test candidate root selectors.
// Output: per-URL ranking of candidates by (blockCount, textLen) — pick
// the most-specific selector that has plenty of content for the audit.
//
// Run: npx ts-node --project scripts/tsconfig.json scripts/find-scys-root-selector.ts

import { parseHTML } from 'linkedom';
import { resolve, join } from 'node:path';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { runRealClip } from './e2e-clip-runner';

const DUMP_DIR = join(tmpdir(), 'scys-probe-hydrated');

const BLOCK_SELECTORS = 'p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, td, th, img';

// Persistent profile dir created by scys-login-persist.ts (one-time QR scan).
const SCYS_PROFILE = resolve(__dirname, '..', '.scys-pw-profile');

const CANDIDATES = {
	article: [
		'.vc-doc-item',
		'.article-content',
		'.topic-detail-content',
		'.topic-content',
		'.article-body',
		'[class*="ArticleContent"]',
		'[class*="article"]',
		'[class*="topic-detail"]',
		'[class*="topic"]',
		'main',
		'article',
	],
	docx: [
		'.docx-render-root',
		'.feishu-docx',
		'.vc-doc-item',
		'.docx-content',
		'[class*="docx"]',
		'[class*="Docx"]',
		'main',
	],
	course: [
		'.chapter-content',
		'.course-chapter',
		'.chapter-body',
		'.vc-doc-item',
		'[class*="chapter"]',
		'[class*="Chapter"]',
		'main',
	],
};

const URLS = {
	article: [
		'https://scys.com/articleDetail/xq_topic/55188248452852824',
		'https://scys.com/articleDetail/xq_topic/418444442181248',
		'https://scys.com/articleDetail/xq_topic/22255855424524441',
		'https://scys.com/articleDetail/xq_topic/2852488814854211',
	],
	docx: ['https://scys.com/view/docx/QSn2dD6QnoYlDxxiYItcudnPnZg'],
	course: ['https://scys.com/course/detail/172?chapterId=11408'],
};

interface CandidateScore {
	selector: string;
	matches: number;
	firstBlocks: number;
	firstTextLen: number;
}

async function exploreUrl(url: string, candidates: string[]): Promise<CandidateScore[]> {
	console.log(`\n--- fetching ${url}`);
	let hydratedHtml: string;
	let markdown: string;
	try {
		const r = await runRealClip(url, { userDataDir: SCYS_PROFILE });
		hydratedHtml = r.hydratedHtml;
		markdown = r.markdown;
	} catch (e: any) {
		console.error(`  ERROR runRealClip: ${e.message}`);
		return [];
	}
	console.log(`  hydratedHtml=${hydratedHtml.length}B  markdown=${markdown.length}B`);
	// Dump hydratedHtml + markdown for offline grep
	if (!existsSync(DUMP_DIR)) mkdirSync(DUMP_DIR, { recursive: true });
	const slug = url.replace(/[^a-z0-9]+/gi, '-').slice(0, 80);
	writeFileSync(join(DUMP_DIR, `${slug}.html`), hydratedHtml);
	writeFileSync(join(DUMP_DIR, `${slug}.md`), markdown);
	console.log(`  dumped: ${DUMP_DIR}/${slug}.{html,md}`);
	if (markdown.length < 200) {
		console.warn(`  WARNING markdown < 200B — possible paywall / cookie failure for ${url}`);
	}
	const normalized = hydratedHtml.replace(/<br\s*\/?\s*>/gi, '\n');
	const { document } = parseHTML(normalized);
	const scores: CandidateScore[] = [];
	for (const sel of candidates) {
		try {
			const matches = document.querySelectorAll(sel);
			if (matches.length === 0) {
				scores.push({ selector: sel, matches: 0, firstBlocks: 0, firstTextLen: 0 });
				continue;
			}
			const first = matches[0];
			const blocks = first.querySelectorAll(BLOCK_SELECTORS);
			const textLen = (first.textContent || '').length;
			scores.push({ selector: sel, matches: matches.length, firstBlocks: blocks.length, firstTextLen: textLen });
		} catch (e: any) {
			scores.push({ selector: sel, matches: -1, firstBlocks: 0, firstTextLen: 0 });
		}
	}
	scores.sort((a, b) => b.firstBlocks - a.firstBlocks || b.firstTextLen - a.firstTextLen);
	for (const s of scores) {
		const tag = s.firstBlocks > 0 ? '  ' : 'X ';
		console.log(`  ${tag}${s.selector.padEnd(40)}  matches=${s.matches}  blocks=${s.firstBlocks}  text=${s.firstTextLen}`);
	}
	return scores;
}

function pickCommonWinner(perUrl: CandidateScore[][]): string | null {
	const counts = new Map<string, { hits: number; totalBlocks: number; totalText: number }>();
	for (const url of perUrl) {
		for (const s of url) {
			if (s.firstBlocks < 5) continue;
			const cur = counts.get(s.selector) || { hits: 0, totalBlocks: 0, totalText: 0 };
			cur.hits += 1;
			cur.totalBlocks += s.firstBlocks;
			cur.totalText += s.firstTextLen;
			counts.set(s.selector, cur);
		}
	}
	const sorted = [...counts.entries()]
		.filter(([, c]) => c.hits === perUrl.length)
		.sort((a, b) => b[1].totalBlocks - a[1].totalBlocks);
	return sorted.length > 0 ? sorted[0][0] : null;
}

async function main() {
	for (const [pageType, urls] of Object.entries(URLS)) {
		console.log(`\n========================================`);
		console.log(`PAGE TYPE: ${pageType}  (${urls.length} URL${urls.length > 1 ? 's' : ''})`);
		console.log(`========================================`);
		const candidates = CANDIDATES[pageType as keyof typeof CANDIDATES];
		const perUrl: CandidateScore[][] = [];
		for (const url of urls) {
			perUrl.push(await exploreUrl(url, candidates));
		}
		const winner = pickCommonWinner(perUrl);
		console.log(`\n>>> RECOMMENDED rootSelector for ${pageType}: ${winner ?? '(no common winner — manual review needed)'}`);
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
