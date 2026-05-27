import {
	isSectionHeaderText,
	type FeishuBlock,
} from '../../src/utils/feishu-extractor';
import {
	authorTagFromOpenId,
	formatCommentTime,
	type FeishuComment,
} from '../../src/utils/feishu-comments';

// Block-type constants (must match feishu-extractor's FEISHU_BLOCK_TYPE).
const TYPE = {
	PAGE: 1, TEXT: 2, HEADING1: 3, BULLET: 12, ORDERED: 13, IFRAME: 26,
} as const;

export type ExpectedUnit =
	| { kind: 'h1_numbered'; seq: number; title: string; blockId: string }
	| { kind: 'mention_link'; url: string; title: string; blockId: string }
	| { kind: 'iframe_link'; url: string; blockId: string }
	| { kind: 'section_header_standalone'; text: string; blockId: string }
	| { kind: 'ol_item'; text: string; blockId: string }
	| { kind: 'ul_item'; text: string; blockId: string }
	| { kind: 'comments_section_present'; expectedCount: number }
	| { kind: 'comment_thread'; commentId: string; firstReplyText: string; isSolved: boolean; authorTag: string; timestamp: string }
	| { kind: 'comment_image'; commentId: string; replyId: string; imageToken: string }
	| { kind: 'no_placeholder' }
	| { kind: 'no_invalid_image_mime' }
	| { kind: 'no_unresolved_image' }
	| { kind: 'frontmatter_present' };

function textOf(elements: any[] | undefined): string {
	if (!elements) return '';
	return elements
		.map((e: any) => e.text_run?.content || e.mention_doc?.title || e.equation?.content || '')
		.join('')
		.trim();
}

function getAnyElements(block: FeishuBlock): any[] {
	const bodies = [
		block.text, block.heading1, block.heading2, block.heading3,
		block.heading4, block.heading5, block.heading6, block.heading7,
		block.heading8, block.heading9, block.bullet, block.ordered,
		block.quote, block.callout, block.todo, block.code,
	];
	for (const body of bodies) {
		if (body && Array.isArray((body as any).elements)) return (body as any).elements;
	}
	return [];
}

function commentReplyText(reply: any): string {
	const elems = reply?.content?.elements || [];
	return elems
		.map((e: any) => {
			if (e.type === 'text_run') return e.text_run?.text || '';
			if (e.type === 'docs_link' && e.docs_link) return e.docs_link.title || e.docs_link.url || '';
			return '';
		})
		.join('')
		.trim();
}

export function deriveExpected(blocks: FeishuBlock[], comments: FeishuComment[]): ExpectedUnit[] {
	const expected: ExpectedUnit[] = [{ kind: 'no_placeholder' }];

	let h1Seq = 0;
	for (const b of blocks) {
		if (b.block_type === TYPE.HEADING1) {
			h1Seq += 1;
			const title = textOf(b.heading1?.elements);
			expected.push({ kind: 'h1_numbered', seq: h1Seq, title, blockId: b.block_id });
		}

		for (const e of getAnyElements(b)) {
			if (e.mention_doc?.title && e.mention_doc.url) {
				expected.push({
					kind: 'mention_link',
					url: e.mention_doc.url,
					title: e.mention_doc.title,
					blockId: b.block_id,
				});
			}
		}

		if (b.block_type === TYPE.IFRAME) {
			const raw = (b as any).iframe?.component?.url as string | undefined;
			if (raw) {
				try { expected.push({ kind: 'iframe_link', url: decodeURIComponent(raw), blockId: b.block_id }); } catch { /* malformed url */ }
			}
		}

		if (b.block_type === TYPE.TEXT && isSectionHeaderText(b)) {
			expected.push({ kind: 'section_header_standalone', text: textOf(b.text?.elements), blockId: b.block_id });
		}

		if (b.block_type === TYPE.ORDERED) {
			expected.push({ kind: 'ol_item', text: textOf(b.ordered?.elements), blockId: b.block_id });
		}

		if (b.block_type === TYPE.BULLET) {
			expected.push({ kind: 'ul_item', text: textOf(b.bullet?.elements), blockId: b.block_id });
		}
	}

	if (comments.length > 0) {
		expected.push({ kind: 'comments_section_present', expectedCount: comments.length });
	}
	for (const c of comments) {
		const replies = c.reply_list?.replies || [];
		if (replies.length === 0) continue;
		const head = replies[0];
		expected.push({
			kind: 'comment_thread',
			commentId: c.comment_id,
			firstReplyText: commentReplyText(head),
			isSolved: c.is_solved,
			authorTag: authorTagFromOpenId(head.user_id),
			timestamp: formatCommentTime(head.create_time),
		});
		for (const r of replies) {
			for (const t of r.extra?.image_list || []) {
				expected.push({ kind: 'comment_image', commentId: c.comment_id, replyId: r.reply_id, imageToken: t });
			}
		}
	}

	expected.push({ kind: 'no_invalid_image_mime' });
	expected.push({ kind: 'no_unresolved_image' });
	expected.push({ kind: 'frontmatter_present' });

	return expected;
}
