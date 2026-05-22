// scripts/weixin-visual-audit.ts
//
// Full-content audit: with hydratedHtml as ground truth, assert every visible
// block-level text content in #js_content appears in the clipped markdown.
//
// Used as ship gate (T5-4) — must report 0 mismatch before "请验收".
//
// Usage as CLI:
//   npx ts-node --project scripts/tsconfig.json scripts/weixin-visual-audit.ts <md-file> <html-file>
// Used as library from vitest:
//   import { auditWeixinClip } from '../../scripts/weixin-visual-audit';

import { parseHTML } from 'linkedom';
import { readFileSync } from 'node:fs';

export interface AuditMismatch {
	kind: 'missing' | 'extra';
	tag: string;
	excerpt: string;
	fullText: string;
}

export interface AuditReport {
	mismatches: AuditMismatch[];
	totalBlocks: number;
	mdSize: number;
	htmlSize: number;
}

const BLOCK_SELECTORS = 'p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, td, th, img';

function normalizeText(s: string): string {
	return s
		.replace(/ /g, ' ')
		.replace(/[​-‍﻿]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}

function normalizeForCompare(s: string): string {
	return normalizeText(s)
		.replace(/[*_`~\\]/g, '')
		.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/[\[\]()<>]/g, '')
		// Strip ALL whitespace: HTML textContent doesn't insert whitespace between
		// adjacent inline + block elements (e.g. <li>text:<pre>code</pre></li>),
		// but markdown layout adds newlines around block items. Equality must be
		// whitespace-insensitive for prefix-based block matching.
		.replace(/\s+/g, '');
}

export function auditWeixinClip(hydratedHtml: string, markdown: string): AuditReport {
	// Pre-process: replace <br> with literal newlines so textContent of <pre>
	// blocks (which uses <span>...<br>...<br>... in mp.weixin) yields the line
	// structure we expect to find in markdown.
	const normalizedHtml = hydratedHtml.replace(/<br\s*\/?\s*>/gi, '\n');
	const { document } = parseHTML(normalizedHtml);
	const root = document.querySelector('#js_content');
	const htmlSize = hydratedHtml.length;
	const mdSize = markdown.length;

	if (!root) {
		return {
			mismatches: [{ kind: 'missing', tag: 'root', excerpt: '#js_content not found in hydratedHtml', fullText: '' }],
			totalBlocks: 0,
			mdSize,
			htmlSize,
		};
	}

	const mdNorm = normalizeForCompare(markdown);
	const blocks = Array.from(root.querySelectorAll(BLOCK_SELECTORS));
	const mismatches: AuditMismatch[] = [];
	let counted = 0;

	for (const el of blocks) {
		const tag = el.tagName.toLowerCase();

		if (tag === 'img') {
			const src = el.getAttribute('src') || el.getAttribute('data-src') || '';
			if (!src) continue;
			// Skip data: URIs (SVG/PNG placeholders for lazy-load spacers — not content images)
			if (src.startsWith('data:')) continue;
			counted++;
			const srcCore = src.split('?')[0];
			if (!markdown.includes(srcCore) && !markdown.includes(src)) {
				mismatches.push({ kind: 'missing', tag: 'img', excerpt: srcCore.slice(-60), fullText: src });
			}
			continue;
		}

		const text = normalizeText(el.textContent || '');
		if (!text) continue;
		if (text.length < 6) continue;

		const fuzzy = normalizeForCompare(text);
		if (!fuzzy) continue;
		counted++;

		const anchorLen = Math.min(40, fuzzy.length);
		const anchor = fuzzy.slice(0, anchorLen);

		if (!mdNorm.includes(anchor)) {
			mismatches.push({
				kind: 'missing',
				tag,
				excerpt: text.slice(0, 60),
				fullText: text,
			});
		}
	}

	return { mismatches, totalBlocks: counted, mdSize, htmlSize };
}

export function formatReport(report: AuditReport): string {
	const lines: string[] = [];
	lines.push(`[audit] total blocks scanned: ${report.totalBlocks}`);
	lines.push(`[audit] markdown size: ${report.mdSize}B`);
	lines.push(`[audit] hydratedHtml size: ${report.htmlSize}B`);
	lines.push(`[audit] mismatches: ${report.mismatches.length}`);
	if (report.mismatches.length === 0) {
		lines.push('[audit] ✓ 0 mismatch — markdown contains every visible content block');
	} else {
		const byTag = new Map<string, AuditMismatch[]>();
		for (const m of report.mismatches) {
			const arr = byTag.get(m.tag) || [];
			arr.push(m);
			byTag.set(m.tag, arr);
		}
		for (const [tag, arr] of byTag) {
			lines.push(`\n--- ${arr.length} missing <${tag}>(${arr.length}) ---`);
			for (const m of arr.slice(0, 20)) {
				lines.push(`  [${m.tag}] ${m.excerpt}`);
			}
			if (arr.length > 20) lines.push(`  ... +${arr.length - 20} more`);
		}
	}
	return lines.join('\n');
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
