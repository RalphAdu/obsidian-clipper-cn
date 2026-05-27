import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseHTML } from 'linkedom';
import { extractWeChatPublishedFromDocument, normalizePreBlockLineBreaks, normalizeMdniceJavascriptLinks, normalizeMdniceSectionCards, normalizeMdniceSmallHeadings, normalizeMdniceInlineBold, normalizeMdniceImageCaptions, normalizeMdniceChapterHeadings, normalizeMdniceSubHeadings, normalizeMdniceCodeBlocks, normalizeMdniceFootnotes, normalizeMdniceArticle } from './weixin-helpers';

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

	it('removes caption that is sibling of img ancestor (mdnice wraps img in <section>)', () => {
		// Real mdnice DOM: <section><img alt="X"></section><p>X</p>
		// Caption is NOT a sibling of <img>; it's a sibling of <img>'s parent.
		const { document: doc } = parseHTML(`
			<html><body>
				<section style="border-radius:18px;background-color:rgb(223,233,244);">
					<img alt="信息过滤" src="https://example.com/x.png">
				</section>
				<p>信息过滤</p>
				<p>后续段落</p>
			</body></html>
		`);
		normalizeMdniceImageCaptions(doc);
		const ps = Array.from(doc.querySelectorAll('p')).map(p => (p.textContent || '').trim());
		expect(ps).toEqual(['后续段落']);
	});

	it('walks up multiple ancestor levels to find caption sibling', () => {
		// <section><section><img alt="X"></section></section><p>X</p>
		const { document: doc } = parseHTML(`
			<html><body>
				<section>
					<section>
						<img alt="深层" src="https://example.com/y.png">
					</section>
				</section>
				<p>深层</p>
			</body></html>
		`);
		normalizeMdniceImageCaptions(doc);
		expect(doc.querySelector('p')).toBeNull();
	});
});

describe('normalizeMdniceChapterHeadings', () => {
	it('converts mdnice chapter heading section to <h1> + <p><em> subtitle', () => {
		const { document: doc } = parseHTML(`
			<html><body>
				<section>
					<section style="font-size:0;line-height:0;white-space:nowrap;">
						<span style="font-size:120px;color:rgba(236,223,252,0.008);"><span leaf="">壹</span></span>
						<span style="display:inline-block;">
							<section style="font-size:26px;font-weight:700;color:#1b1c1a"><span leaf="">先采集</span></section>
							<section style="font-size:17px;font-style:italic;color:rgba(27,28,26,0.40)"><span leaf="">Inbox First</span></section>
						</span>
					</section>
				</section>
			</body></html>
		`);
		normalizeMdniceChapterHeadings(doc);
		expect(doc.querySelector('h1')?.textContent).toBe('先采集');
		expect(doc.querySelector('em')?.textContent).toBe('Inbox First');
		expect(doc.body.textContent).not.toContain('壹');
	});

	it('emits only <h1> when subtitle section missing', () => {
		const { document: doc } = parseHTML(`
			<html><body>
				<section>
					<section style="font-size:0;">
						<span style="font-size:120px;color:rgba(236,223,252,0.008);"><span leaf="">贰</span></span>
						<span><section style="font-size:26px;font-weight:700"><span leaf="">怎么搭的</span></section></span>
					</section>
				</section>
			</body></html>
		`);
		normalizeMdniceChapterHeadings(doc);
		expect(doc.querySelector('h1')?.textContent).toBe('怎么搭的');
		expect(doc.querySelector('em')).toBeNull();
	});

	it('does not touch non-mdnice section without 120px decoration char', () => {
		const { document: doc } = parseHTML(`
			<html><body>
				<section>
					<p>普通段落</p>
					<p>另一个</p>
				</section>
			</body></html>
		`);
		normalizeMdniceChapterHeadings(doc);
		expect(doc.querySelector('h1')).toBeNull();
	});

	it('handles nested chapter sections — processes innermost, not outer wrapper', () => {
		const { document: doc } = parseHTML(`
			<html><body>
				<section>
					<section>
						<section style="font-size:0;">
							<span style="font-size:120px;color:rgba(236,223,252,0.008);"><span leaf="">壹</span></span>
							<span><section style="font-size:26px;font-weight:700"><span leaf="">先采集</span></section></span>
						</section>
					</section>
				</section>
			</body></html>
		`);
		normalizeMdniceChapterHeadings(doc);
		expect(doc.querySelectorAll('h1').length).toBe(1);
		expect(doc.querySelector('h1')?.textContent).toBe('先采集');
	});
});

describe('normalizeMdniceSubHeadings', () => {
	it('converts mdnice sub-heading section to <h2> + <p><em> Node_ID', () => {
		const { document: doc } = parseHTML(`
			<html><body>
				<section>
					<section style="font-size:0;white-space:nowrap;">
						<span style="display:inline-block;width:12px;margin-right:12px;">
							<span style="background-color:#caa1ff;width:3px;"><span leaf="">&nbsp;</span></span>
							<span style="background-color:#ab59ff;width:3px;"><span leaf="">&nbsp;</span></span>
						</span>
						<span style="display:inline-block;">
							<section style="font-size:24px;font-weight:700;color:#1b1c1a"><span leaf="">监听更新</span></section>
							<section style="font-size:10px;letter-spacing:3px;text-transform:uppercase;color:rgba(171,89,255,0.72)"><span leaf="">Node_ID: trigger</span></section>
						</span>
					</section>
				</section>
			</body></html>
		`);
		normalizeMdniceSubHeadings(doc);
		expect(doc.querySelector('h2')?.textContent).toBe('监听更新');
		expect(doc.querySelector('em')?.textContent).toBe('Node_ID: trigger');
	});

	it('emits only <h2> when subtitle missing', () => {
		const { document: doc } = parseHTML(`
			<html><body>
				<section>
					<span><span style="background-color:#ab59ff;width:3px;"><span leaf="">&nbsp;</span></span></span>
					<span><section style="font-size:24px;font-weight:700"><span leaf="">后筛选</span></section></span>
				</section>
			</body></html>
		`);
		normalizeMdniceSubHeadings(doc);
		expect(doc.querySelector('h2')?.textContent).toBe('后筛选');
		expect(doc.querySelector('em')).toBeNull();
	});

	it('does NOT touch chapter heading (font-size:26px) — chapterHeadings handles those', () => {
		const { document: doc } = parseHTML(`
			<html><body>
				<section>
					<span><section style="font-size:26px;font-weight:700"><span leaf="">先采集</span></section></span>
				</section>
			</body></html>
		`);
		normalizeMdniceSubHeadings(doc);
		expect(doc.querySelector('h2')).toBeNull();
	});

	it('handles nested sub-heading sections — processes innermost, not outer wrapper', () => {
		const { document: doc } = parseHTML(`
			<html><body>
				<section>
					<section>
						<section>
							<span><span style="background-color:#ab59ff;width:3px;"><span leaf="">&nbsp;</span></span></span>
							<span><section style="font-size:24px;font-weight:700"><span leaf="">监听更新</span></section></span>
						</section>
					</section>
				</section>
			</body></html>
		`);
		normalizeMdniceSubHeadings(doc);
		expect(doc.querySelectorAll('h2').length).toBe(1);
		expect(doc.querySelector('h2')?.textContent).toBe('监听更新');
	});
});

describe('normalizeMdniceCodeBlocks', () => {
	it('converts mdnice terminal-style pseudo code block to <pre><code class="language-text">', () => {
		const { document: doc } = parseHTML(`
			<html><body>
				<section>
					<section style="padding:20px 0 24px;">
						<span style="display:inline-block;font-size:10px;letter-spacing:1.2px;text-transform:uppercase;color:#ab59ff;font-weight:700"><span leaf="">terminal</span></span>
						<span style="display:inline-block;font-size:10px;letter-spacing:1.2px;text-transform:uppercase;color:#ab59ff;font-weight:700"><span leaf="">TEXT</span></span>
						<section><span leaf="">1. 首先登录平台</span></section>
						<section><span leaf="">2. 然后获取对应的 API 密钥</span></section>
						<section><span leaf="">3. 把密钥交给 HermesAgent</span></section>
					</section>
				</section>
			</body></html>
		`);
		normalizeMdniceCodeBlocks(doc);
		const pre = doc.querySelector('pre');
		expect(pre).not.toBeNull();
		const code = pre!.querySelector('code');
		expect(code?.getAttribute('class')).toBe('language-text');
		expect(code?.textContent).toBe('1. 首先登录平台\n2. 然后获取对应的 API 密钥\n3. 把密钥交给 HermesAgent');
	});

	it('uses lang badge when it is a recognizable language (e.g. python, javascript)', () => {
		const { document: doc } = parseHTML(`
			<html><body>
				<section>
					<section>
						<span style="font-size:10px;letter-spacing:1.2px;text-transform:uppercase;color:#ab59ff;font-weight:700"><span leaf="">script.py</span></span>
						<span style="font-size:10px;letter-spacing:1.2px;text-transform:uppercase;color:#ab59ff;font-weight:700"><span leaf="">PYTHON</span></span>
						<section><span leaf="">print('hi')</span></section>
					</section>
				</section>
			</body></html>
		`);
		normalizeMdniceCodeBlocks(doc);
		expect(doc.querySelector('code')?.getAttribute('class')).toBe('language-python');
	});

	it('handles file-name lang badge (kebab-case dot ext like wechat-mp-monitor)', () => {
		const { document: doc } = parseHTML(`
			<html><body>
				<section>
					<section>
						<span style="font-size:10px;letter-spacing:1.2px;text-transform:uppercase;color:#ab59ff;font-weight:700"><span leaf="">wechat-mp-monitor</span></span>
						<span style="font-size:10px;letter-spacing:1.2px;text-transform:uppercase;color:#ab59ff;font-weight:700"><span leaf="">TEXT</span></span>
						<section><span leaf="">wechat-mp-monitor/</span></section>
						<section><span leaf="">├── SKILL.md</span></section>
					</section>
				</section>
			</body></html>
		`);
		normalizeMdniceCodeBlocks(doc);
		const code = doc.querySelector('code');
		expect(code?.getAttribute('class')).toBe('language-text');
		expect(code?.textContent).toContain('├── SKILL.md');
	});

	it('does NOT touch sections without lang badge', () => {
		const { document: doc } = parseHTML(`
			<html><body>
				<section>
					<p>just a paragraph in a section</p>
				</section>
			</body></html>
		`);
		normalizeMdniceCodeBlocks(doc);
		expect(doc.querySelector('pre')).toBeNull();
	});

	it('matches lang badge using rgba color (not just hex #ab59ff)', () => {
		const { document: doc } = parseHTML(`
			<html><body>
				<section>
					<section>
						<span style="font-size:10px;letter-spacing:1.2px;text-transform:uppercase;color:rgba(171,89,255,0.62);font-weight:700"><span leaf="">terminal</span></span>
						<span style="font-size:10px;letter-spacing:1.2px;text-transform:uppercase;color:rgba(171,89,255,0.62);font-weight:700"><span leaf="">TEXT</span></span>
						<section><span leaf="">line one</span></section>
					</section>
				</section>
			</body></html>
		`);
		normalizeMdniceCodeBlocks(doc);
		expect(doc.querySelector('code')?.getAttribute('class')).toBe('language-text');
	});
});

describe('normalizeMdniceFootnotes', () => {
	it('rewrites inline <sup>[N]</sup> markers to text "[^N]"', () => {
		const { document: doc } = parseHTML(`
			<html><body>
				<p>正文 <sup style="font-size:11px;color:#ab59ff;font-weight:700"><span leaf="">[1]</span></sup> 继续</p>
			</body></html>
		`);
		normalizeMdniceFootnotes(doc);
		expect(doc.body.textContent).toContain('[^1]');
		expect(doc.body.textContent).not.toContain('[1]');
		expect(doc.querySelector('sup')).toBeNull();
	});

	it('collects Sources block into footnote definitions appended at body end', () => {
		const { document: doc } = parseHTML(`
			<html><body>
				<p>正文 <sup><span leaf="">[1]</span></sup> 引用一</p>
				<p>正文 <sup><span leaf="">[2]</span></sup> 引用二</p>
				<p style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#ab59ff;font-weight:700"><span leaf="">Sources</span></p>
				<p>
					<span style="padding:0 6px;border-radius:6px"><span leaf="">[1]</span></span>
					<span leaf="">wechat-article-exporter</span>
				</p>
				<p>
					<span leaf="">https://github.com/wechat-article/wechat-article-exporter</span>
				</p>
				<p>
					<span style="padding:0 6px;border-radius:6px"><span leaf="">[2]</span></span>
					<span leaf="">wechat-article-exporter-api</span>
				</p>
				<p>
					<span leaf="">https://down.mptext.top/dashboard/api</span>
				</p>
			</body></html>
		`);
		normalizeMdniceFootnotes(doc);
		expect(doc.body.textContent).not.toContain('Sources');
		const badges = doc.querySelectorAll('span[style*="padding:0 6px"]');
		expect(badges.length).toBe(0);
		const fnDiv = doc.querySelector('div[data-mdnice-footnotes]');
		expect(fnDiv).not.toBeNull();
		const txt = fnDiv!.textContent || '';
		expect(txt).toContain('[^1]: wechat-article-exporter — https://github.com/wechat-article/wechat-article-exporter');
		expect(txt).toContain('[^2]: wechat-article-exporter-api — https://down.mptext.top/dashboard/api');
	});

	it('is a no-op when no <sup> and no Sources block', () => {
		const { document: doc } = parseHTML(
			'<html><body><p>normal paragraph</p></body></html>'
		);
		normalizeMdniceFootnotes(doc);
		expect(doc.body.innerHTML).toContain('<p>normal paragraph</p>');
		expect(doc.querySelector('div[data-mdnice-footnotes]')).toBeNull();
	});
});

describe('normalizeMdniceArticle (integration)', () => {
	it('runs all 9 sub-normalizers in the right order on the real fixture', () => {
		const fixturePath = join(__dirname, 'fixtures', 'weixin-mdnice-HCBkgfIZ.html');
		const html = readFileSync(fixturePath, 'utf-8');
		const { document: doc } = parseHTML(html);
		const root = doc.querySelector('#js_content');
		expect(root, 'fixture should contain #js_content').not.toBeNull();
		normalizeMdniceArticle(root!);

		expect(root!.querySelectorAll('h1').length).toBeGreaterThanOrEqual(2);
		expect(root!.querySelectorAll('h2').length).toBeGreaterThanOrEqual(5);
		expect(root!.querySelectorAll('h3').length).toBeGreaterThanOrEqual(1);
		expect(root!.querySelectorAll('pre code').length).toBeGreaterThanOrEqual(2);
		expect(root!.querySelectorAll('strong').length).toBeGreaterThanOrEqual(1);
		expect(root!.querySelector('div[data-mdnice-footnotes]')).not.toBeNull();
		expect(root!.querySelector('a[href^="javascript:"]')).toBeNull();
		expect((root!.textContent || '')).not.toContain('Reading Time');
		expect((root!.textContent || '')).not.toContain('WECHAT_MONITOR');
		expect((root!.textContent || '')).not.toContain('EXPORT_AND_SKILL');
	});
});
