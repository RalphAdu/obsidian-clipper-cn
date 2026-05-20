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
 * Extract WeChat MP article publish time from raw HTML.
 *
 * mp.weixin.qq.com pages render <em id="publish_time"> as empty and
 * populate it via JS after load. The authoritative source is the inline
 * script variable `ct` (create time, Unix seconds). We parse it directly
 * from raw HTML for resilience to extractor-vs-JS race conditions.
 */
export function extractWeChatPublishedFromRawHtml(rawHtml: string): string {
	const m = rawHtml.match(CT_REGEX);
	if (!m) return '';
	return ctSecondsToDate(parseInt(m[1], 10));
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
