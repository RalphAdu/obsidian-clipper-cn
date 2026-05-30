import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { fetchDetailHtml, auditRow, validateSingleId } from './cbex-csv-validator';
import { FIELD_ORDER } from './cbex-csv-extract';

describe('fetchDetailHtml', () => {
	let fetchSpy: any;
	beforeEach(() => { fetchSpy = vi.spyOn(globalThis, 'fetch'); });
	afterEach(() => { fetchSpy.mockRestore(); });

	it('第 1 次成功：直接返回 HTML', async () => {
		fetchSpy.mockResolvedValueOnce(new Response('<html>OK</html>', { status: 200 }));
		const r = await fetchDetailHtml('521134', 'https://jpxkc.cbex.com/...');
		expect(r).toBe('<html>OK</html>');
	});

	it('3 次都失败：返回 null', async () => {
		fetchSpy.mockRejectedValue(new Error('netfail'));
		// 3 次重试间各 sleep — 测 fail path 时强制 maxRetry=3 但 sleep 由 fakeTimers 跳过
		vi.useFakeTimers();
		const promise = fetchDetailHtml('521134', 'https://x', 3);
		// fast-forward all timers
		await vi.runAllTimersAsync();
		const r = await promise;
		vi.useRealTimers();
		expect(r).toBeNull();
		expect(fetchSpy).toHaveBeenCalledTimes(3);
	});
});

describe('auditRow', () => {
	it('rowA == rowB 全字段：32 point pass', () => {
		const a: any = {}; const b: any = {};
		for (const f of FIELD_ORDER) { a[f] = '同'; b[f] = '同'; }
		const r = auditRow('521134', a, b);
		expect(r.status).toBe('pass');
		expect(r.fieldResults.length).toBe(32);
		expect(r.fieldResults.every(f => f.pass)).toBe(true);
	});

	it('1 字段不一致 → fail', () => {
		const a: any = {}; const b: any = {};
		for (const f of FIELD_ORDER) { a[f] = '同'; b[f] = '同'; }
		a['法院'] = 'A 法院'; b['法院'] = 'B 法院';
		const r = auditRow('521134', a, b);
		expect(r.status).toBe('fail');
		expect(r.fieldResults.find(f => f.field === '法院')!.pass).toBe(false);
	});

	it('number tolerance 0.01', () => {
		const a: any = {}; const b: any = {};
		for (const f of FIELD_ORDER) { a[f] = ''; b[f] = ''; }
		a['总价'] = 105000.001; b['总价'] = 105000;
		const r = auditRow('521134', a, b);
		expect(r.fieldResults.find(f => f.field === '总价')!.pass).toBe(true);
	});
});

describe('validateSingleId (mock fetch via cache)', () => {
	it('521134 A == B → pass (using markdown as fake detail)', async () => {
		const fakeDetail = readFileSync(join(__dirname, '../../.claude/cbex-batch-2238/markdown/521134.md'), 'utf-8');
		const detailDir = `/tmp/cbex-detail-test-${Date.now()}`;
		mkdirSync(detailDir, { recursive: true });
		writeFileSync(join(detailDir, '521134.html'), fakeDetail);

		const r = await validateSingleId({
			id: '521134', detailUrl: 'https://x',
			markdownPath: join(__dirname, '../../.claude/cbex-batch-2238/markdown/521134.md'),
			detailCacheDir: detailDir, today: '2026-05-30',
		});
		expect(r.status).toBe('pass');
	});

	it('detail fetch 全失败 → audit_infrastructure_error', async () => {
		const detailDir = `/tmp/cbex-detail-test-${Date.now()}-fail`;
		mkdirSync(detailDir, { recursive: true });
		// no cache file → will trigger fetch — mock to all fail

		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('netfail'));
		vi.useFakeTimers();
		const promise = validateSingleId({
			id: '999999', detailUrl: 'https://x',
			markdownPath: join(__dirname, '../../.claude/cbex-batch-2238/markdown/521134.md'),
			detailCacheDir: detailDir, today: '2026-05-30',
		});
		await vi.runAllTimersAsync();
		const r = await promise;
		vi.useRealTimers();
		fetchSpy.mockRestore();
		expect(r.status).toBe('audit_infrastructure_error');
		expect(r.infraError).toBe('detail 3 次失败');
	});
});
