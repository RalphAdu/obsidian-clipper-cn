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
 * Convert mdnice "chapter heading" sections to <h1> + optional italic
 * subtitle <p><em>...</em></p>. The template encodes chapter title as:
 *
 *   <section>                             ← chapter container
 *     <span font-size:120px color:rgba(...0.008)>壹</span>   ← decoration
 *     <span>
 *       <section font-size:26px font-weight:700>先采集</section>
 *       <section font-size:17px font-style:italic>Inbox First</section>
 *     </span>
 *   </section>
 *
 * The decoration char (壹/贰/叁) is an enlarged ghost letter purely for
 * visual flair; markdown does not need it. We pivot off this decoration
 * span (font-size:120px + very-low-alpha color) as the unique signature.
 */
export function normalizeMdniceChapterHeadings(root: ParentNode): void {
	forEachDescendant(root, el => {
		if (el.tagName !== 'SECTION') return;
		const deco = el.querySelector('span[style*="font-size:120px"]');
		if (!deco) return;
		const decoStyle = deco.getAttribute('style') || '';
		if (!/color:\s*rgba\(\s*\d+,\s*\d+,\s*\d+,\s*0?\.0\d/.test(decoStyle)) return;
		// Inner-section guard: if a descendant <section> also has the 120px decoration,
		// defer to it (process inner-most first so we don't replace outer + leave inner
		// as detached subtree). Same pattern as normalizeMdniceCodeBlocks.
		const innerDeco = Array.from(el.querySelectorAll('section')).some(s => {
			if (s === el) return false;
			const d = (s as Element).querySelector('span[style*="font-size:120px"]');
			if (!d) return false;
			return /color:\s*rgba\(\s*\d+,\s*\d+,\s*\d+,\s*0?\.0\d/.test(d.getAttribute('style') || '');
		});
		if (innerDeco) return;
		const candidates = el.querySelectorAll('section');
		let title: Element | null = null;
		let subtitle: Element | null = null;
		for (const sec of Array.from(candidates)) {
			const style = (sec as Element).getAttribute('style') || '';
			if (!title && /font-size:\s*26px/.test(style) && /font-weight:\s*700/.test(style)) {
				title = sec as Element;
			} else if (!subtitle && /font-size:\s*17px/.test(style) && /font-style:\s*italic/.test(style)) {
				subtitle = sec as Element;
			}
		}
		if (!title) return;
		const ownerDoc = el.ownerDocument;
		if (!ownerDoc) return;
		const h1 = ownerDoc.createElement('h1');
		h1.textContent = (title.textContent || '').trim();
		const replacement = ownerDoc.createDocumentFragment();
		replacement.appendChild(h1);
		if (subtitle) {
			const p = ownerDoc.createElement('p');
			const em = ownerDoc.createElement('em');
			em.textContent = (subtitle.textContent || '').trim();
			p.appendChild(em);
			replacement.appendChild(p);
		}
		el.replaceWith(replacement);
	});
}

/**
 * Convert mdnice "sub-heading" sections to <h2> + optional <p><em>
 * subtitle ("Node_ID: trigger" style). Template:
 *
 *   <section>
 *     <span>...purple bar decorations (background-color:#ab59ff width:3px)...</span>
 *     <span>
 *       <section font-size:24px font-weight:700>监听更新</section>
 *       <section font-size:10px letter-spacing:3px uppercase color:rgba(171,89,255,*)>Node_ID: trigger</section>
 *     </span>
 *   </section>
 *
 * Pivot signature is the purple bar `background-color:#ab59ff` with
 * width≤3px decoration, paired with a 24px+700 sibling section.
 */
export function normalizeMdniceSubHeadings(root: ParentNode): void {
	forEachDescendant(root, el => {
		if (el.tagName !== 'SECTION') return;
		const bar = el.querySelector('span[style*="#ab59ff"], span[style*="#AB59FF"]');
		if (!bar) return;
		const barStyle = bar.getAttribute('style') || '';
		if (!/width:\s*[123]px/.test(barStyle)) return;
		// Inner-section guard: defer to nested sub-heading section.
		const innerBar = Array.from(el.querySelectorAll('section')).some(s => {
			if (s === el) return false;
			return Array.from((s as Element).querySelectorAll('span')).some(b => {
				const bs = (b as Element).getAttribute('style') || '';
				return /#ab59ff/i.test(bs) && /width:\s*[123]px/.test(bs);
			});
		});
		if (innerBar) return;
		const sections = el.querySelectorAll('section');
		let title: Element | null = null;
		let subtitle: Element | null = null;
		for (const sec of Array.from(sections)) {
			const style = (sec as Element).getAttribute('style') || '';
			if (!title && /font-size:\s*24px/.test(style) && /font-weight:\s*700/.test(style)) {
				title = sec as Element;
			} else if (!subtitle && /font-size:\s*10px/.test(style) && /letter-spacing:\s*3px/.test(style)) {
				subtitle = sec as Element;
			}
		}
		if (!title) return;
		const ownerDoc = el.ownerDocument;
		if (!ownerDoc) return;
		const h2 = ownerDoc.createElement('h2');
		h2.textContent = (title.textContent || '').trim();
		const replacement = ownerDoc.createDocumentFragment();
		replacement.appendChild(h2);
		if (subtitle) {
			const p = ownerDoc.createElement('p');
			const em = ownerDoc.createElement('em');
			em.textContent = (subtitle.textContent || '').trim();
			p.appendChild(em);
			replacement.appendChild(p);
		}
		el.replaceWith(replacement);
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
		// The caption can be either an immediate sibling of <img>, or a sibling
		// of an ancestor — mdnice often wraps <img> in a styled <section>, and
		// places the caption <p> as the next sibling of THAT wrapper. Walk up
		// at most 4 levels; at each level check the next element sibling.
		let cur: Element | null = img;
		for (let depth = 0; depth < 4 && cur; depth++) {
			// Skip whitespace-only text nodes at this level.
			let next: Node | null = cur.nextSibling;
			while (next && next.nodeType === 3 /* text */ && (next.textContent || '').trim() === '') {
				next = next.nextSibling;
			}
			if (next && next.nodeType === 1) {
				const el = next as Element;
				if ((el.tagName === 'SECTION' || el.tagName === 'P') &&
					(el.textContent || '').trim() === alt) {
					el.remove();
					return;
				}
			}
			cur = cur.parentElement;
		}
	});
}

// Lang badges that look like an explicit code language (case-insensitive).
const KNOWN_LANGS = new Set([
	'bash', 'shell', 'sh', 'zsh',
	'js', 'javascript', 'ts', 'typescript', 'json',
	'python', 'py',
	'go', 'rust', 'java', 'kotlin',
	'html', 'css', 'xml', 'yaml', 'yml', 'toml',
	'sql', 'c', 'cpp', 'csharp',
	'php', 'ruby', 'swift',
	'markdown', 'md',
]);

/**
 * Match mdnice's "lang badge" span: small uppercase letter-spaced purple
 * text inside the code-block header. We use these tight constraints
 * (font-size:10px + letter-spacing:1.2px + uppercase + #ab59ff +
 * font-weight≥700) because the same purple appears throughout mdnice
 * decoration and we must not catch non-code badges.
 */
function isMdniceLangBadge(el: Element): boolean {
	const style = el.getAttribute('style') || '';
	return (
		/font-size:\s*10px/.test(style) &&
		/letter-spacing:\s*1\.2px/.test(style) &&
		/text-transform:\s*uppercase/.test(style) &&
		/color:\s*(?:#ab59ff|rgba\(\s*171\s*,\s*89\s*,\s*255\s*,)/i.test(style) &&
		/font-weight:\s*(?:700|800|900|bold)/.test(style)
	);
}

/**
 * Convert mdnice "pseudo code block" containers into <pre><code>. The
 * template uses a header row of 1-2 purple uppercase badges (file name +
 * lang, or just lang) followed by per-line <section> elements rendered
 * in a monospace-ish look.
 *
 * Strategy:
 *   1. Find the deepest <section> that contains a lang badge but has no
 *      nested section also containing a lang badge — that's the code
 *      block container.
 *   2. Collect all lang badges; pick the last one's text as candidate
 *      lang. If it's in KNOWN_LANGS use it; otherwise fall back to "text".
 *   3. Collect all <section> children that are NOT badge containers and
 *      treat their textContent as one code line. Join with "\n".
 *   4. Replace the container with <pre><code class="language-X">…</code></pre>.
 */
export function normalizeMdniceCodeBlocks(root: ParentNode): void {
	const allSections = Array.from(root.querySelectorAll('section'));
	for (const sec of allSections) {
		const badges = Array.from(sec.querySelectorAll('span')).filter(s => isMdniceLangBadge(s as Element)) as Element[];
		if (badges.length === 0) continue;
		// Nested-section guard: skip if a descendant section also has a badge
		// (we'll process the inner one).
		const inner = Array.from(sec.querySelectorAll('section')).some(child => {
			if (child === sec) return false;
			return Array.from((child as Element).querySelectorAll('span')).some(s => isMdniceLangBadge(s as Element));
		});
		if (inner) continue;

		// lang detection: take last badge's text, lowercase.
		const langRaw = (badges[badges.length - 1].textContent || '').trim().toLowerCase();
		const lang = KNOWN_LANGS.has(langRaw) ? langRaw : 'text';

		// Collect code-line sections — direct or nested <section> children
		// whose textContent is NOT the badge label.
		const badgeTexts = new Set(badges.map(b => (b.textContent || '').trim()));
		const lineSections = Array.from(sec.querySelectorAll('section')).filter(s => {
			const t = ((s as Element).textContent || '').trim();
			if (!t) return false;
			if (badgeTexts.has(t)) return false;
			if (Array.from((s as Element).querySelectorAll('span')).some(x => isMdniceLangBadge(x as Element))) return false;
			return true;
		});
		// Deduplicate: a code line may appear in multiple `<section>` nestings
		// (mdnice often wraps each line in an extra `<section>`). Pick the
		// innermost — sections whose children include OTHER `<section>` are
		// wrappers, not leaf lines.
		const leafLines = lineSections.filter(s => {
			const childSecs = Array.from((s as Element).children).filter(c => (c as Element).tagName === 'SECTION');
			return childSecs.length === 0;
		});

		// Layout B fallback: mdnice may split the code block into a header
		// <section> (badges only) and a sibling body <section> (code lines only).
		// In that case leafLines is empty here and the code lines live in a
		// sibling section of `sec` inside `sec.parentElement`.
		let container: Element = sec as Element;
		let resolvedLeafLines = leafLines;
		if (leafLines.length === 0) {
			const parent = (sec as Element).parentElement;
			if (parent && parent.tagName === 'SECTION') {
				// Collect code lines from all sibling sections (not the badge section).
				const siblingLineSections = Array.from(parent.querySelectorAll('section')).filter(s => {
					// Must not be sec itself or a descendant of sec.
					if ((sec as Element).contains(s as Element)) return false;
					const t = ((s as Element).textContent || '').trim();
					if (!t) return false;
					if (badgeTexts.has(t)) return false;
					if (Array.from((s as Element).querySelectorAll('span')).some(x => isMdniceLangBadge(x as Element))) return false;
					return true;
				});
				const siblingLeafLines = siblingLineSections.filter(s => {
					const childSecs = Array.from((s as Element).children).filter(c => (c as Element).tagName === 'SECTION');
					return childSecs.length === 0;
				});
				if (siblingLeafLines.length > 0) {
					resolvedLeafLines = siblingLeafLines;
					container = parent;
				}
			}
		}

		if (resolvedLeafLines.length === 0) continue;
		const codeText = resolvedLeafLines.map(s => ((s as Element).textContent || '').trim()).join('\n');

		const ownerDoc = (container as Element).ownerDocument;
		if (!ownerDoc) continue;
		const pre = ownerDoc.createElement('pre');
		const code = ownerDoc.createElement('code');
		code.setAttribute('class', `language-${lang}`);
		code.textContent = codeText;
		pre.appendChild(code);
		container.replaceWith(pre);
	}
}

/**
 * Rewrite mdnice footnote markup so it survives turndown as standard
 * markdown footnotes (`[^N]` inline + `[^N]: …` definitions).
 *
 * Two stages:
 *
 *   Stage 1 — inline markers. `<sup>` elements containing text like
 *     "[N]" are replaced with a text node "[^N]". The brackets must
 *     pass through turndown unescaped; we rely on the upstream caller
 *     to NOT escape `[^…]` (turndown by default doesn't).
 *
 *   Stage 2 — Sources block. Locate a small-heading-style <p> whose
 *     text equals "Sources" (or its lowercase variant). After it,
 *     mdnice emits one <p> per footnote — first <p> has a rounded badge
 *     `[N]` span + title, next <p> has the URL. We pair them by [N]
 *     number and emit `[^N]: title — url` lines into a trailing
 *     `<div data-mdnice-footnotes>`.
 *
 * After this normalizer, turndown produces:
 *
 *     正文 [^1] 引用一
 *
 *     [^1]: wechat-article-exporter — https://github.com/.../exporter
 *
 * which Obsidian renders as a proper footnote with backlinks.
 */
export function normalizeMdniceFootnotes(root: ParentNode): void {
	const ownerDoc =
		(root as Element).ownerDocument ||
		((root as any).nodeType === 9 ? (root as Document) : null);
	if (!ownerDoc) return;

	// ---- Stage 1: <sup>[N]</sup> → text "[^N]" ----
	const sups = root.querySelectorAll('sup');
	sups.forEach(sup => {
		const text = (sup.textContent || '').trim();
		const m = text.match(/^\[(\d+)\]$/);
		if (!m) return;
		sup.replaceWith(ownerDoc.createTextNode(`[^${m[1]}]`));
	});

	// ---- Stage 2: locate Sources block + collect footnotes ----
	const allP = Array.from(root.querySelectorAll('p'));
	const sourcesIdx = allP.findIndex(p => {
		const style = p.getAttribute('style') || '';
		const text = (p.textContent || '').trim().toLowerCase();
		if (text !== 'sources') return false;
		return /font-size:\s*1[01]px/.test(style) && /color:\s*#ab59ff/i.test(style);
	});
	if (sourcesIdx < 0) return;

	type Foot = { num: string; title: string; url: string };
	const collected: Foot[] = [];
	let current: Partial<Foot> | null = null;
	for (let i = sourcesIdx + 1; i < allP.length; i++) {
		const p = allP[i];
		const style = p.getAttribute('style') || '';
		if (/text-transform:\s*uppercase/.test(style) && /letter-spacing/.test(style)) break;

		const badge = Array.from(p.querySelectorAll('span')).find(s => {
			const sStyle = (s as Element).getAttribute('style') || '';
			const sText = ((s as Element).textContent || '').trim();
			return /padding:\s*0\s*6px/.test(sStyle) && /^\[\d+\]$/.test(sText);
		}) as Element | undefined;

		if (badge) {
			if (current && current.num && current.title && current.url) {
				collected.push(current as Foot);
			}
			const num = (badge.textContent || '').trim().match(/\d+/)?.[0] || '';
			const fullText = (p.textContent || '').trim();
			const title = fullText.replace(/\[\d+\]/, '').trim();
			current = { num, title, url: '' };
		} else if (current) {
			const text = (p.textContent || '').trim();
			if (/^https?:\/\//i.test(text)) {
				current.url = text;
			}
		}
	}
	if (current && current.num && current.title && current.url) {
		collected.push(current as Foot);
	}
	if (collected.length === 0) return;

	const sourcesP = allP[sourcesIdx];
	sourcesP.remove();
	for (let i = sourcesIdx + 1; i < allP.length; i++) {
		const p = allP[i];
		const style = p.getAttribute('style') || '';
		if (/text-transform:\s*uppercase/.test(style) && /letter-spacing/.test(style)) break;
		const hasBadge = Array.from(p.querySelectorAll('span')).some(s => {
			const sStyle = (s as Element).getAttribute('style') || '';
			return /padding:\s*0\s*6px/.test(sStyle);
		});
		const text = (p.textContent || '').trim();
		const isUrl = /^https?:\/\//i.test(text);
		if (hasBadge || isUrl) p.remove();
	}

	const target =
		(root as any).body ||
		(root as Element).querySelector?.('body') ||
		root;
	const div = ownerDoc.createElement('div');
	div.setAttribute('data-mdnice-footnotes', 'true');
	for (const f of collected) {
		const p = ownerDoc.createElement('p');
		p.textContent = `[^${f.num}]: ${f.title} — ${f.url}`;
		div.appendChild(p);
	}
	(target as Element).appendChild(div);
}

/**
 * One-shot entry point that runs all mdnice sub-normalizers in
 * dependency order. Call this on a cloned article DOM before turndown.
 *
 * Order rationale:
 *   1. javascriptLinks — strip first, so code-block lang badges /
 *      heading subtitles don't contain dangling <a> elements.
 *   2. sectionCards — delete decoration cards (Reading Time meta +
 *      column anchors) so they don't pollute later heading detection.
 *   3. chapterHeadings, subHeadings — promote to <h1>/<h2>.
 *   4. footnotes — must run BEFORE smallHeadings, because it looks for
 *      a raw <p>Sources</p> small-heading <p> as anchor.
 *   5. smallHeadings — promote remaining small-heading <p>s to <h3>.
 *   6. codeBlocks — convert pseudo code-block sections to <pre><code>.
 *   7. imageCaptions — last image-related step, so DOM siblings of
 *      <img> are stable.
 *   8. inlineBold — last, so headings are already <h1>/<h2>/<h3> and
 *      we can correctly skip spans inside headings.
 */
export function normalizeMdniceArticle(root: ParentNode): void {
	normalizeMdniceJavascriptLinks(root);
	normalizeMdniceSectionCards(root);
	normalizeMdniceChapterHeadings(root);
	normalizeMdniceSubHeadings(root);
	normalizeMdniceFootnotes(root);
	normalizeMdniceSmallHeadings(root);
	normalizeMdniceCodeBlocks(root);
	normalizeMdniceImageCaptions(root);
	normalizeMdniceInlineBold(root);
}
