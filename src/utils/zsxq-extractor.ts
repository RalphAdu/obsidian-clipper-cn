import browser from 'webextension-polyfill';
import { createLogger } from './logger';

const logger = createLogger('zsxq-extractor');

// ─── URL detection ────────────────────────────────────────────────────────────
// zsxq topic page:   https://wx.zsxq.com/group/{groupId}/topic/{topicId}
// zsxq article page: https://wx.zsxq.com/group/{groupId}/article/{articleId}
// groupId is always numeric; topicId is numeric (15-ish digits);
// articleId is a short alphanumeric token (e.g. "0rpvzt86eie6").

export function isZsxqTopicUrl(url: string): boolean {
	try {
		const u = new URL(url);
		if (u.hostname !== 'wx.zsxq.com') return false;
		return /^\/group\/\d+\/topic\/\d+\/?$/.test(u.pathname);
	} catch {
		return false;
	}
}

export function isZsxqArticleUrl(url: string): boolean {
	try {
		const u = new URL(url);
		if (u.hostname !== 'wx.zsxq.com') return false;
		return /^\/group\/\d+\/article\/[A-Za-z0-9]+\/?$/.test(u.pathname);
	} catch {
		return false;
	}
}

export type ZsxqUrlInfo =
	| { kind: 'topic'; groupId: string; topicId: string }
	| { kind: 'article'; groupId: string; articleId: string };

export function parseZsxqUrl(url: string): ZsxqUrlInfo | null {
	try {
		const u = new URL(url);
		if (u.hostname !== 'wx.zsxq.com') return null;
		const topicMatch = u.pathname.match(/^\/group\/(\d+)\/topic\/(\d+)\/?$/);
		if (topicMatch) {
			return { kind: 'topic', groupId: topicMatch[1], topicId: topicMatch[2] };
		}
		const articleMatch = u.pathname.match(/^\/group\/(\d+)\/article\/([A-Za-z0-9]+)\/?$/);
		if (articleMatch) {
			return { kind: 'article', groupId: articleMatch[1], articleId: articleMatch[2] };
		}
		return null;
	} catch {
		return null;
	}
}
