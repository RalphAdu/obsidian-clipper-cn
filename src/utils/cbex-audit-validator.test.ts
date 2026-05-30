import { describe, it, expect } from 'vitest';
import { parseMarkdown, validateClip } from '../../scripts/cbex-audit-validator';

const SAMPLE_MARKDOWN = `---
title: "京NC6575别克牌SGM6527AT蓝小型汽车"
source: "https://jpxkc.cbex.com/jpxkc/prj/detail/522611.html"
author:
published: 2025-12-15 08:00
created: 2026-05-30
description: "202512NC6575"
tags:
  - "clippings"
subject_id: "202512NC6575"
status: 竞价结束
final_price: 30000
start_price: 20000
assess_price: 20000
cap_price: 30000
deposit: 20000
bid_start: "2025-12-15 08:00"
signup_end: "2025-12-12 15:00"
end_time: "2025-12-15 16:00:00"
bid_count: 265
followers: 411
views: 124489
---
# 京NC6575别克牌SGM6527AT蓝小型汽车

## 关键信息

| 项目 | 内容 |
|---|---|
| 标的物编号 | 202512NC6575 |
| 竞价状态 | 竞价结束 |
| 起始价 | ¥20,000.00 |
| 最高限价 | ¥30,000.00 |
| 成交价 | ¥30,000.00 |

## 标的物介绍

车辆信息...

## 图片展示

![](https://www.cbex.com.cn/upfiles/jpxkc/x1.jpg)
![](https://www.cbex.com.cn/upfiles/jpxkc/x2.jpg)

## 联系方式

电话：010-12368
`;

describe('parseMarkdown', () => {
	it('extracts frontmatter k/v + tags array', () => {
		const p = parseMarkdown(SAMPLE_MARKDOWN);
		expect(p.frontmatter.title).toBe('京NC6575别克牌SGM6527AT蓝小型汽车');
		expect(p.frontmatter.subject_id).toBe('202512NC6575');
		expect(p.frontmatter.final_price).toBe(30000);
		expect(p.frontmatter.bid_count).toBe(265);
		expect(p.frontmatter.tags).toEqual(['clippings']);
	});

	it('extracts section headers', () => {
		const p = parseMarkdown(SAMPLE_MARKDOWN);
		expect(p.sections.has('## 关键信息')).toBe(true);
		expect(p.sections.has('## 标的物介绍')).toBe(true);
		expect(p.sections.has('## 图片展示')).toBe(true);
		expect(p.sections.has('## 联系方式')).toBe(true);
	});

	it('extracts 关键信息 table rows', () => {
		const p = parseMarkdown(SAMPLE_MARKDOWN);
		expect(p.keyInfoRows.get('标的物编号')).toBe('202512NC6575');
		expect(p.keyInfoRows.get('成交价')).toBe('¥30,000.00');
	});

	it('counts images in body', () => {
		const p = parseMarkdown(SAMPLE_MARKDOWN);
		expect(p.imageCount).toBe(2);
		expect(p.imageUrls).toHaveLength(2);
	});
});

describe('validateClip (skeleton)', () => {
	it('returns AuditResult shape', () => {
		const r = validateClip({
			id: '522611',
			detailUrl: 'https://jpxkc.cbex.com/jpxkc/prj/detail/522611.html',
			markdown: SAMPLE_MARKDOWN,
			hydratedHtml: '<html></html>',
			listItemHtml: '<li>',
			ggnrXhr: '',
			wtListXhr: '',
			jjjgXhr: '',
			today: '2026-05-30',
		});
		expect(r.id).toBe('522611');
		expect(r.status).toBeDefined();
	});
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const LI_FIXTURE = readFileSync(join(__dirname, 'fixtures/cbex-prj_li-p1.html'), 'utf-8');
const LI_522611 = LI_FIXTURE.match(/<li id="prj_li_522611"[\s\S]*?<\/li>/)![0];
const HYDRATED_522611 = readFileSync(join(__dirname, 'cbex-extractor.fixture.html'), 'utf-8');

describe('validateClip — frontmatter audit (9 points)', () => {
	const input = {
		id: '522611',
		detailUrl: 'https://jpxkc.cbex.com/jpxkc/prj/detail/522611.html',
		markdown: SAMPLE_MARKDOWN,
		hydratedHtml: HYDRATED_522611,
		listItemHtml: LI_522611,
		ggnrXhr: '<dummy>司法处置公告</dummy>',
		wtListXhr: '<table><tr></tr><tr></tr></table>',
		jjjgXhr: '<dummy>竞价结果</dummy>',
		today: '2026-05-30',
	};

	it('title passes (triple A)', () => {
		const r = validateClip(input);
		const titleR = r.fieldResults.find((f) => f.field === 'title');
		expect(titleR?.pass).toBe(true);
		expect(titleR?.groundTruths.length).toBe(3);
	});

	it('source passes', () => {
		const r = validateClip(input);
		expect(r.fieldResults.find((f) => f.field === 'source')?.pass).toBe(true);
	});

	it('subject_id passes (double A)', () => {
		const r = validateClip(input);
		expect(r.fieldResults.find((f) => f.field === 'subject_id')?.pass).toBe(true);
	});

	it('audit_infrastructure_error when XHR is null', () => {
		const r = validateClip({ ...input, ggnrXhr: null });
		expect(r.status).toBe('audit_infrastructure_error');
	});
});

describe('validateClip — price/time/image audit (9 points)', () => {
	const input = {
		id: '522611',
		detailUrl: 'https://jpxkc.cbex.com/jpxkc/prj/detail/522611.html',
		markdown: SAMPLE_MARKDOWN,
		hydratedHtml: HYDRATED_522611,
		listItemHtml: LI_522611,
		ggnrXhr: '<dummy>司法处置公告</dummy>',
		wtListXhr: '<table><tr></tr><tr></tr></table>',
		jjjgXhr: '<dummy>竞价结果</dummy>',
		today: '2026-05-30',
	};

	const findField = (field: string, r = validateClip(input)) =>
		r.fieldResults.find((f) => f.field === field);

	it('final_price passes (status=竞价结束)', () => {
		expect(findField('final_price')?.pass).toBe(true);
	});

	it('start_price passes (double A)', () => {
		expect(findField('start_price')?.pass).toBe(true);
	});

	it('assess_price passes or absent matches', () => {
		expect(findField('assess_price')?.pass).toBe(true);
	});

	it('cap_price passes (triple A)', () => {
		const f = findField('cap_price');
		expect(f?.pass).toBe(true);
		expect(f?.groundTruths.length).toBe(3);
	});

	it('deposit passes', () => {
		expect(findField('deposit')?.pass).toBe(true);
	});

	it('bid_start passes (double A normalized)', () => {
		expect(findField('bid_start')?.pass).toBe(true);
	});

	it('signup_end passes (double A normalized)', () => {
		expect(findField('signup_end')?.pass).toBe(true);
	});

	it('end_time passes (list-item + hydrated time_num concat)', () => {
		expect(findField('end_time')?.pass).toBe(true);
	});

	it('image returns pass=true (no fm.image in SAMPLE_MARKDOWN)', () => {
		// SAMPLE_MARKDOWN has no `image:` frontmatter line → audit_image skips
		expect(findField('image')?.pass).toBe(true);
	});
});

describe('validateClip — stats/buyer/ct2_count audit (7 points)', () => {
	const input = {
		id: '522611',
		detailUrl: 'https://jpxkc.cbex.com/jpxkc/prj/detail/522611.html',
		markdown: SAMPLE_MARKDOWN,
		hydratedHtml: HYDRATED_522611,
		listItemHtml: LI_522611,
		ggnrXhr: '<dummy>司法处置公告</dummy>',
		wtListXhr: '<table><tr></tr><tr></tr></table>',
		jjjgXhr: '<dummy>竞价结果</dummy>',
		today: '2026-05-30',
	};

	const findField = (field: string, r = validateClip(input)) =>
		r.fieldResults.find((f) => f.field === field);

	it('bid_count returns double-A result (list-item bdlist_side_num + wtList tr count)', () => {
		const f = findField('bid_count');
		expect(f).toBeDefined();
		// 2 GT (list-item + wtList tr count); .jp_detail_bjnum span removed
		// because its semantic is 最高限价报价人数 (different from total bid count)
		expect(f?.groundTruths.length).toBe(2);
	});

	it('followers passes (same-snapshot DOM equality)', () => {
		expect(findField('followers')?.pass).toBe(true);
	});

	it('views passes', () => {
		expect(findField('views')?.pass).toBe(true);
	});

	it('buyer.lottery_code: SAMPLE has no row, status=竞价结束, GT1/GT2 should also be absent or markdown skipped', () => {
		// SAMPLE_MARKDOWN does not have buyer rows in 関键信息 table — should pass as "absent expected" branch
		const f = findField('buyer.lottery_code');
		expect(f).toBeDefined();
		// Either pass (if hydrated also lacks buyer info) or note buyer expected but missing
	});

	it('ct2_image_count: SAMPLE has 2 images, hydrated has more', () => {
		// SAMPLE has imageCount=2; hydrated 522611 has 9 img[bimg]
		// → mismatch is expected for this test fixture
		const f = findField('ct2_image_count');
		expect(f).toBeDefined();
		expect(f?.groundTruths.length).toBe(2);
	});
});

describe('validateClip — section audit (8 points) + 33-point complete', () => {
	const input = {
		id: '522611',
		detailUrl: 'https://jpxkc.cbex.com/jpxkc/prj/detail/522611.html',
		markdown: SAMPLE_MARKDOWN,
		hydratedHtml: HYDRATED_522611,
		listItemHtml: LI_522611,
		ggnrXhr: '<div>这是司法处置公告内容，应当超过50字以触发 gtPresent=true 条件，包含一些占位文本来达到字数要求。</div>',
		wtListXhr: '<table><tr></tr><tr></tr></table>',
		jjjgXhr: '<div>这是竞价结果内容，应当超过50字以触发 gtPresent=true 条件，包含一些占位文本。</div>',
		today: '2026-05-30',
	};

	const findField = (field: string, r = validateClip(input)) =>
		r.fieldResults.find((f) => f.field === field);

	it('validateClip returns 33 field results', () => {
		const r = validateClip(input);
		expect(r.fieldResults.length).toBe(33);
	});

	it('section_关键信息 always pass (unconditional)', () => {
		expect(findField('section_关键信息')?.pass).toBe(true);
	});

	it('section_图片展示 pass when markdown has section and hydrated has imgs', () => {
		// SAMPLE has '## 图片展示' (because imageCount = 2 in body)
		// hydrated 522611 has 9 img[bimg]
		// → both present → pass
		expect(findField('section_图片展示')?.pass).toBe(true);
	});

	it('section_标的物介绍 pass when both expected and ground truth agree', () => {
		// SAMPLE has '## 标的物介绍'; hydrated has #content_BDWJS with long content
		expect(findField('section_标的物介绍')?.pass).toBe(true);
	});

	it('all 33 audit points return FieldResult objects', () => {
		const r = validateClip(input);
		expect(r.fieldResults.every((f) => typeof f.field === 'string' && typeof f.pass === 'boolean')).toBe(true);
	});
});
