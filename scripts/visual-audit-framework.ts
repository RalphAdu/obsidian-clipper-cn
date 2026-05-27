// scripts/visual-audit-framework.ts
//
// Generic visual audit: with hydratedHtml as ground truth, assert every
// visible block-level text content (and img src) inside `rootSelector`
// appears in the clipped markdown.
//
// Used as ship gate (T5-4) — must report 0 mismatch before "请验收".
//
// site-specific audit files (weixin-visual-audit.ts / scys-*-visual-audit.ts)
// import this and provide their own AuditConfig.

import { parseHTML } from 'linkedom';

export interface AuditMismatch {
	// 'extra' reserved for future detection of markdown content not in HTML
	// (currently runVisualAudit only emits 'missing')
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

export interface AuditConfig {
	/** hydratedHtml parse 后从这个 selector 开始扫；找不到 → 返回 1 mismatch (tag='root') */
	rootSelector: string;
	/** 要扫的 block-level selector，默认 ['p','h1','h2','h3','h4','h5','h6','li','blockquote','pre','td','th','img'] */
	blockSelectors?: string[];
	/** 文本规范化：默认 — 替 NBSP → ' '、剔零宽字符、合 whitespace + trim */
	normalizeText?: (s: string) => string;
	/** 比对规范化：默认 — normalizeText + 剥 markdown emphasis markers + 剥所有 whitespace */
	normalizeForCompare?: (s: string) => string;
	/** image src 是否需特殊处理（默认 split('?')[0] 出现在 markdown）— 返回 true 表示 PASS */
	imageAssert?: (src: string, markdown: string) => boolean;
	/** 文本断言：默认 — fuzzy 前 40 字符 substring 出现在 normalized markdown */
	textAssert?: (blockFuzzy: string, markdownFuzzy: string) => boolean;
}

const DEFAULT_BLOCK_SELECTORS = ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote', 'pre', 'td', 'th', 'img'];

export function defaultNormalizeText(s: string): string {
	return s
		.replace(/ /g, ' ')
		.replace(/[​-‍﻿]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}

export function defaultNormalizeForCompare(s: string): string {
	return defaultNormalizeText(s)
		.replace(/[*_`~\\]/g, '')
		.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/[\[\]()<>]/g, '')
		.replace(/\s+/g, '');
}

export function defaultImageAssert(src: string, markdown: string): boolean {
	// Guard for direct callers (tests / custom configs that compose this helper).
	// runVisualAudit pre-filters data: URIs before calling imageAssert, so this
	// branch is dead via the framework's normal path.
	if (src.startsWith('data:')) return true;
	const core = src.split('?')[0];
	return markdown.includes(core) || markdown.includes(src);
}

export function defaultTextAssert(blockFuzzy: string, mdFuzzy: string): boolean {
	const anchorLen = Math.min(40, blockFuzzy.length);
	const anchor = blockFuzzy.slice(0, anchorLen);
	return mdFuzzy.includes(anchor);
}

export function runVisualAudit(
	hydratedHtml: string,
	markdown: string,
	config: AuditConfig,
): AuditReport {
	const blockSelectors = config.blockSelectors ?? DEFAULT_BLOCK_SELECTORS;
	const normalizeText = config.normalizeText ?? defaultNormalizeText;
	const normalizeForCompare = config.normalizeForCompare ?? defaultNormalizeForCompare;
	const imageAssert = config.imageAssert ?? defaultImageAssert;
	const textAssert = config.textAssert ?? defaultTextAssert;

	const normalizedHtml = hydratedHtml.replace(/<br\s*\/?\s*>/gi, '\n');
	const { document } = parseHTML(normalizedHtml);
	const root = document.querySelector(config.rootSelector);
	const htmlSize = hydratedHtml.length;
	const mdSize = markdown.length;

	if (!root) {
		return {
			mismatches: [{ kind: 'missing', tag: 'root', excerpt: `${config.rootSelector} not found in hydratedHtml`, fullText: '' }],
			totalBlocks: 0,
			mdSize,
			htmlSize,
		};
	}

	const mdNorm = normalizeForCompare(markdown);
	const blocks = Array.from(root.querySelectorAll(blockSelectors.join(',')));
	const mismatches: AuditMismatch[] = [];
	let counted = 0;

	for (const el of blocks) {
		const tag = el.tagName.toLowerCase();

		if (tag === 'img') {
			const src = el.getAttribute('src') || el.getAttribute('data-src') || '';
			if (!src) continue;
			if (src.startsWith('data:')) continue;
			counted++;
			if (!imageAssert(src, markdown)) {
				const srcCore = src.split('?')[0];
				mismatches.push({ kind: 'missing', tag: 'img', excerpt: srcCore.slice(-60), fullText: src });
			}
			continue;
		}

		const text = normalizeText(el.textContent || '');
		if (!text) continue;
		// Skip ultra-short strings (single chars, short labels) that are usually UI
		// chrome or punctuation noise rather than article content. Threshold 6 inherited
		// from weixin-visual-audit.ts; tune per-site via custom textAssert override if
		// you need to audit shorter blocks.
		if (text.length < 6) continue;

		const fuzzy = normalizeForCompare(text);
		if (!fuzzy) continue;
		counted++;

		if (!textAssert(fuzzy, mdNorm)) {
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
			lines.push(`\n--- ${arr.length} missing <${tag}> ---`);
			for (const m of arr.slice(0, 20)) {
				lines.push(`  [${m.tag}] ${m.excerpt}`);
			}
			if (arr.length > 20) lines.push(`  ... +${arr.length - 20} more`);
		}
	}
	return lines.join('\n');
}
