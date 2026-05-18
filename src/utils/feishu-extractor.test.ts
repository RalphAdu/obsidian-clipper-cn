import { describe, it, expect } from 'vitest';
import { convertBlocksToHtml, type FeishuBlock } from './feishu-extractor';
import fixture from './fixtures/feishu-iframe-orderedlist.json';

const blocks = fixture as unknown as FeishuBlock[];

describe('convertBlocksToHtml — IFRAME', () => {
	it('renders IFRAME block as a clickable link with decoded URL and domain+path label', () => {
		const html = convertBlocksToHtml(blocks);
		expect(html).toContain('<a href="https://www.join-tsinghua.edu.cn/ebook/index.html">join-tsinghua.edu.cn/ebook/index.html</a>');
		expect(html).toContain('🌐');
		expect(html).not.toContain('[Embedded content: type 26]');
	});

	it('falls back to placeholder when iframe.component.url is missing', () => {
		const noUrl: FeishuBlock[] = [
			{ block_id: 'p', block_type: 1, page: { elements: [] }, children: ['x'] },
			{ block_id: 'x', block_type: 26, parent_id: 'p', iframe: { component: { iframe_type: 99 } } } as any,
		];
		const html = convertBlocksToHtml(noUrl);
		expect(html).toContain('[Embedded content: type 26]');
	});

	it('preserves query string in the label when the path is empty', () => {
		const blocks: FeishuBlock[] = [
			{ block_id: 'p', block_type: 1, page: { elements: [] }, children: ['i'] },
			{ block_id: 'i', block_type: 26, parent_id: 'p', iframe: { component: { iframe_type: 99, url: 'https%3A%2F%2Fdocs.example.com%2F%3Fid%3Dabc123' } } } as any,
		];
		const html = convertBlocksToHtml(blocks);
		expect(html).toContain('<a href="https://docs.example.com/?id=abc123">docs.example.com?id=abc123</a>');
	});
});

describe('convertBlocksToHtml — list merging', () => {
	it('merges 4 ORDERED blocks interleaved with 4 TEXT explanations into a single <ol> with explanations nested in each <li>', () => {
		const html = convertBlocksToHtml(blocks);

		// Exactly one <ol> (not four, not eight)
		const olMatches = html.match(/<ol>/g);
		expect(olMatches?.length).toBe(1);

		// Four <li> inside that ol
		const liMatches = html.match(/<li>/g);
		expect(liMatches?.length).toBe(4);

		// Each explanation paragraph nested inside its preceding <li>
		expect(html).toContain('<li><strong>哲学的辩证：以退为进的破局</strong><p>停播七个月去打磨产品。</p></li>');
		expect(html).toContain('<li><strong>文学的觉察：看见数据背后的人</strong><p>家长不是来学习复杂系统的，是来找答案的。</p></li>');
		expect(html).toContain('<li><strong>心理学：降低决策成本</strong><p>成交的核心是更低的决策成本。</p></li>');
		expect(html).toContain('<li><strong>经济学：衡量隐性代价</strong><p>机会成本的博弈。</p></li>');

		// Explanation paragraphs must NOT exist as siblings of <ol>
		expect(html).not.toMatch(/<\/ol>\s*<p>停播七个月/);
		expect(html).not.toMatch(/<\/ol>\s*<p>家长/);
	});

	it('closes the current <ol> when a HEADING block appears between OL items', () => {
		const b: FeishuBlock[] = [
			{ block_id: 'p', block_type: 1, page: { elements: [] }, children: ['o1', 'h', 'o2'] },
			{ block_id: 'o1', block_type: 13, parent_id: 'p', ordered: { elements: [{ text_run: { content: 'first' } }], style: { sequence: '1' } } } as any,
			{ block_id: 'h', block_type: 4, parent_id: 'p', heading2: { elements: [{ text_run: { content: 'Section' } }] } } as any,
			{ block_id: 'o2', block_type: 13, parent_id: 'p', ordered: { elements: [{ text_run: { content: 'second' } }], style: { sequence: '1' } } } as any,
		];
		const html = convertBlocksToHtml(b);
		const olMatches = html.match(/<ol>/g);
		expect(olMatches?.length).toBe(2);
		expect(html).toContain('<h2>Section</h2>');
	});

	it('closes the current <ol> when a BULLET block appears (different list kind acts as boundary)', () => {
		const b: FeishuBlock[] = [
			{ block_id: 'p', block_type: 1, page: { elements: [] }, children: ['o1', 'u1', 'o2'] },
			{ block_id: 'o1', block_type: 13, parent_id: 'p', ordered: { elements: [{ text_run: { content: 'ord' } }] } } as any,
			{ block_id: 'u1', block_type: 12, parent_id: 'p', bullet: { elements: [{ text_run: { content: 'bul' } }] } } as any,
			{ block_id: 'o2', block_type: 13, parent_id: 'p', ordered: { elements: [{ text_run: { content: 'ord2' } }] } } as any,
		];
		const html = convertBlocksToHtml(b);
		expect(html.match(/<ol>/g)?.length).toBe(2);
		expect(html.match(/<ul>/g)?.length).toBe(1);
		expect(html.indexOf('<ul>')).toBeGreaterThan(html.indexOf('<ol>'));
		expect(html.lastIndexOf('<ol>')).toBeGreaterThan(html.indexOf('<ul>'));
	});

	it('preserves TODO checkboxes and merges interleaved TEXT into preceding <li>', () => {
		const b: FeishuBlock[] = [
			{ block_id: 'p', block_type: 1, page: { elements: [] }, children: ['td1', 'tx', 'td2'] },
			{ block_id: 'td1', block_type: 17, parent_id: 'p', todo: { elements: [{ text_run: { content: 'task one' } }], style: { done: false } } } as any,
			{ block_id: 'tx', block_type: 2, parent_id: 'p', text: { elements: [{ text_run: { content: 'note for task one' } }] } } as any,
			{ block_id: 'td2', block_type: 17, parent_id: 'p', todo: { elements: [{ text_run: { content: 'task two' } }], style: { done: true } } } as any,
		];
		const html = convertBlocksToHtml(b);
		expect(html.match(/<ul class="feishu-todo">/g)?.length).toBe(1);
		expect(html).toContain('[ ] task one<p>note for task one</p>');
		expect(html).toContain('[x] task two');
	});

	it('flushes trailing followers (TEXT after the last OL) into the last <li>', () => {
		const b: FeishuBlock[] = [
			{ block_id: 'p', block_type: 1, page: { elements: [] }, children: ['o1', 'tx', 'h'] },
			{ block_id: 'o1', block_type: 13, parent_id: 'p', ordered: { elements: [{ text_run: { content: 'item' } }] } } as any,
			{ block_id: 'tx', block_type: 2, parent_id: 'p', text: { elements: [{ text_run: { content: 'tail note' } }] } } as any,
			{ block_id: 'h', block_type: 4, parent_id: 'p', heading2: { elements: [{ text_run: { content: 'Next section' } }] } } as any,
		];
		const html = convertBlocksToHtml(b);
		expect(html).toContain('<li>item<p>tail note</p></li>');
		expect(html).not.toMatch(/<\/ol>\s*<p>tail note/);
		expect(html).toContain('<h2>Next section</h2>');
	});
});

describe('convertBlocksToHtml — mention_doc', () => {
	it('renders mention_doc as <a href> using OpenAPI-provided url', () => {
		const blocks: FeishuBlock[] = [
			{ block_id: 'p', block_type: 1, page: { elements: [] }, children: ['t'] },
			{
				block_id: 't',
				block_type: 2,
				parent_id: 'p',
				text: {
					elements: [
						{ text_run: { content: '书接上回：' } },
						{ mention_doc: { title: '@包子', token: 'X0E', url: 'https://my.feishu.cn/docx/X0E', obj_type: 22 } },
					],
				},
			} as any,
		];
		const html = convertBlocksToHtml(blocks);
		expect(html).toContain('<a href="https://my.feishu.cn/docx/X0E">@包子</a>');
	});

	it('falls back to plain title when mention_doc.url is missing', () => {
		const blocks: FeishuBlock[] = [
			{ block_id: 'p', block_type: 1, page: { elements: [] }, children: ['t'] },
			{
				block_id: 't',
				block_type: 2,
				parent_id: 'p',
				text: {
					elements: [{ mention_doc: { title: '@旧引用', token: 'old', obj_type: 22 } }],
				},
			} as any,
		];
		const html = convertBlocksToHtml(blocks);
		expect(html).toContain('@旧引用');
		expect(html).not.toContain('<a href');
	});
});

describe('convertBlocksToHtml — H1 auto-numbering', () => {
	it('numbers each H1 by document order; H2/H3 are not numbered (autoNumberHeadings: true)', () => {
		const blocks: FeishuBlock[] = [
			{ block_id: 'p', block_type: 1, page: { elements: [] }, children: ['h1a', 'h2', 'h1b', 'h3', 'h1c'] },
			{ block_id: 'h1a', block_type: 3, parent_id: 'p', heading1: { elements: [{ text_run: { content: '起心动念' } }] } } as any,
			{ block_id: 'h2', block_type: 4, parent_id: 'p', heading2: { elements: [{ text_run: { content: '小节 A' } }] } } as any,
			{ block_id: 'h1b', block_type: 3, parent_id: 'p', heading1: { elements: [{ text_run: { content: '抬高视角' } }] } } as any,
			{ block_id: 'h3', block_type: 5, parent_id: 'p', heading3: { elements: [{ text_run: { content: '更小一层' } }] } } as any,
			{ block_id: 'h1c', block_type: 3, parent_id: 'p', heading1: { elements: [{ text_run: { content: '极致简单' } }] } } as any,
		];
		const html = convertBlocksToHtml(blocks, { autoNumberHeadings: true });
		expect(html).toContain('<h1>1. 起心动念</h1>');
		expect(html).toContain('<h1>2. 抬高视角</h1>');
		expect(html).toContain('<h1>3. 极致简单</h1>');
		expect(html).toContain('<h2>小节 A</h2>');
		expect(html).toContain('<h3>更小一层</h3>');
	});

	it('does not number when autoNumberHeadings is false (scys path)', () => {
		// Default behavior — scys reuses convertBlocksToHtml; its docs hand-write
		// "2.1.1"-style prefixes, so cn must not double-number.
		const blocks: FeishuBlock[] = [
			{ block_id: 'p', block_type: 1, page: { elements: [] }, children: ['h1a'] },
			{ block_id: 'h1a', block_type: 3, parent_id: 'p', heading1: { elements: [{ text_run: { content: '起心动念' } }] } } as any,
		];
		const html = convertBlocksToHtml(blocks);
		expect(html).toContain('<h1>起心动念</h1>');
		expect(html).not.toMatch(/<h\d>\d+\./);
	});

	it('numbers H4 within each H2 section (reset at H2 boundary)', () => {
		const blocks: FeishuBlock[] = [
			{ block_id: 'p', block_type: 1, page: { elements: [] }, children: ['h2a', 'h4a1', 'h4a2', 'h2b', 'h4b1'] },
			{ block_id: 'h2a', block_type: 4, parent_id: 'p', heading2: { elements: [{ text_run: { content: '一、自我介绍' } }] } } as any,
			{ block_id: 'h4a1', block_type: 6, parent_id: 'p', heading4: { elements: [{ text_run: { content: '每天朝九晚五' } }] } } as any,
			{ block_id: 'h4a2', block_type: 6, parent_id: 'p', heading4: { elements: [{ text_run: { content: '三个重大决定' } }] } } as any,
			{ block_id: 'h2b', block_type: 4, parent_id: 'p', heading2: { elements: [{ text_run: { content: '二、取得的成绩' } }] } } as any,
			{ block_id: 'h4b1', block_type: 6, parent_id: 'p', heading4: { elements: [{ text_run: { content: '行动起来' } }] } } as any,
		];
		const html = convertBlocksToHtml(blocks, { autoNumberHeadings: true });
		expect(html).toContain('<h4>1. 每天朝九晚五</h4>');
		expect(html).toContain('<h4>2. 三个重大决定</h4>');
		expect(html).toContain('<h4>1. 行动起来</h4>'); // reset at H2b boundary
	});
});

describe('convertBlocksToHtml — section header boundary', () => {
	it('an all-bold non-empty TEXT block between BULLET lists closes the first <ul>', () => {
		const blocks: FeishuBlock[] = [
			{ block_id: 'p', block_type: 1, page: { elements: [] }, children: ['u1', 'sh', 'u2'] },
			{ block_id: 'u1', block_type: 12, parent_id: 'p', bullet: { elements: [{ text_run: { content: 'first item' } }] } } as any,
			{
				block_id: 'sh',
				block_type: 2,
				parent_id: 'p',
				text: {
					elements: [{ text_run: { content: '家长的痛点：', text_element_style: { bold: true } } }],
				},
			} as any,
			{ block_id: 'u2', block_type: 12, parent_id: 'p', bullet: { elements: [{ text_run: { content: 'second item' } }] } } as any,
		];
		const html = convertBlocksToHtml(blocks);
		expect(html.match(/<ul>/g)?.length).toBe(2);
		expect(html).toContain('<p><strong>家长的痛点：</strong></p>');
		expect(html).not.toMatch(/<li>[^<]*家长的痛点：/);
	});

	it('a non-bold TEXT block between OL lists still gets absorbed (no regression)', () => {
		const blocks: FeishuBlock[] = [
			{ block_id: 'p', block_type: 1, page: { elements: [] }, children: ['o1', 'tx', 'o2'] },
			{ block_id: 'o1', block_type: 13, parent_id: 'p', ordered: { elements: [{ text_run: { content: 'one' } }] } } as any,
			{ block_id: 'tx', block_type: 2, parent_id: 'p', text: { elements: [{ text_run: { content: 'plain explanation', text_element_style: { bold: false } } }] } } as any,
			{ block_id: 'o2', block_type: 13, parent_id: 'p', ordered: { elements: [{ text_run: { content: 'two' } }] } } as any,
		];
		const html = convertBlocksToHtml(blocks);
		expect(html.match(/<ol>/g)?.length).toBe(1);
		expect(html).toContain('<li>one<p>plain explanation</p></li>');
	});

	it('a spacer-style empty bold TEXT is not a boundary (gets absorbed silently)', () => {
		const blocks: FeishuBlock[] = [
			{ block_id: 'p', block_type: 1, page: { elements: [] }, children: ['u1', 'sp', 'u2'] },
			{ block_id: 'u1', block_type: 12, parent_id: 'p', bullet: { elements: [{ text_run: { content: 'first' } }] } } as any,
			{ block_id: 'sp', block_type: 2, parent_id: 'p', text: { elements: [{ text_run: { content: '', text_element_style: { bold: true } } }] } } as any,
			{ block_id: 'u2', block_type: 12, parent_id: 'p', bullet: { elements: [{ text_run: { content: 'second' } }] } } as any,
		];
		const html = convertBlocksToHtml(blocks);
		expect(html.match(/<ul>/g)?.length).toBe(1);
	});
});

describe('convertBlocksToHtml — list spacer boundary', () => {
	it('BULLET → empty TEXT → non-empty TEXT × 3 → H2: list closes, paragraphs are siblings', () => {
		const blocks: FeishuBlock[] = [
			{ block_id: 'p', block_type: 1, page: { elements: [] }, children: ['u1', 'sp', 't1', 't2', 't3', 'h'] },
			{ block_id: 'u1', block_type: 12, parent_id: 'p', bullet: { elements: [{ text_run: { content: 'frequent BUG fixes' } }] } } as any,
			{ block_id: 'sp', block_type: 2, parent_id: 'p', text: { elements: [{ text_run: { content: '' } }] } } as any,
			{ block_id: 't1', block_type: 2, parent_id: 'p', text: { elements: [{ text_run: { content: 'These issues require constant back-and-forth,' } }] } } as any,
			{ block_id: 't2', block_type: 2, parent_id: 'p', text: { elements: [{ text_run: { content: 'and optimizing is a bottomless pit.' } }] } } as any,
			{ block_id: 't3', block_type: 2, parent_id: 'p', text: { elements: [{ text_run: { content: 'I finally decided to learn coding myself.' } }] } } as any,
			{ block_id: 'h', block_type: 4, parent_id: 'p', heading2: { elements: [{ text_run: { content: 'Next section' } }] } } as any,
		];
		const html = convertBlocksToHtml(blocks);
		expect(html.match(/<li>/g)?.length).toBe(1);
		expect(html).toContain('<li>frequent BUG fixes</li>');
		expect(html).toContain('<p>These issues require constant back-and-forth,</p>');
		expect(html).toContain('<p>and optimizing is a bottomless pit.</p>');
		expect(html).toContain('<p>I finally decided to learn coding myself.</p>');
		expect(html).not.toMatch(/<li>[^<]*<p>These issues/);
		expect(html).toContain('<h2>Next section</h2>');
	});

	it('BULLET → empty TEXT × 2 → non-empty TEXT: consecutive spacers do not block lookahead', () => {
		const blocks: FeishuBlock[] = [
			{ block_id: 'p', block_type: 1, page: { elements: [] }, children: ['u1', 'sp1', 'sp2', 't1'] },
			{ block_id: 'u1', block_type: 12, parent_id: 'p', bullet: { elements: [{ text_run: { content: 'item' } }] } } as any,
			{ block_id: 'sp1', block_type: 2, parent_id: 'p', text: { elements: [{ text_run: { content: '' } }] } } as any,
			{ block_id: 'sp2', block_type: 2, parent_id: 'p', text: { elements: [{ text_run: { content: '  ' } }] } } as any,
			{ block_id: 't1', block_type: 2, parent_id: 'p', text: { elements: [{ text_run: { content: 'standalone paragraph' } }] } } as any,
		];
		const html = convertBlocksToHtml(blocks);
		expect(html.match(/<li>/g)?.length).toBe(1);
		expect(html).toContain('<li>item</li>');
		expect(html).toContain('<p>standalone paragraph</p>');
		expect(html).not.toMatch(/<li>[^<]*<p>standalone/);
	});

	it('BULLET → empty TEXT → EOF: list closes cleanly, no orphan empty <p>', () => {
		const blocks: FeishuBlock[] = [
			{ block_id: 'p', block_type: 1, page: { elements: [] }, children: ['u1', 'sp'] },
			{ block_id: 'u1', block_type: 12, parent_id: 'p', bullet: { elements: [{ text_run: { content: 'only item' } }] } } as any,
			{ block_id: 'sp', block_type: 2, parent_id: 'p', text: { elements: [{ text_run: { content: '' } }] } } as any,
		];
		const html = convertBlocksToHtml(blocks);
		expect(html).toContain('<ul><li>only item</li></ul>');
		expect(html).not.toContain('<p></p>');
	});

	it('BULLET → empty TEXT → ORDERED: <ul> closes, <ol> stands alone', () => {
		const blocks: FeishuBlock[] = [
			{ block_id: 'p', block_type: 1, page: { elements: [] }, children: ['u1', 'sp', 'o1'] },
			{ block_id: 'u1', block_type: 12, parent_id: 'p', bullet: { elements: [{ text_run: { content: 'bullet item' } }] } } as any,
			{ block_id: 'sp', block_type: 2, parent_id: 'p', text: { elements: [{ text_run: { content: '' } }] } } as any,
			{ block_id: 'o1', block_type: 13, parent_id: 'p', ordered: { elements: [{ text_run: { content: 'ordered item' } }] } } as any,
		];
		const html = convertBlocksToHtml(blocks);
		expect(html).toContain('<ul><li>bullet item</li></ul>');
		expect(html).toContain('<ol><li>ordered item</li></ol>');
		// bullet item must NOT appear inside the <ol>
		expect(html).not.toMatch(/<ol>[^]*bullet item/);
	});
});

describe('extractFeishuStructuredContent — comments wiring', () => {
	it('extractFeishuComments is imported and reachable from feishu-comments module', async () => {
		const mod = await import('./feishu-comments');
		expect(typeof mod.extractFeishuComments).toBe('function');
	});
});

describe('convertBlocksToHtml — IMAGE caption', () => {
	it('renders <figcaption> when image.caption.content is non-empty', () => {
		const blocks: FeishuBlock[] = [
			{ block_id: 'p', block_type: 1, page: { elements: [] }, children: ['i'] } as any,
			{ block_id: 'i', block_type: 27, parent_id: 'p', image: { token: 'GI3bbDFW9oUf1WxuiAdcTsIrn9e', width: 246, height: 27, caption: { content: 'EXE为更新和启动的主要组件。' } } } as any,
		];
		const html = convertBlocksToHtml(blocks);
		expect(html).toContain('<figcaption>EXE为更新和启动的主要组件。</figcaption>');
	});

	it('omits <figcaption> when caption.content is missing', () => {
		const blocks: FeishuBlock[] = [
			{ block_id: 'p', block_type: 1, page: { elements: [] }, children: ['i'] },
			{ block_id: 'i', block_type: 27, parent_id: 'p', image: { token: 'T1', width: 100, height: 50 } } as any,
		];
		const html = convertBlocksToHtml(blocks);
		expect(html).not.toContain('<figcaption>');
		expect(html).toContain('feishu-image://T1');
	});
});
