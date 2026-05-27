import { convertDate } from './date-utils';

const CT_REGEX = /\bct\s*=\s*["'](\d+)["']/;
const CHINESE_DATE_REGEX = /(\d{4})年(\d{1,2})月(\d{1,2})日/;

function ctSecondsToDate(seconds: number): string {
	if (!Number.isFinite(seconds)) return '';
	const date = new Date(seconds * 1000);
	if (Number.isNaN(date.getTime())) return '';
	return convertDate(date);
}

function parseChineseDate(text: string): string {
	const m = text.match(CHINESE_DATE_REGEX);
	if (!m) return '';
	const y = m[1];
	const mo = m[2].padStart(2, '0');
	const d = m[3].padStart(2, '0');
	return `${y}-${mo}-${d}`;
}

/**
 * Extract WeChat MP article publish time from the live DOM.
 *
 * Resolution order, settling on the first non-empty result:
 *   1. `#publish_time` element's textContent — mp.weixin's own JS populates
 *      it after page load with the user-visible date like "2026年4月14日
 *      00:30". This is the canonical browser-runtime source.
 *   2. Walk every <script> node's textContent for `ct = "<unix>"`. This is
 *      a fallback for cases where #publish_time hasn't yet been populated
 *      (e.g. very-fast scripted clip) and the original server-side inline
 *      ct script is still around.
 *
 * Both paths read DOM directly — does NOT depend on
 * documentElement.outerHTML serialization, which empirically drops inline
 * <script> bodies in browser runtime even though the nodes are live in
 * the DOM. Returns '' if neither source resolves.
 */
export function extractWeChatPublishedFromDocument(doc: ParentNode): string {
	const publishTimeEl = doc.querySelector('#publish_time');
	if (publishTimeEl) {
		const text = ((publishTimeEl as any).textContent || '').trim();
		const fromDom = parseChineseDate(text);
		if (fromDom) return fromDom;
	}
	const scripts = doc.querySelectorAll('script');
	for (let i = 0; i < scripts.length; i++) {
		const text = (scripts[i] as any).textContent || '';
		const m = text.match(CT_REGEX);
		if (m) {
			const result = ctSecondsToDate(parseInt(m[1], 10));
			if (result) return result;
		}
	}
	return '';
}

/**
 * Normalize <pre> subtrees so Turndown emits a clean fenced code block.
 *
 * mdnice-style WeChat editors render multi-line code blocks as
 * <pre><code><span>line</span><span><br/></span>…</code></pre>. Turndown
 * preserves the inner HTML of <pre><code> verbatim, so:
 *  - <br> survives and is dropped during markdown serialization, collapsing
 *    everything onto one line; AND
 *  - <span> tags leak literally into the markdown output.
 *
 * To fix both: replace each <br> with '\n', then flatten the <pre> (or its
 * <code> child) to a single text node holding the now-newline-bearing text.
 */
export function normalizePreBlockLineBreaks(root: ParentNode): void {
	const pres = root.querySelectorAll('pre');
	pres.forEach(pre => {
		const ownerDoc = pre.ownerDocument;
		if (!ownerDoc) return;
		// Step 1: <br> → '\n'.
		pre.querySelectorAll('br').forEach(br => {
			br.replaceWith(ownerDoc.createTextNode('\n'));
		});
		// Step 2: collapse to plain text, preserving <code> wrapper if present.
		// NBSP (&nbsp; →  ) is also normalized to ASCII space because
		// markdown fenced code blocks do not decode HTML entities; leaving
		// NBSP would emit literal `&#160;` in Obsidian's rendered view.
		const text = (pre.textContent ?? '').replace(/ /g, ' ');
		const code = pre.querySelector('code');
		if (code) {
			while (code.firstChild) code.removeChild(code.firstChild);
			code.appendChild(ownerDoc.createTextNode(text));
			// Drop any non-code children (whitespace, attributes-bearing siblings).
			Array.from(pre.childNodes).forEach(node => {
				if (node !== code) pre.removeChild(node);
			});
		} else {
			while (pre.firstChild) pre.removeChild(pre.firstChild);
			pre.appendChild(ownerDoc.createTextNode(text));
		}
	});
}

/**
 * Strip <a href="javascript:..."> elements down to their inner text.
 * mdnice editor uses these as in-page anchors (e.g.
 * `<a href="javascript:;">公众号监控脚本</a>`); turndown otherwise emits
 * `[公众号监控脚本](javascript:;)` which is useless in markdown.
 */
export function normalizeMdniceJavascriptLinks(root: ParentNode): void {
	const anchors = root.querySelectorAll('a[href^="javascript:"]');
	anchors.forEach(a => {
		const ownerDoc = a.ownerDocument;
		if (!ownerDoc) return;
		a.replaceWith(ownerDoc.createTextNode(a.textContent || ''));
	});
}

// ============================================================
// mdnice template normalizers — shared utilities
// ============================================================

/**
 * Test if an element's inline style attribute matches all given regex
 * patterns. Forward-declared utility — not used in Task 2's normalizers
 * (they inline their own regex checks), but used by Tasks 4-6's
 * chapterHeadings / subHeadings / codeBlocks helpers, which all need
 * to combine multiple style signature tests.
 */
function styleMatchesAll(el: Element, patterns: RegExp[]): boolean {
	const style = el.getAttribute('style') || '';
	return patterns.every(p => p.test(style));
}

/**
 * Walk every descendant of root and call fn. We use a snapshot array so
 * fn is free to mutate the DOM (replaceWith / remove) without breaking
 * the live NodeList iteration.
 */
function forEachDescendant(root: ParentNode, fn: (el: Element) => void): void {
	const arr: Element[] = [];
	const walker = (node: ParentNode) => {
		for (const child of Array.from(node.children || [])) {
			arr.push(child as Element);
			walker(child as ParentNode);
		}
	};
	walker(root);
	arr.forEach(fn);
}

/**
 * Remove two mdnice "section card" decorations:
 *
 *   1. Reading Time meta card at article top — `<section>` with
 *      `padding: 10px 12px` + `background-color: rgb(244, 244, 240)`.
 *      Contains author badge + reading time, pure decoration.
 *
 *   2. Column-divider anchor — `<section>` whose textContent is an
 *      all-uppercase identifier (WECHAT_MONITOR / EXPORT_AND_SKILL),
 *      rendered as small letter-spaced purple text. Used as a visual
 *      section divider in mdnice; markdown gets H1 from the chapter
 *      heading right below it, so the anchor is redundant.
 */
export function normalizeMdniceSectionCards(root: ParentNode): void {
	forEachDescendant(root, el => {
		if (el.tagName !== 'SECTION') return;
		const style = el.getAttribute('style') || '';
		const text = (el.textContent || '').trim();

		// Pattern 1: Reading Time meta card.
		const isMetaCard =
			/padding:\s*10px\s*12px/.test(style) &&
			/background-color:\s*rgb\(\s*244,\s*244,\s*240\s*\)/.test(style) &&
			/Reading Time/i.test(text);
		// Plain mp.weixin articles do not wrap regular paragraph text inside
		// dedicated <section> elements, so a short all-uppercase identifier as
		// the sole content of one is a strong mdnice-anchor signal — even short
		// codes like NOTE/FAQ/TIP would almost never appear isolated in a
		// <section>. False-positive risk is low.
		// Pattern 2: column anchor (all-uppercase identifier, short).
		const isColumnAnchor =
			text.length > 0 && text.length < 40 && /^[A-Z][A-Z0-9_]+$/.test(text);

		if (isMetaCard || isColumnAnchor) {
			el.remove();
		}
	});
}

/**
 * Promote mdnice "small heading" <p> elements (letter-spaced uppercase
 * purple text — used as section labels like "流程闭环" / "Sources") to
 * <h3>. Signature is all 5 inline-style properties matching simultaneously,
 * which is highly specific to mdnice's template; ordinary paragraphs do
 * not carry this combination.
 */
export function normalizeMdniceSmallHeadings(root: ParentNode): void {
	const ps = root.querySelectorAll('p');
	ps.forEach(p => {
		const style = p.getAttribute('style') || '';
		const matches =
			/font-size:\s*(?:9|10|11|12)px/.test(style) &&
			/letter-spacing:\s*[23]px/.test(style) &&
			/text-transform:\s*uppercase/.test(style) &&
			/color:\s*#ab59ff/i.test(style) &&
			/font-weight:\s*(?:700|800|900|bold)/.test(style);
		if (!matches) return;
		const ownerDoc = p.ownerDocument;
		if (!ownerDoc) return;
		const h3 = ownerDoc.createElement('h3');
		h3.textContent = (p.textContent || '').trim();
		p.replaceWith(h3);
	});
}

/**
 * Wrap mdnice "inline emphasis" spans in <strong>. mdnice uses
 * `<span style="display:inline; color:#ab59ff; font-weight:600">...</span>`
 * to emphasize phrases (e.g. "标题、封面、发布时间、原文链接。"). turndown
 * has no rule for inline-CSS-encoded bold, so without this normalizer the
 * emphasis is silently lost in markdown.
 *
 * Constraints to avoid false positives:
 *   - Must be `display: inline` in inline style.
 *   - font-weight ≥ 600 (covers 600/700/800/900/bold/bolder).
 *   - textContent length ≥ 2 (single chars are usually decoration glyphs).
 *   - Not inside a heading element (heading already conveys emphasis).
 */
export function normalizeMdniceInlineBold(root: ParentNode): void {
	const spans = root.querySelectorAll('span');
	spans.forEach(span => {
		const style = span.getAttribute('style') || '';
		if (!/display\s*:\s*inline\b/.test(style)) return;
		if (!/font-weight\s*:\s*(?:600|700|800|900|bold|bolder)\b/.test(style)) return;
		const text = (span.textContent || '').trim();
		if (text.length < 2) return;
		// Walk ancestors to check for heading containment.
		let cur: Element | null = span.parentElement;
		while (cur) {
			const t = cur.tagName;
			if (t === 'H1' || t === 'H2' || t === 'H3' || t === 'H4' || t === 'H5' || t === 'H6') return;
			cur = cur.parentElement;
		}
		const ownerDoc = span.ownerDocument;
		if (!ownerDoc) return;
		const strong = ownerDoc.createElement('strong');
		strong.textContent = text;
		span.replaceWith(strong);
	});
}

/**
 * Remove duplicate image captions emitted by mdnice. Pattern:
 *
 *   <img alt="信息过滤" src="…">
 *   <section>信息过滤</section>   ← duplicate caption
 *
 * Without this normalizer the markdown becomes:
 *
 *   ![信息过滤](url)
 *   信息过滤
 *
 * with caption repeated twice (alt + standalone paragraph). After
 * normalization only `![信息过滤](url)` remains; markdown alt already
 * conveys the caption semantically.
 */
export function normalizeMdniceImageCaptions(root: ParentNode): void {
	const imgs = root.querySelectorAll('img');
	imgs.forEach(img => {
		const alt = (img.getAttribute('alt') || '').trim();
		if (!alt) return;
		// Walk forward over whitespace-only text nodes to find the next element.
		let next: Node | null = img.nextSibling;
		while (next && next.nodeType === 3 /* text */) {
			if ((next.textContent || '').trim() !== '') return;
			next = next.nextSibling;
		}
		if (!next || next.nodeType !== 1) return;
		const el = next as Element;
		if (el.tagName !== 'SECTION' && el.tagName !== 'P') return;
		const captionText = (el.textContent || '').trim();
		if (captionText !== alt) return;
		el.remove();
	});
}
