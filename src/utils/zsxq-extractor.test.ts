import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
	isZsxqTopicUrl,
	isZsxqArticleUrl,
	parseZsxqUrl,
	parseZsxqInlineText,
	renderZsxqTopicBodyHtml,
	renderZsxqCommentsHtml,
	fetchZsxqTopic,
	fetchZsxqAllComments,
	fetchZsxqArticleHtml,
	resolveZsxqImages,
	type ZsxqTopic,
	type ZsxqComment,
} from './zsxq-extractor';

const FIXTURE_DIR = join(__dirname, 'fixtures');
const topicFixture = JSON.parse(
	readFileSync(join(FIXTURE_DIR, 'zsxq-topic-185414442218552.json'), 'utf8'),
);
const articleHtmlFixture = readFileSync(
	join(FIXTURE_DIR, 'zsxq-article-qleditor-0rpvzt86eie6.html'),
	'utf8',
);
const commentsFixture = JSON.parse(
	readFileSync(join(FIXTURE_DIR, 'zsxq-comments-185414442218552.json'), 'utf8'),
);

describe('isZsxqTopicUrl', () => {
	it('matches a canonical wx.zsxq.com topic URL', () => {
		expect(isZsxqTopicUrl('https://wx.zsxq.com/group/1824528822/topic/185414442218552')).toBe(true);
	});

	it('matches a URL with trailing slash', () => {
		expect(isZsxqTopicUrl('https://wx.zsxq.com/group/1824528822/topic/185414442218552/')).toBe(true);
	});

	it('rejects an article URL', () => {
		expect(isZsxqTopicUrl('https://wx.zsxq.com/group/1824528822/article/185414442218552')).toBe(false);
	});

	it('rejects another host', () => {
		expect(isZsxqTopicUrl('https://example.com/group/1824528822/topic/185414442218552')).toBe(false);
	});

	it('rejects when group id is missing', () => {
		expect(isZsxqTopicUrl('https://wx.zsxq.com/topic/185414442218552')).toBe(false);
	});

	it('rejects when topic id is missing', () => {
		expect(isZsxqTopicUrl('https://wx.zsxq.com/group/1824528822/topic/')).toBe(false);
	});

	it('rejects non-numeric topic id', () => {
		expect(isZsxqTopicUrl('https://wx.zsxq.com/group/1824528822/topic/abc')).toBe(false);
	});

	it('rejects malformed string input', () => {
		expect(isZsxqTopicUrl('not-a-url')).toBe(false);
	});
});

describe('isZsxqArticleUrl', () => {
	it('matches a canonical article URL', () => {
		expect(isZsxqArticleUrl('https://wx.zsxq.com/group/1824528822/article/185414442218552')).toBe(true);
	});

	it('matches with trailing slash', () => {
		expect(isZsxqArticleUrl('https://wx.zsxq.com/group/1824528822/article/185414442218552/')).toBe(true);
	});

	it('rejects topic URLs', () => {
		expect(isZsxqArticleUrl('https://wx.zsxq.com/group/1824528822/topic/185414442218552')).toBe(false);
	});

	it('rejects another host', () => {
		expect(isZsxqArticleUrl('https://example.com/group/1/article/2')).toBe(false);
	});
});

describe('parseZsxqUrl', () => {
	it('parses a topic URL into kind=topic with groupId + topicId', () => {
		expect(parseZsxqUrl('https://wx.zsxq.com/group/1824528822/topic/185414442218552')).toEqual({
			kind: 'topic',
			groupId: '1824528822',
			topicId: '185414442218552',
		});
	});

	it('parses an article URL into kind=article with groupId + articleId', () => {
		expect(parseZsxqUrl('https://wx.zsxq.com/group/1824528822/article/0rpvzt86eie6')).toEqual({
			kind: 'article',
			groupId: '1824528822',
			articleId: '0rpvzt86eie6',
		});
	});

	it('returns null for non-zsxq URL', () => {
		expect(parseZsxqUrl('https://example.com/group/1/topic/2')).toBeNull();
	});

	it('returns null for malformed input', () => {
		expect(parseZsxqUrl('not-a-url')).toBeNull();
	});

	it('returns null for unknown shapes', () => {
		expect(parseZsxqUrl('https://wx.zsxq.com/')).toBeNull();
	});
});

describe('parseZsxqInlineText', () => {
	it('returns empty string for empty input', () => {
		expect(parseZsxqInlineText('')).toBe('');
	});

	it('passes through plain text unchanged', () => {
		expect(parseZsxqInlineText('大家好')).toBe('大家好');
	});

	it('expands hashtag <e> tag (URL-decoded title already contains #…#)', () => {
		expect(parseZsxqInlineText('<e type="hashtag" title="%23AI%23" />')).toBe('#AI#');
	});

	it('expands mention <e> tag (URL-decoded title already starts with @)', () => {
		expect(parseZsxqInlineText('<e type="mention" title="%40%E9%99%88%E5%A4%A7" />')).toBe('@陈大');
	});

	it('expands emoji <e> tag via URL-decoded title', () => {
		expect(parseZsxqInlineText('<e type="emoji" title="%F0%9F%98%80" />')).toBe('😀');
	});

	it('emoji without title falls back to [表情]', () => {
		expect(parseZsxqInlineText('<e type="emoji" />')).toBe('[表情]');
	});

	it('expands web <e> tag into a markdown link', () => {
		const out = parseZsxqInlineText('<e type="web" href="https://x.com" title="%E5%B7%A5%E5%85%B7" />');
		expect(out).toBe('[工具](https://x.com)');
	});

	it('drops unknown <e> types silently', () => {
		expect(parseZsxqInlineText('a<e type="mystery" title="x" />b')).toBe('ab');
	});

	it('converts <br> and <br/> to newline', () => {
		expect(parseZsxqInlineText('a<br>b<br/>c')).toBe('a\nb\nc');
	});

	it('decodes common HTML entities', () => {
		expect(parseZsxqInlineText('a &amp; b &lt;tag&gt; &quot;x&quot; &#39;y&#39;&nbsp;z'))
			.toBe('a & b <tag> "x" \'y\' z');
	});

	it('handles mixed-order tags and entities', () => {
		const out = parseZsxqInlineText('Hi <e type="mention" title="%40bob" />! see <e type="web" href="https://a.com" title="here" /><br>END');
		expect(out).toBe('Hi @bob! see [here](https://a.com)\nEND');
	});
});

describe('renderZsxqTopicBodyHtml', () => {
	const topic: ZsxqTopic = topicFixture.resp_data.topic;

	it('uses the articleBodyHtml as primary body when talk.article exists', () => {
		const out = renderZsxqTopicBodyHtml(topic, articleHtmlFixture);
		// The article body HTML should be embedded verbatim.
		expect(out).toContain('<div class="content ql-editor">');
		expect(out).toContain('我是鹏哥');
	});

	it('prepends the talk.text teaser as a blockquote when article is provided', () => {
		const out = renderZsxqTopicBodyHtml(topic, articleHtmlFixture);
		// The teaser is talk.text — it gets quoted before the article body.
		expect(out).toContain('<blockquote>');
		// The first 30 chars of the teaser must appear inside that blockquote.
		const teaser = topic.talk!.text.slice(0, 30);
		expect(out.indexOf(teaser)).toBeLessThan(out.indexOf('我是鹏哥'));
	});

	it('falls back to talk.text paragraphs when no article body is available', () => {
		const synthetic: ZsxqTopic = {
			topic_id: 1,
			type: 'talk',
			create_time: '2024-01-01T00:00:00+0800',
			likes_count: 0,
			comments_count: 0,
			talk: {
				owner: { user_id: 1, name: 'alice', avatar_url: '' },
				text: '第一段。\n\n第二段。',
			},
		};
		const out = renderZsxqTopicBodyHtml(synthetic, null);
		expect(out).toContain('<p>第一段。</p>');
		expect(out).toContain('<p>第二段。</p>');
	});

	it('renders q&a topics with question + answer headings', () => {
		const synthetic: ZsxqTopic = {
			topic_id: 2,
			type: 'q&a',
			create_time: '2024-01-01T00:00:00+0800',
			likes_count: 0,
			comments_count: 0,
			question: {
				owner: { user_id: 1, name: 'asker', avatar_url: '' },
				text: '问题内容',
			},
			answer: {
				owner: { user_id: 2, name: 'answerer', avatar_url: '' },
				text: '答案内容',
			},
		};
		const out = renderZsxqTopicBodyHtml(synthetic, null);
		expect(out).toContain('<h2>🙋 提问</h2>');
		expect(out).toContain('<h2>💡 回答</h2>');
		expect(out).toContain('问题内容');
		expect(out).toContain('答案内容');
	});

	it('emits image placeholders via feishu-image://zsxq: protocol (prefer original)', () => {
		const synthetic: ZsxqTopic = {
			topic_id: 3,
			type: 'talk',
			create_time: '2024-01-01T00:00:00+0800',
			likes_count: 0,
			comments_count: 0,
			talk: {
				owner: { user_id: 1, name: 'alice', avatar_url: '' },
				text: 'hi',
				images: [{
					image_id: 99,
					thumbnail: { url: 'https://images.zsxq.com/thumb.jpg' },
					large: { url: 'https://images.zsxq.com/large.jpg' },
					original: { url: 'https://images.zsxq.com/orig.jpg' },
				}],
			},
		};
		const out = renderZsxqTopicBodyHtml(synthetic, null);
		expect(out).toContain('feishu-image://zsxq:');
		expect(out).toContain(encodeURIComponent('https://images.zsxq.com/orig.jpg'));
		expect(out).toContain('alt="99"');
	});

	it('falls back to large then thumbnail when original is missing', () => {
		const onlyLarge: ZsxqTopic = {
			topic_id: 4, type: 'talk',
			create_time: '2024-01-01T00:00:00+0800',
			likes_count: 0, comments_count: 0,
			talk: {
				owner: { user_id: 1, name: 'a', avatar_url: '' },
				text: 'hi',
				images: [{ image_id: 1, large: { url: 'https://x/large.jpg' } }],
			},
		};
		expect(renderZsxqTopicBodyHtml(onlyLarge, null)).toContain(encodeURIComponent('https://x/large.jpg'));

		const onlyThumb: ZsxqTopic = {
			topic_id: 5, type: 'talk',
			create_time: '2024-01-01T00:00:00+0800',
			likes_count: 0, comments_count: 0,
			talk: {
				owner: { user_id: 1, name: 'a', avatar_url: '' },
				text: 'hi',
				images: [{ image_id: 2, thumbnail: { url: 'https://x/thumb.jpg' } }],
			},
		};
		expect(renderZsxqTopicBodyHtml(onlyThumb, null)).toContain(encodeURIComponent('https://x/thumb.jpg'));
	});

	it('renders attached files as a list of markdown-style download links', () => {
		const synthetic: ZsxqTopic = {
			topic_id: 6, type: 'talk',
			create_time: '2024-01-01T00:00:00+0800',
			likes_count: 0, comments_count: 0,
			talk: {
				owner: { user_id: 1, name: 'a', avatar_url: '' },
				text: 'with file',
				files: [
					{ file_id: 7, name: 'plan.pdf', download_url: 'https://files.zsxq.com/abc' },
				],
			},
		};
		const out = renderZsxqTopicBodyHtml(synthetic, null);
		expect(out).toContain('📎');
		expect(out).toContain('<a href="https://files.zsxq.com/abc">plan.pdf</a>');
	});

	it('escapes HTML in talk.text fallback so user-supplied < > do not break markup', () => {
		const synthetic: ZsxqTopic = {
			topic_id: 7, type: 'talk',
			create_time: '2024-01-01T00:00:00+0800',
			likes_count: 0, comments_count: 0,
			talk: {
				owner: { user_id: 1, name: 'a', avatar_url: '' },
				text: 'a <script>x</script> b',
			},
		};
		const out = renderZsxqTopicBodyHtml(synthetic, null);
		expect(out).not.toContain('<script>x</script>');
		expect(out).toContain('&lt;script&gt;');
	});
});

describe('renderZsxqCommentsHtml', () => {
	it('returns empty string for empty array', () => {
		expect(renderZsxqCommentsHtml([], 0)).toBe('');
	});

	it('renders a single top-level comment with author + date', () => {
		const c: ZsxqComment = {
			comment_id: 1,
			create_time: '2024-01-11T13:23:50.636+0800',
			text: 'hello',
			owner: { user_id: 1, name: 'alice', avatar_url: '' },
			likes_count: 0,
			group_owner_liked: false,
			topic_owner_liked: false,
			rewards_count: 0,
			sticky: false,
		};
		const out = renderZsxqCommentsHtml([c], 1);
		expect(out).toContain('<h2>💬 全部评论（1 条）</h2>');
		expect(out).toContain('<strong>alice</strong>');
		expect(out).toContain('2024-01-11');
		expect(out).toContain('hello');
		// likes_count = 0 — heart suffix MUST be omitted
		expect(out).not.toContain('❤️');
	});

	it('shows likes count when > 0', () => {
		const c: ZsxqComment = {
			comment_id: 1,
			create_time: '2024-01-11T13:23:50.636+0800',
			text: 'x',
			owner: { user_id: 1, name: 'alice', avatar_url: '' },
			likes_count: 5,
			group_owner_liked: false,
			topic_owner_liked: false,
			rewards_count: 0,
			sticky: false,
		};
		const out = renderZsxqCommentsHtml([c], 1);
		expect(out).toContain('5 ❤️');
	});

	it('renders nested replied_comments as inner blockquotes', () => {
		// Use the fixture: pick a comment with replied_comments.
		const all: ZsxqComment[] = commentsFixture.resp_data.comments;
		const withReplies = all.find(c => Array.isArray(c.replied_comments) && c.replied_comments!.length > 0);
		expect(withReplies).toBeTruthy();
		const out = renderZsxqCommentsHtml([withReplies!], 1);
		// outer blockquote + at least one inner blockquote
		expect((out.match(/<blockquote>/g) || []).length).toBeGreaterThanOrEqual(2);
		// each reply author appears
		for (const r of withReplies!.replied_comments!) {
			expect(out).toContain(`<strong>${r.owner.name}</strong>`);
		}
	});

	it('totalCount drives the header label, even when items array is partial', () => {
		const c: ZsxqComment = {
			comment_id: 1,
			create_time: '2024-01-11T13:23:50.636+0800',
			text: 'x',
			owner: { user_id: 1, name: 'a', avatar_url: '' },
			likes_count: 0,
			group_owner_liked: false,
			topic_owner_liked: false,
			rewards_count: 0,
			sticky: false,
		};
		const out = renderZsxqCommentsHtml([c], 54);
		expect(out).toContain('💬 全部评论（54 条）');
	});

	it('passes comment text through parseZsxqInlineText (decodes <e> tags)', () => {
		const c: ZsxqComment = {
			comment_id: 1,
			create_time: '2024-01-11T13:23:50.636+0800',
			text: 'hi <e type="mention" title="%40bob" />',
			owner: { user_id: 1, name: 'a', avatar_url: '' },
			likes_count: 0,
			group_owner_liked: false,
			topic_owner_liked: false,
			rewards_count: 0,
			sticky: false,
		};
		const out = renderZsxqCommentsHtml([c], 1);
		expect(out).toContain('hi @bob');
		// raw <e> tag should not survive
		expect(out).not.toContain('<e type=');
	});

	it('renders comment images via the same feishu-image://zsxq: protocol', () => {
		const c: ZsxqComment = {
			comment_id: 1,
			create_time: '2024-01-11T13:23:50.636+0800',
			text: '',
			owner: { user_id: 1, name: 'a', avatar_url: '' },
			likes_count: 0,
			group_owner_liked: false,
			topic_owner_liked: false,
			rewards_count: 0,
			sticky: false,
			images: [{ image_id: 11, original: { url: 'https://x/a.jpg' } }],
		};
		const out = renderZsxqCommentsHtml([c], 1);
		expect(out).toContain('feishu-image://zsxq:');
		expect(out).toContain(encodeURIComponent('https://x/a.jpg'));
	});
});

describe('fetchZsxqTopic', () => {
	const originalFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	it('hits the /info endpoint and returns resp_data.topic on success', async () => {
		const fetchMock = vi.fn(async (url: any) => {
			expect(String(url)).toBe('https://api.zsxq.com/v2/topics/12345/info');
			return new Response(JSON.stringify({
				succeeded: true,
				resp_data: { type: 'topic', topic: { topic_id: 12345, type: 'talk', create_time: '', likes_count: 0, comments_count: 0 } },
			}), { status: 200, headers: { 'Content-Type': 'application/json' } });
		});
		globalThis.fetch = fetchMock as any;
		const t = await fetchZsxqTopic('12345');
		expect(t).toBeTruthy();
		expect(t!.topic_id).toBe(12345);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('returns null on non-2xx', async () => {
		globalThis.fetch = vi.fn(async () => new Response('nope', { status: 401 })) as any;
		expect(await fetchZsxqTopic('1')).toBeNull();
	});

	it('returns null when succeeded=false', async () => {
		globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ succeeded: false }), { status: 200 })) as any;
		expect(await fetchZsxqTopic('1')).toBeNull();
	});

	it('returns null on network error', async () => {
		globalThis.fetch = vi.fn(async () => { throw new Error('boom'); }) as any;
		expect(await fetchZsxqTopic('1')).toBeNull();
	});
});

describe('fetchZsxqAllComments', () => {
	const originalFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	function makeComment(id: number, time: string): any {
		return {
			comment_id: id, create_time: time, text: `c${id}`,
			owner: { user_id: 1, name: 'a', avatar_url: '' },
			likes_count: 0, group_owner_liked: false, topic_owner_liked: false,
			rewards_count: 0, sticky: false,
		};
	}

	it('stops when a page returns fewer than 30 comments', async () => {
		const fetchMock = vi.fn(async () => new Response(JSON.stringify({
			succeeded: true,
			resp_data: { comments: [makeComment(1, '2024-01-01T00:00:00+0800')] },
		}), { status: 200 }));
		globalThis.fetch = fetchMock as any;
		const out = await fetchZsxqAllComments('99');
		expect(out).toHaveLength(1);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('paginates with end_time of last comment until a short page', async () => {
		const page1 = Array.from({ length: 30 }, (_, i) => makeComment(i + 1, `2024-01-${String(i + 1).padStart(2, '0')}T00:00:00+0800`));
		const page2 = [makeComment(31, '2024-02-01T00:00:00+0800')];
		const calls: string[] = [];
		globalThis.fetch = vi.fn(async (url: any) => {
			calls.push(String(url));
			const body = calls.length === 1
				? { succeeded: true, resp_data: { comments: page1 } }
				: { succeeded: true, resp_data: { comments: page2 } };
			return new Response(JSON.stringify(body), { status: 200 });
		}) as any;
		const out = await fetchZsxqAllComments('99');
		expect(out).toHaveLength(31);
		expect(calls).toHaveLength(2);
		// 2nd call must carry end_time matching the last comment's create_time.
		expect(calls[1]).toContain('end_time=');
		expect(calls[1]).toContain(encodeURIComponent(page1[page1.length - 1].create_time));
	});

	it('returns [] when first page errors', async () => {
		globalThis.fetch = vi.fn(async () => new Response('boom', { status: 500 })) as any;
		expect(await fetchZsxqAllComments('1')).toEqual([]);
	});
});

describe('fetchZsxqArticleHtml', () => {
	const originalFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	it('extracts the .ql-editor outerHTML from a full SSR page', async () => {
		const wrapped = `<!doctype html><html><body>${articleHtmlFixture}</body></html>`;
		globalThis.fetch = vi.fn(async () => new Response(wrapped, { status: 200 })) as any;
		const out = await fetchZsxqArticleHtml('0rpvzt86eie6');
		expect(out).toBeTruthy();
		expect(out!.startsWith('<div class="content ql-editor">')).toBe(true);
		expect(out!.endsWith('</div>')).toBe(true);
	});

	it('returns null when no ql-editor block is present and background path is unavailable', async () => {
		globalThis.fetch = vi.fn(async () => new Response('<html><body>nope</body></html>', { status: 200 })) as any;
		// browser.runtime.sendMessage will resolve to {} per mock — no html means null.
		const out = await fetchZsxqArticleHtml('xxx');
		expect(out).toBeNull();
	});

	it('returns null on network error', async () => {
		globalThis.fetch = vi.fn(async () => { throw new Error('cors'); }) as any;
		expect(await fetchZsxqArticleHtml('xxx')).toBeNull();
	});
});

describe('resolveZsxqImages', () => {
	const originalFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	it('returns input unchanged when no tokens present', async () => {
		const html = '<p>plain html, no tokens</p>';
		expect(await resolveZsxqImages(html)).toBe(html);
	});

	it('replaces token with base64 data URL on L1 success', async () => {
		const url = 'https://images.zsxq.com/foo.jpg';
		const token = `zsxq:${encodeURIComponent(url)}`;
		const html = `<img alt="1" src="feishu-image://${token}"/>`;

		// Mock fetch to return a tiny blob with image/jpeg.
		globalThis.fetch = vi.fn(async (target: any) => {
			expect(String(target)).toBe(url);
			const data = new Uint8Array([0xff, 0xd8, 0xff]); // jpeg magic
			const blob = new Blob([data], { type: 'image/jpeg' });
			return new Response(blob, { status: 200, headers: { 'Content-Type': 'image/jpeg' } });
		}) as any;

		const out = await resolveZsxqImages(html);
		expect(out).toContain('data:image/jpeg;base64,');
		expect(out).not.toContain('feishu-image://zsxq:');
	});

	it('degrades to raw URL when both L1 and L2 fail', async () => {
		const url = 'https://images.zsxq.com/bar.jpg';
		const token = `zsxq:${encodeURIComponent(url)}`;
		const html = `<img alt="2" src="feishu-image://${token}"/>`;

		// L1 returns ok:false; L2 (browser.runtime.sendMessage in mock) resolves to {}
		// — so no replacement; fall through to L3 raw-URL degradation.
		globalThis.fetch = vi.fn(async () => new Response('nope', { status: 403 })) as any;

		const out = await resolveZsxqImages(html);
		expect(out).not.toContain('feishu-image://zsxq:');
		expect(out).toContain(`src="${url}"`);
	});
});
