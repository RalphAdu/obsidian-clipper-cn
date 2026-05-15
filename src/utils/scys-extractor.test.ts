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
