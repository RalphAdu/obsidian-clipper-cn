import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseHTML } from 'linkedom';
import { createMarkdownContent } from 'defuddle/full';
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

describe('weixin audit — mp.weixin.qq.com/s/SPLTD-hFAsyYAA7V1lU8OA', () => {
	const { html, source } = loadHtml();
	const articleHtml = simulateExtract(html);
	const markdown = articleHtml
		? createMarkdownContent(articleHtml, 'https://mp.weixin.qq.com/s/SPLTD-hFAsyYAA7V1lU8OA')
		: '';

	it('publish time resolves to 2026-04-14 from ct field', () => {
		console.log(`[audit] HTML source: ${source} (${html.length} bytes)`);
		expect(extractWeChatPublishedFromRawHtml(html)).toBe('2026-04-14');
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
});
