// src/utils/cbex-csv-validator.ts
// spec §5 — A/B 双路径 audit + detail HTML fetch

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { ExtractedRow, FieldName } from './cbex-csv-extract';
import { FIELD_ORDER, extractAllFields } from './cbex-csv-extract';

export type AuditStatus = 'pass' | 'fail' | 'audit_infrastructure_error';

export interface FieldResult {
	field: FieldName;
	pass: boolean;
	a: string | number;  // A 路径值
	b: string | number;  // B 路径值
	note?: string;
}

export interface RowAuditResult {
	id: string;
	status: AuditStatus;
	fieldResults: FieldResult[];
	infraError?: string;  // detail fetch 失败时
}

// spec §5 — 价格/费用/里程数 数值字段 tolerance 0.01
const NUMERIC_FIELDS: FieldName[] = [
	'总价', '起始价', '评估价', '保证金', '最高限价',
	'违章罚款', '违章次数', '扣分',
	'停车维修费', '配钥匙费', '其他费用',
];

function eq(field: FieldName, a: any, b: any): boolean {
	if (NUMERIC_FIELDS.includes(field)) {
		const na = Number(a);
		const nb = Number(b);
		// both parseable as numbers → tolerance compare; otherwise fall through to string eq
		if (!isNaN(na) && !isNaN(nb)) {
			return Math.abs(na - nb) < 0.01;
		}
	}
	return String(a ?? '').trim() === String(b ?? '').trim();
}

export function auditRow(id: string, rowA: ExtractedRow, rowB: ExtractedRow): RowAuditResult {
	const fieldResults: FieldResult[] = FIELD_ORDER.map((f) => ({
		field: f,
		pass: eq(f, rowA[f], rowB[f]),
		a: rowA[f],
		b: rowB[f],
	}));
	const status: AuditStatus = fieldResults.every((r) => r.pass) ? 'pass' : 'fail';
	return { id, status, fieldResults };
}

/** spec §5 Round 2 — GET detail/<id>.html，3 次重试 5/10/20s backoff */
export async function fetchDetailHtml(
	id: string,
	referer: string,
	maxRetry: number = 3
): Promise<string | null> {
	const url = `https://jpxkc.cbex.com/jpxkc/prj/detail/${id}.html`;
	for (let attempt = 0; attempt < maxRetry; attempt++) {
		try {
			const res = await fetch(url, {
				method: 'GET',
				headers: {
					'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
					'Referer': referer,
				},
			});
			if (res.ok) return await res.text();
			throw new Error(`HTTP ${res.status}`);
		} catch (e) {
			const backoffMs = [5000, 10000, 20000][attempt] ?? 30000;
			if (attempt < maxRetry - 1) await new Promise((r) => setTimeout(r, backoffMs));
		}
	}
	return null;
}

// ── Task 16: validateSingleId 端到端 A/B 路径 audit ──────────────────────────

export interface ValidateOpts {
	id: string;
	detailUrl: string;
	markdownPath: string;
	detailCacheDir: string;   // 缓存 detail HTML 到这里
	today: string;
}

export async function validateSingleId(opts: ValidateOpts): Promise<RowAuditResult> {
	const { id, markdownPath, detailCacheDir, detailUrl, today } = opts;

	// fetch detail HTML (with cache)
	const cachePath = join(detailCacheDir, `${id}.html`);
	let detailHtml: string | null = null;
	if (existsSync(cachePath)) {
		detailHtml = readFileSync(cachePath, 'utf-8');
	} else {
		detailHtml = await fetchDetailHtml(id, detailUrl);
		if (detailHtml) {
			mkdirSync(detailCacheDir, { recursive: true });
			writeFileSync(cachePath, detailHtml);
		}
	}
	if (!detailHtml) {
		return { id, status: 'audit_infrastructure_error', fieldResults: [], infraError: 'detail 3 次失败' };
	}

	const markdownText = readFileSync(markdownPath, 'utf-8');

	// A 路径：从 detail HTML 提
	const rowA = extractAllFields({ id, rawText: detailHtml, today });
	// B 路径：从本地 markdown 提
	const rowB = extractAllFields({ id, rawText: markdownText, today });

	return auditRow(id, rowA, rowB);
}
