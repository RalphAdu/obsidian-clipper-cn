import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
	isZsxqTopicUrl,
	isZsxqArticleUrl,
	parseZsxqUrl,
	parseZsxqInlineText,
	renderZsxqTopicBodyHtml,
	type ZsxqTopic,
} from './zsxq-extractor';

const FIXTURE_DIR = join(__dirname, 'fixtures');
const topicFixture = JSON.parse(
	readFileSync(join(FIXTURE_DIR, 'zsxq-topic-185414442218552.json'), 'utf8'),
);
const articleHtmlFixture = readFileSync(
	join(FIXTURE_DIR, 'zsxq-article-qleditor-0rpvzt86eie6.html'),
	'utf8',
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
