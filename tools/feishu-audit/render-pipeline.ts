import TurndownService from 'turndown';
import { convertBlocksToHtml, type FeishuBlock } from '../../src/utils/feishu-extractor';
import { renderCommentsMarkdown, type FeishuComment, type CommentImage } from '../../src/utils/feishu-comments';

const turndown = new TurndownService({
	headingStyle: 'atx',
	bulletListMarker: '-',
	codeBlockStyle: 'fenced',
	emDelimiter: '*',
});

export interface RenderInput {
	blocks: FeishuBlock[];
	comments: FeishuComment[];
	commentImages: Map<string, CommentImage>;
}

export function renderToMarkdown(input: RenderInput): string {
	const html = convertBlocksToHtml(input.blocks);
	let md = turndown.turndown(html);
	const commentsMd = renderCommentsMarkdown(input.comments, input.commentImages);
	if (commentsMd) md = `${md}\n\n${commentsMd}`;
	return md;
}
