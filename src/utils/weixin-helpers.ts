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
 * Normalize <br> elements inside <pre> subtrees by replacing each with
 * a '\n' text node.
 *
 * mdnice-style WeChat editors render multi-line code blocks as a chain of
 * <span>line</span><span><br/></span>; Turndown strips <br> inside fenced
 * code blocks, collapsing everything onto one line. Pre-emptively rewriting
 * <br> as newline text preserves the semantic line breaks downstream.
 */
export function normalizePreBlockLineBreaks(root: ParentNode): void {
	const brs = root.querySelectorAll('pre br');
	brs.forEach(br => {
		const ownerDoc = br.ownerDocument;
		if (!ownerDoc) return;
		br.replaceWith(ownerDoc.createTextNode('\n'));
	});
}
