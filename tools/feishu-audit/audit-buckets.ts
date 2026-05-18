import type { ExpectedUnit } from './expectations';

export interface Miss { unit: ExpectedUnit; reason: string }
export interface Bucket { name: string; misses: Miss[] }

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Normalize markdown for tolerant matching:
 *   - turndown escapes `[`, `]`, `.`, `*` etc with backslash; strip those
 *   - collapse runs of whitespace
 */
function normalize(md: string): string {
	return md.replace(/\\([\\[\].*+?^${}()|])/g, '$1');
}

function normalizeForMatch(s: string): string {
	return s.replace(/\s+/g, ' ').trim();
}

function checkH1Numbered(unit: Extract<ExpectedUnit, { kind: 'h1_numbered' }>, mdNorm: string): Miss | null {
	const re = new RegExp(`^#\\s+${unit.seq}\\.\\s+${escapeRegExp(unit.title)}\\s*$`, 'm');
	return re.test(mdNorm) ? null : { unit, reason: `expected line "# ${unit.seq}. ${unit.title}"` };
}

function checkMentionLink(unit: Extract<ExpectedUnit, { kind: 'mention_link' }>, mdNorm: string): Miss | null {
	const needle = `[${unit.title}](${unit.url})`;
	return mdNorm.includes(needle) ? null : { unit, reason: `missing markdown link [${unit.title}](${unit.url})` };
}

function checkIframeLink(unit: Extract<ExpectedUnit, { kind: 'iframe_link' }>, mdNorm: string): Miss | null {
	const re = new RegExp(`\\]\\(${escapeRegExp(unit.url)}\\)`);
	return re.test(mdNorm) ? null : { unit, reason: `missing iframe link to ${unit.url}` };
}

function checkSectionHeader(unit: Extract<ExpectedUnit, { kind: 'section_header_standalone' }>, mdNorm: string): Miss | null {
	const text = unit.text;
	const lines = mdNorm.split('\n');
	for (const line of lines) {
		if (line.includes(text)) {
			const trimmed = line.trim();
			const isListItem = /^[-*+]\s/.test(trimmed) || /^\d+\.\s/.test(trimmed);
			// Bold paragraph indicator: line starts with `**` or contains `**…**` wrap.
			if (!isListItem && trimmed.includes('**')) return null;
		}
	}
	return { unit, reason: `expected standalone bold paragraph "**${text}**", not inside any list item` };
}

function checkOlItem(unit: Extract<ExpectedUnit, { kind: 'ol_item' }>, mdNorm: string): Miss | null {
	const normalized = normalizeForMatch(unit.text);
	if (!normalized) return null; // empty OL items can't be asserted
	const fragment = normalized.slice(0, Math.min(20, normalized.length));
	const re = new RegExp(`^\\d+\\.\\s+.*${escapeRegExp(fragment)}.*$`, 'm');
	return re.test(mdNorm) ? null : { unit, reason: `expected ordered-list item containing "${normalized.slice(0, 30)}…"` };
}

function checkUlItem(unit: Extract<ExpectedUnit, { kind: 'ul_item' }>, mdNorm: string): Miss | null {
	const normalized = normalizeForMatch(unit.text);
	if (!normalized) return null;
	const fragment = normalized.slice(0, Math.min(20, normalized.length));
	const re = new RegExp(`^[-*+]\\s+.*${escapeRegExp(fragment)}.*$`, 'm');
	return re.test(mdNorm) ? null : { unit, reason: `expected bullet item containing "${normalized.slice(0, 30)}…"` };
}

function checkNoPlaceholder(md: string): Miss | null {
	// Use raw md (not normalized) — `[Embedded content: …]` literal must not appear
	if (/\[Embedded content: type \d+\]/.test(md)) {
		return { unit: { kind: 'no_placeholder' }, reason: 'placeholder "[Embedded content: type N]" still present' };
	}
	return null;
}

function checkCommentsSection(unit: Extract<ExpectedUnit, { kind: 'comments_section_present' }>, md: string): Miss | null {
	// Comments markdown bypasses turndown — check the literal pattern
	return /---\s*\n+\s*##\s+评论/.test(md) ? null : { unit, reason: 'missing "## 评论" section anchor' };
}

function checkCommentThread(unit: Extract<ExpectedUnit, { kind: 'comment_thread' }>, md: string): Miss | null {
	const kind = unit.isSolved ? 'success' : 'quote';
	const calloutLine = `> [!${kind}]+ ${unit.authorTag} · ${unit.timestamp}`;
	if (!md.includes(calloutLine)) {
		return { unit, reason: `expected callout header "${calloutLine}"` };
	}
	if (unit.firstReplyText && !md.includes(unit.firstReplyText.slice(0, Math.min(20, unit.firstReplyText.length)))) {
		return { unit, reason: `callout present but first-reply text not found` };
	}
	return null;
}

function checkCommentImage(_unit: Extract<ExpectedUnit, { kind: 'comment_image' }>, md: string): Miss | null {
	if (md.includes('data:image/') || md.includes('*[评论图片加载失败]*')) return null;
	return { unit: _unit, reason: `no embedded comment image (data URI or placeholder) found` };
}

function checkImageMimes(unit: Extract<ExpectedUnit, { kind: 'no_invalid_image_mime' }>, vaultMd: string): Miss | null {
	const matches = [...vaultMd.matchAll(/!\[[^\]]*\]\(data:([^;,)]+)[;,]/g)];
	const invalid = matches
		.map((m) => m[1])
		.filter((mime) => !mime.startsWith('image/'));
	if (invalid.length === 0) return null;
	const uniqueMimes = [...new Set(invalid)];
	return {
		unit,
		reason: `${invalid.length} image data URI(s) with non-image MIME: ${uniqueMimes.join(', ')}`,
	};
}

function checkFrontmatter(unit: Extract<ExpectedUnit, { kind: 'frontmatter_present' }>, vaultMd: string): Miss[] {
	const fmMatch = vaultMd.match(/^---\n([\s\S]*?)\n---/);
	if (!fmMatch) {
		return [{ unit, reason: 'missing frontmatter block' }];
	}
	const fm = fmMatch[1];
	const misses: Miss[] = [];
	if (!/^author:[^\S\n]*\S/m.test(fm)) misses.push({ unit, reason: 'frontmatter author is empty' });
	if (!/^published:[^\S\n]*\S/m.test(fm)) misses.push({ unit, reason: 'frontmatter published is empty' });
	return misses;
}

export function audit(expected: ExpectedUnit[], md: string, vaultMd?: string): Bucket[] {
	// Build a normalized md once for body-text checks.
	const mdNorm = normalize(md);

	const buckets: Record<string, Bucket> = {
		h1_numbering: { name: 'h1_numbering', misses: [] },
		mention_link: { name: 'mention_link', misses: [] },
		iframe_link: { name: 'iframe_link', misses: [] },
		section_header_misplaced: { name: 'section_header_misplaced', misses: [] },
		orderedlist_split: { name: 'orderedlist_split', misses: [] },
		bulletlist_split: { name: 'bulletlist_split', misses: [] },
		placeholder_residue: { name: 'placeholder_residue', misses: [] },
		comments_section: { name: 'comments_section', misses: [] },
		comment_thread: { name: 'comment_thread', misses: [] },
		comment_image: { name: 'comment_image', misses: [] },
		image_mime_invalid: { name: 'image_mime_invalid', misses: [] },
		frontmatter_field_empty: { name: 'frontmatter_field_empty', misses: [] },
	};

	for (const unit of expected) {
		let miss: Miss | null = null;
		switch (unit.kind) {
			case 'h1_numbered':
				miss = checkH1Numbered(unit, mdNorm);
				if (miss) buckets.h1_numbering.misses.push(miss);
				break;
			case 'mention_link':
				miss = checkMentionLink(unit, mdNorm);
				if (miss) buckets.mention_link.misses.push(miss);
				break;
			case 'iframe_link':
				miss = checkIframeLink(unit, mdNorm);
				if (miss) buckets.iframe_link.misses.push(miss);
				break;
			case 'section_header_standalone':
				miss = checkSectionHeader(unit, mdNorm);
				if (miss) buckets.section_header_misplaced.misses.push(miss);
				break;
			case 'ol_item':
				miss = checkOlItem(unit, mdNorm);
				if (miss) buckets.orderedlist_split.misses.push(miss);
				break;
			case 'ul_item':
				miss = checkUlItem(unit, mdNorm);
				if (miss) buckets.bulletlist_split.misses.push(miss);
				break;
			case 'no_placeholder':
				miss = checkNoPlaceholder(md);
				if (miss) buckets.placeholder_residue.misses.push(miss);
				break;
			case 'comments_section_present':
				miss = checkCommentsSection(unit, md);
				if (miss) buckets.comments_section.misses.push(miss);
				break;
			case 'comment_thread':
				miss = checkCommentThread(unit, md);
				if (miss) buckets.comment_thread.misses.push(miss);
				break;
			case 'comment_image':
				miss = checkCommentImage(unit, md);
				if (miss) buckets.comment_image.misses.push(miss);
				break;
			case 'no_invalid_image_mime':
				if (vaultMd) {
					miss = checkImageMimes(unit, vaultMd);
					if (miss) buckets.image_mime_invalid.misses.push(miss);
				}
				break;
			case 'frontmatter_present':
				if (vaultMd) {
					const fmMisses = checkFrontmatter(unit, vaultMd);
					buckets.frontmatter_field_empty.misses.push(...fmMisses);
				}
				break;
		}
	}

	return Object.values(buckets);
}

export function printReport(buckets: Bucket[]): void {
	for (const b of buckets) {
		const pad = b.name.padEnd(26);
		console.log(`[${pad}] ${b.misses.length} miss${b.misses.length === 1 ? '' : 'es'}`);
		for (const m of b.misses) {
			const where = 'blockId' in m.unit ? ` blockId=${m.unit.blockId}` : 'commentId' in m.unit ? ` commentId=${m.unit.commentId}` : '';
			console.log(`  -${where} — ${m.reason}`);
		}
	}
	const total = buckets.reduce((s, b) => s + b.misses.length, 0);
	console.log('');
	console.log(total === 0
		? `PASS — 0 misses across ${buckets.length} buckets`
		: `FAIL — ${total} misses across ${buckets.filter((b) => b.misses.length).length} buckets (of ${buckets.length})`);
}
