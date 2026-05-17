import { describe, it, expect } from 'vitest';
import {
	isZsxqTopicUrl,
	isZsxqArticleUrl,
	parseZsxqUrl,
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
