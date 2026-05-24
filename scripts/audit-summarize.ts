// scripts/audit-summarize.ts
//
// Aggregate N subagent slice JSON reports into a ship-checklist-T5
// markdown block. See spec §6 for the output format and §5 for slice
// schema.

import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

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

const STATUS_BADGE: Record<CheckStatus, string> = {
	pass: '✅ pass',
	fail: '❌ fail',
	na: '⚪ na',
	unknown: '⚠️ unknown',
};

function renderUrlSection(r: UrlReport, idx: number): string {
	const lines: string[] = [];
	lines.push(`### URL ${idx + 1}: ${r.url}`);
	const gridRange = `grids 1-${r.gridCount}`;
	lines.push(`- URL: \`${r.url}\``);
	lines.push(`- Subagents: ${r.sliceCount} (${gridRange})`);
	const statusBadge = r.status === 'PASS' ? '✅ PASS'
		: r.status === 'FAIL' ? `❗ FAIL (${r.diffs.filter(d => d.severity === 'blocker').length} blocker / ${r.diffs.filter(d => d.severity === 'warn').length} warn)`
		: '⚠️ NEEDS REVIEW';
	lines.push(`- Status: ${statusBadge}`);
	lines.push('');
	lines.push('| 检查项 | 状态 | 备注 |');
	lines.push('|---|---|---|');
	for (const k of CHECKLIST_KEYS) {
		const st = r.checklist[k];
		let note = '—';
		if (st === 'na') note = `本 URL 无 ${k}`;
		else if (st === 'fail') {
			const failed = r.diffs.filter(d => d.category === k);
			note = failed.map(d => `${d.grid} ${d.location}（详见 diffs）`).join('；') || '—';
		} else if (st === 'unknown') {
			note = '看不清，建议主 session 复核';
		}
		lines.push(`| ${k} | ${STATUS_BADGE[st]} | ${note} |`);
	}
	if (r.diffs.length > 0) {
		lines.push('');
		lines.push('**Diffs**:');
		lines.push('');
		r.diffs.forEach((d, i) => {
			lines.push(`${i + 1}. **[${d.severity}] ${d.category} — ${d.grid}** (${d.location})`);
			lines.push(`   - ${d.desc}`);
		});
	}
	return lines.join('\n');
}

export function renderMarkdown(reports: UrlReport[], runId: string): string {
	const total = reports.length;
	const failCount = reports.filter(r => r.status === 'FAIL').length;
	const reviewCount = reports.filter(r => r.status === 'NEEDS_REVIEW').length;
	const overallBadge = failCount > 0 || reviewCount > 0
		? `❗ FAIL (${failCount} URL fail / ${reviewCount} URL needs review)`
		: '✅ PASS';
	const subagentTotal = reports.reduce((s, r) => s + r.sliceCount, 0);

	const out: string[] = [];
	out.push('## T5-2 视觉 audit 报告（audit-via-subagents v1）');
	out.push('');
	out.push(`**Run ID**: ${runId}`);
	out.push(`**URLs 总数**: ${total}`);
	out.push(`**Subagent 总数**: ${subagentTotal}`);
	out.push(`**整体状态**: ${overallBadge}`);
	out.push('');
	out.push('---');
	out.push('');
	reports.forEach((r, i) => {
		out.push(renderUrlSection(r, i));
		out.push('');
		out.push('---');
		out.push('');
	});

	const reviewItems: string[] = [];
	for (const r of reports) {
		for (const d of r.diffs) {
			reviewItems.push(`- ${d.grid}（${r.url}）— ${d.severity}/${d.category}`);
		}
		for (const k of CHECKLIST_KEYS) {
			if (r.checklist[k] === 'unknown') {
				reviewItems.push(`- ${r.url} — ${k} 标记 unknown，建议 Read 全部 slice 的 grid`);
			}
		}
	}
	if (reviewItems.length > 0) {
		out.push('## 整体复核清单（如有 fail / unknown）');
		out.push('');
		out.push('需主 session Read 的 grid（共 ' + reviewItems.length + ' 项）:');
		reviewItems.forEach(line => out.push(line));
	}

	return out.join('\n');
}

function findSliceJsons(runDir: string): string[] {
	const out: string[] = [];
	for (const urlDir of readdirSync(runDir)) {
		const urlPath = join(runDir, urlDir);
		if (!statSync(urlPath).isDirectory()) continue;
		for (const f of readdirSync(urlPath)) {
			if (f.startsWith('slice-') && f.endsWith('.json')) {
				out.push(join(urlPath, f));
			}
		}
	}
	return out;
}

function main() {
	const args = process.argv.slice(2);
	let runId: string | undefined;
	let runDir: string | undefined;
	let outPath: string | undefined;
	for (let i = 0; i < args.length; i++) {
		if (args[i] === '--run-id') runId = args[++i];
		else if (args[i] === '--run-dir') runDir = args[++i];
		else if (args[i] === '--out') outPath = args[++i];
	}
	if (!runId || !runDir || !outPath) {
		console.error('Usage: audit-summarize.ts --run-id <id> --run-dir <dir> --out <path>');
		console.error('  --run-dir typically /tmp/audit-<id>/');
		process.exit(2);
	}
	const sliceFiles = findSliceJsons(runDir);
	if (sliceFiles.length === 0) {
		console.error(`[FATAL] no slice-*.json files under ${runDir}`);
		process.exit(2);
	}
	const slices = sliceFiles.map(f => {
		try {
			return parseSlice(readFileSync(f, 'utf8'));
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			throw new Error(`${f}: ${msg}`);
		}
	});
	const reports = aggregateByUrl(slices);
	const md = renderMarkdown(reports, runId);
	writeFileSync(outPath, md);
	console.log(`[OK] wrote ${outPath} (${slices.length} slices, ${reports.length} URLs)`);
	const anyFail = reports.some(r => r.status === 'FAIL' || r.status === 'NEEDS_REVIEW');
	process.exit(anyFail ? 1 : 0);
}

if (require.main === module) {
	main();
}
