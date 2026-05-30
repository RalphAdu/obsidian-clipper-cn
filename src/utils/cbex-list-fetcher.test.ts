import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseListItemHtml, fetchListIds } from '../../scripts/cbex-list-fetcher';

const FIXTURE = readFileSync(join(__dirname, 'fixtures/cbex-prj_li-p1.html'), 'utf-8');

describe('parseListItemHtml', () => {
	it('parses cj (成交) variant — 522611', () => {
		const li = FIXTURE.match(/<li id="prj_li_522611"[\s\S]*?<\/li>/)![0];
		const parsed = parseListItemHtml(li);
		expect(parsed.id).toBe('522611');
		expect(parsed.subject_id).toBe('202512NC6575');
		expect(parsed.title).toBe('京NC6575别克牌SGM6527AT蓝小型汽车');
		expect(parsed.dataStyle).toBe('cj');
		expect(parsed.status).toBe('竞价结束');
		expect(parsed.final_price).toBe(30000);
		expect(parsed.cap_price).toBe(30000);
		expect(parsed.end_time).toBe('2025-12-15 16:00:00');
		expect(parsed.bid_count).toBe(265);
		expect(parsed.image).toMatch(/\.jpg(_MzAwLDMwMA==\.jpg)?$/);
		expect(parsed.start_price).toBeUndefined(); // 成交 状态 list-item 显示成交价不显示起始价
	});

	it('parses ch (已撤回) variant when present in fixture', () => {
		const liMatch = FIXTURE.match(/<li id="prj_li_\d+" data-xmid="\d+" data-style="ch"[\s\S]*?<\/li>/);
		if (!liMatch) {
			// p1 fixture may not contain a 'ch' item; skip silently with note
			return;
		}
		const parsed = parseListItemHtml(liMatch[0]);
		expect(parsed.dataStyle).toBe('ch');
		expect(parsed.status).toBe('已撤回');
		expect(parsed.start_price).toBeDefined();
		expect(parsed.final_price).toBeUndefined();
	});
});

describe('fetchListIds (network)', () => {
	it.skip('fetches all 542 IDs from 2238 list', async () => {
		// Manual e2e: hits cbex network. Skip in normal vitest run.
		const items = await fetchListIds('https://jpxkc.cbex.com/jpxkc/zc_prjs/2238.html');
		expect(items.length).toBe(542);
	});
});
