import { convertDate } from './date-utils';

/**
 * Extract WeChat MP article publish time from raw HTML.
 *
 * mp.weixin.qq.com pages render <em id="publish_time"> as empty and
 * populate it via JS after load. The authoritative source is the inline
 * script variable `ct` (create time, Unix seconds). We parse it directly
 * from raw HTML for resilience to extractor-vs-JS race conditions.
 */
export function extractWeChatPublishedFromRawHtml(rawHtml: string): string {
	const m = rawHtml.match(/\bct\s*=\s*["'](\d+)["']/);
	if (!m) return '';
	const seconds = parseInt(m[1], 10);
	if (!Number.isFinite(seconds)) return '';
	const date = new Date(seconds * 1000);
	if (Number.isNaN(date.getTime())) return '';
	return convertDate(date);
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
