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

// ─── Inline text parsing ──────────────────────────────────────────────────────
// zsxq text fields embed self-closing <e> tags for hashtags, mentions, emoji
// and inline web links, plus the usual <br> and HTML entities. Convert all of
// that into plain markdown text without DOM dependencies (vitest runs in pure
// node — no jsdom). The <e> tag attributes are always URL-encoded.

function safeDecode(s: string): string {
	try { return decodeURIComponent(s); } catch { return s; }
}

function decodeBasicEntities(s: string): string {
	return s
		.replace(/&nbsp;/g, ' ')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, '\'')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&amp;/g, '&');
}

export function parseZsxqInlineText(text: string): string {
	if (!text) return '';
	let out = text;

	// 1. <e type="..." ... /> tags (self-closing, no nesting).
	out = out.replace(/<e\s+([^>]*?)\/?>/g, (_m, attrsRaw: string) => {
		// Parse attributes loosely: key="value" pairs.
		const attrs: Record<string, string> = {};
		const attrRe = /(\w+)="([^"]*)"/g;
		let m: RegExpExecArray | null;
		while ((m = attrRe.exec(attrsRaw)) !== null) {
			attrs[m[1]] = m[2];
		}
		const type = attrs.type ?? '';
		const title = attrs.title ? safeDecode(attrs.title) : '';
		const href = attrs.href ? safeDecode(attrs.href) : '';
		switch (type) {
			case 'hashtag':
				// title usually already wraps the term in #…#
				return title || '';
			case 'mention':
				// title usually already starts with @
				return title || '';
			case 'emoji':
				return title || '[表情]';
			case 'web':
				if (href) {
					return `[${title || href}](${href})`;
				}
				return title;
			default:
				return '';
		}
	});

	// 2. <br> / <br/> → newline.
	out = out.replace(/<br\s*\/?>/gi, '\n');

	// 3. HTML entities.
	out = decodeBasicEntities(out);

	return out;
}

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
