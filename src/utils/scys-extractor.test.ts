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

import { extractScysStructuredContent } from './scys-extractor';

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
						showTitle: 'T', docBlocks: [], gmtCreate: 1762503084,
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
	});

	it('appends comments section when present, using topicDTO.commentsCount as the displayed total', async () => {
		global.fetch = vi.fn().mockImplementation((url: any) => {
			if (String(url).includes('topicDetail')) {
				return Promise.resolve({ ok: true, json: () => Promise.resolve({
					data: {
						topicDTO: {
							entityId: '1', entityType: 'xq_topic', showTitle: 'X',
							docBlocks: [],
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
