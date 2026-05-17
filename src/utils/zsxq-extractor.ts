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

// ─── Topic / comment / image / file types (mirror zsxq API shape) ───────────

export interface ZsxqUser {
	user_id: number;
	name: string;
	avatar_url: string;
	alias?: string;
	location?: string;
}

export interface ZsxqImage {
	image_id: number;
	thumbnail?: { url: string };
	large?: { url: string };
	original?: { url: string };
}

export interface ZsxqFile {
	file_id: number;
	name: string;
	download_url?: string;
}

export interface ZsxqArticleRef {
	title: string;
	article_id: string;
	article_url: string;
	inline_article_url?: string;
}

export interface ZsxqTalkBody {
	owner: ZsxqUser;
	text: string;
	images?: ZsxqImage[];
	files?: ZsxqFile[];
	article?: ZsxqArticleRef;
}

export interface ZsxqQABody {
	owner: ZsxqUser;
	text: string;
	images?: ZsxqImage[];
	files?: ZsxqFile[];
}

export type ZsxqTopicType = 'talk' | 'q&a' | 'task' | 'solution' | string;

export interface ZsxqTopic {
	topic_id: number;
	type: ZsxqTopicType;
	create_time: string;
	group?: { group_id: number; name: string };
	title?: string;
	likes_count: number;
	comments_count: number;
	talk?: ZsxqTalkBody;
	question?: ZsxqQABody;
	answer?: ZsxqQABody;
	task?: ZsxqQABody;
	solution?: ZsxqQABody;
}

// ─── Topic body rendering ────────────────────────────────────────────────────

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function pickImageUrl(img: ZsxqImage): string | null {
	return img.original?.url || img.large?.url || img.thumbnail?.url || null;
}

// Emit an <img> with the feishu-image://zsxq:{encoded-url} protocol placeholder
// that resolveZsxqImages replaces with a base64 data URL.
function renderImage(img: ZsxqImage): string {
	const url = pickImageUrl(img);
	if (!url) return '';
	return `<img alt="${img.image_id}" src="feishu-image://zsxq:${encodeURIComponent(url)}"/>`;
}

function renderImages(images?: ZsxqImage[]): string {
	if (!images || images.length === 0) return '';
	return images.map(img => `<p>${renderImage(img)}</p>`).join('');
}

function renderFiles(files?: ZsxqFile[]): string {
	if (!files || files.length === 0) return '';
	const items = files.map(f => {
		const safeName = escapeHtml(f.name || `file-${f.file_id}`);
		if (f.download_url) {
			return `<li>📎 <a href="${f.download_url}">${safeName}</a></li>`;
		}
		return `<li>📎 ${safeName}</li>`;
	}).join('');
	return `<ul>${items}</ul>`;
}

// Convert a zsxq text field (raw, possibly with <e>/<br>/entities) into a
// sequence of <p>…</p> paragraphs. Escapes HTML in the plain segments so
// user-supplied < > don't break out into markup. Markdown produced by
// parseZsxqInlineText (e.g. [text](url) for web tags) is preserved as-is —
// downstream defuddle createMarkdownContent will treat the output as HTML and
// pass the bracketed text through.
function renderTextAsParagraphs(text: string): string {
	const plain = parseZsxqInlineText(text || '');
	if (!plain.trim()) return '';
	const paragraphs = plain.split(/\n\n+/).map(s => s.trim()).filter(Boolean);
	return paragraphs.map(p => `<p>${escapeHtml(p).replace(/\n/g, '<br/>')}</p>`).join('');
}

export function renderZsxqTopicBodyHtml(topic: ZsxqTopic, articleBodyHtml: string | null): string {
	const t = topic.type;

	if (t === 'q&a') {
		const q = topic.question;
		const a = topic.answer;
		const parts: string[] = [];
		parts.push('<h2>🙋 提问</h2>');
		if (q) {
			parts.push(renderTextAsParagraphs(q.text));
			parts.push(renderImages(q.images));
			parts.push(renderFiles(q.files));
		}
		parts.push('<h2>💡 回答</h2>');
		if (a) {
			parts.push(renderTextAsParagraphs(a.text));
			parts.push(renderImages(a.images));
			parts.push(renderFiles(a.files));
		}
		return parts.join('');
	}

	// talk / task / solution all share the same "owner + text + media" shape.
	const body =
		(t === 'talk' && topic.talk) ||
		(t === 'task' && topic.task) ||
		(t === 'solution' && topic.solution) ||
		topic.talk ||
		topic.task ||
		topic.solution;

	if (!body) return '';

	const parts: string[] = [];
	const talkBody = body as ZsxqTalkBody;

	// If a real article body is supplied, use it as the primary content and
	// quote the truncated talk.text teaser above. Otherwise paragraph-ize the
	// (full or partial) talk.text directly.
	if (talkBody.article && articleBodyHtml) {
		const teaser = parseZsxqInlineText(talkBody.text || '').trim();
		if (teaser) {
			parts.push(`<blockquote><p>${escapeHtml(teaser).replace(/\n/g, '<br/>')}</p></blockquote>`);
		}
		parts.push(articleBodyHtml);
	} else {
		parts.push(renderTextAsParagraphs(body.text || ''));
	}

	parts.push(renderImages(body.images));
	parts.push(renderFiles(body.files));

	return parts.join('');
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
