import { createLogger } from './logger';
import { convertBlocksToHtml } from './feishu-extractor';
import type { FeishuBlock } from './feishu-extractor';

const logger = createLogger('scys-extractor');

export function isScysCourseUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		if (parsed.hostname !== 'scys.com') return false;
		if (!/^\/course\/detail\/\d+/.test(parsed.pathname)) return false;
		return /^\d+$/.test(parsed.searchParams.get('chapterId') ?? '');
	} catch {
		return false;
	}
}

export function parseScysUrl(url: string): { courseId: number; chapterId: number } | null {
	try {
		const parsed = new URL(url);
		const pathMatch = parsed.pathname.match(/^\/course\/detail\/(\d+)/);
		const chapterIdStr = parsed.searchParams.get('chapterId');
		if (!pathMatch || !chapterIdStr || !/^\d+$/.test(chapterIdStr)) return null;
		return { courseId: parseInt(pathMatch[1], 10), chapterId: parseInt(chapterIdStr, 10) };
	} catch {
		return null;
	}
}

export interface ScysBlock extends Omit<FeishuBlock, 'children'> {
	children_blocks?: ScysBlock[];
	// scys serves the signed OSS URL as a top-level block field
	// (sibling to `image`, not nested inside it). image.token still
	// carries the feishu-style identifier.
	file_url?: string;
}

const HEADING_REWRITE: Record<number, { newType: number; oldField: keyof ScysBlock; newField: string }> = {
	6: { newType: 4, oldField: 'heading4', newField: 'heading2' },
	7: { newType: 5, oldField: 'heading5', newField: 'heading3' },
	8: { newType: 6, oldField: 'heading6', newField: 'heading4' },
};

export function flattenScysBlocks(blocks: ScysBlock[]): FeishuBlock[] {
	const out: FeishuBlock[] = [];

	function walk(block: ScysBlock, parentId?: string): void {
		const childBlocks = block.children_blocks ?? [];
		const childIds = childBlocks.map(c => c.block_id);

		// Shallow copy without children_blocks
		const { children_blocks: _drop, ...rest } = block;
		const flat: any = { ...rest, parent_id: parentId, children: childIds.length ? childIds : undefined };

		// Heading rewrite (block_type 6/7/8 → 4/5/6, copy body to new field name)
		const rewrite = HEADING_REWRITE[flat.block_type];
		if (rewrite) {
			const body = flat[rewrite.oldField];
			if (body === undefined) {
				logger.warn(`heading rewrite: missing ${rewrite.oldField} on block ${block.block_id}`);
			}
			flat[rewrite.newField] = body;
			delete flat[rewrite.oldField];
			flat.block_type = rewrite.newType;
		}

		// Image: inject scys: prefixed token from top-level file_url
		// (scys serves the OSS signed URL alongside the image block, not inside image)
		if (flat.block_type === 27 && flat.file_url) {
			flat.image = { ...flat.image, token: `scys:${encodeURIComponent(flat.file_url)}` };
		}

		out.push(flat as FeishuBlock);
		for (const child of childBlocks) walk(child, block.block_id);
	}

	for (const b of blocks) walk(b);
	return out;
}

export function renderScysChapterContent(scysBlocks: ScysBlock[]): string {
	const flat = flattenScysBlocks(scysBlocks);
	// scys API doesn't include a PAGE block, so synthesise one so convertBlocksToHtml
	// uses the renderChildren(pageBlock.children, blockMap) path. Otherwise it falls
	// back to iterating the entire flat array, which re-renders content nested inside
	// callout/table/grid/quote_container containers (double output).
	const rootIds = scysBlocks.map(b => b.block_id);
	const FEISHU_PAGE_TYPE = 1;
	const page: FeishuBlock = {
		block_id: '__scys_page__',
		block_type: FEISHU_PAGE_TYPE,
		children: rootIds,
	};
	return convertBlocksToHtml([page, ...flat]);
}

async function blobToDataUrl(blob: Blob): Promise<string> {
	// Avoid FileReader so this works in both browser content scripts and the
	// node test runner (vitest is not configured with jsdom). Same pattern as
	// background.ts fetchFeishuImagesViaMainWorld L807-813.
	const buf = await blob.arrayBuffer();
	const bytes = new Uint8Array(buf);
	let bin = '';
	for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
	const base64 = btoa(bin);
	// Default to image/png when blob.type is missing — application/octet-stream
	// would make the browser treat the data URL as a download, not an inline <img>.
	// Matches background.ts:807-813 pattern for feishu images.
	const mime = blob.type || 'image/png';
	return `data:${mime};base64,${base64}`;
}

async function fetchScysImageL1(scysToken: string): Promise<string | null> {
	const fileUrl = decodeURIComponent(scysToken.replace(/^scys:/, ''));
	try {
		const res = await fetch(fileUrl, { credentials: 'include' });
		if (!res.ok) {
			const display = fileUrl.length > 80 ? fileUrl.slice(0, 80) + '...' : fileUrl;
			logger.warn(`[scys-img L1] HTTP ${res.status} for ${display}`);
			return null;
		}
		const blob = await res.blob();
		return await blobToDataUrl(blob);
	} catch (err) {
		logger.warn(`[scys-img L1] fetch error: ${String(err)}`);
		return null;
	}
}

export async function resolveScysImages(html: string): Promise<string> {
	const tokenPattern = /feishu-image:\/\/(scys:[^"'\s>]+)/g;
	const tokens = new Set<string>();
	let match: RegExpExecArray | null;
	while ((match = tokenPattern.exec(html)) !== null) {
		tokens.add(match[1]);
	}
	if (tokens.size === 0) return html;

	const replacements = new Map<string, string>();
	await Promise.all(
		Array.from(tokens).map(async (token) => {
			const dataUrl = await fetchScysImageL1(token);
			if (dataUrl) replacements.set(token, dataUrl);
		})
	);

	let resolved = html;
	for (const [token, dataUrl] of replacements) {
		resolved = resolved.split(`feishu-image://${token}`).join(dataUrl);
	}
	return resolved;
}
