// scripts/cbex-batch-audit.ts
//
// CLI: orchestrate batch e2e audit for a cbex zc_prjs list page.
// Usage:
//   npx tsx scripts/cbex-batch-audit.ts <listUrl> <outDir> [--final-verify] [--ids ID1,ID2,...]
//
// Without --final-verify: emits FAIL/error stats so caller can decide whether
// to enter fix loop or continue.
// With --final-verify: requires PASS=100% to generate REPORT.md; otherwise
// exits with code 3 (so controller can re-enter fix loop).

import { mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { fetchListIds } from './cbex-list-fetcher';
import { startBatchSession, type ClipResult } from './e2e-clip-runner';
import { validateClip, type AuditResult, type AuditInput } from './cbex-audit-validator';
import {
	buildReport,
	type StepReportMeta,
	type E2eError,
	type AuditInfraError,
	type BatchStats,
} from './cbex-audit-report';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const BACKOFF_SEC = [5, 10, 20];

interface CliArgs {
	listUrl: string;
	outDir: string;
	finalVerify: boolean;
	idsSubset?: string[];
}

function parseArgs(): CliArgs {
	const args = process.argv.slice(2);
	const finalVerify = args.includes('--final-verify');
	const subsetIdx = args.indexOf('--ids');
	let idsSubset: string[] | undefined;
	if (subsetIdx >= 0 && args[subsetIdx + 1]) {
		idsSubset = args[subsetIdx + 1].split(',').map((s) => s.trim()).filter(Boolean);
	}
	const positional: string[] = [];
	for (let i = 0; i < args.length; i++) {
		if (args[i].startsWith('--')) {
			if (args[i] === '--ids') i++;
			continue;
		}
		positional.push(args[i]);
	}
	const [listUrl, outDir] = positional;
	if (!listUrl || !outDir) {
		console.error('Usage: cbex-batch-audit.ts <listUrl> <outDir> [--final-verify] [--ids ID1,ID2,...]');
		process.exit(2);
	}
	return { listUrl, outDir, finalVerify, idsSubset };
}

async function refetchXhr(endpoint: string, body: string, listUrl: string): Promise<string | null> {
	for (let attempt = 1; attempt <= 3; attempt++) {
		try {
			const res = await fetch(endpoint, {
				method: 'POST',
				headers: {
					'User-Agent': UA,
					'Referer': listUrl,
					'X-Requested-With': 'XMLHttpRequest',
					'Content-Type': 'application/x-www-form-urlencoded',
				},
				body,
				signal: AbortSignal.timeout(10_000),
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			return await res.text();
		} catch (e) {
			if (attempt < 3) await new Promise((r) => setTimeout(r, BACKOFF_SEC[attempt - 1] * 1000));
		}
	}
	return null;
}

function extractCbexParamsFromHydrated(hydratedHtml: string): { bdid: string; cpdm: string; zgxj: string; jjcc: string } | null {
	const out: Record<string, string> = {};
	const patterns: [string, RegExp][] = [
		['bdid', /\bbdid\s*[:=]\s*['"]?(\d+)/i],
		['cpdm', /\bcpdm\s*[:=]\s*['"]?(\d+)/i],
		['zgxj', /\bzgxj\s*[:=]\s*['"]?(\d+(?:\.\d+)?)/i],
		['jjcc', /\bjjcc\s*[:=]\s*['"]?(\d+)/i],
	];
	for (const [k, re] of patterns) {
		const m = hydratedHtml.match(re);
		if (!m) return null;
		out[k] = m[1];
	}
	return out as any;
}

function collectStepReports(outDir: string): StepReportMeta[] {
	const stepDir = join(outDir, 'step-reports');
	const reports: StepReportMeta[] = [];
	try {
		const files = readdirSync(stepDir).filter((f) => f.endsWith('.md')).sort();
		for (const f of files) {
			// Derive step ID and type from filename: step-01a-phase-a-extractor-wire.md
			const m = f.match(/^step-([0-9a-z-]+?)-(.+)\.md$/);
			if (!m) continue;
			const step = m[1];
			const slug = m[2];
			let type = 'unknown';
			if (slug.startsWith('phase-a')) type = 'code-phase-A';
			else if (slug.startsWith('phase-b')) type = 'code-phase-B';
			else if (slug.startsWith('audit-round')) type = 'audit-round';
			else if (step.startsWith('fix') || slug.includes('fix')) type = 'fix';
			else if (slug === 'final-verify') type = 'verify';
			else if (slug === 'ship') type = 'ship';
			reports.push({ step, type, path: `step-reports/${f}`, summary: slug.replace(/-/g, ' ') });
		}
	} catch { /* dir may not exist yet */ }
	return reports;
}

async function main() {
	const args = parseArgs();
	const outDir = resolve(args.outDir);
	const today = new Date().toISOString().slice(0, 10);

	mkdirSync(join(outDir, 'markdown'), { recursive: true });
	mkdirSync(join(outDir, 'hydrated-fail'), { recursive: true });
	mkdirSync(join(outDir, 'diffs-fail'), { recursive: true });
	mkdirSync(join(outDir, 'step-reports'), { recursive: true });

	console.log(`[batch-audit] fetching list IDs from ${args.listUrl} ...`);
	const items = await fetchListIds(args.listUrl);
	console.log(`[batch-audit] got ${items.length} IDs`);
	writeFileSync(
		join(outDir, 'ids.json'),
		JSON.stringify({ fetchedAt: new Date().toISOString(), listUrl: args.listUrl, total: items.length, items }, null, 2),
	);

	let targets = items;
	if (args.idsSubset) {
		const subsetSet = new Set(args.idsSubset);
		targets = items.filter((i) => subsetSet.has(i.id));
		console.log(`[batch-audit] subset mode: ${targets.length} IDs (of ${args.idsSubset.length} requested)`);
	}

	const results: AuditResult[] = [];
	const e2eErrors: E2eError[] = [];
	const auditInfraErrors: AuditInfraError[] = [];
	const startedAt = new Date().toISOString();

	console.log('[batch-audit] starting batch session (single chromium)...');
	const session = await startBatchSession({ headed: true, offscreen: true });

	try {
		for (let i = 0; i < targets.length; i++) {
			const item = targets[i];
			const detailUrl = `https://jpxkc.cbex.com/jpxkc/prj/detail/${item.id}.html`;
			console.log(`[${i + 1}/${targets.length}] ${item.id} ...`);

			let clip: ClipResult | null = null;
			let lastError = '';
			for (let attempt = 1; attempt <= 3; attempt++) {
				try {
					clip = await session.clip(detailUrl, { wait: '.bd_detail_name', timeout: 120_000 });
					break;
				} catch (e) {
					lastError = String(e instanceof Error ? e.message : e);
					if (attempt < 3) await new Promise((r) => setTimeout(r, BACKOFF_SEC[attempt - 1] * 1000));
				}
			}

			if (!clip) {
				e2eErrors.push({ id: item.id, error: lastError, attempts: 3 });
				continue;
			}

			writeFileSync(join(outDir, 'markdown', `${item.id}.md`), clip.markdown);

			const params = extractCbexParamsFromHydrated(clip.hydratedHtml);
			let ggnrXhr: string | null = null;
			let wtListXhr: string | null = null;
			let jjjgXhr: string | null = null;
			if (params) {
				ggnrXhr = await refetchXhr('https://jpxkc.cbex.com/page/jpxkc/prj/ggnr', `BDID=${params.bdid}`, args.listUrl);
				wtListXhr = await refetchXhr(
					'https://jpxkc.cbex.com/page/jpxkc/prj/wtListPaging',
					`cpdm=${params.cpdm}&zgxj=${params.zgxj}&type=all&pageNo=1&pageSize=10000`,
					args.listUrl,
				);
				jjjgXhr = await refetchXhr(
					'https://jpxkc.cbex.com/page/jpxkc/prj/jjjgListPaging',
					`id=${params.cpdm}&jjcc=${params.jjcc}&pageNo=1&pageSize=10`,
					args.listUrl,
				);
			}

			if (ggnrXhr === null) auditInfraErrors.push({ id: item.id, failedXhr: 'ggnr', attempts: 3 });
			if (wtListXhr === null) auditInfraErrors.push({ id: item.id, failedXhr: 'wtList', attempts: 3 });
			if (jjjgXhr === null) auditInfraErrors.push({ id: item.id, failedXhr: 'jjjg', attempts: 3 });

			const auditInput: AuditInput = {
				id: item.id,
				detailUrl,
				markdown: clip.markdown,
				hydratedHtml: clip.hydratedHtml,
				listItemHtml: item.listItemHtml,
				ggnrXhr,
				wtListXhr,
				jjjgXhr,
				today,
			};

			const result = validateClip(auditInput);
			results.push(result);

			if (result.status === 'fail') {
				writeFileSync(join(outDir, 'hydrated-fail', `${item.id}.html`), clip.hydratedHtml);
				writeFileSync(join(outDir, 'diffs-fail', `${item.id}.json`), JSON.stringify(result, null, 2));
			}

			writeFileSync(
				join(outDir, 'progress.json'),
				JSON.stringify({
					completed: i + 1,
					total: targets.length,
					pass: results.filter((r) => r.status === 'pass').length,
					fail: results.filter((r) => r.status === 'fail').length,
					e2eError: e2eErrors.length,
					auditInfraError: auditInfraErrors.length,
				}, null, 2),
			);
		}
	} finally {
		await session.close();
	}

	const endedAt = new Date().toISOString();

	let extractorSha = 'unknown';
	try {
		extractorSha = execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();
	} catch { /* ignore */ }

	const stats: BatchStats = {
		totalIds: items.length,
		pass: results.filter((r) => r.status === 'pass').length,
		fail: results.filter((r) => r.status === 'fail').length,
		e2eError: e2eErrors.length,
		auditInfraError: auditInfraErrors.length,
		startedAt,
		endedAt,
		roundCount: 1,
		fixCommitCount: 0,
		extractorSha,
		removedIds: [],
	};

	console.log(`[batch-audit] done: PASS=${stats.pass} FAIL=${stats.fail} e2e_err=${stats.e2eError} audit_infra_err=${stats.auditInfraError}`);

	if (args.finalVerify) {
		const clean = stats.pass === stats.totalIds && stats.fail === 0 && stats.e2eError === 0 && stats.auditInfraError === 0;
		if (clean) {
			const stepReports = collectStepReports(outDir);
			const report = buildReport({ stats, results, stepReports, e2eErrors, auditInfraErrors });
			writeFileSync(join(outDir, 'REPORT.md'), report);
			console.log(`[batch-audit] REPORT.md written to ${join(outDir, 'REPORT.md')}`);
		} else {
			console.error('[batch-audit] FINAL VERIFY FAILED — PASS rate not 100%. Aborting REPORT.md generation. Enter fix loop.');
			process.exit(3);
		}
	}

	process.exit(stats.fail + stats.e2eError + stats.auditInfraError > 0 ? 1 : 0);
}

main().catch((e) => {
	console.error('[batch-audit] fatal:', e);
	process.exit(1);
});
