import { describe, it, expect } from 'vitest';
import { renderCommentsMarkdown, formatCommentTime, authorTagFromOpenId, type FeishuComment } from './feishu-comments';

describe('formatCommentTime', () => {
	it('formats unix seconds to YYYY-MM-DD HH:MM in UTC+8', () => {
		// 2026-03-04 14:30:00 UTC+8 = 2026-03-04T06:30:00Z = unix 1772605800
		expect(formatCommentTime(1772605800)).toBe('2026-03-04 14:30');
	});
});

describe('authorTagFromOpenId', () => {
	it('returns "评论者 <last 8 chars>"', () => {
		expect(authorTagFromOpenId('ou_f1ebfcb23370fe6807d07fdce978194e')).toBe('评论者 e978194e');
	});
});

describe('renderCommentsMarkdown', () => {
	it('returns empty string when comments are empty', () => {
		expect(renderCommentsMarkdown([], new Map())).toBe('');
	});

	it('renders single-reply unsolved thread as a [!quote]+ callout', () => {
		const comments: FeishuComment[] = [
			{
				comment_id: 'c1',
				create_time: 1772605800,
				is_solved: false,
				is_whole: true,
				user_id: 'ou_aaaaaaaaaaaaaaaaaaa_a56fe915',
				solver_user_id: null,
				reply_list: {
					replies: [
						{
							reply_id: 'r1',
							create_time: 1772605800,
							user_id: 'ou_aaaaaaaaaaaaaaaaaaa_a56fe915',
							content: { elements: [{ type: 'text_run', text_run: { text: '柳暗花明又一村' } }] },
							extra: { image_list: [] },
						},
					],
				},
			},
		];
		const md = renderCommentsMarkdown(comments, new Map());
		expect(md).toContain('---\n\n## 评论\n');
		expect(md).toContain('> [!quote]+ 评论者 a56fe915 · 2026-03-04 14:30');
		expect(md).toContain('> 柳暗花明又一村');
	});

	it('renders solved thread as [!success]+ callout', () => {
		const comments: FeishuComment[] = [
			{
				comment_id: 'c1',
				create_time: 1772605800,
				is_solved: true,
				is_whole: true,
				user_id: 'ou_aaaaaaa_solved01',
				solver_user_id: 'ou_solver',
				reply_list: {
					replies: [
						{
							reply_id: 'r1',
							create_time: 1772605800,
							user_id: 'ou_aaaaaaa_solved01',
							content: { elements: [{ type: 'text_run', text_run: { text: 'done' } }] },
							extra: { image_list: [] },
						},
					],
				},
			},
		];
		const md = renderCommentsMarkdown(comments, new Map());
		expect(md).toContain('> [!success]+ 评论者 solved01 · 2026-03-04 14:30');
	});

	it('renders multi-reply thread with timeline-style nested entries', () => {
		const comments: FeishuComment[] = [
			{
				comment_id: 'c1',
				create_time: 1772605800,
				is_solved: false,
				is_whole: true,
				user_id: 'ou_user01_xxxxxxxx_aaaa1111',
				solver_user_id: null,
				reply_list: {
					replies: [
						{
							reply_id: 'r1',
							create_time: 1772605800,
							user_id: 'ou_user01_xxxxxxxx_aaaa1111',
							content: { elements: [{ type: 'text_run', text_run: { text: 'first reply' } }] },
							extra: { image_list: [] },
						},
						{
							reply_id: 'r2',
							create_time: 1772609400,
							user_id: 'ou_user02_yyyyyyyy_bbbb2222',
							content: { elements: [{ type: 'text_run', text_run: { text: 'second reply' } }] },
							extra: { image_list: [] },
						},
					],
				},
			},
		];
		const md = renderCommentsMarkdown(comments, new Map());
		expect(md).toContain('> [!quote]+ 评论者 aaaa1111 · 2026-03-04 14:30');
		expect(md).toContain('> first reply');
		expect(md).toContain('> **评论者 bbbb2222 · 2026-03-04 15:30**');
		expect(md).toContain('> second reply');
	});

	it('renders comment image as base64 data URI when provided in image map', () => {
		const tinyPng = Buffer.from('89504e470d0a1a0a', 'hex');
		const imageMap = new Map<string, { mime: string; base64: string }>();
		imageMap.set('img-token', { mime: 'image/png', base64: tinyPng.toString('base64') });

		const comments: FeishuComment[] = [
			{
				comment_id: 'c1',
				create_time: 1772605800,
				is_solved: false,
				is_whole: true,
				user_id: 'ou_user_img_test',
				solver_user_id: null,
				reply_list: {
					replies: [
						{
							reply_id: 'r1',
							create_time: 1772605800,
							user_id: 'ou_user_img_test',
							content: { elements: [{ type: 'text_run', text_run: { text: 'see screenshot' } }] },
							extra: { image_list: ['img-token'] },
						},
					],
				},
			},
		];
		const md = renderCommentsMarkdown(comments, imageMap);
		expect(md).toContain(`![](data:image/png;base64,${tinyPng.toString('base64')})`);
	});

	it('falls back to placeholder when image map lacks the token', () => {
		const comments: FeishuComment[] = [
			{
				comment_id: 'c1',
				create_time: 1772605800,
				is_solved: false,
				is_whole: true,
				user_id: 'ou_user_missing',
				solver_user_id: null,
				reply_list: {
					replies: [
						{
							reply_id: 'r1',
							create_time: 1772605800,
							user_id: 'ou_user_missing',
							content: { elements: [{ type: 'text_run', text_run: { text: 'see screenshot' } }] },
							extra: { image_list: ['missing-token'] },
						},
					],
				},
			},
		];
		const md = renderCommentsMarkdown(comments, new Map());
		expect(md).toContain('*[评论图片加载失败]*');
	});
});
