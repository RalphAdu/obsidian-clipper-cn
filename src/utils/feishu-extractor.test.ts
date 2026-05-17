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
});
