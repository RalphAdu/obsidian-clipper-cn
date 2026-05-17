import { describe, it, expect } from 'vitest';
import {
	isZsxqTopicUrl,
	isZsxqArticleUrl,
	parseZsxqUrl,
	parseZsxqInlineText,
} from './zsxq-extractor';

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
