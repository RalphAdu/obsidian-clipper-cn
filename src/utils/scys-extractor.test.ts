import { describe, it, expect } from 'vitest';
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
