import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseHTML } from 'linkedom';
import { extractWeChatPublishedFromDocument, extractWeChatPublishedFromRawHtml, normalizePreBlockLineBreaks } from './weixin-helpers';

const fixturePath = join(__dirname, 'fixtures', 'weixin-SPLTD-hFAsyYAA7V1lU8OA.html');
const fixtureHtml = readFileSync(fixturePath, 'utf-8');

describe('extractWeChatPublishedFromRawHtml', () => {
	it('extracts ct Unix seconds from fixture and formats as YYYY-MM-DD', () => {
		expect(extractWeChatPublishedFromRawHtml(fixtureHtml)).toBe('2026-04-14');
	});

	it('returns empty string when ct is absent', () => {
		expect(extractWeChatPublishedFromRawHtml('<html><body>no timestamp here</body></html>')).toBe('');
	});
});

describe('extractWeChatPublishedFromDocument', () => {
	it('reads #publish_time textContent (mp.weixin browser-runtime canonical source)', () => {
		const { document: doc } = parseHTML(fixtureHtml);
		expect(extractWeChatPublishedFromDocument(doc)).toBe('2026-04-14');
	});

	it('parses Chinese date format 2026年4月14日 from publish_time element', () => {
		const { document: doc } = parseHTML(
			'<html><body><em id="publish_time">2026年4月14日 00:30</em></body></html>'
		);
		expect(extractWeChatPublishedFromDocument(doc)).toBe('2026-04-14');
	});

	it('zero-pads single-digit month/day', () => {
		const { document: doc } = parseHTML(
			'<html><body><em id="publish_time">2026年4月7日</em></body></html>'
		);
		expect(extractWeChatPublishedFromDocument(doc)).toBe('2026-04-07');
	});

	it('falls back to ct in <script> when #publish_time is missing', () => {
		const { document: doc } = parseHTML(
			'<html><head><script>var ct = "1776097815";</script></head><body></body></html>'
		);
		expect(extractWeChatPublishedFromDocument(doc)).toBe('2026-04-14');
	});

	it('falls back to ct when #publish_time exists but has no Chinese date (e.g. empty pre-JS)', () => {
		const { document: doc } = parseHTML(
			'<html><body><em id="publish_time"></em><script>var ct = "1776097815";</script></body></html>'
		);
		expect(extractWeChatPublishedFromDocument(doc)).toBe('2026-04-14');
	});

	it('returns empty string when neither source resolves', () => {
		const { document: doc } = parseHTML(
			'<html><body><em id="publish_time">几小时前</em></body></html>'
		);
		expect(extractWeChatPublishedFromDocument(doc)).toBe('');
	});
});

describe('normalizePreBlockLineBreaks', () => {
	it('replaces <br/> inside <pre> with newline text nodes', () => {
		const { document: doc } = parseHTML(fixtureHtml);
		normalizePreBlockLineBreaks(doc);
		const pre = doc.querySelector('pre');
		expect(pre).not.toBeNull();
		// Normalize NBSP (  from &nbsp;) to ASCII space so the assertion
		// reads naturally. Real-world rendering keeps NBSP, which is fine.
		const text = pre!.textContent!.replace(/ /g, ' ');
		const lines = text.split('\n').map(s => s.trimEnd()).filter(s => s.length > 0);
		expect(lines).toEqual([
			'Vault/',
			'├── 1-Projects/',
			'│   ├── 公众号文章计划/',
			'│   └── 个人网站重构/',
			'├── 2-Areas/',
			'│   ├── 健康/',
			'│   └── 投资/',
			'├── 3-Resources/',
			'│   ├── 机器学习/',
			'│   └── 设计灵感/',
			'└── 4-Archives/',
		]);
	});

	it('does not touch <br/> outside <pre>', () => {
		const { document: doc } = parseHTML('<html><body><p>A<br/>B</p><pre><code>X<br/>Y</code></pre></body></html>');
		normalizePreBlockLineBreaks(doc);
		const p = doc.querySelector('p')!;
		expect(p.querySelectorAll('br').length).toBe(1);
		const pre = doc.querySelector('pre')!;
		expect(pre.querySelectorAll('br').length).toBe(0);
		expect(pre.textContent).toBe('X\nY');
	});
});
