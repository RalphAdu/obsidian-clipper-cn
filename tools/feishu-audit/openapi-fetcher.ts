import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseFeishuUrl, type FeishuBlock } from '../../src/utils/feishu-extractor';
import type { FeishuComment, CommentImage } from '../../src/utils/feishu-comments';

interface Creds { id: string; secret: string }

const CREDS_PATH = resolve(process.cwd(), 'docs/superpowers/feishu.md');

export function loadCreds(): Creds {
	const raw = readFileSync(CREDS_PATH, 'utf8');
	const id = raw.match(/^id:\s*(\S+)/m)?.[1];
	const secret = raw.match(/^secret:\s*(\S+)/m)?.[1];
	if (!id || !secret) throw new Error(`feishu.md missing id/secret at ${CREDS_PATH}`);
	return { id, secret };
}

export async function getTenantAccessToken(creds: Creds): Promise<string> {
	const resp = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ app_id: creds.id, app_secret: creds.secret }),
	});
	const data = await resp.json() as { tenant_access_token?: string; msg?: string };
	if (!data.tenant_access_token) throw new Error(`tenant token fetch failed: ${data.msg || JSON.stringify(data)}`);
	return data.tenant_access_token;
}

/**
 * Resolve a doc URL to its docx documentId. Supports /docx/{id} directly and
 * /wiki/{token} via the wiki.v2.space.node API (which returns the underlying
 * obj_token + obj_type for the wiki node, then we use that docx token).
 */
export async function resolveDocumentId(token: string, accessToken: string, type: 'docx' | 'wiki' | 'doc'): Promise<string> {
	if (type === 'docx') return token;
	if (type === 'wiki') {
		const url = `https://open.feishu.cn/open-apis/wiki/v2/spaces/get_node?token=${token}`;
		const resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
		const data = await resp.json() as { data?: { node?: { obj_token?: string; obj_type?: string } }; msg?: string; code?: number };
		if (data.code !== 0 || !data.data?.node?.obj_token) {
			throw new Error(`wiki node resolve failed (code=${data.code}): ${data.msg || JSON.stringify(data)}`);
		}
		const node = data.data.node;
		if (node.obj_type !== 'docx') {
			throw new Error(`wiki node is type "${node.obj_type}", not docx — audit only supports docx nodes`);
		}
		return node.obj_token;
	}
	throw new Error(`feishu-audit does not support URL type "${type}"`);
}

export async function fetchAllBlocks(documentId: string, accessToken: string): Promise<FeishuBlock[]> {
	const all: FeishuBlock[] = [];
	let pageToken = '';
	while (true) {
		const params = new URLSearchParams({ page_size: '500' });
		if (pageToken) params.set('page_token', pageToken);
		const url = `https://open.feishu.cn/open-apis/docx/v1/documents/${documentId}/blocks?${params}`;
		const resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
		const data = await resp.json() as { data?: { items?: FeishuBlock[]; page_token?: string; has_more?: boolean }; msg?: string };
		if (!data.data) throw new Error(`blocks fetch failed: ${data.msg || JSON.stringify(data)}`);
		all.push(...(data.data.items || []));
		if (!data.data.has_more || !data.data.page_token) break;
		pageToken = data.data.page_token;
	}
	return all;
}

export async function fetchAllComments(documentId: string, accessToken: string): Promise<FeishuComment[]> {
	const all: FeishuComment[] = [];
	let pageToken = '';
	while (true) {
		const params = new URLSearchParams({ file_type: 'docx', page_size: '100' });
		if (pageToken) params.set('page_token', pageToken);
		const url = `https://open.feishu.cn/open-apis/drive/v1/files/${documentId}/comments?${params}`;
		const resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
		const data = await resp.json() as { data?: { items?: FeishuComment[]; page_token?: string; has_more?: boolean }; msg?: string; code?: number };
		if (data.code !== 0) {
			// Comments endpoint may 403 if App lacks permission — degrade to empty list.
			console.error(`[audit] comments fetch returned code=${data.code} msg=${data.msg} — assuming no comments`);
			break;
		}
		all.push(...(data.data?.items || []));
		if (!data.data?.has_more || !data.data.page_token) break;
		pageToken = data.data.page_token;
	}
	return all;
}

export async function fetchCommentImage(token: string, accessToken: string): Promise<CommentImage | null> {
	const url = `https://open.feishu.cn/open-apis/drive/v1/medias/${encodeURIComponent(token)}/download`;
	const resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
	if (!resp.ok) return null;
	const mime = resp.headers.get('content-type') || 'image/png';
	const buf = Buffer.from(await resp.arrayBuffer());
	return { mime, base64: buf.toString('base64') };
}

/**
 * One-shot orchestrator. Resolves URL → fetches blocks, comments, comment images.
 */
export async function fetchDoc(docUrl: string): Promise<{ blocks: FeishuBlock[]; comments: FeishuComment[]; commentImages: Map<string, CommentImage> }> {
	const parsed = parseFeishuUrl(docUrl);
	if (!parsed.token || !parsed.type) throw new Error(`bad feishu URL: ${docUrl}`);
	const creds = loadCreds();
	const accessToken = await getTenantAccessToken(creds);
	const documentId = await resolveDocumentId(parsed.token, accessToken, parsed.type);

	const [blocks, comments] = await Promise.all([
		fetchAllBlocks(documentId, accessToken),
		fetchAllComments(documentId, accessToken),
	]);

	const tokens = new Set<string>();
	for (const c of comments) {
		for (const r of c.reply_list?.replies || []) {
			for (const t of r.extra?.image_list || []) tokens.add(t);
		}
	}
	const commentImages = new Map<string, CommentImage>();
	await Promise.all(
		Array.from(tokens).map(async (t) => {
			const img = await fetchCommentImage(t, accessToken);
			if (img) commentImages.set(t, img);
		}),
	);

	return { blocks, comments, commentImages };
}
