import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseHTML } from 'linkedom';
import { extractWeChatPublishedFromDocument, normalizePreBlockLineBreaks, normalizeMdniceJavascriptLinks, normalizeMdniceSectionCards, normalizeMdniceSmallHeadings, normalizeMdniceInlineBold, normalizeMdniceImageCaptions } from './weixin-helpers';

const fixturePath = join(__dirname, 'fixtures', 'weixin-SPLTD-hFAsyYAA7V1lU8OA.html');
const fixtureHtml = readFileSync(fixturePath, 'utf-8');

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

describe('normalizeMdniceJavascriptLinks', () => {
	it('replaces <a href="javascript:;"> with its text content', () => {
		const { document: doc } = parseHTML(
			'<html><body><p>before <a href="javascript:;">公众号监控脚本</a> after</p></body></html>'
		);
		normalizeMdniceJavascriptLinks(doc);
		expect(doc.body.innerHTML).toBe('<p>before 公众号监控脚本 after</p>');
	});

	it('also matches javascript:void(0) and other javascript: hrefs', () => {
		const { document: doc } = parseHTML(
			'<html><body><a href="javascript:void(0)">x</a></body></html>'
		);
		normalizeMdniceJavascriptLinks(doc);
		expect(doc.body.innerHTML).toBe('x');
	});

	it('does not touch normal http(s) links', () => {
		const { document: doc } = parseHTML(
			'<html><body><a href="https://example.com">link</a></body></html>'
		);
		normalizeMdniceJavascriptLinks(doc);
		expect(doc.querySelector('a')).not.toBeNull();
		expect(doc.querySelector('a')!.getAttribute('href')).toBe('https://example.com');
	});
});

describe('normalizeMdniceSectionCards', () => {
	it('removes Reading Time meta card at article top', () => {
		const { document: doc } = parseHTML(`
      <html><body>
        <section style="padding: 10px 12px; background-color: rgb(244, 244, 240); text-align: center;">
          <span><span>干货分享</span></span>
          <span>Reading Time</span><span>5 MINS</span>
        </section>
        <p>正文开始</p>
      </body></html>
    `);
		normalizeMdniceSectionCards(doc);
		expect(doc.querySelectorAll('section').length).toBe(0);
		expect(doc.body.textContent).not.toContain('Reading Time');
		expect(doc.body.textContent).toContain('正文开始');
	});

	it('removes uppercase anchor section (WECHAT_MONITOR / EXPORT_AND_SKILL pattern)', () => {
		const { document: doc } = parseHTML(`
      <html><body>
        <section>
          <span style="background-color:#ab59ff"></span>
          <span style="font-size:9px;letter-spacing:4px;text-transform:uppercase;color:#ab59ff">WECHAT_MONITOR</span>
        </section>
        <p>下一段</p>
      </body></html>
    `);
		normalizeMdniceSectionCards(doc);
		expect(doc.querySelectorAll('section').length).toBe(0);
		expect(doc.body.textContent).not.toContain('WECHAT_MONITOR');
	});

	it('does not touch normal sections without mdnice signatures', () => {
		const { document: doc } = parseHTML(`
      <html><body>
        <section><p>普通段落 in section</p></section>
      </body></html>
    `);
		normalizeMdniceSectionCards(doc);
		expect(doc.querySelectorAll('section').length).toBe(1);
	});
});

describe('normalizeMdniceSmallHeadings', () => {
	it('promotes mdnice small heading <p> to <h3>', () => {
		const { document: doc } = parseHTML(`
      <html><body>
        <p style="font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#ab59ff;font-weight:700">流程闭环</p>
        <p style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#ab59ff;font-weight:700">Sources</p>
      </body></html>
    `);
		normalizeMdniceSmallHeadings(doc);
		const h3s = Array.from(doc.querySelectorAll('h3')).map(h => h.textContent);
		expect(h3s).toEqual(['流程闭环', 'Sources']);
		expect(doc.querySelectorAll('p').length).toBe(0);
	});

	it('does not touch ordinary <p> elements', () => {
		const { document: doc } = parseHTML(
			'<html><body><p style="font-size:16px;color:#1b1c1a">正文段落</p></body></html>'
		);
		normalizeMdniceSmallHeadings(doc);
		expect(doc.querySelectorAll('h3').length).toBe(0);
		expect(doc.querySelectorAll('p').length).toBe(1);
	});

	it('requires all 5 signature properties (font-size + letter-spacing + uppercase + purple + bold)', () => {
		const { document: doc } = parseHTML(
			'<html><body><p style="font-size:10px;letter-spacing:3px;text-transform:uppercase;font-weight:700">noColor</p></body></html>'
		);
		normalizeMdniceSmallHeadings(doc);
		expect(doc.querySelectorAll('h3').length).toBe(0);
	});
});

describe('normalizeMdniceInlineBold', () => {
	it('wraps inline span with font-weight:600 in <strong>', () => {
		const { document: doc } = parseHTML(`
			<html><body>
				<p>普通文字 <span style="display:inline;color:#ab59ff;font-weight:600">重点强调</span> 又普通</p>
			</body></html>
		`);
		normalizeMdniceInlineBold(doc);
		expect(doc.querySelector('strong')?.textContent).toBe('重点强调');
	});

	it('also matches font-weight:bold / 700+', () => {
		const { document: doc } = parseHTML(
			'<html><body><span style="display:inline;font-weight:700">bold</span></body></html>'
		);
		normalizeMdniceInlineBold(doc);
		expect(doc.querySelector('strong')?.textContent).toBe('bold');
	});

	it('does not wrap spans inside <h1>/<h2>/<h3>', () => {
		const { document: doc } = parseHTML(
			'<html><body><h1><span style="display:inline;font-weight:600">in heading</span></h1></body></html>'
		);
		normalizeMdniceInlineBold(doc);
		expect(doc.querySelector('strong')).toBeNull();
	});

	it('does not touch spans without display:inline or with weight < 600', () => {
		const { document: doc } = parseHTML(
			'<html><body><span style="font-weight:500">light</span><span style="display:block;font-weight:700">block</span></body></html>'
		);
		normalizeMdniceInlineBold(doc);
		expect(doc.querySelector('strong')).toBeNull();
	});

	it('skips empty or single-char spans (likely decorations)', () => {
		const { document: doc } = parseHTML(
			'<html><body><span style="display:inline;font-weight:600">x</span></body></html>'
		);
		normalizeMdniceInlineBold(doc);
		expect(doc.querySelector('strong')).toBeNull();
	});
});

describe('normalizeMdniceImageCaptions', () => {
	it('removes <section> caption that equals <img alt> exactly', () => {
		const { document: doc } = parseHTML(`
			<html><body>
				<img alt="信息过滤" src="https://example.com/x.png">
				<section>信息过滤</section>
			</body></html>
		`);
		normalizeMdniceImageCaptions(doc);
		expect(doc.querySelector('section')).toBeNull();
		expect(doc.querySelector('img')?.getAttribute('alt')).toBe('信息过滤');
	});

	it('removes <p> caption that equals alt with surrounding whitespace', () => {
		const { document: doc } = parseHTML(`
			<html><body>
				<img alt="信息卡片" src="https://example.com/y.png">
				<p>  信息卡片  </p>
			</body></html>
		`);
		normalizeMdniceImageCaptions(doc);
		expect(doc.querySelector('p')).toBeNull();
	});

	it('does NOT remove caption when text differs from alt', () => {
		const { document: doc } = parseHTML(`
			<html><body>
				<img alt="cover" src="https://example.com/z.png">
				<p>different caption</p>
			</body></html>
		`);
		normalizeMdniceImageCaptions(doc);
		expect(doc.querySelector('p')).not.toBeNull();
	});

	it('does NOT remove anything when alt is empty', () => {
		const { document: doc } = parseHTML(`
			<html><body>
				<img alt="" src="https://example.com/z.png">
				<p></p>
			</body></html>
		`);
		normalizeMdniceImageCaptions(doc);
		expect(doc.querySelectorAll('p').length).toBe(1);
	});

	it('skips text nodes between img and caption', () => {
		const { document: doc } = parseHTML(`
			<html><body>
				<img alt="测试" src="https://example.com/a.png">
				<section>测试</section>
			</body></html>
		`);
		normalizeMdniceImageCaptions(doc);
		expect(doc.querySelector('section')).toBeNull();
	});
});
