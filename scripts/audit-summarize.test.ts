import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseSlice, aggregateByUrl, renderMarkdown, type SliceReport, type UrlReport } from './audit-summarize';

const FIXTURE_DIR = join(__dirname, 'fixtures/audit');

describe('parseSlice', () => {
	it('parses a single PASS slice fixture', () => {
		const raw = readFileSync(join(FIXTURE_DIR, 'single-pass.json'), 'utf8');
		const slice: SliceReport = parseSlice(raw);
		expect(slice.url).toBe('https://example.com/article/1');
		expect(slice.status).toBe('PASS');
		expect(slice.checklist.frontmatter).toBe('pass');
		expect(slice.checklist.table).toBe('na');
		expect(slice.diffs).toEqual([]);
		expect(slice.grid_range).toEqual([1, 5]);
	});

	it('throws on invalid JSON', () => {
		expect(() => parseSlice('{ not json')).toThrow();
	});

	it('throws on missing required field', () => {
		expect(() => parseSlice('{"url": "x"}')).toThrow(/checklist|status/i);
	});
});

describe('aggregateByUrl', () => {
	function loadSlice(name: string): SliceReport {
		return parseSlice(readFileSync(join(FIXTURE_DIR, name), 'utf8'));
	}

	it('aggregates 2 slices of same URL into one UrlReport', () => {
		const slices = [
			loadSlice('two-slice-mixed-1.json'),
			loadSlice('two-slice-mixed-2.json'),
		];
		const reports: UrlReport[] = aggregateByUrl(slices);
		expect(reports).toHaveLength(1);
		expect(reports[0].url).toBe('https://example.com/article/2');
		expect(reports[0].sliceCount).toBe(2);
		expect(reports[0].gridCount).toBe(10);
	});

	it('any-slice-fail → URL fail', () => {
		const slices = [loadSlice('two-slice-mixed-1.json'), loadSlice('two-slice-mixed-2.json')];
		const reports = aggregateByUrl(slices);
		expect(reports[0].status).toBe('FAIL');
		expect(reports[0].checklist.table).toBe('fail');
	});

	it('any-slice-unknown (no fail) → URL unknown for that category', () => {
		const slices = [loadSlice('two-slice-mixed-1.json'), loadSlice('two-slice-mixed-2.json')];
		const reports = aggregateByUrl(slices);
		expect(reports[0].checklist.bold_italic).toBe('unknown');
	});

	it('all-slice-na → URL na', () => {
		const slices = [loadSlice('two-slice-mixed-1.json'), loadSlice('two-slice-mixed-2.json')];
		const reports = aggregateByUrl(slices);
		expect(reports[0].checklist.quote).toBe('na');
		expect(reports[0].checklist.comment).toBe('na');
	});

	it('any-pass-others-na → URL pass', () => {
		const slices = [loadSlice('two-slice-mixed-1.json'), loadSlice('two-slice-mixed-2.json')];
		const reports = aggregateByUrl(slices);
		expect(reports[0].checklist.frontmatter).toBe('pass');
		expect(reports[0].checklist.code).toBe('pass');
	});

	it('collects all diffs from all slices', () => {
		const slices = [loadSlice('two-slice-mixed-1.json'), loadSlice('two-slice-mixed-2.json')];
		const reports = aggregateByUrl(slices);
		expect(reports[0].diffs).toHaveLength(1);
		expect(reports[0].diffs[0].category).toBe('table');
	});

	it('separates slices of different URLs into different reports', () => {
		const slices = [
			parseSlice(readFileSync(join(FIXTURE_DIR, 'single-pass.json'), 'utf8')),
			loadSlice('two-slice-mixed-1.json'),
			loadSlice('two-slice-mixed-2.json'),
		];
		const reports = aggregateByUrl(slices);
		expect(reports).toHaveLength(2);
		const urls = reports.map(r => r.url).sort();
		expect(urls).toEqual([
			'https://example.com/article/1',
			'https://example.com/article/2',
		]);
	});
});

describe('renderMarkdown', () => {
	function load(name: string): SliceReport {
		return parseSlice(readFileSync(join(FIXTURE_DIR, name), 'utf8'));
	}

	it('renders header with overall PASS when all URLs pass', () => {
		const reports = aggregateByUrl([load('single-pass.json')]);
		const md = renderMarkdown(reports, 'test-run-001');
		expect(md).toContain('## T5-2 视觉 audit 报告');
		expect(md).toContain('**Run ID**: test-run-001');
		expect(md).toContain('**整体状态**: ✅ PASS');
	});

	it('renders header with overall FAIL when any URL fails', () => {
		const reports = aggregateByUrl([
			load('two-slice-mixed-1.json'),
			load('two-slice-mixed-2.json'),
		]);
		const md = renderMarkdown(reports, 'run-x');
		expect(md).toMatch(/整体状态.*❗ FAIL/);
	});

	it('lists all 10 checklist items per URL', () => {
		const reports = aggregateByUrl([load('single-pass.json')]);
		const md = renderMarkdown(reports, 'run-x');
		const expectedItems = ['frontmatter', 'heading', 'list', 'table', 'code', 'bold_italic', 'image', 'quote', 'link', 'comment'];
		for (const item of expectedItems) {
			expect(md).toContain(`| ${item} |`);
		}
	});

	it('renders na rows with ⚪ + "本 URL 无 ..." 自动备注', () => {
		const reports = aggregateByUrl([load('single-pass.json')]);
		const md = renderMarkdown(reports, 'run-x');
		expect(md).toMatch(/\| table \| ⚪ na \|/);
	});

	it('renders fail rows with ❌ + diff 引用', () => {
		const reports = aggregateByUrl([load('two-slice-mixed-1.json'), load('two-slice-mixed-2.json')]);
		const md = renderMarkdown(reports, 'run-x');
		expect(md).toMatch(/\| table \| ❌ fail \|/);
		expect(md).toContain('sbs-09.png');
		expect(md).toContain('browser 显示 4 列');
	});

	it('renders unknown rows with ⚠️ and appends to review list', () => {
		const reports = aggregateByUrl([load('two-slice-mixed-1.json'), load('two-slice-mixed-2.json')]);
		const md = renderMarkdown(reports, 'run-x');
		expect(md).toMatch(/\| bold_italic \| ⚠️ unknown \|/);
		expect(md).toContain('需主 session Read');
	});

	it('section header includes URL slug + counts', () => {
		const reports = aggregateByUrl([load('single-pass.json')]);
		const md = renderMarkdown(reports, 'run-x');
		expect(md).toContain('Subagents: 1');
		expect(md).toContain('grids 1-5');
	});
});
