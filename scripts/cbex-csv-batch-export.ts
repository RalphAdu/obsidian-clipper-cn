#!/usr/bin/env tsx
// scripts/cbex-csv-batch-export.ts
// Phase 3 — 跑全 542 → CSV + progress.json + diffs-fail
// 用法：npx tsx scripts/cbex-csv-batch-export.ts [--ids=ID1,ID2]

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { validateSingleId } from '../src/utils/cbex-csv-validator';
import { extractAllFields, FIELD_ORDER } from '../src/utils/cbex-csv-extract';

const ROOT = '.claude/cbex-batch-2238';
const MD_DIR = join(ROOT, 'markdown');
const DETAIL_DIR = join(ROOT, 'detail-cache');
const DIFFS_FAIL = join(ROOT, 'diffs-fail');
const PROGRESS = join(ROOT, 'progress.json');
const CSV_OUT = join(ROOT, 'cbex-2238.csv');

[DETAIL_DIR, DIFFS_FAIL].forEach((d) => existsSync(d) || mkdirSync(d, { recursive: true }));

async function main() {
	const today = new Date().toISOString().slice(0, 10);
	const args = process.argv.slice(2);
	const idsArg = args.find((a) => a.startsWith('--ids='));
	const subsetIds = idsArg ? idsArg.slice('--ids='.length).split(',') : null;

	const allIds = readdirSync(MD_DIR)
		.filter((f) => f.endsWith('.md'))
		.map((f) => f.replace('.md', ''))
		.sort();
	const ids = subsetIds ?? allIds;
	console.log(`处理 ${ids.length} 个 ID（today=${today}）`);

	let pass = 0, fail = 0, infraErr = 0;
	const csvRows: string[] = [];
	csvRows.push(FIELD_ORDER.map(csvEscape).join(','));

	for (let i = 0; i < ids.length; i++) {
		const id = ids[i];
		try {
			// 先 extract B 路径产出 CSV row（即便 audit fail 也要写 CSV）
			const text = readFileSync(join(MD_DIR, `${id}.md`), 'utf-8');
			const row = extractAllFields({ id, rawText: text, today });
			csvRows.push(FIELD_ORDER.map((f) => csvEscape(String(row[f]))).join(','));

			// audit
			const r = await validateSingleId({
				id,
				detailUrl: String(row['车辆URL']),
				markdownPath: join(MD_DIR, `${id}.md`),
				detailCacheDir: DETAIL_DIR,
				today,
			});
			if (r.status === 'pass') pass++;
			else if (r.status === 'audit_infrastructure_error') {
				infraErr++;
				writeFileSync(join(DIFFS_FAIL, `${id}.infra.json`), JSON.stringify(r, null, 2));
			} else {
				fail++;
				writeFileSync(join(DIFFS_FAIL, `${id}.json`), JSON.stringify(r, null, 2));
			}
		} catch (e) {
			fail++;
			writeFileSync(join(DIFFS_FAIL, `${id}.error.json`), JSON.stringify({ id, err: String(e) }));
		}

		if (i % 20 === 0 || i === ids.length - 1) {
			writeFileSync(
				PROGRESS,
				JSON.stringify({ total: ids.length, processed: i + 1, pass, fail, infraErr }, null, 2)
			);
			console.log(`[${i + 1}/${ids.length}] pass=${pass} fail=${fail} infra=${infraErr}`);
		}

		// spec §9 容错 — 200ms inter-request 限速防反爬（缓存命中则 skip sleep）
		const cached = existsSync(join(DETAIL_DIR, `${id}.html`));
		if (!cached && i < ids.length - 1) await new Promise((r) => setTimeout(r, 200));
	}

	writeFileSync(
		PROGRESS,
		JSON.stringify({ total: ids.length, processed: ids.length, pass, fail, infraErr }, null, 2)
	);
	// UTF-8 BOM
	writeFileSync(CSV_OUT, '﻿' + csvRows.join('\n'), 'utf-8');
	console.log(`\n完成 — pass=${pass} fail=${fail} infra=${infraErr}`);
	console.log(`CSV=${CSV_OUT}`);
}

function csvEscape(s: string): string {
	if (s.includes(',') || s.includes('"') || s.includes('\n')) return `"${s.replace(/"/g, '""')}"`;
	return s;
}

main().catch((e) => { console.error(e); process.exit(1); });
