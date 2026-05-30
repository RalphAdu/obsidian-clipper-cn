// src/utils/cbex-csv-extract.ts
// cbex-2238 32 字段 CSV 提取纯函数集
// 接受 markdown (含 frontmatter) 或 server-rendered detail HTML 两种 input
// 设计：spec docs/superpowers/specs/2026-05-30-cbex-2238-csv-extract-design.md §4

import { parseHTML } from 'linkedom';

/** 32 列 CSV 字段（顺序固定，跟 spec §2 一致） */
export const FIELD_ORDER = [
	'ID', '标的物编号', '标题', '车辆URL', '法院', '竞价开始时间',
	'总价', '起始价', '评估价', '保证金', '最高限价',
	'违章罚款', '违章次数', '扣分',
	'停车维修费', '配钥匙费', '其他费用', '是否抵押',
	'行车里程',
	'车辆出厂日期', '初次登记日期', '登记至今间隔',
	'强制保险终止日期', '商业保险终止日期', '检验有效期终止日期',
	'车辆报废止期', '逾期检验报废期',
	'车辆型号', '发动机号', '车辆识别代码', '车辆登记证书编号',
	'排放标准',
] as const;

export type FieldName = typeof FIELD_ORDER[number];

export type FieldValue = string | number;

export type ExtractedRow = Record<FieldName, FieldValue>;

/** 单文件 input 抽象 — 同一套算法处理 markdown / detail HTML 两种来源 */
export interface ExtractInput {
	id: string;                                 // 文件名（无扩展名）
	rawText: string;                            // markdown 全文 或 server-rendered detail HTML
	frontmatter?: Record<string, FieldValue | string[]>;  // 解析后的 frontmatter（B 路径才有）
	listItemHtml?: string;                      // list-item HTML（A 路径才有）
	today: string;                              // YYYY-MM-DD 跑分析的当天
}

export interface SectionTexts {
	权利限制: string;                            // <p> 拆段后 join，全空白 stripped
	标的现状: string;
	标的介绍: string;
	公告头部: string;                            // markdown 的 "## 司法处置公告" section 或 ggnr 公告段
	权利限制Paragraphs: string[];                // <p> 块数组
	标的介绍Paragraphs: string[];
}

/** spec §4.8 抵押归一 */
export function normalize抵押(raw: string): '是' | '否' | '未知' {
	const t = (raw ?? '').replace(/[\s ；;]+/g, '');
	if (!t) return '未知';
	if (/^(是|已抵押|有抵押|有)$/.test(t)) return '是';
	if (/^(否|未抵押|无抵押|无)$/.test(t)) return '否';
	process.stderr.write(`[WARN] normalize抵押 fallback: raw='${raw}'\n`);
	return '未知';
}

/** spec §4.8 排放标准归一 */
export function normalize排放标准(raw: string): string {
	const t = (raw ?? '').replace(/[\s （）()]/g, '').replace(/国三及以上/, '国三');
	if (/国(三|3|III)/.test(t)) return '国三';
	if (/国(四|4|IV)/.test(t)) return '国四';
	// 国六 must be tested before 国五: VI contains V, so check longer token first
	if (/国(六|6|VI|Ⅵ)/.test(t)) return '国六';
	if (/国(五|5|V|Ⅴ)/.test(t)) return '国五';
	if (raw && raw.trim()) process.stderr.write(`[WARN] normalize排放标准 fallback: raw='${raw}'\n`);
	return raw?.trim() ?? '';
}

/** spec §4.8 日期归一 — YYYY-MM-DD 或 '' */
export function normalize日期(raw: string): string {
	const t = (raw ?? '').replace(/[\s ]/g, '');
	if (!t || /^(不详|不祥|不明|无|空)$/.test(t)) return '';
	let m = t.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/);
	if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
	m = t.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日?$/);
	if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
	if (raw && raw.trim()) process.stderr.write(`[WARN] normalize日期 fallback: raw='${raw}'\n`);
	return '';
}

// ── Task 4: markdown parse + table section extraction + paragraph split ─────

const stripWS = (s: string) => s.replace(/[\s ]+/g, '');

/** 解析 markdown，分离 frontmatter + body */
export function parseMarkdown(text: string): {
	frontmatter: Record<string, FieldValue | string[]>;
	body: string;
} {
	const fm: Record<string, FieldValue | string[]> = {};
	let body = text;
	const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
	if (!m) return { frontmatter: fm, body };
	body = m[2];
	const lines = m[1].split('\n');
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		const kv = line.match(/^([^:]+):\s*(.*)$/);
		if (!kv) { i++; continue; }
		const key = kv[1].trim();
		let val: FieldValue | string[] = kv[2].trim();
		if (key === 'tags' && val === '') {
			const tags: string[] = [];
			i++;
			while (i < lines.length && lines[i].startsWith('  - ')) {
				tags.push(lines[i].replace(/^  - "?/, '').replace(/"$/, '').trim());
				i++;
			}
			fm.tags = tags;
			continue;
		}
		if (typeof val === 'string' && val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
		if (typeof val === 'string' && /^-?\d+(\.\d+)?$/.test(val)) val = parseFloat(val);
		fm[key] = val;
		i++;
	}
	return { frontmatter: fm, body };
}

/** 拆 <p> blocks + strip 全空白 */
export function splitToParagraphs(html: string): string[] {
	const { document } = parseHTML(`<html><body>${html}</body></html>`);
	return Array.from(document.querySelectorAll('p'))
		.map((p) => stripWS(p.textContent || ''))
		.filter(Boolean);
}

function findRowText(table: string, prefix: string): { text: string; html: string } {
	const { document } = parseHTML(`<html><body>${table}</body></html>`);
	for (const tr of Array.from(document.querySelectorAll('tr'))) {
		const t = stripWS(tr.textContent || '');
		if (t.startsWith(prefix)) return { text: t, html: tr.innerHTML };
	}
	return { text: '', html: '' };
}

function extractGonggao(body: string): string {
	// markdown style: "## 司法处置公告" heading
	const m = body.match(/##\s*司法处置公告\s*\n([\s\S]+?)(?=\n##\s|\n*$)/);
	if (m) return m[1].replace(/\*+/g, '').slice(0, 600);
	// detail HTML style: search whole body for "XX人民法院 [spaces] 将 [spaces] 于" + 500 chars context
	// Strip HTML tags first so the court name is contiguous (not split by spans).
	// "将于" must allow spaces between 将 and 于 (HTML tag stripping may insert space between adjacent CJK chars).
	const stripped = body.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
	const courtMatch = stripped.match(/([一-龥]{2,20}人民法院\s*将\s*于[\s\S]{0,500})/);
	if (courtMatch) return courtMatch[1].slice(0, 600);
	return '';
}

/** spec §4.3 违章 3 字段 — 京内+京外求和，容错短形态 */
export function extract违章(text: string): { 次数: number; 扣分: number; 罚款: number } {
	const stripped = text.replace(/[\s ]/g, '');
	let 次数 = 0, 扣分 = 0, 罚款 = 0;
	// 标准三元组 X 起 Y 分 Z 元
	for (const m of stripped.matchAll(/(\d+)起[，,](\d+)分[，,](\d+)元/g)) {
		次数 += +m[1]; 扣分 += +m[2]; 罚款 += +m[3];
	}
	// 短形态 X 起 Z 元（缺扣分）：只在三元组之外的部分匹配
	const noTriple = stripped.replace(/\d+起[，,]\d+分[，,]\d+元[；;]?/g, '');
	for (const m of noTriple.matchAll(/(\d+)起[，,](\d+)元/g)) {
		次数 += +m[1]; 罚款 += +m[2];
	}
	// 只剩 X 起（京外纯次数）
	const onlyQi = noTriple.replace(/\d+起[，,]\d+元[；;]?/g, '');
	for (const m of onlyQi.matchAll(/(\d+)起[；;]/g)) {
		次数 += +m[1];
	}
	return { 次数, 扣分, 罚款 };
}

/** 提取 3 段 + 公告头部 + paragraph 数组 */
export function extractTableSections(bodyOrHtml: string): SectionTexts {
	const tableMatch = bodyOrHtml.match(/<table[\s\S]*?<\/table>/);
	const table = tableMatch ? tableMatch[0] : '';
	const quanxianItem = findRowText(table, '权利限制及瑕疵');
	const biaodiXianzhuang = findRowText(table, '标的现状');
	let biaodiJieshao = findRowText(table, '标的介绍');
	if (!biaodiJieshao.text) biaodiJieshao = findRowText(table, '标的');
	return {
		权利限制: quanxianItem.text,
		标的现状: biaodiXianzhuang.text,
		标的介绍: biaodiJieshao.text,
		公告头部: extractGonggao(bodyOrHtml),
		权利限制Paragraphs: splitToParagraphs(quanxianItem.html),
		标的介绍Paragraphs: splitToParagraphs(biaodiJieshao.html),
	};
}

/** spec §4.3 + §4.8 是否抵押 */
export function extract抵押(text: string): '是' | '否' | '未知' {
	const stripped = text.replace(/[\s ]/g, '');
	// 找 "抵押:" 或 "抵押：" 后的内容直到 ( / （ / ; / ； / 数字编号 / "其他" / 末尾
	const m = stripped.match(/(?:是否)?抵押[:：]([^（(；;<]+?)(?=（|\(|；|;|\d+[、.]|其他|$)/);
	if (!m) return '未知';
	return normalize抵押(m[1]);
}

// ── Task 7: 费用字段提取 ─────────────────────────────────────────────────────

/** spec §4.5.1 — 处理"先总价后分项"陷阱
 * 扫描文本中所有 "X 元" 匹配，找到总价标记（共计/合计/总计/车辆的费用共计），
 * 把总价标记前 100 字符内的分项和总价标记本身分到同一组，只输出总价；
 * 不在任何分组内的独立费用逐项输出。
 */
export function clusterFeesByTotalMarker(text: string): number[] {
	const fees = Array.from(text.matchAll(/(\d+(?:\.\d+)?)\s*元/g))
		.map((m) => ({ value: +m[1], offset: m.index! }));
	const totalMarkers = Array.from(
		text.matchAll(/(?:车辆的费用)?(?:共|合|总)计(?:约)?\s*(\d+(?:\.\d+)?)\s*元/g)
	).map((m) => ({ value: +m[1], offset: m.index! }));

	const grouped = new Set<number>();
	const reps: number[] = [];

	for (const tm of totalMarkers) {
		reps.push(tm.value);
		grouped.add(tm.offset);
		// Also mark the fee match at same offset as the total marker itself
		const tmFeeOffset = fees.find((f) => Math.abs(f.offset - tm.offset) < 20)?.offset;
		if (tmFeeOffset !== undefined) grouped.add(tmFeeOffset);
		// Sub-items appear BEFORE the total marker, within ~100 chars
		for (const f of fees) {
			if (f.offset < tm.offset && tm.offset - f.offset < 100) {
				grouped.add(f.offset);
			}
		}
	}
	// Sub-account breakdown AFTER total marker (e.g. "其中 X 元汇入...") — also exclude
	for (const tm of totalMarkers) {
		for (const f of fees) {
			if (f.offset > tm.offset && f.offset - tm.offset < 150) {
				grouped.add(f.offset);
			}
		}
	}

	for (const f of fees) {
		if (!grouped.has(f.offset)) reps.push(f.value);
	}
	return reps;
}

/** spec §4.5 STEP 3 — 提取 "停车、维修等费用：" 整段，到下一个编号节为止 */
export function extract停车维修费用Block(cleaned: string): string {
	const m = cleaned.match(
		/(?:\d+、)?停车[、，]?维修[^：:]{0,8}[：:][\s\S]*?(?=\d+、|其他瑕疵披露|拟提供的文件|备注|$)/
	);
	return m ? m[0] : '';
}

/** spec §4.5 — 4 费用字段：违章罚款 / 停车维修费 / 配钥匙费 / 其他费用 */
export function extract费用(权利限制Text: string): {
	违章罚款: number; 停车维修费: number; 配钥匙费: number; 其他费用: number;
} {
	// STEP 1: 排除非费用片段（日费率 + 违章起数段）
	const cleaned = 权利限制Text
		.replace(/(?:每天|24\s*小时|\d+\s*小时)\s*\d+(?:\.\d+)?\s*元/g, '')
		.replace(/\d+(?:\.\d+)?\s*元\s*\/\s*(?:天|小时)/g, '')
		.replace(/\d+\s*起[，,][^；;]*?元/g, '');

	// STEP 2: 违章罚款（用原文，不用 cleaned，避免 replace 误删）
	const { 罚款: 违章罚款 } = extract违章(权利限制Text);

	// STEP 3: 停车维修费 block
	const feeBlock = extract停车维修费用Block(cleaned);
	const 停车维修费 = clusterFeesByTotalMarker(feeBlock).reduce((s, n) => s + n, 0);

	// STEP 4: 配钥匙费（两 alt label）
	let 配钥匙费 = 0;
	const m1 = cleaned.match(/配钥匙费用?\s*[：:]?\s*(\d+(?:\.\d+)?)\s*元/);
	const m2 = cleaned.match(/配钥匙的相关费用为\s*(\d+(?:\.\d+)?)\s*元/);
	if (m1) 配钥匙费 = +m1[1];
	else if (m2) 配钥匙费 = +m2[1];

	// STEP 5: 其他费用 = cleaned 内 feeBlock 之外的总价 - 配钥匙费
	const restText = cleaned
		.replace(feeBlock, '')
		.replace(/配钥匙费用?\s*[：:]?\s*\d+(?:\.\d+)?\s*元/g, '')
		.replace(/配钥匙的相关费用为\s*\d+(?:\.\d+)?\s*元/g, '');
	const restTotal = clusterFeesByTotalMarker(restText).reduce((s, n) => s + n, 0);
	const 其他费用 = Math.max(0, restTotal - 配钥匙费);

	return { 违章罚款, 停车维修费, 配钥匙费, 其他费用 };
}

// ── Task 8: 车辆参数字段提取 ──────────────────────────────────────────────────

/** 按 label 从 paragraphs 找一段并去前缀 */
export function getFieldFromParagraphs(paragraphs: string[], ...labels: string[]): string {
	for (const p of paragraphs) {
		for (const l of labels) {
			// 前缀可能有 "1、" / "2、" / "3、" / 空
			// label 后允许可选短后缀如 "（约）" 再接冒号
			const re = new RegExp(`^(?:\\d+[、.])?${l}[^：:]{0,6}[：:](.*)$`);
			const m = p.match(re);
			if (m) {
				// 去尾巴可能粘的括号注释（如 "国五(国三及以上...)" → "国五"）
				return m[1].trim().replace(/[\(（].*$/, '').trim();
			}
		}
	}
	return '';
}

export interface 车辆参数 {
	车辆出厂日期: string;
	初次登记日期: string;
	行车里程: string;
	强制保险终止日期: string;
	商业保险终止日期: string;
	检验有效期终止日期: string;
	车辆报废止期: string;
	逾期检验报废期: string;
	车辆型号: string;
	发动机号: string;
	车辆识别代码: string;
	车辆登记证书编号: string;
	排放标准: string;
}

function getMileage(raw: string): string {
	if (!raw) return '';
	if (/见图片展示|见照片/.test(raw)) return '';
	const m = raw.match(/^(\d+(?:\.\d+)?(?:km|公里|KM)?)/);
	return m ? m[1] : '';
}

function cleanFromEmpty(raw: string): string {
	if (!raw) return '';
	if (/^(不详|不祥|不明|无)$/.test(raw.trim())) return '';
	return raw.trim();
}

// ── Task 9: 法院字段提取 ──────────────────────────────────────────────────────

/** spec §4.6 — 三级 fallback
 * 优先级：公告 "XX 法院将于" > 公告末尾署名 > 权利限制 "被 XX 法院"
 * 语义：管辖/处置法院，非查封法院
 */
export function extract法院(公告Text: string, 权利限制Text: string): string {
	// Allow optional whitespace between 法院 and 将于, AND between 将 and 于 (detail HTML stripping inserts spaces between adjacent CJK chars)
	const m1 = 公告Text.match(/([一-龥]{2,20}人民法院)\s*将\s*于/);
	if (m1) return m1[1];
	const m1b = 公告Text.match(/([一-龥]{2,20}人民法院)\s*$/m);
	if (m1b) return m1b[1];
	const m2 = 权利限制Text.match(/被([一-龥]{2,20}人民法院)/);
	if (m2) return m2[1];
	return '';
}

/** 5 北京区法院在权利限制源中历史上不带北京市前缀，需硬编码补全
 * （其余 27 个非前缀法院已实地验证均为真外地，不得补北京市）
 */
const BEIJING_DISTRICTS_NEEDING_PREFIX = ['丰台区', '房山区', '平谷区', '通州区', '石景山区'];

/** spec §4.6 — 不盲补前缀，依公告源对照
 * 优先级：原文已含省/市前缀 > 北京区白名单 > 公告源 regex 匹配 > 原样 + WARN
 */
export function normalize法院(raw: string, sources: { 公告: string; 权利限制: string }): string {
	if (!raw) return '';
	// cbex markdown 公告偶有 typo: 北京市第一/二/三中级区人民法院 — 中级法院无"区"层级
	const t = raw.trim().replace(/(中级)区(人民法院)/, '$1$2');
	if (/^(.{2,5}省|.{2,5}市|北京市|天津市|上海市|重庆市)/.test(t)) return t;
	// Beijing district white list (5 districts that appear without prefix in 权利限制 source)
	for (const d of BEIJING_DISTRICTS_NEEDING_PREFIX) {
		if (t.startsWith(d)) return '北京市' + t;
	}
	// Fallback: 公告 source match
	const m = sources.公告.match(new RegExp(`(.{2,5}(?:市|省))${t}`));
	if (m) return m[1] + t;
	process.stderr.write(`[WARN] normalize法院 无法补全前缀: raw='${raw}'\n`);
	return t;
}

export function extract车辆参数(paragraphs: string[]): 车辆参数 {
	const get = (...labels: string[]) => getFieldFromParagraphs(paragraphs, ...labels);
	return {
		车辆出厂日期: normalize日期(get('车辆出厂日期', '出厂日期')),
		初次登记日期: normalize日期(get('初次登记日期')),
		行车里程: getMileage(get('里程表显示行车里程', '行车里程')),
		强制保险终止日期: normalize日期(get('强制保险终止日期')),
		商业保险终止日期: normalize日期(get('商业保险终止日期')),
		检验有效期终止日期: normalize日期(get('检验有效期终止日期')),
		车辆报废止期: normalize日期(get('车辆报废止期')),
		逾期检验报废期: normalize日期(get('逾期检验报废期')),
		车辆型号: get('车辆型号'),
		发动机号: get('发动机号'),
		车辆识别代码: get('车辆识别代码'),
		车辆登记证书编号: cleanFromEmpty(get('车辆登记证书编号')),
		排放标准: normalize排放标准(get('排放标准')),
	};
}

// ── Task 10: 总价 + 登记至今间隔 ──────────────────────────────────────────────

/** spec §4.7 — 总价 = cap_price + 4 费用项之和 */
export function compute总价(args: {
	cap_price: number; 停车维修费: number; 违章罚款: number; 配钥匙费: number; 其他费用: number;
}): number {
	return args.cap_price + args.停车维修费 + args.违章罚款 + args.配钥匙费 + args.其他费用;
}

/** spec §4.7 — 单位「年」保留 1 位小数 */
export function compute登记至今间隔(登记日期: string, today: string): string {
	if (!登记日期 || !today) return '';
	const start = new Date(登记日期 + 'T00:00:00Z').getTime();
	const end = new Date(today + 'T00:00:00Z').getTime();
	if (isNaN(start) || isNaN(end)) return '';
	const years = (end - start) / (365.25 * 24 * 3600 * 1000);
	return years.toFixed(1);
}

// ── Task 11: detail HTML branch helpers ───────────────────────────────────────

/** Round 2 A 路径 — 检测 rawText 是否为 server-rendered detail HTML */
export function isDetailHtml(text: string): boolean {
	return text.includes('bd_detail_num') && text.includes('bd_detail_name');
}

/** Round 2 A 路径 — 从 detail HTML 抽 frontmatter 等价字段 */
export function extractFrontmatterFromDetailHtml(
	html: string,
	id: string
): Record<string, FieldValue | string[]> {
	const fm: Record<string, FieldValue | string[]> = {};

	// subject_id: <... class="bd_detail_num">标的物编号：202512QY97H8</div>
	const subM = html.match(/class="bd_detail_num"[^>]*>\s*标的物编号[：:]\s*([^<\s]+)/);
	if (subM) fm.subject_id = subM[1].trim();

	// title: <... class="bd_detail_name">京XXX某品牌某型号</div>  (often has nested spans)
	const titleM = html.match(/class="bd_detail_name"[^>]*>([^<]+)</);
	if (titleM) fm.title = titleM[1].trim();

	// URL is derivable from id
	fm.source = `https://jpxkc.cbex.com/jpxkc/prj/detail/${id}.html`;

	// Prices: "起始价：¥ 82,700.00" (allow optional space and comma in number)
	const pricePatterns: Array<[string, RegExp]> = [
		['start_price', /起始价[：:]\s*[¥￥]\s*([\d,.]+)/],
		['assess_price', /评估价[：:]\s*[¥￥]\s*([\d,.]+)/],
		['deposit', /保证金[：:]\s*[¥￥]\s*([\d,.]+)/],
		['cap_price', /最高限价[：:]\s*[¥￥]\s*([\d,.]+)/],
	];
	for (const [k, re] of pricePatterns) {
		const m = html.match(re);
		if (m) fm[k] = parseFloat(m[1].replace(/,/g, ''));
	}

	// bid_start: accept "YYYY.M.D HH:MM" / "YYYY/M/D HH:MM" / "YYYY-M-D HH:MM"
	const bidM = html.match(/竞价开始时间[：:]\s*(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})\s+(\d{1,2}:\d{2})/);
	if (bidM) fm.bid_start = `${bidM[1]}-${bidM[2].padStart(2, '0')}-${bidM[3].padStart(2, '0')} ${bidM[4]}`;

	return fm;
}

// ── Task 11: extractAllFields 集成入口 ─────────────────────────────────────────

/** spec §4 — 顶层 orchestrator，调用所有 Phase 1 函数，返回单行 32 字段 */
export function extractAllFields(input: ExtractInput): ExtractedRow {
	const { id, rawText, today } = input;

	let frontmatter: Record<string, FieldValue | string[]>;
	let body: string;
	if (isDetailHtml(rawText)) {
		frontmatter = extractFrontmatterFromDetailHtml(rawText, id);
		body = rawText;
	} else {
		const parsed = parseMarkdown(rawText);
		frontmatter = parsed.frontmatter;
		body = parsed.body;
	}

	const sections = extractTableSections(body);

	const 法院Raw = extract法院(sections.公告头部, sections.权利限制);
	const 法院 = normalize法院(法院Raw, { 公告: sections.公告头部, 权利限制: sections.权利限制 });
	const 违章 = extract违章(sections.权利限制);
	const 抵押 = extract抵押(sections.权利限制);
	const 费用 = extract费用(sections.权利限制);
	const 车辆参数 = extract车辆参数(sections.标的介绍Paragraphs);

	const cap_price = Number(frontmatter.cap_price ?? 0);
	const 总价 = compute总价({
		cap_price,
		停车维修费: 费用.停车维修费,
		违章罚款: 费用.违章罚款,
		配钥匙费: 费用.配钥匙费,
		其他费用: 费用.其他费用,
	});
	const 登记至今间隔 = compute登记至今间隔(车辆参数.初次登记日期, today);

	return {
		ID: id,
		标的物编号: String(frontmatter.subject_id ?? ''),
		标题: String(frontmatter.title ?? ''),
		车辆URL: String(frontmatter.source ?? ''),
		法院,
		竞价开始时间: String(frontmatter.bid_start ?? ''),
		总价,
		起始价: Number(frontmatter.start_price ?? 0),
		评估价: Number(frontmatter.assess_price ?? 0),
		保证金: Number(frontmatter.deposit ?? 0),
		最高限价: cap_price,
		违章罚款: 费用.违章罚款,
		违章次数: 违章.次数,
		扣分: 违章.扣分,
		停车维修费: 费用.停车维修费,
		配钥匙费: 费用.配钥匙费,
		其他费用: 费用.其他费用,
		是否抵押: 抵押,
		行车里程: 车辆参数.行车里程,
		车辆出厂日期: 车辆参数.车辆出厂日期,
		初次登记日期: 车辆参数.初次登记日期,
		登记至今间隔,
		强制保险终止日期: 车辆参数.强制保险终止日期,
		商业保险终止日期: 车辆参数.商业保险终止日期,
		检验有效期终止日期: 车辆参数.检验有效期终止日期,
		车辆报废止期: 车辆参数.车辆报废止期,
		逾期检验报废期: 车辆参数.逾期检验报废期,
		车辆型号: 车辆参数.车辆型号,
		发动机号: 车辆参数.发动机号,
		车辆识别代码: 车辆参数.车辆识别代码,
		车辆登记证书编号: 车辆参数.车辆登记证书编号,
		排放标准: 车辆参数.排放标准,
	} as ExtractedRow;
}
