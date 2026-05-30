#!/usr/bin/env tsx
// Phase 0 discovery: 扫全 542 个 markdown，输出 patterns JSON
// 供 spec §4 字段提取算法 + §4.4 费用算法设计输入

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { parseHTML } from 'linkedom';

function stripFrontmatter(md: string): string {
	const m = md.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
	return m ? m[1] : md;
}

const ROOT = '.claude/cbex-batch-2238';
const MD_DIR = join(ROOT, 'markdown');
const OUT = join(ROOT, 'discovery');
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

const stripWS = (s: string) => s.replace(/[\s ]+/g, '');

function extractTable(body: string): string | null {
	const m = body.match(/<table[\s\S]*?<\/table>/);
	return m ? m[0] : null;
}

function findRowText(table: string, prefix: string): string {
	const { document } = parseHTML(`<html><body>${table}</body></html>`);
	for (const tr of Array.from(document.querySelectorAll('tr'))) {
		const t = stripWS(tr.textContent || '');
		if (t.startsWith(prefix)) return t;
	}
	return '';
}

function extractGonggao(body: string): string {
	const m = body.match(/##\s*司法处置公告\s*\n([\s\S]+?)(?=\n##\s|\n$)/);
	if (!m) return '';
	return m[1].replace(/\*+/g, '').slice(0, 400);
}

interface PerFile {
	id: string;
	权利限制: string;
	标的现状: string;
	标的介绍: string;
	公告头部: string;
}

const ids = readdirSync(MD_DIR)
	.filter((f) => f.endsWith('.md'))
	.map((f) => f.replace('.md', ''))
	.sort();
console.log(`扫描 ${ids.length} 个 markdown 文件...`);

const sectionText: Record<string, PerFile> = {};
const errors: { id: string; err: string }[] = [];

for (const id of ids) {
	try {
		const text = readFileSync(join(MD_DIR, `${id}.md`), 'utf-8');
		const content = stripFrontmatter(text);
		const table = extractTable(content);
		if (!table) {
			errors.push({ id, err: 'no <table>' });
			continue;
		}
		sectionText[id] = {
			id,
			权利限制: findRowText(table, '权利限制及瑕疵'),
			标的现状: findRowText(table, '标的现状'),
			标的介绍: findRowText(table, '标的介绍') || findRowText(table, '标的'),
			公告头部: extractGonggao(content),
		};
	} catch (e) {
		errors.push({ id, err: String(e) });
	}
}

writeFileSync(join(OUT, 'section-text.json'), JSON.stringify(sectionText));
console.log(`section-text.json 落盘：${Object.keys(sectionText).length} 个文件`);
if (errors.length) {
	writeFileSync(join(OUT, 'errors.json'), JSON.stringify(errors, null, 2));
	console.log(`errors.json：${errors.length} 个文件解析失败`);
}

// ============ Pattern 分析 ============

// 1. labels 全集（按 section 分组）
const labelSets: Record<string, Set<string>> = {
	权利限制: new Set(),
	标的介绍: new Set(),
};
for (const pf of Object.values(sectionText)) {
	for (const section of ['权利限制', '标的介绍'] as const) {
		const text = pf[section];
		const re = /([一-龥A-Za-z0-9（）()]{2,10}?)[:：]/g;
		let m;
		while ((m = re.exec(text))) {
			labelSets[section].add(m[1]);
		}
	}
}
const labels = {
	权利限制: Array.from(labelSets['权利限制']).sort(),
	标的介绍: Array.from(labelSets['标的介绍']).sort(),
};
writeFileSync(join(OUT, 'labels.json'), JSON.stringify(labels, null, 2));
console.log(
	`labels.json：权利限制 ${labels['权利限制'].length} 个 label，标的介绍 ${labels['标的介绍'].length} 个 label`
);

// 2. value-patterns: 关键字段每个的 raw value 全集
type Extractor = (pf: PerFile) => string;
const fieldExtractors: Record<string, Extractor> = {
	违章记录: (pf) => {
		const m = pf.权利限制.match(/违章记录[:：]([^3、4、5、]{1,80})/);
		return m?.[1] ?? '';
	},
	是否抵押: (pf) => {
		const m = pf.权利限制.match(/抵押[:：]([^（(；;3、4、5、]{1,15})/);
		return m?.[1] ?? '';
	},
	停车维修费片段: (pf) => {
		const m = pf.权利限制.match(/停车[、，]?维修[^；;]{0,80}/);
		return m?.[0] ?? '';
	},
	所有X元出现: (pf) => {
		return Array.from(pf.权利限制.matchAll(/(\d+(?:\.\d+)?)\s*元/g))
			.map((m) => m[0])
			.join('|');
	},
	共计合计总计片段: (pf) => {
		const m = pf.权利限制.match(/[共合总]计[^；;]{0,40}/);
		return m?.[0] ?? '';
	},
	车辆出厂日期: (pf) => {
		const m = pf.标的介绍.match(/(?:车辆)?出厂日期[：:]([^初123、，,]{1,20})/);
		return m?.[1] ?? '';
	},
	初次登记日期: (pf) => {
		const m = pf.标的介绍.match(/初次登记日期[：:]([^123、，,]{1,20})/);
		return m?.[1] ?? '';
	},
	行车里程: (pf) => {
		const m = pf.标的介绍.match(/行车里程[（(][^)）]*[)）][:：]([^123、强商]{1,40})/);
		return m?.[1] ?? '';
	},
	强制保险终止: (pf) => {
		const m = pf.标的介绍.match(/强制保险终止日期[：:]([^123、商]{1,20})/);
		return m?.[1] ?? '';
	},
	商业保险终止: (pf) => {
		const m = pf.标的介绍.match(/商业保险终止日期[：:]([^123、检]{1,20})/);
		return m?.[1] ?? '';
	},
	检验有效期终止: (pf) => {
		const m = pf.标的介绍.match(/检验有效期终止日期[：:]([^123、车]{1,20})/);
		return m?.[1] ?? '';
	},
	车辆报废止期: (pf) => {
		const m = pf.标的介绍.match(/车辆报废止期[：:]([^123、逾]{1,20})/);
		return m?.[1] ?? '';
	},
	逾期检验报废期: (pf) => {
		const m = pf.标的介绍.match(/逾期检验报废期[：:]([^123、车]{1,20})/);
		return m?.[1] ?? '';
	},
	排放标准: (pf) => {
		const m = pf.标的介绍.match(/排放标准[：:]([^123、（(]{1,15})/);
		return m?.[1] ?? '';
	},
	车辆型号: (pf) => {
		const m = pf.标的介绍.match(/车辆型号[：:]([^发123、]{1,30})/);
		return m?.[1] ?? '';
	},
	发动机号: (pf) => {
		const m = pf.标的介绍.match(/发动机号[：:]([^车123、]{1,30})/);
		return m?.[1] ?? '';
	},
	车辆识别代码: (pf) => {
		const m = pf.标的介绍.match(/车辆识别代码[：:]([^车123、]{1,30})/);
		return m?.[1] ?? '';
	},
	车辆登记证书编号: (pf) => {
		const m = pf.标的介绍.match(/车辆登记证书编号[：:]?([^车123、]{1,30})/);
		return m?.[1] ?? '';
	},
	法院从权利限制: (pf) => {
		const m = pf.权利限制.match(/被([一-龥]{2,18}人民法院)/);
		return m?.[1] ?? '';
	},
	法院从公告: (pf) => {
		const m = pf.公告头部.match(/([一-龥]{2,18}人民法院)将于/);
		return m?.[1] ?? '';
	},
};

const valuePatterns: Record<
	string,
	{
		unique_count: number;
		empty_count: number;
		top_values: { value: string; count: number; sample_ids: string[] }[];
	}
> = {};

for (const [field, fn] of Object.entries(fieldExtractors)) {
	const counts: Record<string, string[]> = {};
	let empty = 0;
	for (const pf of Object.values(sectionText)) {
		const v = fn(pf);
		if (!v) {
			empty++;
			continue;
		}
		counts[v] = counts[v] ?? [];
		if (counts[v].length < 5) counts[v].push(pf.id);
	}
	const sorted = Object.entries(counts).sort(([, a], [, b]) => b.length - a.length);
	valuePatterns[field] = {
		unique_count: sorted.length,
		empty_count: empty,
		top_values: sorted.slice(0, 50).map(([value, ids]) => ({
			value,
			count: ids.length,
			sample_ids: ids,
		})),
	};
}

writeFileSync(join(OUT, 'value-patterns.json'), JSON.stringify(valuePatterns, null, 2));
console.log(`value-patterns.json：${Object.keys(valuePatterns).length} 个字段`);

// 3. 费用名目聚类
const feeContexts: { ctx: string; amount: string; id: string }[] = [];
for (const pf of Object.values(sectionText)) {
	for (const m of pf.权利限制.matchAll(/(\d+(?:\.\d+)?)\s*元/g)) {
		const start = Math.max(0, (m.index ?? 0) - 30);
		const ctx = pf.权利限制.slice(start, m.index);
		feeContexts.push({ ctx, amount: m[0], id: pf.id });
	}
}

const feeNameClusters: Record<string, { count: number; samples: string[] }> = {};
for (const fc of feeContexts) {
	// 找 ctx 末尾的中文短语作 label
	const m = fc.ctx.match(/([一-龥]{2,8})$/);
	const label = m ? m[1] : fc.ctx.slice(-8) || '<empty>';
	feeNameClusters[label] = feeNameClusters[label] ?? { count: 0, samples: [] };
	feeNameClusters[label].count++;
	if (feeNameClusters[label].samples.length < 3) {
		feeNameClusters[label].samples.push(`${fc.id}: "...${fc.ctx}${fc.amount}"`);
	}
}

const sortedFeeClusters = Object.fromEntries(
	Object.entries(feeNameClusters)
		.sort(([, a], [, b]) => b.count - a.count)
		.slice(0, 80)
);
writeFileSync(join(OUT, 'fee-patterns.json'), JSON.stringify(sortedFeeClusters, null, 2));
console.log(`fee-patterns.json：${Object.keys(sortedFeeClusters).length} 个费用名目类（top 80）`);

// 4. 法院名称全集
const courtCounts: Record<string, number> = {};
const courtMismatch: { id: string; from权利限制: string; from公告: string }[] = [];
for (const pf of Object.values(sectionText)) {
	const v1 = fieldExtractors['法院从权利限制'](pf);
	const v2 = fieldExtractors['法院从公告'](pf);
	const v = v1 || v2;
	if (v) courtCounts[v] = (courtCounts[v] ?? 0) + 1;
	if (v1 && v2 && v1 !== v2) {
		courtMismatch.push({ id: pf.id, from权利限制: v1, from公告: v2 });
	}
}
writeFileSync(
	join(OUT, 'court-patterns.json'),
	JSON.stringify(
		{
			counts: Object.fromEntries(Object.entries(courtCounts).sort(([, a], [, b]) => b - a)),
			mismatch_权利限制_vs_公告: courtMismatch,
		},
		null,
		2
	)
);
console.log(`court-patterns.json：${Object.keys(courtCounts).length} 个法院；${courtMismatch.length} 个文件双源不一致`);

console.log('\n=== Discovery 总结 ===');
console.log(`扫描 ${ids.length}，成功 ${Object.keys(sectionText).length}，失败 ${errors.length}`);
console.log(`输出目录：${OUT}`);
