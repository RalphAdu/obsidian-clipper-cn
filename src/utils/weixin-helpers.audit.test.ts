// @vitest-environment happy-dom
//
// Turndown (used inside defuddle/full → createMarkdownContent) needs document
// and DOMParser globals. In the default node vitest env it silently fails with
// "Partial conversion completed with errors. Original HTML: ..." which leaks
// raw HTML and makes audit assertions look like they passed when they did
// not. happy-dom provides a real browser-like env so this audit truly mirrors
// the extension runtime.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseHTML } from 'linkedom';
import { createMarkdownContent } from 'defuddle/full';
import { postProcessExtractorMarkdown } from './markdown-post-process';
import { extractWeChatPublishedFromRawHtml, normalizePreBlockLineBreaks } from './weixin-helpers';

// End-to-end audit: feed real-world mp.weixin.qq.com HTML through the same
// transformation pipeline content.ts uses (extractWeChatArticleContent →
// createMarkdownContent), then assert the resulting markdown matches the
// web-page rendering for the two bugs we fixed:
//   1. frontmatter published populated from `ct` Unix seconds
//   2. <pre><code> blocks remain multi-line (not collapsed to one line)
//
// Uses /tmp/wx-article.html if present (4MB real fetch), otherwise falls back
// to the committed minimal fixture.

const REAL_PATH = '/tmp/wx-article.html';
const FIXTURE_PATH = join(__dirname, 'fixtures', 'weixin-SPLTD-hFAsyYAA7V1lU8OA.html');

function loadHtml(): { html: string; source: 'real' | 'fixture' } {
	try {
		return { html: readFileSync(REAL_PATH, 'utf-8'), source: 'real' };
	} catch {
		return { html: readFileSync(FIXTURE_PATH, 'utf-8'), source: 'fixture' };
	}
}

// Mirror content.ts:extractWeChatArticleContent — extract #js_content,
// strip script/style, normalize <pre><br> → '\n'.
function simulateExtract(rawHtml: string): string | null {
	const { document } = parseHTML(rawHtml);
	const article = document.querySelector('#js_content');
	if (!article) return null;
	const articleClone = article.cloneNode(true) as Element;
	articleClone.querySelectorAll('script, style').forEach(el => el.remove());
	normalizePreBlockLineBreaks(articleClone);
	return (articleClone as any).outerHTML;
}

// Mirror content.ts cleanedHtml computation (line 322-363) — parse the full
// page, strip <script>/<style>/style attrs, return outerHTML.  This is what
// content.ts actually passes as published-extraction input today; the test
// proves that this path LOSES the ct field because the strip-script step
// happens BEFORE published extraction.
function simulateContentTsCleanedHtml(rawHtml: string): string {
	const { document } = parseHTML(rawHtml);
	document.querySelectorAll('script, style').forEach(el => el.remove());
	document.querySelectorAll('*').forEach((el: any) => el.removeAttribute('style'));
	return document.documentElement.outerHTML;
}

describe.concurrent('REPORT — evidence dump for ship acceptance', () => {
	const { html } = loadHtml();
	const articleHtml = simulateExtract(html)!;
	const markdown = postProcessExtractorMarkdown(createMarkdownContent(articleHtml, 'https://mp.weixin.qq.com/s/SPLTD-hFAsyYAA7V1lU8OA'));

	it('bug 1 evidence — published value comparison (old vs new path)', () => {
		const cleanedHtml = simulateContentTsCleanedHtml(html);
		const oldPath = extractWeChatPublishedFromRawHtml(cleanedHtml); // pre-fix
		const newPath = extractWeChatPublishedFromRawHtml(html);        // post-fix
		console.log('\n=== BUG 1 (published) evidence ===');
		console.log(`  cleanedHtml path (pre-fix) → published = ${JSON.stringify(oldPath)}  ← was wiped because <script> stripped`);
		console.log(`  raw doc path     (post-fix) → published = ${JSON.stringify(newPath)}`);
		expect(oldPath).toBe('');
		expect(newPath).toBe('2026-04-14');
	});

	it('bug 2 evidence — PARA + dashboard markdown literal', () => {
		const paraStart = markdown.indexOf('Vault/');
		const paraEnd = markdown.indexOf('4-Archives/', paraStart) + '4-Archives/'.length;
		// Find the fence wrapping the PARA section (walk back to last ``` line).
		const paraFenceStart = markdown.lastIndexOf('\n```', paraStart);
		const paraFenceEnd = markdown.indexOf('\n```', paraEnd);
		const paraBlock = markdown.slice(paraFenceStart + 1, paraFenceEnd + 4);
		console.log('\n=== BUG 2 (PARA block) evidence — literal markdown emitted ===');
		console.log(paraBlock);

		const dashIdx = markdown.indexOf('## 最近修改的笔记');
		// The dashboard is wrapped in a single OUTER fence ` ```` ` (4 backticks)
		// because it contains inner ```dataview``` literals. Walk back to find it.
		const outerFenceStart = markdown.lastIndexOf('\n````', dashIdx);
		const outerFenceEnd = markdown.indexOf('\n````', dashIdx);
		const dashBlock = markdown.slice(outerFenceStart + 1, outerFenceEnd + 5);
		console.log('\n=== BUG 2 (dashboard block w/ inner ```dataview``` literals) evidence — literal markdown emitted ===');
		console.log(dashBlock);

		// Hard assertions
		expect(paraBlock).toMatch(/^```\n/);            // PARA uses 3-backtick fence
		expect(paraBlock).toMatch(/├── 1-Projects\//);  // multi-line preserved
		expect(dashBlock).toMatch(/^````/);             // dashboard outer fence ≥4 backticks
		expect(dashBlock).toMatch(/```dataview/);       // inner ```dataview``` literal preserved
		expect(dashBlock).not.toMatch(/\\`/);           // no backslash-escape
	});
});

describe('weixin audit — mp.weixin.qq.com/s/SPLTD-hFAsyYAA7V1lU8OA', () => {
	const { html, source } = loadHtml();
	const articleHtml = simulateExtract(html);
	const markdown = articleHtml
		? postProcessExtractorMarkdown(createMarkdownContent(articleHtml, 'https://mp.weixin.qq.com/s/SPLTD-hFAsyYAA7V1lU8OA'))
		: '';

	it('publish time resolves to 2026-04-14 from raw HTML (with script tags)', () => {
		console.log(`[audit] HTML source: ${source} (${html.length} bytes)`);
		expect(extractWeChatPublishedFromRawHtml(html)).toBe('2026-04-14');
	});

	it('publish time CANNOT be extracted from cleanedHtml (content.ts strips <script> before — regression sentinel)', () => {
		// Reproduces the bug: content.ts feeds cleanedHtml (post strip-script)
		// to extractWeChatPublishedFromRawHtml; ct lives in a <script> so it's
		// gone by then. Required fix: feed raw document.documentElement.outerHTML
		// instead.
		const cleaned = simulateContentTsCleanedHtml(html);
		expect(cleaned).not.toContain('ct = "');
		expect(extractWeChatPublishedFromRawHtml(cleaned)).toBe('');
	});

	it('PARA directory tree renders as multi-line code block in markdown', () => {
		expect(articleHtml).not.toBeNull();
		expect(markdown.length).toBeGreaterThan(0);

		// Locate the PARA section anchor.
		const paraIdx = markdown.indexOf('Vault/');
		expect(paraIdx).toBeGreaterThan(-1);

		// Look at the markdown window starting at Vault/ — extract the lines
		// up to and including 4-Archives/, which is the last entry.
		const tail = markdown.slice(paraIdx);
		const endIdx = tail.indexOf('4-Archives/');
		expect(endIdx).toBeGreaterThan(-1);
		const block = tail.slice(0, endIdx + '4-Archives/'.length);

		// Must contain genuine newlines (not literal '<br>' or one-liner blob).
		expect(block).not.toContain('<br');
		const blockLines = block.split('\n').filter(s => s.trim().length > 0);
		// 11 entries: Vault, 4 top folders, 6 subfolders.
		expect(blockLines.length).toBeGreaterThanOrEqual(11);

		// Each top-level PARA folder must appear on its own line.
		for (const entry of ['Vault/', '1-Projects/', '2-Areas/', '3-Resources/', '4-Archives/']) {
			const re = new RegExp(`^[^\\n]*${entry.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s*$`, 'm');
			expect(block).toMatch(re);
		}

		console.log('[audit] PARA markdown block:\n' + block);
	});

	it('every <pre> block emits as a clean fenced code block (no <span> leak, no \\` backslash escape)', () => {
		// Whole-document scan — catches any pre block where Turndown emits
		// backslash-escaped backticks (\\`\\`\\`) or leaked <span> tags.
		// Required for backtick-bearing content (e.g. dataview ```dataview).
		expect(markdown).not.toMatch(/<span/);
		expect(markdown).not.toMatch(/\\`/);

		// The "dashboard" pre block in this article embeds three inner
		// ```dataview``` fences as literal markdown. Verify the outer fence
		// is lengthened to at least 4 backticks so the inner triple-backticks
		// render verbatim in Obsidian.
		const dashIdx = markdown.indexOf('## 最近修改的笔记');
		expect(dashIdx).toBeGreaterThan(-1);
		const dashBlockStart = markdown.lastIndexOf('````', dashIdx);
		expect(dashBlockStart).toBeGreaterThan(-1);
		// Inner dataview fences appear verbatim with 3 backticks.
		const between = markdown.slice(dashBlockStart, dashIdx);
		expect(between).toMatch(/```dataview/);
	});
});
