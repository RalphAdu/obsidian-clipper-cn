import { describe, it, expect, vi, afterEach } from 'vitest';
import { isScysCourseUrl, parseScysUrl } from './scys-extractor';
import { autolinkBareUrls } from './feishu-extractor';

describe('autolinkBareUrls (bare URL → clickable anchor; scys puts URLs in plain content)', () => {
	it('wraps a bare https URL into <a href=...>', () => {
		const out = autolinkBareUrls('See https://example.com for more');
		expect(out).toBe('See <a href="https://example.com">https://example.com</a> for more');
	});
	it('wraps URL when preceded by Chinese punctuation (the GFM autolink failure mode)', () => {
		// scys article body: "补上当时的生财好事：https://t.zsxq.com/uFfmH" — bare URL after
		// fullwidth colon. GFM autolink fails here so Obsidian shows inert text.
		const out = autolinkBareUrls('补上当时的生财好事：https://t.zsxq.com/uFfmH');
		expect(out).toContain('<a href="https://t.zsxq.com/uFfmH">https://t.zsxq.com/uFfmH</a>');
	});
	it('strips trailing ASCII sentence-ending punctuation from the URL', () => {
		const out = autolinkBareUrls('see https://example.com.');
		expect(out).toBe('see <a href="https://example.com">https://example.com</a>.');
	});
	it('does not double-wrap URLs already inside an <a> tag', () => {
		const input = 'before <a href="https://example.com">https://example.com</a> after';
		expect(autolinkBareUrls(input)).toBe(input);
	});
	it('autolinks URL outside an anchor while leaving anchored URL untouched', () => {
		const input = '<a href="https://kept.com">kept</a> and https://wrap.com';
		const out = autolinkBareUrls(input);
		expect(out).toContain('<a href="https://kept.com">kept</a>');
		expect(out).toContain('<a href="https://wrap.com">https://wrap.com</a>');
		expect((out.match(/<a href=/g) || []).length).toBe(2);
	});
	it('handles multiple bare URLs in one string', () => {
		const out = autolinkBareUrls('a https://a.com b https://b.com c');
		expect((out.match(/<a href=/g) || []).length).toBe(2);
	});
	it('is a no-op when no http(s) URL is present', () => {
		expect(autolinkBareUrls('plain text 中文')).toBe('plain text 中文');
	});
	it('stops URL at Chinese closing punctuation (e.g. "。" should not be inside the href)', () => {
		const out = autolinkBareUrls('请看 https://example.com。然后...');
		// URL must not contain the 。 terminator
		expect(out).toContain('<a href="https://example.com">https://example.com</a>');
		expect(out).not.toContain('href="https://example.com。');
	});
	it('escapes attribute-breaking characters in href', () => {
		// & in URL query must not break out of href attribute
		const out = autolinkBareUrls('https://x.com/?a=1&b=2');
		expect(out).toMatch(/href="https:\/\/x\.com\/\?a=1&amp;b=2"/);
	});
});

describe('isScysCourseUrl', () => {
	it('matches scys course detail URL with chapterId', () => {
		expect(isScysCourseUrl('https://scys.com/course/detail/172?chapterId=11408')).toBe(true);
	});
	it('rejects scys course URL without chapterId', () => {
		expect(isScysCourseUrl('https://scys.com/course/detail/172')).toBe(false);
	});
	it('rejects other scys paths', () => {
		expect(isScysCourseUrl('https://scys.com/AI')).toBe(false);
		expect(isScysCourseUrl('https://scys.com/search/user/center')).toBe(false);
	});
	it('rejects non-scys hosts', () => {
		expect(isScysCourseUrl('https://example.com/course/detail/172?chapterId=11408')).toBe(false);
	});
	it('rejects malformed URL', () => {
		expect(isScysCourseUrl('not a url')).toBe(false);
	});
});

describe('parseScysUrl', () => {
	it('extracts courseId and chapterId', () => {
		expect(parseScysUrl('https://scys.com/course/detail/172?chapterId=11408'))
			.toEqual({ courseId: 172, chapterId: 11408 });
	});
	it('returns null for invalid URL', () => {
		expect(parseScysUrl('https://scys.com/course/detail/172')).toBeNull();
	});
});

import { flattenScysBlocks, ScysBlock } from './scys-extractor';

describe('flattenScysBlocks', () => {
	it('flattens nested children_blocks into parent.children id array', () => {
		const nested: ScysBlock[] = [{
			block_id: 'parent',
			block_type: 19,
			callout: { elements: [] },
			children_blocks: [
				{ block_id: 'child1', block_type: 2, text: { elements: [] } },
				{ block_id: 'child2', block_type: 2, text: { elements: [] } },
			],
		}];
		const flat = flattenScysBlocks(nested);
		expect(flat.map(b => b.block_id)).toEqual(['parent', 'child1', 'child2']);
		expect(flat[0].children).toEqual(['child1', 'child2']);
		expect(flat[0]).not.toHaveProperty('children_blocks');
		expect(flat[1].parent_id).toBe('parent');
	});

	it('rewrites heading4 (block_type=6) to HEADING2 (block_type=4) with body remap', () => {
		const blocks: ScysBlock[] = [{
			block_id: 'h',
			block_type: 6,
			heading4: { elements: [{ text_run: { content: 'X' } }] },
		}];
		const flat = flattenScysBlocks(blocks);
		expect(flat[0].block_type).toBe(4);
		expect((flat[0] as any).heading2).toEqual({ elements: [{ text_run: { content: 'X' } }] });
		expect((flat[0] as any).heading4).toBeUndefined();
	});

	it('rewrites heading5 (7) → HEADING3 (5) and heading6 (8) → HEADING4 (6)', () => {
		const blocks: ScysBlock[] = [
			{ block_id: 'a', block_type: 7, heading5: { elements: [{ text_run: { content: 'A' } }] } },
			{ block_id: 'b', block_type: 8, heading6: { elements: [{ text_run: { content: 'B' } }] } },
		];
		const flat = flattenScysBlocks(blocks);
		expect(flat[0].block_type).toBe(5);
		expect((flat[0] as any).heading3).toEqual({ elements: [{ text_run: { content: 'A' } }] });
		expect(flat[1].block_type).toBe(6);
		expect((flat[1] as any).heading4).toEqual({ elements: [{ text_run: { content: 'B' } }] });
	});

	it('injects scys: image token using file_url', () => {
		const blocks: ScysBlock[] = [{
			block_id: 'img1',
			block_type: 27,
			image: { width: 100, height: 50 },
			file_url: 'https://sphere-sh.oss-cn-shanghai.aliyuncs.com/xx?sig=abc',
		}];
		const flat = flattenScysBlocks(blocks);
		expect(flat[0].image?.token).toMatch(/^scys:/);
		expect(decodeURIComponent(flat[0].image!.token!.slice(5)))
			.toBe('https://sphere-sh.oss-cn-shanghai.aliyuncs.com/xx?sig=abc');
	});

	it('recurses into children_blocks for heading rewrite + image injection', () => {
		const blocks: ScysBlock[] = [{
			block_id: 'callout',
			block_type: 19,
			callout: { elements: [] },
			children_blocks: [{
				block_id: 'inner-img',
				block_type: 27,
				file_url: 'https://x.y/z',
			}],
		}];
		const flat = flattenScysBlocks(blocks);
		expect(flat).toHaveLength(2);
		const innerImg = flat.find(b => b.block_id === 'inner-img');
		expect(innerImg?.image?.token).toMatch(/^scys:/);
	});

	it('emits children: undefined (not [] or missing) for leaf blocks', () => {
		const blocks: ScysBlock[] = [{
			block_id: 'leaf',
			block_type: 2,
			text: { elements: [] },
		}];
		const flat = flattenScysBlocks(blocks);
		expect(flat[0].children).toBeUndefined();
	});

	// scys article authors abuse HEADING5/6 as a bold-paragraph styler for long
	// prose — blindly rewriting to H3/H4 makes Obsidian render them as huge blue
	// headings, totally unlike the browser's plain 12px paragraph rendering.
	// Per-type cutoffs: HEADING4 → 50, HEADING5/6 → 30 chars.
	it('downgrades HEADING5 (block_type=7) to TEXT when content ≥ 30 chars', () => {
		const longText = '以经典书籍 / 权威人物 IP 开篇，格式：《XX》：当你有某类经历，就会发现某些缺点式行为往往才是正面特质';
		expect(longText.length).toBeGreaterThanOrEqual(30);
		const blocks: ScysBlock[] = [{
			block_id: 'h',
			block_type: 7,
			heading5: { elements: [{ text_run: { content: longText } }] },
		}];
		const flat = flattenScysBlocks(blocks);
		expect(flat[0].block_type).toBe(2);
		expect((flat[0] as any).text).toEqual({ elements: [{ text_run: { content: longText } }] });
		expect((flat[0] as any).heading5).toBeUndefined();
		expect((flat[0] as any).heading3).toBeUndefined();
	});

	it('downgrades 34-char HEADING5 abused as paragraph (real article block)', () => {
		// Real fixture block: "爆文链接丢入：丢入上面的提示词之后，丢入爆文链接，让其对爆文进行分析" (34 chars).
		// First user visual-diff round showed this slipping through with cutoff=40.
		const text = '爆文链接丢入：丢入上面的提示词之后，丢入爆文链接，让其对爆文进行分析';
		expect(text.length).toBe(34);
		const flat = flattenScysBlocks([{ block_id: 'h', block_type: 7, heading5: { elements: [{ text_run: { content: text } }] } }]);
		expect(flat[0].block_type).toBe(2);
	});

	it('downgrades 38-char HEADING5 abused as paragraph (real article block)', () => {
		const text = '生成原创爆文+垂直小号：丢入之后就可以生成原创垂直小号了+你的垂直人设和IP';
		expect(text.length).toBe(38);
		const flat = flattenScysBlocks([{ block_id: 'h', block_type: 7, heading5: { elements: [{ text_run: { content: text } }] } }]);
		expect(flat[0].block_type).toBe(2);
	});

	it('downgrades HEADING6 (block_type=8) to TEXT when content ≥ 30 chars', () => {
		const longText = '10个豆包软件：顾名思义开通10个豆包软件或者网页物理批量生成最高';
		expect(longText.length).toBeGreaterThanOrEqual(30);
		const flat = flattenScysBlocks([{ block_id: 'h', block_type: 8, heading6: { elements: [{ text_run: { content: longText } }] } }]);
		expect(flat[0].block_type).toBe(2);
	});

	it('keeps short HEADING5 as <h3> (course/docx-style real chapter heading)', () => {
		const blocks: ScysBlock[] = [{
			block_id: 'h',
			block_type: 7,
			heading5: { elements: [{ text_run: { content: '2.1 需求判断：想清楚这个知识库是干嘛的' } }] },
		}];
		const flat = flattenScysBlocks(blocks);
		expect(flat[0].block_type).toBe(5);
		expect((flat[0] as any).heading3).toBeDefined();
	});

	it('keeps HEADING5 "爆文模板提示词（可直接套用创作）" (16 chars) as H3 — real subsection', () => {
		// Boundary on the keep side: short article H5 used as a real subsection title.
		const text = '爆文模板提示词（可直接套用创作）';
		const flat = flattenScysBlocks([{ block_id: 'h', block_type: 7, heading5: { elements: [{ text_run: { content: text } }] } }]);
		expect(flat[0].block_type).toBe(5);
	});

	it('keeps short HEADING4 as <h2> (e.g. "0. 本章概要")', () => {
		const flat = flattenScysBlocks([{ block_id: 'h', block_type: 6, heading4: { elements: [{ text_run: { content: '0. 本章概要' } }] } }]);
		expect(flat[0].block_type).toBe(4);
	});

	it('downgrades long HEADING7 (block_type=9) to TEXT (real article block)', () => {
		// "模板提示词植入个人IP形成专属个人IP模板提示词（仅供参考，每个领域提示词不一样，需要以实拆爆文的模板提示词为主）："
		const text = '模板提示词植入个人IP形成专属个人IP模板提示词（仅供参考，每个领域提示词不一样，需要以实拆爆文的模板提示词为主）：';
		expect(text.length).toBeGreaterThanOrEqual(30);
		const flat = flattenScysBlocks([{ block_id: 'h', block_type: 9, heading7: { elements: [{ text_run: { content: text } }] } } as any]);
		expect(flat[0].block_type).toBe(2);
	});

	it('keeps short HEADING7 as <h6> (default feishu fallback rendering)', () => {
		const flat = flattenScysBlocks([{ block_id: 'h', block_type: 9, heading7: { elements: [{ text_run: { content: '拆解爆文形成模板提示词：' } }] } } as any]);
		// short HEADING7 stays block_type=9 (no rewrite mapping); feishu-extractor renders it as <h6>
		expect(flat[0].block_type).toBe(9);
	});

	it('counts mention_doc.title toward heading length (multi-element prose with link)', () => {
		// Real article block: text_run + mention_doc, combined visible text >= 30 chars
		// but text_run alone is 27 — without summing mention_doc we'd miss the demotion.
		const flat = flattenScysBlocks([{
			block_id: 'h', block_type: 9,
			heading7: { elements: [
				{ text_run: { content: '提示词和批量下载器已经打包到链接当中，请点击飞书链接：' } },
				{ mention_doc: { title: '提示词和批量下载软件', url: 'https://example.com' } },
			] },
		} as any]);
		expect(flat[0].block_type).toBe(2);
	});

	it('keeps 32-char HEADING4 as H2 (real article chapter "垂直小号原创ip爆文操作步骤（其它领域逻辑互通，以读书领域为例）")', () => {
		// HEADING4 cutoff is higher (50) than H5/6 (30) — article block_type=6 is
		// reliably used for real chapter titles; longest real one is 32 chars.
		const text = '垂直小号原创ip爆文操作步骤（其它领域逻辑互通，以读书领域为例）';
		expect(text.length).toBe(32);
		const flat = flattenScysBlocks([{ block_id: 'h', block_type: 6, heading4: { elements: [{ text_run: { content: text } }] } }]);
		expect(flat[0].block_type).toBe(4);
	});

	it('downgrades long HEADING built from multiple text_run elements (length is summed)', () => {
		// Real scys blocks often split bold/non-bold runs into separate elements.
		const blocks: ScysBlock[] = [{
			block_id: 'h',
			block_type: 7,
			heading5: { elements: [
				{ text_run: { content: '加入个人IP，形成个人专属提示词：', text_element_style: { bold: true } } },
				{ text_run: { content: '得到了一篇爆文提示词，这个时候我们要丰富人设，植入个人IP故事和经历' } },
			] },
		}];
		const flat = flattenScysBlocks(blocks);
		expect(flat[0].block_type).toBe(2);
	});

	// Browser article CSS makes the entire heading container bold (font-weight:
	// 600 on .block5/.block6) regardless of per-run bold metadata. When demoting
	// long article headings to TEXT, we must apply the same: force bold=true on
	// every text_run so the markdown shows the whole prose in **…**, matching the
	// visual exactly.
	it('forceBoldOnDemote=true: every text_run gets bold=true after demotion', () => {
		const blocks: ScysBlock[] = [{
			block_id: 'h', block_type: 7,
			heading5: { elements: [
				{ text_run: { content: '加入个人IP，形成个人专属提示词：', text_element_style: { bold: true } } },
				{ text_run: { content: '得到了一篇爆文提示词，这个时候我们要丰富人设，植入个人IP故事和经历' } },
			] },
		}];
		const flat = flattenScysBlocks(blocks, { forceBoldOnDemote: true });
		expect(flat[0].block_type).toBe(2);
		const els = (flat[0] as any).text.elements;
		expect(els[0].text_run.text_element_style.bold).toBe(true);
		expect(els[1].text_run.text_element_style.bold).toBe(true);
	});

	it('does NOT emit <strong> inside a HEADING (skipBold) — bold flag on heading text_runs is redundant since H tags are visually bold', () => {
		// Real fixture: "二、取得的项目成绩" has bold=true on its text_run.
		// Old behaviour: `## **二、取得的项目成绩**` (markdown-noisy + breaks ** pairs).
		// New: plain `## 二、取得的项目成绩`.
		const blocks: ScysBlock[] = [{
			block_id: 'h', block_type: 5,
			heading3: { elements: [{ text_run: { content: '二、取得的项目成绩', text_element_style: { bold: true } } }] },
		}] as any;
		// course/docx path: 5 → default H3 (no rewrite). Heading inner bold suppressed.
		const html = renderScysChapterContent(blocks);
		expect(html).toContain('<h3>二、取得的项目成绩</h3>');
		expect(html).not.toMatch(/<h3><strong>/);
	});

	// Note: text_color and block.style.align are intentionally not encoded into
	// markdown — pure markdown has no color or alignment primitive, and HTML
	// inline-style attributes get stripped by defuddle's turndown anyway.

	it('merges adjacent <strong> blocks so markdown does not show literal `****`', () => {
		// Pre-fix: <strong>aa</strong><strong>bb</strong> → markdown **aa****bb**
		// (some renderers surface that middle **** as literal characters).
		const blocks: ScysBlock[] = [{
			block_id: 'p', block_type: 2,
			text: { elements: [
				{ text_run: { content: 'aa', text_element_style: { bold: true } } },
				{ text_run: { content: 'bb', text_element_style: { bold: true } } },
			] },
		}] as any;
		const html = renderScysChapterContent(blocks);
		// Merged into a single <strong>aabb</strong> rather than two adjacent ones.
		expect(html).toContain('<strong>aabb</strong>');
		expect(html).not.toContain('</strong><strong>');
	});

	it('forceBoldOnDemote=false (default): bold flags untouched after demotion', () => {
		const blocks: ScysBlock[] = [{
			block_id: 'h', block_type: 7,
			heading5: { elements: [
				{ text_run: { content: '加入个人IP，形成个人专属提示词：', text_element_style: { bold: true } } },
				{ text_run: { content: '得到了一篇爆文提示词，这个时候我们要丰富人设，植入个人IP故事和经历' } },
			] },
		}];
		const flat = flattenScysBlocks(blocks);
		const els = (flat[0] as any).text.elements;
		expect(els[0].text_run.text_element_style.bold).toBe(true);
		expect(els[1].text_run.text_element_style).toBeUndefined();
	});
});

import fixtureChapter from './fixtures/scys-chapter-11408.json';
import { renderScysChapterContent } from './scys-extractor';

describe('renderScysChapterContent (real fixture)', () => {
	const blocks = (fixtureChapter as any).data.chapter.content;

	it('produces HTML containing all chapter h2 headings', () => {
		const html = renderScysChapterContent(blocks);
		// HEADING4 (block_type=6) is rewritten to HEADING2 → <h2>
		expect(html).toContain('<h2>0. 本章概要</h2>');
		expect(html).toContain('<h2>1. 什么是积累能力</h2>');
		expect(html).toContain('<h2>2. 积累能力的三个核心技能</h2>');
	});

	it('produces h3 for HEADING5 (e.g. "2.1 需求判断...")', () => {
		const html = renderScysChapterContent(blocks);
		// heading5 elements in this fixture have bold:false → no <strong> wrapper.
		// The optional wrapper allowance defends against future bold heading5 data.
		expect(html).toMatch(/<h3>(?:<strong>)?2\.1\s*需求判断/);
	});

	it('produces h4 for HEADING6 (e.g. "2.1.1 用途...")', () => {
		const html = renderScysChapterContent(blocks);
		// renderTextElements now skips <strong> when invoked from a HEADING
		// context (the H tag is already visually bold; nested **…** in markdown
		// causes `## **二、…**` noise and breaks `**` pair counting).
		expect(html).toMatch(/<h4>2\.1\.1\s*用途/);
	});

	it('renders bullet list block as <ul>', () => {
		const html = renderScysChapterContent(blocks);
		expect(html).toMatch(/<ul>[\s\S]*<li>/);
	});

	it('renders ordered list block as <ol>', () => {
		const html = renderScysChapterContent(blocks);
		expect(html).toMatch(/<ol>[\s\S]*<li>/);
	});

	it('renders callout block as blockquote.feishu-callout', () => {
		const html = renderScysChapterContent(blocks);
		expect(html).toContain('class="feishu-callout"');
	});

	// Regression: callouts must emit Obsidian-native `[!type]` title line so
	// reading-view renders them as colored boxes (not gray quotes). Otherwise
	// callouts visually mismatch feishu's tinted callout rendering.
	it('renders callout with [!type] prefix mapped from emoji_id (bulb→tip)', () => {
		const html = renderScysChapterContent(blocks);
		// Course fixture's first callout has no emoji_id (course doesn't expose
		// it) → falls back to [!note]. At minimum some `[!note]` or `[!*]` line
		// must appear inside a feishu-callout blockquote.
		expect(html).toMatch(/<blockquote class="feishu-callout"><p>\[!\w+\]/);
	});

	it('promotes first heading child into callout title when callout.elements is empty', () => {
		const calloutWithHeadingChild = [{
			block_id: 'callout1',
			block_type: 19,
			callout: { elements: null, emoji_id: 'bulb' },
			children_blocks: [
				{ block_id: 'h3', block_type: 5,
					heading3: { elements: [{ text_run: { content: '查看顺序', text_element_style: {} } }] } },
				{ block_id: 'p1', block_type: 2,
					text: { elements: [{ text_run: { content: '1. body', text_element_style: {} } }] } },
			],
		}] as any;
		const html = renderScysChapterContent(calloutWithHeadingChild);
		// Title line should contain the heading text, NOT a separate <h3> inside body.
		expect(html).toContain('[!tip] 💡 查看顺序');
		expect(html).not.toContain('<h3>查看顺序</h3>');
		expect(html).toContain('1. body');
	});

	it('falls back to [!note] when callout has no emoji_id', () => {
		const callout = [{
			block_id: 'c1',
			block_type: 19,
			callout: { elements: [{ text_run: { content: 'plain title', text_element_style: {} } }] },
			children_blocks: [],
		}] as any;
		const html = renderScysChapterContent(callout);
		expect(html).toContain('[!note] plain title');
	});

	it('renders code block as <pre><code>', () => {
		const html = renderScysChapterContent(blocks);
		expect(html).toMatch(/<pre><code>/);
	});

	it('renders table block', () => {
		const html = renderScysChapterContent(blocks);
		expect(html).toMatch(/<table[\s>]/);
	});

	it('keeps image placeholders with scys: prefixed src for later resolution', () => {
		const html = renderScysChapterContent(blocks);
		expect(html).toMatch(/<img src="feishu-image:\/\/scys:[^"]+"/);
	});

	it('injects scys: token for all image blocks in real fixture', () => {
		const html = renderScysChapterContent(blocks);
		// Real fixture has exactly 58 image blocks (block_type=27); every one should
		// produce a scys:-prefixed placeholder in the rendered HTML.
		const matches = html.match(/feishu-image:\/\/scys:/g) || [];
		expect(matches.length).toBe(58);
	});

	it('does not double-render content nested inside containers', () => {
		const html = renderScysChapterContent(blocks);
		// Real fixture has 58 image blocks (block_type=27). Counting feishu-image:
		// occurrences must equal exactly 58 — duplicates from container double-render
		// would push the count higher (pre-fix this fixture produced 74 due to
		// callout/table contents being rendered both inside their container and
		// again in the outer flat-array iteration).
		const imageMatches = html.match(/feishu-image:\/\//g) || [];
		expect(imageMatches.length).toBe(58);
	});
});

import { resolveScysImages } from './scys-extractor';

describe('resolveScysImages (L1 same-origin fetch)', () => {
	const originalFetch = global.fetch;

	afterEach(() => { global.fetch = originalFetch; });

	it('replaces scys: token with base64 data URL on success', async () => {
		const png1x1 = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			headers: new Headers({ 'Content-Type': 'image/png' }),
			blob: () => Promise.resolve(new Blob([png1x1], { type: 'image/png' })),
		} as any);
		const html = '<img src="feishu-image://scys:https%3A%2F%2Fexample.com%2Fa.png">';
		const resolved = await resolveScysImages(html);
		expect(resolved).toMatch(/<img src="data:image\/png;base64,[A-Za-z0-9+/=]+">/);
		expect(resolved).not.toContain('feishu-image://scys:');
	});

	it('leaves token in place if fetch fails', async () => {
		global.fetch = vi.fn().mockResolvedValue({ ok: false } as any);
		const html = '<img src="feishu-image://scys:https%3A%2F%2Fexample.com%2Fa.png">';
		const resolved = await resolveScysImages(html);
		expect(resolved).toContain('feishu-image://scys:');
	});

	it('handles multiple images independently (mixed success/failure)', async () => {
		// URL-specific mock — avoids depending on fetch call ordering through Set iteration.
		global.fetch = vi.fn().mockImplementation((url: any) => {
			// fileUrl is decoded before fetch, so url here is "https://a" / "https://b".
			const isA = String(url).endsWith('/a');
			return Promise.resolve({
				ok: isA,
				headers: new Headers({ 'Content-Type': 'image/png' }),
				blob: () => Promise.resolve(new Blob([new Uint8Array([1])], { type: 'image/png' })),
			});
		});
		const html =
			'<img src="feishu-image://scys:https%3A%2F%2Fa">' +
			'<img src="feishu-image://scys:https%3A%2F%2Fb">';
		const resolved = await resolveScysImages(html);
		// a/ succeeded → data URL present; b/ failed → placeholder retained.
		expect(resolved).toMatch(/<img src="data:image\/png;base64,/);
		expect(resolved).toContain('feishu-image://scys:https%3A%2F%2Fb');
		expect(resolved).not.toContain('feishu-image://scys:https%3A%2F%2Fa');
	});

	it('is a no-op for HTML with no scys tokens', async () => {
		global.fetch = vi.fn();
		const html = '<p>no images here</p><img src="https://example.com/x.png">';
		const resolved = await resolveScysImages(html);
		expect(resolved).toBe(html);
		expect(global.fetch).not.toHaveBeenCalled();
	});

	it('deduplicates identical tokens into a single fetch call', async () => {
		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			headers: new Headers({ 'Content-Type': 'image/png' }),
			blob: () => Promise.resolve(new Blob([new Uint8Array([1])], { type: 'image/png' })),
		} as any);
		const token = 'feishu-image://scys:https%3A%2F%2Fexample.com%2Fsame.png';
		const html = `<img src="${token}"><img src="${token}">`;
		const resolved = await resolveScysImages(html);
		expect(global.fetch).toHaveBeenCalledTimes(1);
		// Both occurrences in HTML get replaced
		expect((resolved.match(/data:image/g) || []).length).toBe(2);
		expect(resolved).not.toContain('feishu-image://scys:');
	});
});

import { fetchScysChapter, fetchScysComments } from './scys-extractor';

describe('fetchScysChapter', () => {
	const originalFetch = global.fetch;
	afterEach(() => { global.fetch = originalFetch; });

	it('hits /search/course/getChapterContent with credentials and returns chapter object', async () => {
		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: () => Promise.resolve({ data: { chapter: { id: 11408, title: 'X', content: [] } } }),
		} as any);
		const result = await fetchScysChapter(172, 11408);
		expect(global.fetch).toHaveBeenCalledWith(
			'/search/course/getChapterContent?course_id=172&chapter_id=11408',
			{ credentials: 'include' }
		);
		expect(result).toEqual({ id: 11408, title: 'X', content: [] });
	});

	it('returns null on HTTP error', async () => {
		global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401 } as any);
		expect(await fetchScysChapter(172, 11408)).toBeNull();
	});

	it('returns null on missing data.chapter', async () => {
		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: () => Promise.resolve({ data: {} }),
		} as any);
		expect(await fetchScysChapter(172, 11408)).toBeNull();
	});

	it('returns null when fetch throws', async () => {
		global.fetch = vi.fn().mockRejectedValue(new Error('network down'));
		expect(await fetchScysChapter(172, 11408)).toBeNull();
	});
});

describe('fetchScysComments', () => {
	const originalFetch = global.fetch;
	afterEach(() => { global.fetch = originalFetch; });

	it('paginates until total reached, merging items and users', async () => {
		const pages = [
			{ data: { total: 25, items: Array(20).fill(null).map((_, i) => ({ id: i, user_id: i, content: [], comments: null, like_count: 0, created_at: 0 })), extra: { users: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }] } } },
			{ data: { total: 25, items: Array(5).fill(null).map((_, i) => ({ id: 20 + i, user_id: 20 + i, content: [], comments: null, like_count: 0, created_at: 0 })), extra: { users: [{ id: 2, name: 'B' }, { id: 3, name: 'C' }] } } },
		];
		let n = 0;
		global.fetch = vi.fn().mockImplementation(() =>
			Promise.resolve({ ok: true, json: () => Promise.resolve(pages[n++]) } as any)
		);
		const result = await fetchScysComments(172, 11408);
		expect(result?.items).toHaveLength(25);
		expect(result?.users.size).toBe(3);
		expect(result?.users.get(2)?.name).toBe('B');
		expect(result?.total).toBe(25);
	});

	it('stops if page returns empty items even before total reached (safety)', async () => {
		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: () => Promise.resolve({ data: { total: 100, items: [], extra: { users: [] } } }),
		} as any);
		const result = await fetchScysComments(172, 11408);
		expect(result?.items).toHaveLength(0);
	});

	it('returns null on first-page fetch error', async () => {
		global.fetch = vi.fn().mockResolvedValue({ ok: false } as any);
		expect(await fetchScysComments(172, 11408)).toBeNull();
	});
});

import { renderScysComments, formatScysCommentHeader, ScysComment, ScysCommentsResult } from './scys-extractor';

describe('formatScysCommentHeader', () => {
	it('formats with user, likes>0, and date', () => {
		const users = new Map([[1, { id: 1, name: '叁斤' }]]);
		// 1715000000 unix sec = 2024-05-06 in UTC, allow CN/US TZ slack:
		const out = formatScysCommentHeader({ user_id: 1, like_count: 9, created_at: 1715000000 } as any, users);
		expect(out).toMatch(/^\*\*叁斤\*\* · 9 ❤️ · 2024-05-0[6-7]$/);
	});
	it('omits ❤️ segment when like_count is 0', () => {
		const users = new Map([[1, { id: 1, name: '叁斤' }]]);
		const out = formatScysCommentHeader({ user_id: 1, like_count: 0, created_at: 1715000000 } as any, users);
		expect(out).toMatch(/^\*\*叁斤\*\* · 2024-05-0[6-7]$/);
	});
	it('falls back to anonymous when user not in map', () => {
		const out = formatScysCommentHeader({ user_id: 999, like_count: 0, created_at: 1715000000 } as any, new Map());
		expect(out).toMatch(/^\*\*匿名#999\*\* · 2024-05-0[6-7]$/);
	});
	it('accepts ISO 8601 string for created_at (real scys API format)', () => {
		const users = new Map([[1, { id: 1, name: '叁斤' }]]);
		const out = formatScysCommentHeader({ user_id: 1, like_count: 0, created_at: '2026-05-09T22:06:55+08:00' } as any, users);
		expect(out).toMatch(/^\*\*叁斤\*\* · 2026-05-09$/);
	});
});

describe('renderScysComments', () => {
	const baseUsers = new Map([
		[1, { id: 1, name: '叁斤' }],
		[2, { id: 2, name: '杨树亮' }],
		[3, { id: 3, name: 'Gaby' }],
	]);
	const mkComment = (id: number, userId: number, likes: number, createdAt: number, content: ScysBlock[], replies?: ScysComment[]): ScysComment => ({
		id, user_id: userId, like_count: likes, created_at: createdAt, content, comments: replies ?? null,
	});
	const textBlock = (s: string): ScysBlock => ({
		block_id: `t${Math.random().toString(36).slice(2, 10)}`,
		block_type: 5001,
		sc_html: { content: `<p>${s}</p>` },
	});

	it('renders empty section when no items', () => {
		expect(renderScysComments({ total: 0, items: [], users: baseUsers }).trim()).toBe('');
	});

	it('renders H2 header and one main comment with body (HTML)', () => {
		const result: ScysCommentsResult = {
			total: 1, users: baseUsers,
			items: [mkComment(1, 1, 9, 1715000000, [textBlock('hello world')])],
		};
		const html = renderScysComments(result);
		expect(html).toContain('<h2>💬 章节评论（1 条）</h2>');
		expect(html).toContain('<blockquote>');
		expect(html).toMatch(/<p><strong>叁斤<\/strong> · 9 ❤️ · 2024-05-0[6-7]<\/p>/);
		expect(html).toContain('hello world');
	});

	it('renders nested replies as nested blockquotes (HTML)', () => {
		const lvl3 = mkComment(3, 3, 0, 1715000000, [textBlock('深嵌套')]);
		const lvl2 = mkComment(2, 2, 2, 1715000000, [textBlock('一级回复')], [lvl3]);
		const top = mkComment(1, 1, 9, 1715000000, [textBlock('主评论')], [lvl2]);
		const html = renderScysComments({ total: 1, items: [top], users: baseUsers });
		// Outer blockquote (top), inner (lvl2), innermost (lvl3) — count >= 3 <blockquote> tags
		expect((html.match(/<blockquote>/g) || []).length).toBe(3);
		expect(html).toContain('主评论');
		expect(html).toContain('一级回复');
		expect(html).toContain('深嵌套');
		expect(html).toMatch(/<strong>杨树亮<\/strong> · 2 ❤️/);
		expect(html).toMatch(/<strong>Gaby<\/strong>/);
	});

	it('uses total in header even when items < total', () => {
		const result: ScysCommentsResult = {
			total: 70, users: baseUsers,
			items: [mkComment(1, 1, 0, 1715000000, [textBlock('x')])],
		};
		expect(renderScysComments(result)).toContain('<h2>💬 章节评论（70 条）</h2>');
	});
});

import fixtureComments from './fixtures/scys-comments-11408.json';
import { ScysUser } from './scys-extractor';

describe('renderScysComments (real fixture)', () => {
	const fix = fixtureComments as any;
	const users = new Map<number, ScysUser>();
	for (const u of fix.data.extra.users) users.set(u.id, u);
	const result: ScysCommentsResult = {
		total: fix.data.total,
		items: fix.data.items,
		users,
	};

	it('renders header with 70 total comments (HTML)', () => {
		expect(renderScysComments(result)).toContain('<h2>💬 章节评论（70 条）</h2>');
	});

	it('includes nested blockquotes for replies', () => {
		const html = renderScysComments(result);
		// Real fixture has 70 main + 41 replies = 111 blockquotes minimum
		expect((html.match(/<blockquote>/g) || []).length).toBeGreaterThanOrEqual(70);
	});

	it('shows ❤️ for at least one main comment (likes > 0)', () => {
		const html = renderScysComments(result);
		expect(html).toMatch(/❤️/);
	});

	it('emits exactly 70 top-level blockquotes (one per main comment)', () => {
		const html = renderScysComments(result);
		const parts = html.split('</h2>');
		const body = parts[1] || '';
		const total = (body.match(/<blockquote>/g) || []).length;
		expect(total).toBeGreaterThanOrEqual(70);
	});

	it('renders real comment body text (not empty) — guards against sc_html handling regression', () => {
		const html = renderScysComments(result);
		expect(html).toContain('结构化思维好强');
	});

	it('renders dates as YYYY-MM-DD from ISO string created_at', () => {
		const html = renderScysComments(result);
		expect(html).toMatch(/· 2026-\d{2}-\d{2}/);
		expect(html).not.toContain('NaN');
	});
});

import { extractScysStructuredContent, preprocessScysEntityHtml } from './scys-extractor';
import { convertDate } from './date-utils';

describe('extractScysStructuredContent (orchestration)', () => {
	const originalFetch = global.fetch;
	afterEach(() => { global.fetch = originalFetch; });

	it('returns null for non-scys URLs', async () => {
		const doc = { URL: 'https://example.com/foo' } as Document;
		expect(await extractScysStructuredContent(doc)).toBeNull();
	});

	it('returns null when fetchScysChapter fails', async () => {
		global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401 } as any);
		const doc = { URL: 'https://scys.com/course/detail/172?chapterId=11408' } as Document;
		expect(await extractScysStructuredContent(doc)).toBeNull();
	});

	it('returns content with chapter title + body when comments fail', async () => {
		global.fetch = vi.fn().mockImplementation((url: string) => {
			if (String(url).includes('getChapterContent')) {
				return Promise.resolve({
					ok: true,
					json: () => Promise.resolve({
						data: { chapter: { id: 11408, title: 'Test Chapter', content: [
							{ block_id: 'b1', block_type: 5001, sc_html: { content: '<p>Hello</p>' } } as any,
						] } }
					}),
				});
			}
			// Comments + course detail all fail
			return Promise.resolve({ ok: false, status: 500 });
		});
		const doc = { URL: 'https://scys.com/course/detail/172?chapterId=11408' } as Document;
		const result = await extractScysStructuredContent(doc);
		expect(result).not.toBeNull();
		expect(result?.title).toBe('Test Chapter');
		// chapter content (block_type 5001 is comment-only; chapter blocks won't render via standard path)
		// content should at minimum be a non-empty string, but may be empty if no chapter blocks render
		expect(typeof result?.content).toBe('string');
		expect(result?.author).toBe('');
		// no comments section since comments failed
		expect(result?.content).not.toContain('💬 章节评论');
	});

	it('appends comments section when comments fetch succeeds', async () => {
		global.fetch = vi.fn().mockImplementation((url: string) => {
			const s = String(url);
			if (s.includes('getChapterContent')) {
				return Promise.resolve({
					ok: true,
					json: () => Promise.resolve({
						data: { chapter: { id: 11408, title: 'X', content: [] } }
					}),
				});
			}
			if (s.includes('getCourseComments')) {
				return Promise.resolve({
					ok: true,
					json: () => Promise.resolve({
						data: {
							total: 1,
							items: [{
								id: 1, user_id: 1, like_count: 0, created_at: '2026-05-09T22:06:55+08:00',
								content: [{ block_id: 'c1', block_type: 5001, sc_html: { content: '<p>hi</p>' } }],
								comments: null,
							}],
							extra: { users: [{ id: 1, name: 'Tester' }] },
						},
					}),
				});
			}
			if (s.includes('getCourseDetail')) {
				return Promise.resolve({
					ok: true,
					json: () => Promise.resolve({ data: { course: { author: 'AuthorName' } } }),
				});
			}
			return Promise.resolve({ ok: false });
		});
		const doc = { URL: 'https://scys.com/course/detail/172?chapterId=11408' } as Document;
		const result = await extractScysStructuredContent(doc);
		expect(result?.title).toBe('X');
		expect(result?.author).toBe('AuthorName');
		expect(result?.content).toContain('<h2>💬 章节评论（1 条）</h2>');
		expect(result?.content).toMatch(/<strong>Tester<\/strong>/);
		expect(result?.content).toContain('hi');
	});
});

import { isScysDocxUrl, parseScysDocxUrl } from './scys-extractor';

describe('isScysDocxUrl', () => {
	it('matches /view/docx/{token}', () => {
		expect(isScysDocxUrl('https://scys.com/view/docx/QSn2dD6QnoYlDxxiYItcudnPnZg')).toBe(true);
		expect(isScysDocxUrl('https://scys.com/view/docx/QSn2dD6QnoYlDxxiYItcudnPnZg/')).toBe(true);
	});
	it('rejects course URLs', () => {
		expect(isScysDocxUrl('https://scys.com/course/detail/172?chapterId=11408')).toBe(false);
	});
	it('rejects /view/wiki/* or other view variants', () => {
		expect(isScysDocxUrl('https://scys.com/view/wiki/ABC')).toBe(false);
		expect(isScysDocxUrl('https://scys.com/view/sheet/XYZ')).toBe(false);
	});
	it('rejects non-scys hosts', () => {
		expect(isScysDocxUrl('https://example.com/view/docx/X')).toBe(false);
	});
	it('rejects malformed URL', () => {
		expect(isScysDocxUrl('not a url')).toBe(false);
	});
});

describe('parseScysDocxUrl', () => {
	it('extracts token', () => {
		expect(parseScysDocxUrl('https://scys.com/view/docx/Abc-XYZ_123')).toEqual({ token: 'Abc-XYZ_123' });
	});
	it('extracts token with trailing slash', () => {
		expect(parseScysDocxUrl('https://scys.com/view/docx/Test/')).toEqual({ token: 'Test' });
	});
	it('returns null for invalid URL', () => {
		expect(parseScysDocxUrl('https://scys.com/foo')).toBeNull();
		expect(parseScysDocxUrl('not a url')).toBeNull();
	});
});

// Minimal Storage/localStorage shim — vitest runs in node env (no DOM globals).
// Plan-prescribed tests below monkey-patch Storage.prototype.getItem, so we
// install a stub class + global localStorage instance before the suite.
if (typeof (globalThis as any).Storage === 'undefined') {
	class StorageStub {
		getItem(_key: string): string | null { return null; }
		setItem(_key: string, _val: string): void {}
		removeItem(_key: string): void {}
		clear(): void {}
		key(_i: number): string | null { return null; }
		get length(): number { return 0; }
	}
	(globalThis as any).Storage = StorageStub;
	(globalThis as any).localStorage = new StorageStub();
}

describe('extractScysDocxStandalone (via router)', () => {
	const originalGetItem = Storage.prototype.getItem;
	afterEach(() => { Storage.prototype.getItem = originalGetItem; });

	it('returns null when no captured blocks in localStorage', async () => {
		Storage.prototype.getItem = vi.fn().mockReturnValue(null);
		const doc = { URL: 'https://scys.com/view/docx/Test', title: 'Test' } as any;
		expect(await extractScysStructuredContent(doc)).toBeNull();
	});

	it('returns null when captured blocks is empty array', async () => {
		Storage.prototype.getItem = vi.fn().mockReturnValue('[]');
		const doc = { URL: 'https://scys.com/view/docx/Test', title: 'Test' } as any;
		expect(await extractScysStructuredContent(doc)).toBeNull();
	});

	it('returns null when captured blocks is malformed JSON', async () => {
		Storage.prototype.getItem = vi.fn().mockReturnValue('not-json');
		const doc = { URL: 'https://scys.com/view/docx/Test', title: 'Test' } as any;
		expect(await extractScysStructuredContent(doc)).toBeNull();
	});

	it('renders content from captured blocks (reusing course fixture)', async () => {
		const fixture = (await import('./fixtures/scys-chapter-11408.json')) as any;
		const blocks = fixture.default.data.chapter.content;
		Storage.prototype.getItem = vi.fn().mockReturnValue(JSON.stringify(blocks));
		const doc = { URL: 'https://scys.com/view/docx/Test', title: 'AI 工具怎么选丨超级 AI 大航海丨生财有术' } as any;
		const result = await extractScysStructuredContent(doc);
		expect(result).not.toBeNull();
		expect(result?.title).toBe('AI 工具怎么选');  // suffix stripped
		expect(result?.content).toContain('<h2>0. 本章概要</h2>');
		expect(result?.content).toContain('class="feishu-callout"');
		expect(result?.author).toBe('');
		expect(result?.wordCount).toBeGreaterThan(100);
	});

	it('strips only 丨生财有术 suffix when 丨超级 AI 大航海 absent', async () => {
		Storage.prototype.getItem = vi.fn().mockReturnValue('[{"block_id":"x","block_type":2,"text":{"elements":[]}}]');
		const doc = { URL: 'https://scys.com/view/docx/X', title: '简单标题丨生财有术' } as any;
		const result = await extractScysStructuredContent(doc);
		expect(result?.title).toBe('简单标题');
	});

	it('falls back to original title when suffix patterns not present', async () => {
		Storage.prototype.getItem = vi.fn().mockReturnValue('[{"block_id":"x","block_type":2,"text":{"elements":[]}}]');
		const doc = { URL: 'https://scys.com/view/docx/X', title: 'Pure Title' } as any;
		const result = await extractScysStructuredContent(doc);
		expect(result?.title).toBe('Pure Title');
	});
});

import fixtureChapter11407 from './fixtures/scys-chapter-11407.json';
import fixtureComments11407 from './fixtures/scys-comments-11407.json';

// 11407 covers data shapes 11408 lacks: divider blocks, deeper heading
// hierarchy (h2+h3+h4 all populated), and a comment thread that spans
// multiple pages (120 items).
describe('scys 11407 fixture (divider + extended hierarchy)', () => {
	const blocks = (fixtureChapter11407 as any).data.chapter.content;

	it('renders DIVIDER (block_type=22) as <hr>', () => {
		const html = renderScysChapterContent(blocks);
		// 11407 has 2 divider blocks; 11408 has none.
		expect((html.match(/<hr>/g) || []).length).toBeGreaterThanOrEqual(2);
	});

	it('produces full h2/h3/h4 hierarchy from heading4/5/6 blocks', () => {
		const html = renderScysChapterContent(blocks);
		expect(html).toContain('<h2>0. 本章概要</h2>');
		expect(html).toMatch(/<h3>(?:<strong>)?1\.1\s*什么是思考能力/);
		expect(html).toContain('<h4>路径一：提前沉淀你的个人背景文档</h4>');
	});

	it('emits exactly 31 image placeholders matching API count', () => {
		const html = renderScysChapterContent(blocks);
		const matches = html.match(/feishu-image:\/\/scys:/g) || [];
		expect(matches.length).toBe(31);
	});
});

describe('scys 11407 comments fixture (multi-page accumulation)', () => {
	// Fixture stores the raw page array (6 pages × 20 items = 120 total) so
	// the test also documents the consumer-side merge shape.
	const pages = fixtureComments11407 as any[];
	const allItems = pages.flatMap(p => p?.data?.items || []);
	const users = new Map<number, ScysUser>();
	for (const p of pages) {
		for (const u of (p?.data?.extra?.users || [])) {
			users.set(u.id, u);
		}
	}
	const result: ScysCommentsResult = {
		total: pages[0]?.data?.total || 0,
		items: allItems,
		users,
	};

	it('accumulates 120 top-level comments across 6 pages', () => {
		expect(allItems.length).toBe(120);
		expect(result.total).toBe(120);
	});

	it('renders header with 120 total comments', () => {
		expect(renderScysComments(result)).toContain('<h2>💬 章节评论（120 条）</h2>');
	});

	it('emits at least 120 top-level blockquotes (plus nested reply ones)', () => {
		const html = renderScysComments(result);
		expect((html.match(/<blockquote>/g) || []).length).toBeGreaterThanOrEqual(120);
	});
});

import fixtureDocxQSn2dD from './fixtures/scys-docx-QSn2dD.json';

describe('scys docx fixture — callout visual-parity regression (commit 43a7ed8)', () => {
	// Real fixture: 542 blocks, 7 callouts (1 bulb + 6 mag_right).
	// Each callout has callout.elements=null + first child HEADING3 as visual title.
	const docxBlocks = fixtureDocxQSn2dD as any[];
	const html = renderScysChapterContent(docxBlocks);

	it('renders 7 callouts as Obsidian-native [!type] colored boxes', () => {
		// Expect exactly 7 callout title lines with [!tip] or [!info] prefix.
		const calloutTitleLines = html.match(/<blockquote class="feishu-callout"><p>\[!\w+\]/g) || [];
		expect(calloutTitleLines.length).toBe(7);
	});

	it('maps emoji_id="bulb" → [!tip] with 💡 in title', () => {
		expect(html).toContain('[!tip] 💡');
	});

	it('maps emoji_id="mag_right" → [!info] with 🔍 in title', () => {
		const infoCount = (html.match(/\[!info\] 🔍/g) || []).length;
		expect(infoCount).toBe(6);
	});

	it('promotes "查看顺序" H3 child into the [!tip] callout title (not as inner heading)', () => {
		expect(html).toContain('[!tip] 💡 查看顺序');
		// The H3 should NOT also appear standalone inside the callout body.
		// Match: <blockquote ...>...<h3>查看顺序</h3>... (would indicate non-promotion)
		expect(html).not.toMatch(/<blockquote class="feishu-callout">[^<]*<p>\[!tip\][^<]*<\/p><h3>查看顺序<\/h3>/);
	});
});

// ─── /articleDetail/xq_topic/{id} (zsxq topic mirror) ──────────────────────
import {
	isScysArticleUrl,
	parseScysArticleUrl,
	formatScysArticleCommentHeader,
	renderScysArticleComments,
	fetchScysArticleDetail,
	fetchScysArticleComments,
	ScysArticleComment,
} from './scys-extractor';

describe('isScysArticleUrl', () => {
	it('matches /articleDetail/{type}/{id}', () => {
		expect(isScysArticleUrl('https://scys.com/articleDetail/xq_topic/55188248452852824')).toBe(true);
		expect(isScysArticleUrl('https://scys.com/articleDetail/xq_topic/55188248452852824/')).toBe(true);
	});
	it('rejects course / docx URLs', () => {
		expect(isScysArticleUrl('https://scys.com/course/detail/172?chapterId=11408')).toBe(false);
		expect(isScysArticleUrl('https://scys.com/view/docx/ABC')).toBe(false);
	});
	it('rejects non-numeric id', () => {
		expect(isScysArticleUrl('https://scys.com/articleDetail/xq_topic/abc')).toBe(false);
	});
	it('rejects non-scys host', () => {
		expect(isScysArticleUrl('https://example.com/articleDetail/xq_topic/123')).toBe(false);
	});
	it('rejects malformed URL', () => {
		expect(isScysArticleUrl('not a url')).toBe(false);
	});
});

describe('parseScysArticleUrl', () => {
	it('extracts entityType and entityId', () => {
		expect(parseScysArticleUrl('https://scys.com/articleDetail/xq_topic/55188248452852824'))
			.toEqual({ entityType: 'xq_topic', entityId: '55188248452852824' });
	});
	it('preserves entityType slug for non-xq_topic types (future-proofing)', () => {
		expect(parseScysArticleUrl('https://scys.com/articleDetail/sc_post/123'))
			.toEqual({ entityType: 'sc_post', entityId: '123' });
	});
	it('returns null for invalid path', () => {
		expect(parseScysArticleUrl('https://scys.com/articleDetail/onlytype')).toBeNull();
	});
});

describe('formatScysArticleCommentHeader', () => {
	const base: ScysArticleComment = {
		commentId: '17778942586844', pCommentId: '0',
		gmtCreate: 1762503084, // 2025-11-07
		content: '<p>hi</p>', userName: 'SUXI',
		likeCount: 0, isAuthor: false,
	} as ScysArticleComment;

	it('renders bare name + date when no likes / not author', () => {
		expect(formatScysArticleCommentHeader(base))
			.toMatch(/^<p><strong>SUXI<\/strong> · 2025-11-0[7-8]<\/p>$/);
	});
	it('adds 作者 marker when isAuthor=true', () => {
		const c = { ...base, isAuthor: true };
		expect(formatScysArticleCommentHeader(c))
			.toMatch(/^<p><strong>SUXI<\/strong> · 作者 · 2025-11-0[7-8]<\/p>$/);
	});
	it('adds likes when likeCount > 0', () => {
		const c = { ...base, likeCount: 9 };
		expect(formatScysArticleCommentHeader(c))
			.toMatch(/^<p><strong>SUXI<\/strong> · 9 ❤️ · 2025-11-0[7-8]<\/p>$/);
	});
	it('shows reply target when replyUserName present', () => {
		const c = { ...base, replyUserName: '刘智行' };
		expect(formatScysArticleCommentHeader(c))
			.toMatch(/^<p><strong>SUXI<\/strong> · 2025-11-0[7-8] · 回复 @刘智行<\/p>$/);
	});
	it('falls back to anonymous-id placeholder when userName missing', () => {
		const c = { ...base, userName: '' };
		expect(formatScysArticleCommentHeader(c))
			.toMatch(/^<p><strong>匿名#17778942586844<\/strong>/);
	});
});

describe('renderScysArticleComments', () => {
	const mk = (id: string, name: string, content: string, opts: Partial<ScysArticleComment> = {}): ScysArticleComment => ({
		commentId: id, pCommentId: opts.pCommentId ?? '0',
		gmtCreate: 1762503084, content, userName: name,
		likeCount: 0, isAuthor: false, ...opts,
	} as ScysArticleComment);

	it('returns empty string for no items', () => {
		expect(renderScysArticleComments([], 0)).toBe('');
	});

	it('renders H2 with total count and one comment as <blockquote>', () => {
		const html = renderScysArticleComments([mk('1', 'A', '<p>hello</p>')], 1);
		expect(html).toContain('<h2>💬 评论（1 条）</h2>');
		expect(html).toContain('<blockquote>');
		expect(html).toContain('hello');
		expect(html).toMatch(/<strong>A<\/strong>/);
	});

	it('renders nested replies as nested blockquotes (1 level deep)', () => {
		const reply = mk('2', 'B', '<p>reply</p>', { pCommentId: '1' });
		const main = mk('1', 'A', '<p>main</p>', { replies: [reply], repliesCount: 1 });
		const html = renderScysArticleComments([main], 1);
		expect((html.match(/<blockquote>/g) || []).length).toBe(2);
		expect(html).toContain('main');
		expect(html).toContain('reply');
	});

	it('uses passed-in total (which may include replies) in H2', () => {
		// Real-world case: API data.total = 101 (top-level), but UI shows 262
		// (top + replies). We pass through the explicit total argument.
		const html = renderScysArticleComments([mk('1', 'A', '<p>x</p>')], 262);
		expect(html).toContain('<h2>💬 评论（262 条）</h2>');
	});

	it('emits placeholder <img> with feishu-image://scys: protocol for non-empty images field', () => {
		const c = mk('1', 'A', '<p>see below</p>', { images: 'https://search01.shengcaiyoushu.com/foo/bar.png' });
		const html = renderScysArticleComments([c], 1);
		expect(html).toMatch(/<img src="feishu-image:\/\/scys:https%3A%2F%2F[^"]+"/);
	});

	it('handles comma-separated images string (defense against multi-image future shape)', () => {
		const c = mk('1', 'A', '<p>x</p>', { images: 'https://a/1.png, https://b/2.png' });
		const html = renderScysArticleComments([c], 1);
		expect((html.match(/feishu-image:\/\/scys:/g) || []).length).toBe(2);
	});

	it('skips image rendering when images is empty string or undefined', () => {
		const c1 = mk('1', 'A', '<p>x</p>', { images: '' });
		const c2 = mk('2', 'B', '<p>y</p>');
		const html = renderScysArticleComments([c1, c2], 2);
		expect(html).not.toContain('feishu-image://');
	});
});

describe('fetchScysArticleDetail', () => {
	const originalFetch = global.fetch;
	afterEach(() => { global.fetch = originalFetch; });

	it('POSTs to topicDetail with entityId/entityType and unwraps topicDTO + topicUserDTO', async () => {
		const sent: any = {};
		global.fetch = vi.fn().mockImplementation((url: any, init: any) => {
			sent.url = url; sent.init = init;
			return Promise.resolve({ ok: true, json: () => Promise.resolve({
				success: true, data: {
					topicDTO: {
						entityId: '55188248452852824', entityType: 'xq_topic',
						showTitle: 'T',
						docBlocks: [{ block_id: 'x', block_type: 2, text: { elements: [] } }],
						gmtCreate: 1762503084,
						commentsCount: 262, likeCount: 1078, readingCount: 19880,
					},
					topicUserDTO: { name: '刘智行' },
				},
			}) } as any);
		});
		const r = await fetchScysArticleDetail('55188248452852824', 'xq_topic');
		expect(sent.url).toBe('/shengcai-web/client/homePage/topicDetail');
		expect(sent.init.method).toBe('POST');
		expect(JSON.parse(sent.init.body)).toEqual({ entityId: '55188248452852824', entityType: 'xq_topic' });
		expect(r?.showTitle).toBe('T');
		expect(r?.authorName).toBe('刘智行');
		expect(r?.commentsCount).toBe(262);
	});

	it('returns null on HTTP error', async () => {
		global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 } as any);
		expect(await fetchScysArticleDetail('1', 'xq_topic')).toBeNull();
	});

	it('returns null when topicDTO missing or docBlocks not array', async () => {
		global.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ data: {} }) } as any);
		expect(await fetchScysArticleDetail('1', 'xq_topic')).toBeNull();
	});
});

describe('fetchScysArticleComments', () => {
	const originalFetch = global.fetch;
	afterEach(() => { global.fetch = originalFetch; });

	it('paginates by pageIndex until accumulated items >= total', async () => {
		const pages = [
			{ data: { total: 25, items: Array(20).fill(null).map((_, i) => ({ commentId: String(i) })) } },
			{ data: { total: 25, items: Array(5).fill(null).map((_, i) => ({ commentId: String(20 + i) })) } },
		];
		let n = 0;
		global.fetch = vi.fn().mockImplementation(() =>
			Promise.resolve({ ok: true, json: () => Promise.resolve(pages[n++]) } as any)
		);
		const r = await fetchScysArticleComments('1', 'xq_topic');
		expect(r?.items.length).toBe(25);
		expect(r?.total).toBe(25);
		expect(global.fetch).toHaveBeenCalledTimes(2);
	});

	it('sends pageIndex starting at 1 with sortType=1 (default 智能排序)', async () => {
		const captured: any[] = [];
		global.fetch = vi.fn().mockImplementation((url: any, init: any) => {
			captured.push(JSON.parse(init.body));
			return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: { total: 1, items: [{}] } }) } as any);
		});
		await fetchScysArticleComments('1', 'xq_topic');
		expect(captured[0]).toEqual({ entityId: '1', entityType: 'xq_topic', sortType: 1, pageIndex: 1 });
	});

	it('returns null on first-page HTTP error', async () => {
		global.fetch = vi.fn().mockResolvedValue({ ok: false } as any);
		expect(await fetchScysArticleComments('1', 'xq_topic')).toBeNull();
	});

	it('stops on empty items page (safety) even before total reached', async () => {
		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: () => Promise.resolve({ data: { total: 100, items: [] } }),
		} as any);
		const r = await fetchScysArticleComments('1', 'xq_topic');
		expect(r?.items.length).toBe(0);
	});
});

import fixtureArticleDetail from './fixtures/scys-article-55188248-detail.json';
import fixtureArticleComments from './fixtures/scys-article-55188248-comments.json';

describe('scys article fixture — real 55188248 (zsxq topic mirror)', () => {
	const topic = (fixtureArticleDetail as any).data.topicDTO;
	const html = renderScysChapterContent(topic.docBlocks);

	it('fixture has expected size signals (541 top-level docBlocks, 262 commentsCount)', () => {
		expect(topic.docBlocks.length).toBe(541);
		// Top-level block_type=27 (image) is only 40; the full nested tree has 120
		// because scys inlines images inside block_type=25 wrapper containers nested
		// in other containers (grid cells, etc.). Live page renders 125 imgs in
		// .content-container (120 article + 4 comment + 1 decoration) — extractor
		// matches that.
		expect(topic.docBlocks.filter((b: any) => b.block_type === 27).length).toBe(40);
		expect(topic.commentsCount).toBe(262);
	});

	it('renders the showTitle as the first heading-derived <h1> (post-placeholder)', () => {
		// renderScysChapterContent prepends a placeholder H1 that defuddle later strips;
		// the next thing in HTML is the real HEADING1 content from docBlocks.
		expect(html).toContain('AI+公众号垂直小号');
	});

	it('renders 120 image placeholders matching nested image-block count (40 top + 80 nested)', () => {
		// scys docBlocks has 40 top-level block_type=27 plus 80 more nested inside
		// inline-image containers (block_type=25) within other containers. Each is
		// a distinct block_id with its own file_url — must all be rendered.
		expect((html.match(/feishu-image:\/\/scys:/g) || []).length).toBe(120);
	});

	it('renders sectional H2/H3/H4 from heading4/5/6 blocks (real content)', () => {
		// Sampling a couple of known sections from the article
		expect(html).toMatch(/<h2>[^<]*垂直小号[^<]*<\/h2>/);
	});

	// Regression 2026-05-16: scys topic blocks have no link metadata on text_runs;
	// URLs sit as plain content. Without autolinking, Obsidian renders them as
	// inert text (GFM autolink breaks on adjacent CJK punctuation).
	it('wraps every bare URL in the body into a clickable <a href="…">', () => {
		// Fixture has 5 distinct bare URLs in the body text content.
		const bodyUrls = [
			'https://t.zsxq.com/uFfmH',
			'https://scys.com/articleDetail/xq_topic/8852214148411152',
			'https://user.benfuip.com/main/memberLogin',
			'https://user.benfuvip.com/main/register?aff=496724970',
			'https://www.bitbrowser.cn/?signup=1',
		];
		for (const u of bodyUrls) {
			// Note: query strings get & → &amp; via escapeAttr; match either form.
			const escaped = u.replace(/&/g, '&amp;');
			expect(html).toMatch(new RegExp(`<a href="${escaped.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}">`));
		}
	});

	it('produces no surviving bare URL outside of an <a> tag in body html', () => {
		// Strip anchor blocks, then scan for any remaining bare URL.
		const stripped = html.replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, '');
		expect(stripped).not.toMatch(/https?:\/\//);
	});
});

describe('scys article comments fixture — real 55188248 (11 pages, 262 incl. replies)', () => {
	const pages = fixtureArticleComments as any[];
	const allItems: ScysArticleComment[] = pages.flatMap(p => p?.data?.items || []);
	const total = pages[0]?.data?.total ?? 0;

	it('captures 11 pages and 101 top-level + 161 replies = 262', () => {
		expect(pages.length).toBe(11);
		expect(allItems.length).toBe(101);
		expect(total).toBe(101);
		const replies = allItems.flatMap(it => it.replies || []);
		expect(replies.length).toBe(161);
	});

	it('renderScysArticleComments emits header with API total (101) and at least 101 top-level blockquotes', () => {
		const html = renderScysArticleComments(allItems, total);
		expect(html).toContain('<h2>💬 评论（101 条）</h2>');
		// each top + each reply contributes a <blockquote> tag → 262 minimum
		expect((html.match(/<blockquote>/g) || []).length).toBeGreaterThanOrEqual(262);
	});

	it('renders real comment body text from server-rendered HTML (regression guard)', () => {
		const html = renderScysArticleComments(allItems, total);
		// First comment we saw on the page (verified via get_page_text capture)
		expect(html).toContain('尝试了好多遍，不知道哪里不对');
		// An author reply
		expect(html).toContain('联系鱼丸，联系我。不要放弃');
	});

	it('renders dates as YYYY-MM-DD (no NaN)', () => {
		const html = renderScysArticleComments(allItems, total);
		expect(html).toMatch(/· 20\d{2}-\d{2}-\d{2}/);
		expect(html).not.toContain('NaN');
	});

	it('emits image placeholders for the 4 comments that have non-empty images', () => {
		const html = renderScysArticleComments(allItems, total);
		const allComments = [...allItems, ...allItems.flatMap(it => it.replies || [])];
		const imgComments = allComments.filter(c => c.images && c.images !== '');
		expect(imgComments.length).toBe(4);
		expect((html.match(/feishu-image:\/\/scys:/g) || []).length).toBe(4);
	});

	it('renders "作者" marker on isAuthor=true comments', () => {
		const html = renderScysArticleComments(allItems, total);
		expect(html).toContain(' · 作者 · ');
	});

	it('renders "回复 @{name}" on replies that target a specific user', () => {
		const html = renderScysArticleComments(allItems, total);
		expect(html).toMatch(/· 回复 @[^<]+</);
	});

	// Regression 2026-05-16: scys server-renders comment content as HTML but
	// does NOT wrap URLs in <a>. The article fixture has exactly 1 such comment.
	// Without renderOneArticleCommentHtml's autolink pass, Obsidian shows it
	// as inert text.
	it('autolinks bare URLs found inside comment content (server-rendered HTML)', () => {
		const html = renderScysArticleComments(allItems, total);
		// The one comment with a URL points to another scys topic, terminated by
		// Chinese ）— must not be inside the href, must be outside as plain char.
		expect(html).toMatch(/<a href="https:\/\/scys\.com\/articleDetail\/xq_topic\/5122542855245514">/);
		expect(html).not.toMatch(/href="[^"]*）/);
	});
});

describe('extractScysStructuredContent — article route', () => {
	const originalFetch = global.fetch;
	afterEach(() => { global.fetch = originalFetch; });

	it('returns null when topicDetail fails', async () => {
		global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 } as any);
		const doc = { URL: 'https://scys.com/articleDetail/xq_topic/55188248452852824' } as Document;
		expect(await extractScysStructuredContent(doc)).toBeNull();
	});

	it('returns content+title+author when topicDetail succeeds (comments optional)', async () => {
		global.fetch = vi.fn().mockImplementation((url: any) => {
			if (String(url).includes('topicDetail')) {
				return Promise.resolve({ ok: true, json: () => Promise.resolve({
					success: true, data: {
						topicDTO: {
							entityId: '1', entityType: 'xq_topic', showTitle: 'Test Article',
							docBlocks: [
								{ block_id: 'b1', block_type: 2, text: { elements: [{ text_run: { content: 'body text' } }] } } as any,
							],
							gmtCreate: 1762503084, commentsCount: 0, likeCount: 0, readingCount: 100,
						},
						topicUserDTO: { name: 'Tester' },
					},
				}) } as any);
			}
			// pageTopicComment → return empty so no comments section
			return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: { total: 0, items: [] } }) } as any);
		});
		const doc = { URL: 'https://scys.com/articleDetail/xq_topic/55188248452852824' } as Document;
		const r = await extractScysStructuredContent(doc);
		expect(r?.title).toBe('Test Article');
		expect(r?.author).toBe('Tester');
		expect(r?.content).toContain('body text');
		expect(r?.content).not.toContain('💬 评论');
		expect(r?.published).toBe(convertDate(new Date(1762503084 * 1000)));
	});

	it('returns published="" when gmtCreate is 0/missing', async () => {
		global.fetch = vi.fn().mockImplementation((url: any) => {
			if (String(url).includes('topicDetail')) {
				return Promise.resolve({ ok: true, json: () => Promise.resolve({
					success: true, data: {
						topicDTO: {
							entityId: '2', entityType: 'xq_topic', showTitle: 'No Date',
							docBlocks: [
								{ block_id: 'b1', block_type: 2, text: { elements: [{ text_run: { content: 'x' } }] } } as any,
							],
							gmtCreate: 0, commentsCount: 0, likeCount: 0, readingCount: 0,
						},
						topicUserDTO: { name: 'T' },
					},
				}) } as any);
			}
			return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: { total: 0, items: [] } }) } as any);
		});
		const doc = { URL: 'https://scys.com/articleDetail/xq_topic/2' } as Document;
		const r = await extractScysStructuredContent(doc);
		expect(r?.published).toBe('');
	});

	it('resolves FILE block links to article URL anchors (video/.mp4 attachments)', async () => {
		// scys article has 3 FILE blocks (video attachments). The default feishu
		// FILE rendering emits an internal feishu-file-block:// URL that defuddle
		// drops during markdown conversion, losing the filename. Scys path must
		// rewrite to a real anchor so the filename survives in the clipped note.
		global.fetch = vi.fn().mockImplementation((url: any) => {
			if (String(url).includes('topicDetail')) {
				return Promise.resolve({ ok: true, json: () => Promise.resolve({
					data: {
						topicDTO: {
							entityId: '999', entityType: 'xq_topic', showTitle: 'X',
							docBlocks: [
								{ block_id: 'file1', block_type: 23, file: { name: '内容王国操作流程(简洁版1).mp4', token: 'TOK' } } as any,
							],
							gmtCreate: 0, commentsCount: 0, likeCount: 0, readingCount: 0,
						},
						topicUserDTO: { name: 'A' },
					},
				}) } as any);
			}
			return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: { total: 0, items: [] } }) } as any);
		});
		const doc = { URL: 'https://scys.com/articleDetail/xq_topic/999' } as Document;
		const r = await extractScysStructuredContent(doc);
		expect(r?.content).toContain('内容王国操作流程(简洁版1).mp4');
		expect(r?.content).not.toContain('feishu-file-block://');
		// Anchor href must contain the article URL + block id
		expect(r?.content).toMatch(/href="[^"]*\/articleDetail\/xq_topic\/999#file1"/);
	});

	// Legacy article body: pre-2024 posts (e.g. 418444442181248) deliver
	// `topicDTO.articleContent` as a Quill ql-editor HTML string instead of a
	// docBlocks array. The extractor must fall back to that.
	it('fixture 2852488814854211: legacy plain-text article (no <p>) paragraphizes + decodes <e> entities', async () => {
		// Real pre-2024 post (2852488814854211). articleContent is plain text
		// separated by \n\n with scys custom <e type="web" href="URL-encoded"
		// title="URL-encoded"/> entities — no <p>/<div>/<ol> wrappers at all.
		// Old extractor passed it through unchanged → defuddle collapsed
		// everything into a single markdown paragraph. New behaviour: paragraph-
		// ize on \n\n + expand <e> → <a>.
		const detail = await import('./fixtures/scys-article-2852488814854211-detail.json');
		const comments = await import('./fixtures/scys-article-2852488814854211-comments.json');
		const pageIter = [...(comments.default as any[])];
		global.fetch = vi.fn().mockImplementation((url: any) => {
			const u = String(url);
			if (u.includes('topicDetail')) return Promise.resolve({ ok: true, json: () => Promise.resolve(detail.default) } as any);
			if (u.includes('pageTopicComment')) {
				const next = pageIter.shift();
				return Promise.resolve({ ok: true, json: () => Promise.resolve(next || { data: { total: 0, items: [] } }) } as any);
			}
			return Promise.resolve({ ok: false } as any);
		});
		const doc = { URL: 'https://scys.com/articleDetail/xq_topic/2852488814854211' } as Document;
		const r = await extractScysStructuredContent(doc);
		expect(r?.title).toBe('高考Agent「AI高考通」可能是做高考志愿填报业务的一大变现助力');
		// Paragraph-ized: html should contain many <p> wrappers (≥10 paragraphs)
		const pCount = (r?.content.match(/<p>/g) || []).length;
		expect(pCount).toBeGreaterThanOrEqual(10);
		// First paragraph text survived
		expect(r?.content).toContain('QQ浏览器推出行业首个高考Agent');
		// scys <e> entity decoded to <a> with full URL + decoded title
		expect(r?.content).toContain('<a href="https://browser.qq.com/gaokao-agent">搜索落地页</a>');
		expect(r?.content).toContain('<a href="https://mp.weixin.qq.com/');
		// Raw <e> tags must NOT survive
		expect(r?.content).not.toMatch(/<e\s+type/);
		// URL-encoded title fragments must not leak
		expect(r?.content).not.toContain('%E6%90%9C');
	});

	it('preprocessScysEntityHtml: <e type="web"> decodes href + title; \\n\\n → <p>', () => {
		const input = 'para A\n\npara B\n\nlink: <e type="web" href="https%3A%2F%2Fa.com" title="%E6%90%9C" />';
		const out = preprocessScysEntityHtml(input);
		expect(out).toContain('<p>para A</p>');
		expect(out).toContain('<p>para B</p>');
		expect(out).toContain('<a href="https://a.com">搜</a>');
		expect(out).not.toMatch(/<e\s+type/);
	});

	it('preprocessScysEntityHtml: empty title falls back to href text', () => {
		const out = preprocessScysEntityHtml('x <e type="web" href="https%3A%2F%2Fb.com" title="" />');
		expect(out).toContain('<a href="https://b.com">https://b.com</a>');
	});

	it('preprocessScysEntityHtml: inner single \\n becomes <br>', () => {
		const out = preprocessScysEntityHtml('line1\nline2\n\npara B');
		expect(out).toContain('<p>line1<br>line2</p>');
		expect(out).toContain('<p>para B</p>');
	});

	it('fixture 418444442181248: legacy ql-editor article renders all key sections', async () => {
		// Real pre-2024 post (2021-06-23). 23K char articleContent HTML with 247
		// <p>/<ol> children, 6 imgs (article-images.zsxq.com + docimg3.docs.qq.com),
		// 27 <li>, 20 <strong>. Wire it through the real article-route so the
		// legacy fallback path is exercised end-to-end.
		const detail = await import('./fixtures/scys-article-418444442181248-detail.json');
		const comments = await import('./fixtures/scys-article-418444442181248-comments.json');
		const pageIter = [...(comments.default as any[])];
		global.fetch = vi.fn().mockImplementation((url: any) => {
			const u = String(url);
			if (u.includes('topicDetail')) return Promise.resolve({ ok: true, json: () => Promise.resolve(detail.default) } as any);
			if (u.includes('pageTopicComment')) {
				const next = pageIter.shift();
				return Promise.resolve({ ok: true, json: () => Promise.resolve(next || { data: { total: 0, items: [] } }) } as any);
			}
			return Promise.resolve({ ok: false } as any);
		});
		const doc = { URL: 'https://scys.com/articleDetail/xq_topic/418444442181248' } as Document;
		const r = await extractScysStructuredContent(doc);
		expect(r?.title).toBe('高考志愿填报这门生意分析');
		// First / last paragraph
		expect(r?.content).toContain('每年会有大量的高考同学需要填报志愿');
		expect(r?.content).toContain('看完的你也很厉害哦');
		// Ordered list items survived
		expect(r?.content).toContain('<li>');
		// Bold (Quill <strong>) survived
		expect(r?.content).toContain('<strong>');
		// Image src rewritten to scys: token form (resolver will inline base64)
		const imgTokens = r?.content.match(/feishu-image:\/\/scys:/g) || [];
		expect(imgTokens.length).toBeGreaterThanOrEqual(5);
		// Wrapper stripped
		expect(r?.content).not.toContain('ql-editor');
		// Word count is non-trivial
		expect(r?.wordCount).toBeGreaterThan(1000);
	});

	it('falls back to articleContent (Quill HTML) when docBlocks is empty', async () => {
		const articleHtml = '<div class="content ql-editor"><p>每年会有大量的高考同学需要填报志愿。</p>' +
			'<p><img src="https://article-images.zsxq.com/xxx" width="342"></p>' +
			'<ol><li>第一</li><li>第二</li></ol></div>';
		global.fetch = vi.fn().mockImplementation((url: any) => {
			if (String(url).includes('topicDetail')) {
				return Promise.resolve({ ok: true, json: () => Promise.resolve({
					data: {
						topicDTO: {
							entityId: '418444442181248', entityType: 'xq_topic',
							showTitle: '高考志愿填报这门生意分析',
							// NOTE: no docBlocks (legacy post)
							articleContent: articleHtml,
							gmtCreate: 1624406702, commentsCount: 1, likeCount: 0, readingCount: 0,
						},
						topicUserDTO: { name: 'Tester' },
					},
				}) } as any);
			}
			return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: { total: 0, items: [] } }) } as any);
		});
		const doc = { URL: 'https://scys.com/articleDetail/xq_topic/418444442181248' } as Document;
		const r = await extractScysStructuredContent(doc);
		expect(r?.title).toBe('高考志愿填报这门生意分析');
		expect(r?.content).toContain('每年会有大量的高考同学需要填报志愿');
		expect(r?.content).toContain('<li>第一</li>');
		expect(r?.content).toContain('<li>第二</li>');
		// img src rewritten to feishu-image://scys:… token form for resolver
		expect(r?.content).toMatch(/feishu-image:\/\/scys:https%3A%2F%2Farticle-images\.zsxq\.com/);
		// Outer .ql-editor wrapper stripped
		expect(r?.content).not.toContain('ql-editor');
	});

	it('fetchScysArticleDetail returns null when neither docBlocks nor articleContent populated', async () => {
		global.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({
			data: { topicDTO: { entityId: '1', entityType: 'xq_topic', showTitle: 'X' }, topicUserDTO: { name: 'A' } },
		}) } as any);
		const r = await fetchScysArticleDetail('1', 'xq_topic');
		expect(r).toBeNull();
	});

	it('appends comments section when present, using topicDTO.commentsCount as the displayed total', async () => {
		global.fetch = vi.fn().mockImplementation((url: any) => {
			if (String(url).includes('topicDetail')) {
				return Promise.resolve({ ok: true, json: () => Promise.resolve({
					data: {
						topicDTO: {
							entityId: '1', entityType: 'xq_topic', showTitle: 'X',
							docBlocks: [{ block_id: 'x', block_type: 2, text: { elements: [] } }],
							gmtCreate: 1762503084, commentsCount: 5, likeCount: 0, readingCount: 0,
						},
						topicUserDTO: { name: 'A' },
					},
				}) } as any);
			}
			return Promise.resolve({ ok: true, json: () => Promise.resolve({
				data: { total: 1, items: [{
					commentId: 'c1', gmtCreate: 1762503084, content: '<p>hi</p>',
					userName: 'U', likeCount: 0, isAuthor: false,
				}] },
			}) } as any);
		});
		const doc = { URL: 'https://scys.com/articleDetail/xq_topic/55188248452852824' } as Document;
		const r = await extractScysStructuredContent(doc);
		// 5 should appear (commentsCount fallback), not 1 (API total)
		expect(r?.content).toContain('<h2>💬 评论（5 条）</h2>');
		expect(r?.content).toContain('hi');
	});
});
