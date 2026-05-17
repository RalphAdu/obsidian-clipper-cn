import browser from './browser-polyfill';
import { createLogger } from './logger';

const logger = createLogger('FeishuComments');

export interface FeishuCommentElement {
	type: 'text_run' | 'docs_link' | 'person' | string;
	text_run?: { text?: string };
	docs_link?: { url?: string; title?: string } | null;
	person?: { user_id?: string } | null;
}

export interface FeishuCommentReply {
	reply_id: string;
	create_time: number;
	user_id: string;
	content: { elements: FeishuCommentElement[] };
	extra?: { image_list?: string[] };
}

export interface FeishuComment {
	comment_id: string;
	create_time: number;
	is_solved: boolean;
	is_whole: boolean;
	user_id: string;
	solver_user_id?: string | null;
	reply_list: { replies: FeishuCommentReply[] };
}

export interface CommentImage {
	mime: string;
	base64: string;
}

/**
 * Returns "评论者 <last 8 chars of open_id>". Stable identifier when the
 * App cannot resolve names (lacks contact:user.base:readonly permission).
 */
export function authorTagFromOpenId(openId: string): string {
	const suffix = openId.length >= 8 ? openId.slice(-8) : openId;
	return `评论者 ${suffix}`;
}

/**
 * Formats unix seconds as "YYYY-MM-DD HH:MM" in UTC+8 (Feishu users are
 * predominantly in mainland China / HK / TW).
 */
export function formatCommentTime(unixSeconds: number): string {
	const d = new Date(unixSeconds * 1000);
	const utc8 = new Date(d.getTime() + 8 * 60 * 60 * 1000);
	return utc8.toISOString().slice(0, 16).replace('T', ' ');
}

/**
 * Renders a single reply's content elements to a markdown fragment.
 * Unsupported element types (docs_link, person) degrade to a [<type>] tag.
 */
function renderCommentElements(elements: FeishuCommentElement[]): string {
	return elements.map((el) => {
		if (el.type === 'text_run') return el.text_run?.text || '';
		if (el.type === 'docs_link' && el.docs_link?.url) {
			return `[${el.docs_link.title || el.docs_link.url}](${el.docs_link.url})`;
		}
		if (el.type === 'person') return '[@某人]';
		return `[${el.type}]`;
	}).join('');
}

/**
 * Wraps a text block into callout-quoted lines (each line prefixed `> `).
 */
function quoteLines(text: string): string {
	if (text === '') return '>';
	return text.split('\n').map((l) => l === '' ? '>' : `> ${l}`).join('\n');
}

/**
 * Renders a comment thread as one Obsidian callout. Multi-reply threads
 * list each reply in order with a bolded `**author · time**` separator.
 * Images embed as data: URIs when imageMap has them, else a placeholder.
 */
function renderOneThread(comment: FeishuComment, imageMap: Map<string, CommentImage>): string {
	const calloutKind = comment.is_solved ? 'success' : 'quote';
	const replies = comment.reply_list?.replies || [];
	if (replies.length === 0) return '';

	const headReply = replies[0];
	const headAuthor = authorTagFromOpenId(headReply.user_id);
	const headTime = formatCommentTime(headReply.create_time);
	const lines: string[] = [];
	lines.push(`> [!${calloutKind}]+ ${headAuthor} · ${headTime}`);

	const renderReplyBody = (reply: FeishuCommentReply): string[] => {
		const out: string[] = [];
		const text = renderCommentElements(reply.content?.elements || []);
		if (text) out.push(...quoteLines(text).split('\n'));
		const imgs = reply.extra?.image_list || [];
		for (const token of imgs) {
			if (out.length > 0) out.push('>');
			const img = imageMap.get(token);
			if (img) {
				out.push(`> ![](data:${img.mime};base64,${img.base64})`);
			} else {
				out.push('> *[评论图片加载失败]*');
			}
		}
		return out;
	};

	lines.push(...renderReplyBody(headReply));

	for (const reply of replies.slice(1)) {
		lines.push('>'); // blank line between replies inside same callout
		const author = authorTagFromOpenId(reply.user_id);
		const time = formatCommentTime(reply.create_time);
		lines.push(`> **${author} · ${time}**`);
		lines.push(...renderReplyBody(reply));
	}

	return lines.join('\n');
}

/**
 * Renders the full comments section: `---` + `## 评论` + each thread as
 * a callout, separated by blank lines. Returns empty string when there
 * are no comments — caller can append unconditionally.
 */
export function renderCommentsMarkdown(comments: FeishuComment[], imageMap: Map<string, CommentImage>): string {
	if (!comments.length) return '';
	const threads = comments
		.map((c) => renderOneThread(c, imageMap))
		.filter((s) => s.length > 0);
	if (threads.length === 0) return '';
	return `---\n\n## 评论\n\n${threads.join('\n\n')}`;
}

/**
 * Fetches all comments for a docx document via the OpenAPI. Paginates.
 * Routes through background.ts (same channel as fetchFeishuApi).
 */
export async function fetchFeishuComments(documentId: string): Promise<FeishuComment[]> {
	const all: FeishuComment[] = [];
	let pageToken: string | undefined;
	while (true) {
		const params = new URLSearchParams({ file_type: 'docx', page_size: '100' });
		if (pageToken) params.set('page_token', pageToken);
		const url = `https://open.feishu.cn/open-apis/drive/v1/files/${documentId}/comments?${params}`;
		const resp = await browser.runtime.sendMessage({ action: 'fetchFeishuApi', url }) as {
			success?: boolean;
			data?: { items?: FeishuComment[]; page_token?: string; has_more?: boolean };
			error?: string;
		};
		if (!resp?.success || !resp.data) {
			logger.warn(`Comments fetch failed: ${resp?.error || 'unknown'}`);
			break;
		}
		all.push(...(resp.data.items || []));
		if (!resp.data.has_more || !resp.data.page_token) break;
		pageToken = resp.data.page_token;
	}
	return all;
}

/**
 * Fetches a comment-image as base64 via the drive/v1/medias/{token}/download
 * endpoint (different from doc-body image extraction, which uses page-runtime).
 */
export async function fetchFeishuCommentImage(token: string): Promise<CommentImage | null> {
	const resp = await browser.runtime.sendMessage({ action: 'fetchFeishuCommentImage', token }) as {
		success?: boolean;
		mime?: string;
		base64?: string;
		error?: string;
	};
	if (!resp?.success || !resp.base64) {
		logger.warn(`Comment image fetch failed [${token}]: ${resp?.error || 'unknown'}`);
		return null;
	}
	return { mime: resp.mime || 'image/png', base64: resp.base64 };
}

/**
 * Top-level entry. Fetches comments + all their images, then renders to
 * markdown. Returns empty string when there are no comments.
 */
export async function extractFeishuComments(documentId: string): Promise<string> {
	const comments = await fetchFeishuComments(documentId);
	if (!comments.length) return '';

	const tokens = new Set<string>();
	for (const c of comments) {
		for (const r of c.reply_list?.replies || []) {
			for (const t of r.extra?.image_list || []) tokens.add(t);
		}
	}

	const imageMap = new Map<string, CommentImage>();
	await Promise.all(
		Array.from(tokens).map(async (t) => {
			const img = await fetchFeishuCommentImage(t);
			if (img) imageMap.set(t, img);
		}),
	);

	return renderCommentsMarkdown(comments, imageMap);
}
