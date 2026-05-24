import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseSlice, type SliceReport } from './audit-summarize';

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
