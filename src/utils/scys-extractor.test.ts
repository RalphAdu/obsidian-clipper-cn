import { describe, it, expect, vi, afterEach } from 'vitest';
import { isScysCourseUrl, parseScysUrl } from './scys-extractor';

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
		// heading6 elements in this fixture have bold:true on text_run →
		// renderTextElements wraps content in <strong>. Required, not optional.
		expect(html).toMatch(/<h4><strong>2\.1\.1\s*用途/);
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
