// scripts/audit-summarize.ts
//
// Aggregate N subagent slice JSON reports into a ship-checklist-T5
// markdown block. See spec §6 for the output format and §5 for slice
// schema.

export type CheckStatus = 'pass' | 'fail' | 'na' | 'unknown';

export type SliceStatus = 'PASS' | 'FAIL' | 'NEEDS_REVIEW' | 'ERROR';

export interface Diff {
	grid: string;
	location: string;
	category: string;
	severity: 'blocker' | 'warn' | 'info';
	desc: string;
}

export interface Checklist {
	frontmatter: CheckStatus;
	heading: CheckStatus;
	list: CheckStatus;
	table: CheckStatus;
	code: CheckStatus;
	bold_italic: CheckStatus;
	image: CheckStatus;
	quote: CheckStatus;
	link: CheckStatus;
	comment: CheckStatus;
}

export interface SliceReport {
	url: string;
	slice: string;
	grid_range: [number, number];
	status: SliceStatus;
	checklist: Checklist;
	diffs: Diff[];
	notes: string;
}

const CHECKLIST_KEYS: (keyof Checklist)[] = [
	'frontmatter', 'heading', 'list', 'table', 'code',
	'bold_italic', 'image', 'quote', 'link', 'comment',
];

export function parseSlice(raw: string): SliceReport {
	const obj = JSON.parse(raw);
	if (typeof obj.url !== 'string') throw new Error('parseSlice: missing url');
	if (typeof obj.status !== 'string') throw new Error('parseSlice: missing status');
	if (typeof obj.checklist !== 'object' || obj.checklist === null) {
		throw new Error('parseSlice: missing checklist');
	}
	for (const k of CHECKLIST_KEYS) {
		if (typeof obj.checklist[k] !== 'string') {
			throw new Error(`parseSlice: checklist.${k} missing or not string`);
		}
	}
	return obj as SliceReport;
}

export interface UrlReport {
	url: string;
	sliceCount: number;
	gridCount: number;
	status: SliceStatus;
	checklist: Checklist;
	diffs: Diff[];
}

function aggregateChecklistKey(values: CheckStatus[]): CheckStatus {
	if (values.some(v => v === 'fail')) return 'fail';
	if (values.some(v => v === 'unknown')) return 'unknown';
	if (values.some(v => v === 'pass')) return 'pass';
	return 'na';
}

function deriveUrlStatus(checklist: Checklist): SliceStatus {
	const vals = Object.values(checklist);
	if (vals.some(v => v === 'fail')) return 'FAIL';
	if (vals.some(v => v === 'unknown')) return 'NEEDS_REVIEW';
	return 'PASS';
}

export function aggregateByUrl(slices: SliceReport[]): UrlReport[] {
	const byUrl = new Map<string, SliceReport[]>();
	for (const s of slices) {
		const arr = byUrl.get(s.url) ?? [];
		arr.push(s);
		byUrl.set(s.url, arr);
	}

	const reports: UrlReport[] = [];
	for (const [url, urlSlices] of byUrl) {
		const checklist = {} as Checklist;
		for (const k of CHECKLIST_KEYS) {
			checklist[k] = aggregateChecklistKey(urlSlices.map(s => s.checklist[k]));
		}
		const diffs: Diff[] = urlSlices.flatMap(s => s.diffs);
		const gridCount = urlSlices.reduce(
			(sum, s) => sum + (s.grid_range[1] - s.grid_range[0] + 1),
			0,
		);
		reports.push({
			url,
			sliceCount: urlSlices.length,
			gridCount,
			status: deriveUrlStatus(checklist),
			checklist,
			diffs,
		});
	}
	return reports;
}
