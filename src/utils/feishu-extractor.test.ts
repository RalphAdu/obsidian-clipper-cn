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
});
