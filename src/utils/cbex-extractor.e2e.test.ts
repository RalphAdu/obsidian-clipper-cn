// src/utils/cbex-extractor.e2e.test.ts
//
// True end-to-end test: real chrome + dist/ extension + real network.
// Excluded from `npm test`; run via `npm run test:e2e`.

import { describe, it, expect, beforeAll } from 'vitest';
import { runRealClip, type ClipResult } from '../../scripts/e2e-clip-runner';

describe('cbex e2e — 522611 (竞价结束 + 成交 + 买受人摇号)', () => {
	let clip: ClipResult;

	beforeAll(async () => {
		clip = await runRealClip('https://jpxkc.cbex.com/jpxkc/prj/detail/522611.html', {
			wait: '.bd_detail_name',
			timeout: 120_000,
		});
	}, 180_000);

	it('markdown contains correct title', () => {
		expect(clip.markdown).toContain('京NC6575别克牌SGM6527AT蓝小型汽车');
	});

	it('frontmatter has subject_id', () => {
		expect(clip.markdown).toMatch(/^subject_id: "202512NC6575"$/m);
	});

	it('all 8 section headers present', () => {
		expect(clip.markdown).toContain('## 关键信息');
		expect(clip.markdown).toContain('## 标的物介绍');
		expect(clip.markdown).toContain('## 图片展示');
		expect(clip.markdown).toContain('## 司法处置公告');
		expect(clip.markdown).toContain('## 竞买须知');
		expect(clip.markdown).toContain('## 竞价记录');
		expect(clip.markdown).toContain('## 竞价结果');
		expect(clip.markdown).toContain('## 联系方式');
	});

	it('contains 成交价', () => {
		expect(clip.markdown).toContain('成交价');
	});

	it('frontmatter has start_price / cap_price / deposit', () => {
		expect(clip.markdown).toMatch(/^start_price: 20000$/m);
		expect(clip.markdown).toMatch(/^cap_price: 30000$/m);
		expect(clip.markdown).toMatch(/^deposit: 20000$/m);
	});

	it('frontmatter has final_price 30000 (成交)', () => {
		expect(clip.markdown).toMatch(/^final_price: 30000$/m);
	});

	it('frontmatter has bid_start / signup_end / end_time', () => {
		expect(clip.markdown).toMatch(/^bid_start: "2025-12-15 08:00"$/m);
		expect(clip.markdown).toMatch(/^signup_end: "2025-12-12 15:00"$/m);
		expect(clip.markdown).toMatch(/^end_time: "2025-12-15 16:00:00"$/m);
	});

	it('frontmatter has bid_count / followers / views (numbers)', () => {
		expect(clip.markdown).toMatch(/^bid_count: \d+$/m);
		expect(clip.markdown).toMatch(/^followers: \d+$/m);
		expect(clip.markdown).toMatch(/^views: \d+$/m);
	});
});

describe('cbex e2e — 522884 (竞价结束 + 成交)', () => {
	let clip: ClipResult;

	beforeAll(async () => {
		clip = await runRealClip('https://jpxkc.cbex.com/jpxkc/prj/detail/522884.html', {
			wait: '.bd_detail_name',
			timeout: 120_000,
		});
	}, 180_000);

	it('markdown contains correct title', () => {
		expect(clip.markdown).toContain('京P61185北京现代牌BH6430AY黑色小型汽车');
	});

	it('frontmatter has subject_id', () => {
		expect(clip.markdown).toMatch(/^subject_id: "202512P61185"$/m);
	});

	it('contains ## 关键信息', () => {
		expect(clip.markdown).toContain('## 关键信息');
	});

	it('contains 成交价', () => {
		expect(clip.markdown).toContain('成交价');
	});

	it('frontmatter has start_price / cap_price / deposit', () => {
		expect(clip.markdown).toMatch(/^start_price: \d+$/m);
		expect(clip.markdown).toMatch(/^cap_price: \d+$/m);
		expect(clip.markdown).toMatch(/^deposit: \d+$/m);
	});

	it('frontmatter has bid_start / signup_end / end_time', () => {
		expect(clip.markdown).toMatch(/^bid_start: "\d{4}-\d{2}-\d{2} \d{2}:\d{2}"$/m);
		expect(clip.markdown).toMatch(/^signup_end: "\d{4}-\d{2}-\d{2} \d{2}:\d{2}"$/m);
		expect(clip.markdown).toMatch(/^end_time: "\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}"$/m);
	});

	it('frontmatter has bid_count / followers / views', () => {
		expect(clip.markdown).toMatch(/^bid_count: \d+$/m);
		expect(clip.markdown).toMatch(/^followers: \d+$/m);
		expect(clip.markdown).toMatch(/^views: \d+$/m);
	});
});
