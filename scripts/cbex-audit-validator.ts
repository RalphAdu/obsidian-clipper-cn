// scripts/cbex-audit-validator.ts
//
// 33-point cbex audit validator. Compares e2e-clipped markdown against
// multiple independent ground-truth sources (hydrated DOM, list-item HTML,
// audit-time XHR re-fetches) per spec §4.

import { parseHTML } from 'linkedom';
import { parseListItemHtml, type ParsedListItem } from './cbex-list-fetcher';

export interface FieldGroundTruth {
	source: string;             // e.g. 'hydrated <title>', 'list-item .info p', 'body regex'
	value: string | number | null;
	match: boolean;
}

export interface FieldResult {
	field: string;
	pass: boolean;
	expected: string | number | null;   // value from markdown
	groundTruths: FieldGroundTruth[];
	note?: string;
}

export interface AuditInput {
	id: string;
	detailUrl: string;
	markdown: string;
	hydratedHtml: string;
	listItemHtml: string;
	ggnrXhr: string | null;     // null = XHR refetch failed 3 times → audit_infrastructure_error
	wtListXhr: string | null;
	jjjgXhr: string | null;
	today: string;              // YYYY-MM-DD for `created` field validation
}

export type AuditStatus = 'pass' | 'fail' | 'audit_infrastructure_error';

export interface AuditResult {
	id: string;
	status: AuditStatus;
	fieldResults: FieldResult[];
}

export interface ParsedMarkdown {
	frontmatter: Record<string, string | number | string[]>;
	body: string;
	sections: Set<string>;       // e.g. '## 关键信息', '## 标的物介绍', ...
	keyInfoRows: Map<string, string>;  // row label → value (from "## 关键信息" table)
	imageCount: number;           // count of '![' in body
	imageUrls: string[];          // URLs in body markdown img syntax
}

export function parseMarkdown(md: string): ParsedMarkdown {
	const fm: Record<string, string | number | string[]> = {};
	const sections = new Set<string>();
	const keyInfoRows = new Map<string, string>();
	let body = md;

	// Extract frontmatter
	const fmMatch = md.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
	if (fmMatch) {
		const fmBody = fmMatch[1];
		body = fmMatch[2];
		const lines = fmBody.split('\n');
		let i = 0;
		while (i < lines.length) {
			const line = lines[i];
			const kv = line.match(/^([^:]+):\s*(.*)$/);
			if (!kv) {
				i++;
				continue;
			}
			const key = kv[1].trim();
			let val: string | number | string[] = kv[2].trim();
			// tags multiline: "tags:" then "  - clippings"
			if (key === 'tags' && val === '') {
				const tags: string[] = [];
				i++;
				while (i < lines.length && lines[i].startsWith('  - ')) {
					const tag = lines[i].replace(/^  - "?/, '').replace(/"$/, '').trim();
					tags.push(tag);
					i++;
				}
				fm.tags = tags;
				continue;
			}
			// strip surrounding "" for string values
			if (typeof val === 'string' && val.startsWith('"') && val.endsWith('"')) {
				val = val.slice(1, -1);
			}
			// numeric guess (only if pure number string, no leading spaces/units)
			if (typeof val === 'string' && /^-?\d+(\.\d+)?$/.test(val)) {
				val = parseFloat(val);
			}
			fm[key] = val;
			i++;
		}
	}

	// Extract section headers
	const sectionRe = /^(##\s+\S.*?)$/gm;
	let m: RegExpExecArray | null;
	while ((m = sectionRe.exec(body)) !== null) {
		sections.add(m[1].trim());
	}

	// Extract 关键信息 table rows
	const keyInfoMatch = body.match(/##\s+关键信息\n([\s\S]*?)(?=\n##\s+|\n*$)/);
	if (keyInfoMatch) {
		const tableBody = keyInfoMatch[1];
		const rowRe = /^\|\s*(\S[^|]*?)\s*\|\s*(\S[^|]*?)\s*\|$/gm;
		let rm: RegExpExecArray | null;
		while ((rm = rowRe.exec(tableBody)) !== null) {
			if (rm[1] === '项目' || rm[1] === '---') continue;
			keyInfoRows.set(rm[1].trim(), rm[2].trim());
		}
	}

	// Image URLs in body
	const imageUrls: string[] = [];
	const imgRe = /!\[[^\]]*\]\(([^)]+)\)/g;
	while ((m = imgRe.exec(body)) !== null) {
		imageUrls.push(m[1]);
	}

	return {
		frontmatter: fm,
		body,
		sections,
		keyInfoRows,
		imageCount: imageUrls.length,
		imageUrls,
	};
}

function normalizeWs(s: string | null | undefined): string {
	return (s ?? '').replace(/\s+/g, ' ').trim();
}

function audit_title(input: AuditInput, parsed: ParsedMarkdown): FieldResult {
	const expected = normalizeWs(parsed.frontmatter.title as string);
	const { document: hydratedDoc } = parseHTML(input.hydratedHtml);
	const { document: liDoc } = parseHTML(input.listItemHtml);

	const gt1 = normalizeWs(hydratedDoc.querySelector('title')?.textContent?.replace(/^北交互联-/, ''));
	const gt2 = normalizeWs(liDoc.querySelector('a.title')?.textContent);
	const gt3 = normalizeWs(hydratedDoc.querySelector('.bd_detail_name')?.textContent);

	const groundTruths: FieldGroundTruth[] = [
		{ source: 'hydrated <title>', value: gt1, match: expected === gt1 },
		{ source: 'list-item a.title', value: gt2, match: expected === gt2 },
		{ source: 'hydrated .bd_detail_name', value: gt3, match: expected === gt3 },
	];
	return {
		field: 'title',
		pass: groundTruths.every((g) => g.match),
		expected,
		groundTruths,
	};
}

function audit_source(input: AuditInput, parsed: ParsedMarkdown): FieldResult {
	const expected = parsed.frontmatter.source as string;
	return {
		field: 'source',
		pass: expected === input.detailUrl,
		expected,
		groundTruths: [{ source: 'detailUrl input', value: input.detailUrl, match: expected === input.detailUrl }],
	};
}

function audit_subject_id(input: AuditInput, parsed: ParsedMarkdown): FieldResult {
	const expected = parsed.frontmatter.subject_id as string;
	const { document: hydratedDoc } = parseHTML(input.hydratedHtml);
	const li = parseListItemHtml(input.listItemHtml);

	const gt1 = li.subject_id;
	const gt2 = normalizeWs(hydratedDoc.querySelector('.bd_detail_num')?.textContent?.replace(/^标的物编号：/, ''));

	const groundTruths: FieldGroundTruth[] = [
		{ source: 'list-item subject_id', value: gt1, match: expected === gt1 },
		{ source: 'hydrated .bd_detail_num', value: gt2, match: expected === gt2 },
	];
	return {
		field: 'subject_id',
		pass: groundTruths.every((g) => g.match),
		expected,
		groundTruths,
	};
}

function audit_status(input: AuditInput, parsed: ParsedMarkdown): FieldResult {
	const expected = parsed.frontmatter.status as string;
	const { document: hydratedDoc } = parseHTML(input.hydratedHtml);
	const li = parseListItemHtml(input.listItemHtml);

	const gt1 = li.status;
	const gt2 = normalizeWs(hydratedDoc.querySelector('.state_mark')?.textContent);

	const groundTruths: FieldGroundTruth[] = [
		{ source: 'list-item data-style mapping', value: gt1, match: expected === gt1 },
		{ source: 'hydrated .state_mark', value: gt2, match: expected === gt2 },
	];
	return {
		field: 'status',
		pass: groundTruths.every((g) => g.match),
		expected,
		groundTruths,
	};
}

function audit_published(_input: AuditInput, parsed: ParsedMarkdown): FieldResult {
	const expected = normalizeWs(parsed.frontmatter.published as string);
	const gt = normalizeWs(parsed.frontmatter.bid_start as string);
	return {
		field: 'published',
		pass: expected === gt,
		expected,
		groundTruths: [{ source: 'derived fm.bid_start', value: gt, match: expected === gt }],
	};
}

function audit_description(_input: AuditInput, parsed: ParsedMarkdown): FieldResult {
	const expected = parsed.frontmatter.description as string;
	const gt = parsed.frontmatter.subject_id as string;
	return {
		field: 'description',
		pass: expected === gt,
		expected,
		groundTruths: [{ source: 'derived fm.subject_id', value: gt, match: expected === gt }],
	};
}

function audit_author(_input: AuditInput, parsed: ParsedMarkdown): FieldResult {
	const expected = parsed.frontmatter.author as string | undefined;
	const pass = !expected || expected === '';
	return {
		field: 'author',
		pass,
		expected: expected ?? null,
		groundTruths: [{ source: 'cbex has no author', value: null, match: pass }],
	};
}

function audit_tags(_input: AuditInput, parsed: ParsedMarkdown): FieldResult {
	const expected = parsed.frontmatter.tags as string[] | undefined;
	const pass = Array.isArray(expected) && expected.length === 1 && expected[0] === 'clippings';
	return {
		field: 'tags',
		pass,
		expected: expected ? expected.join(',') : null,
		groundTruths: [{ source: 'hardcoded ["clippings"]', value: 'clippings', match: pass }],
	};
}

function audit_created(input: AuditInput, parsed: ParsedMarkdown): FieldResult {
	const expected = parsed.frontmatter.created as string;
	const pass = /^\d{4}-\d{2}-\d{2}$/.test(expected) && expected === input.today;
	return {
		field: 'created',
		pass,
		expected,
		groundTruths: [{ source: 'today YYYY-MM-DD', value: input.today, match: pass }],
	};
}

function findColSpan(doc: Document, label: string): string | null {
	const cols = Array.from(doc.querySelectorAll('span.col'));
	for (const c of cols) {
		const t = normalizeWs(c.textContent);
		if (t.startsWith(label + '：')) {
			return t.replace(new RegExp('^' + label + '：'), '');
		}
	}
	return null;
}

function parsePriceText(text: string | null): number | null {
	if (!text) return null;
	const m = text.match(/[¥￥]?\s*([\d,]+(?:\.\d+)?)/);
	return m ? parseFloat(m[1].replace(/,/g, '')) : null;
}

function bodyText(hydratedDoc: Document): string {
	return hydratedDoc.body?.textContent || '';
}

function bodyRegexNumber(hydratedDoc: Document, re: RegExp): number | null {
	const text = bodyText(hydratedDoc);
	const m = text.match(re);
	return m ? parsePriceText(m[1]) : null;
}

function normalizeDateTime(s: string): string {
	// '2025.12.15 08:00' → '2025-12-15 08:00'; '2025年12月12日15时00分' → '2025-12-12 15:00'
	const m1 = s.match(/(\d{4})[年.\-](\d{1,2})[月.\-](\d{1,2})日?\s*(\d{1,2})[时:](\d{1,2})分?/);
	if (m1) {
		return `${m1[1]}-${String(m1[2]).padStart(2, '0')}-${String(m1[3]).padStart(2, '0')} ${String(m1[4]).padStart(2, '0')}:${String(m1[5]).padStart(2, '0')}`;
	}
	return s.trim();
}

function audit_final_price(input: AuditInput, parsed: ParsedMarkdown): FieldResult {
	const expected = parsed.frontmatter.final_price as number | undefined;
	const li = parseListItemHtml(input.listItemHtml);
	const { document: hydratedDoc } = parseHTML(input.hydratedHtml);

	const gt1 = li.final_price;
	const gt2 = bodyRegexNumber(hydratedDoc as any, /本标的物成交价[：:]\s*[¥￥]?\s*([\d,]+(?:\.\d+)?)/);

	// status='竞价结束' 且 list-item.final_price defined → markdown 必有 final_price 且 = GT1 = GT2
	// 否则 → markdown 必无 final_price
	const status = parsed.frontmatter.status as string;
	const isFinalExpected = status === '竞价结束' && gt1 !== undefined;

	if (isFinalExpected) {
		const groundTruths: FieldGroundTruth[] = [
			{ source: 'list-item 成交价', value: gt1 ?? null, match: expected === gt1 },
			{ source: 'body regex 本标的物成交价', value: gt2, match: gt2 === null ? false : expected === gt2 },
		];
		return {
			field: 'final_price',
			pass: expected !== undefined && groundTruths.every((g) => g.match),
			expected: expected ?? null,
			groundTruths,
		};
	}
	// status≠竞价结束 → markdown 必无 final_price
	return {
		field: 'final_price',
		pass: expected === undefined,
		expected: expected ?? null,
		groundTruths: [{ source: 'status not 竞价结束 → final_price must be absent', value: null, match: expected === undefined }],
	};
}

function audit_start_price(input: AuditInput, parsed: ParsedMarkdown): FieldResult {
	const expected = parsed.frontmatter.start_price as number | undefined;
	const { document: hydratedDoc } = parseHTML(input.hydratedHtml);

	const gt1 = parsePriceText(findColSpan(hydratedDoc as any, '起始价'));
	const gt2 = bodyRegexNumber(hydratedDoc as any, /起始价[：:]\s*[¥￥]?\s*([\d,]+(?:\.\d+)?)/);

	const groundTruths: FieldGroundTruth[] = [
		{ source: 'hydrated .col 起始价', value: gt1, match: expected === gt1 },
		{ source: 'body regex 起始价', value: gt2, match: expected === gt2 },
	];
	return {
		field: 'start_price',
		pass: expected !== undefined && groundTruths.every((g) => g.match),
		expected: expected ?? null,
		groundTruths,
	};
}

function audit_assess_price(input: AuditInput, parsed: ParsedMarkdown): FieldResult {
	const expected = parsed.frontmatter.assess_price as number | undefined;
	const { document: hydratedDoc } = parseHTML(input.hydratedHtml);

	const gt1 = parsePriceText(findColSpan(hydratedDoc as any, '评估价'));
	const gt2 = bodyRegexNumber(hydratedDoc as any, /评估价[：:]\s*[¥￥]?\s*([\d,]+(?:\.\d+)?)/);

	// assess_price is optional in markdown (only when extractor found it)
	if (expected === undefined) {
		// markdown skipped it → ground truths should both also be null/undefined
		const pass = gt1 === null && gt2 === null;
		return {
			field: 'assess_price',
			pass,
			expected: null,
			groundTruths: [
				{ source: 'hydrated .col 评估价', value: gt1, match: gt1 === null },
				{ source: 'body regex 评估价', value: gt2, match: gt2 === null },
			],
		};
	}

	const groundTruths: FieldGroundTruth[] = [
		{ source: 'hydrated .col 评估价', value: gt1, match: expected === gt1 },
		{ source: 'body regex 评估价', value: gt2, match: expected === gt2 },
	];
	return {
		field: 'assess_price',
		pass: groundTruths.every((g) => g.match),
		expected,
		groundTruths,
	};
}

function audit_cap_price(input: AuditInput, parsed: ParsedMarkdown): FieldResult {
	const expected = parsed.frontmatter.cap_price as number | undefined;
	const { document: hydratedDoc } = parseHTML(input.hydratedHtml);
	const li = parseListItemHtml(input.listItemHtml);

	// GT1: inline JS var zgxj = N
	const scriptsText = Array.from(hydratedDoc.querySelectorAll('script:not([src])'))
		.map((s) => s.textContent || '')
		.join('\n');
	const zgxjMatch = scriptsText.match(/\bzgxj\s*[:=]\s*['"]?(\d+(?:\.\d+)?)/);
	const gt1 = zgxjMatch ? parseFloat(zgxjMatch[1]) : null;

	const gt2 = parsePriceText(findColSpan(hydratedDoc as any, '最高限价'));
	const gt3 = isNaN(li.cap_price) ? null : li.cap_price;

	const groundTruths: FieldGroundTruth[] = [
		{ source: 'inline JS zgxj', value: gt1, match: expected === gt1 },
		{ source: 'hydrated .col 最高限价', value: gt2, match: expected === gt2 },
		{ source: 'list-item 最高限价', value: gt3, match: expected === gt3 },
	];
	return {
		field: 'cap_price',
		pass: expected !== undefined && groundTruths.every((g) => g.match),
		expected: expected ?? null,
		groundTruths,
	};
}

function audit_deposit(input: AuditInput, parsed: ParsedMarkdown): FieldResult {
	const expected = parsed.frontmatter.deposit as number | undefined;
	const { document: hydratedDoc } = parseHTML(input.hydratedHtml);

	const gt1 = parsePriceText(findColSpan(hydratedDoc as any, '保证金'));
	const gt2 = bodyRegexNumber(hydratedDoc as any, /保证金[：:]\s*[¥￥]?\s*([\d,]+(?:\.\d+)?)/);

	const groundTruths: FieldGroundTruth[] = [
		{ source: 'hydrated .col 保证金', value: gt1, match: expected === gt1 },
		{ source: 'body regex 保证金', value: gt2, match: expected === gt2 },
	];
	return {
		field: 'deposit',
		pass: expected !== undefined && groundTruths.every((g) => g.match),
		expected: expected ?? null,
		groundTruths,
	};
}

function audit_bid_start(input: AuditInput, parsed: ParsedMarkdown): FieldResult {
	const expected = parsed.frontmatter.bid_start as string;
	const { document: hydratedDoc } = parseHTML(input.hydratedHtml);

	const gt1Raw = findColSpan(hydratedDoc as any, '竞价开始时间');
	const gt1 = gt1Raw ? normalizeDateTime(gt1Raw) : null;

	const bodyMatch = bodyText(hydratedDoc as any).match(/竞价开始时间[：:]\s*(\d{4})[.\-](\d{1,2})[.\-](\d{1,2})\s+(\d{1,2}):(\d{2})/);
	const gt2 = bodyMatch
		? `${bodyMatch[1]}-${String(bodyMatch[2]).padStart(2, '0')}-${String(bodyMatch[3]).padStart(2, '0')} ${String(bodyMatch[4]).padStart(2, '0')}:${bodyMatch[5]}`
		: null;

	const groundTruths: FieldGroundTruth[] = [
		{ source: 'hydrated .col 竞价开始时间', value: gt1, match: expected === gt1 },
		{ source: 'body regex 竞价开始时间', value: gt2, match: expected === gt2 },
	];
	return {
		field: 'bid_start',
		pass: groundTruths.every((g) => g.match),
		expected,
		groundTruths,
	};
}

function audit_signup_end(input: AuditInput, parsed: ParsedMarkdown): FieldResult {
	const expected = parsed.frontmatter.signup_end as string;
	const { document: hydratedDoc } = parseHTML(input.hydratedHtml);

	// GT1: .jp_detail_joininfo .cont p .color_theme.fwb
	const colorThemeEl = hydratedDoc.querySelector('.jp_detail_joininfo .cont p .color_theme.fwb');
	const gt1Raw = colorThemeEl ? normalizeWs(colorThemeEl.textContent) : null;
	const gt1 = gt1Raw ? normalizeDateTime(gt1Raw) : null;

	// GT2: body regex
	const bodyMatch = bodyText(hydratedDoc as any).match(/报名及保证金报名费交纳截止时间[：:]\s*(\d{4})年(\d{1,2})月(\d{1,2})日(\d{1,2})时(\d{1,2})分/);
	const gt2 = bodyMatch
		? `${bodyMatch[1]}-${String(bodyMatch[2]).padStart(2, '0')}-${String(bodyMatch[3]).padStart(2, '0')} ${String(bodyMatch[4]).padStart(2, '0')}:${String(bodyMatch[5]).padStart(2, '0')}`
		: null;

	const groundTruths: FieldGroundTruth[] = [
		{ source: 'hydrated .color_theme.fwb', value: gt1, match: expected === gt1 },
		{ source: 'body regex 截止时间', value: gt2, match: expected === gt2 },
	];
	return {
		field: 'signup_end',
		pass: groundTruths.every((g) => g.match),
		expected,
		groundTruths,
	};
}

function audit_end_time(input: AuditInput, parsed: ParsedMarkdown): FieldResult {
	const expected = parsed.frontmatter.end_time as string | undefined;
	const li = parseListItemHtml(input.listItemHtml);
	const { document: hydratedDoc } = parseHTML(input.hydratedHtml);

	const gt1 = li.end_time;

	// GT2: 6 `.bd_detail_state_over .time_num` 拼接 YYYY-MM-DD HH:mm:ss
	const nums = Array.from(hydratedDoc.querySelectorAll('.bd_detail_state_over .time_num'))
		.map((el) => normalizeWs(el.textContent));
	const gt2 = nums.length >= 6
		? `${nums[0]}-${String(nums[1]).padStart(2, '0')}-${String(nums[2]).padStart(2, '0')} ${String(nums[3]).padStart(2, '0')}:${String(nums[4]).padStart(2, '0')}:${String(nums[5]).padStart(2, '0')}`
		: null;

	if (!expected) {
		// markdown skipped end_time → ground truths should also be unavailable
		const pass = !gt1 && !gt2;
		return {
			field: 'end_time',
			pass,
			expected: null,
			groundTruths: [
				{ source: 'list-item end_time', value: gt1, match: !gt1 },
				{ source: 'hydrated time_num concat', value: gt2, match: !gt2 },
			],
		};
	}

	const groundTruths: FieldGroundTruth[] = [
		{ source: 'list-item end_time', value: gt1, match: expected === gt1 },
		{ source: 'hydrated time_num concat', value: gt2, match: expected === gt2 },
	];
	return {
		field: 'end_time',
		pass: groundTruths.every((g) => g.match),
		expected,
		groundTruths,
	};
}

function audit_image(input: AuditInput, parsed: ParsedMarkdown): FieldResult {
	const expected = parsed.frontmatter.image as string | undefined;
	if (!expected) {
		// no frontmatter.image — OK only if ct2 image count is 0 (handled in audit_ct2_count Task 12)
		return {
			field: 'image',
			pass: true,
			expected: null,
			groundTruths: [{ source: 'no image expected', value: null, match: true }],
		};
	}
	const li = parseListItemHtml(input.listItemHtml);
	// GT: list-item <img data-original> URL; thumbnail vs full path may differ but file ID prefix matches
	const gt1Match = li.image.match(/\/(\d{16,})\.jpg/);
	const expectedMatch = expected.match(/\/(\d{16,})\.jpg/);
	const pass = !!gt1Match && !!expectedMatch && gt1Match[1] === expectedMatch[1];
	return {
		field: 'image',
		pass,
		expected,
		groundTruths: [{ source: 'list-item img data-original file ID prefix', value: li.image, match: pass }],
	};
}

function audit_bid_count(input: AuditInput, parsed: ParsedMarkdown): FieldResult {
	const expected = parsed.frontmatter.bid_count as number;
	const li = parseListItemHtml(input.listItemHtml);
	const { document: hydratedDoc } = parseHTML(input.hydratedHtml);

	// GT1: list-item bdlist_side_num — total bid count (后端 list API 计算)
	const gt1 = li.bid_count;
	// GT2: wtList XHR data row count — total bid count.
	// wtList HTML structure: 1 <tr> header + N <tr> data rows. Subtract 1.
	// 撤回 status: wtList may be empty string → no <tr> matches → 0 data rows.
	const trMatches = input.wtListXhr ? input.wtListXhr.match(/<tr/gi) : null;
	const gt2 = trMatches ? Math.max(0, trMatches.length - 1) : 0;
	// Note: hydrated .jp_detail_bjnum span shows "最高限价报价人数" (cap-price bidders),
	// NOT total bid count. Different semantics — informational only, not used in audit
	// pass criterion. Recorded as note.
	const bjnumEl = hydratedDoc.querySelector('.jp_detail_bjnum span');
	const capPriceBidders = bjnumEl ? parseInt(normalizeWs(bjnumEl.textContent), 10) : null;

	const groundTruths: FieldGroundTruth[] = [
		{ source: 'list-item bdlist_side_num (total bid count)', value: gt1, match: expected === gt1 },
		{ source: 'wtList <tr> count (total bid count)', value: gt2, match: expected === gt2 },
	];

	return {
		field: 'bid_count',
		pass: expected === gt1 && expected === gt2,
		expected,
		groundTruths,
		note: capPriceBidders !== null ? `Info: hydrated .jp_detail_bjnum (最高限价报价人数) = ${capPriceBidders} (semantically different from total bid count, informational only)` : undefined,
	};
}

function audit_followers(input: AuditInput, parsed: ParsedMarkdown): FieldResult {
	const expected = parsed.frontmatter.followers as number;
	const { document: hydratedDoc } = parseHTML(input.hydratedHtml);

	const bodyMatch = bodyText(hydratedDoc as any).match(/(\d+)人关注/);
	const gt1 = bodyMatch ? parseInt(bodyMatch[1], 10) : null;

	const el = hydratedDoc.querySelector('#focusPrj_countId');
	const gt2 = el ? parseInt(normalizeWs(el.textContent), 10) : null;

	const gt1Normalized = gt1 ?? 0;
	const gt2Normalized = gt2 ?? 0;
	const groundTruths: FieldGroundTruth[] = [
		{ source: 'body regex 人关注', value: gt1, match: expected === gt1Normalized },
		{ source: 'hydrated #focusPrj_countId', value: gt2, match: expected === gt2Normalized },
	];
	return {
		field: 'followers',
		pass: groundTruths.every((g) => g.match),
		expected,
		groundTruths,
	};
}

function audit_views(input: AuditInput, parsed: ParsedMarkdown): FieldResult {
	const expected = parsed.frontmatter.views as number;
	const { document: hydratedDoc } = parseHTML(input.hydratedHtml);

	const bodyMatch = bodyText(hydratedDoc as any).match(/(\d+)次围观/);
	const gt1 = bodyMatch ? parseInt(bodyMatch[1], 10) : null;

	// GT2: span.num followed by textNode '次围观'
	let gt2: number | null = null;
	const numSpans = Array.from(hydratedDoc.querySelectorAll('span.num'));
	for (const span of numSpans) {
		const next = (span as any).nextSibling;
		if (next && next.nodeType === 3 && (next.textContent || '').trim().startsWith('次围观')) {
			gt2 = parseInt(normalizeWs(span.textContent), 10) || 0;
			break;
		}
	}

	const gt1Normalized = gt1 ?? 0;
	const gt2Normalized = gt2 ?? 0;
	const groundTruths: FieldGroundTruth[] = [
		{ source: 'body regex 次围观', value: gt1, match: expected === gt1Normalized },
		{ source: 'hydrated span.num + 次围观 textNode', value: gt2, match: expected === gt2Normalized },
	];
	return {
		field: 'views',
		pass: groundTruths.every((g) => g.match),
		expected,
		groundTruths,
	};
}

function buyerGtFromHydrated(doc: Document, label: string): string | null {
	// labels: '摇号申请编码', '摇号次数', '摇号注册时间'
	const spans = Array.from(doc.querySelectorAll('.jp_detail_jjinfo .cont span'));
	for (const s of spans) {
		const t = normalizeWs(s.textContent);
		if (t.startsWith(label + '：')) {
			return t.replace(new RegExp('^' + label + '：'), '').trim();
		}
	}
	return null;
}

function buyerGtFromBodyRegex(doc: Document, re: RegExp): string | null {
	const text = bodyText(doc);
	const m = text.match(re);
	return m ? m[1].trim() : null;
}

function isBuyerExpected(parsed: ParsedMarkdown): boolean {
	// Buyer fields only present when status='竞价结束' AND markdown has final_price
	return parsed.frontmatter.status === '竞价结束' && parsed.frontmatter.final_price !== undefined;
}

function audit_buyer_lottery_code(input: AuditInput, parsed: ParsedMarkdown): FieldResult {
	const expected = parsed.keyInfoRows.get('买受人摇号编码') || null;
	const { document: hydratedDoc } = parseHTML(input.hydratedHtml);

	const gt1 = buyerGtFromHydrated(hydratedDoc as any, '摇号申请编码');
	const gt2 = buyerGtFromBodyRegex(hydratedDoc as any, /(?:买受人)?摇号申请编码[：:]\s*(\d+)/);

	const buyerExpected = isBuyerExpected(parsed);

	if (!buyerExpected) {
		// markdown should not have this row
		return {
			field: 'buyer.lottery_code',
			pass: expected === null,
			expected,
			groundTruths: [{ source: 'status not 竞价结束 with final_price → buyer absent', value: null, match: expected === null }],
		};
	}

	const groundTruths: FieldGroundTruth[] = [
		{ source: '.jp_detail_jjinfo .cont span 摇号申请编码', value: gt1, match: expected === gt1 },
		{ source: 'body regex 摇号申请编码', value: gt2, match: expected === gt2 },
	];
	return {
		field: 'buyer.lottery_code',
		pass: expected !== null && groundTruths.every((g) => g.match),
		expected,
		groundTruths,
	};
}

function audit_buyer_lottery_count(input: AuditInput, parsed: ParsedMarkdown): FieldResult {
	const expected = parsed.keyInfoRows.get('买受人摇号次数') || null;
	const { document: hydratedDoc } = parseHTML(input.hydratedHtml);

	const gt1 = buyerGtFromHydrated(hydratedDoc as any, '摇号次数');
	const gt2 = buyerGtFromBodyRegex(hydratedDoc as any, /(?:买受人)?摇号次数[：:]\s*(\d+)/);

	const buyerExpected = isBuyerExpected(parsed);

	if (!buyerExpected) {
		return {
			field: 'buyer.lottery_count',
			pass: expected === null,
			expected,
			groundTruths: [{ source: 'buyer absent', value: null, match: expected === null }],
		};
	}

	const groundTruths: FieldGroundTruth[] = [
		{ source: '.jp_detail_jjinfo .cont span 摇号次数', value: gt1, match: expected === gt1 },
		{ source: 'body regex 摇号次数', value: gt2, match: expected === gt2 },
	];
	return {
		field: 'buyer.lottery_count',
		pass: expected !== null && groundTruths.every((g) => g.match),
		expected,
		groundTruths,
	};
}

function audit_buyer_lottery_registered(input: AuditInput, parsed: ParsedMarkdown): FieldResult {
	const expected = parsed.keyInfoRows.get('买受人摇号注册时间') || null;
	const { document: hydratedDoc } = parseHTML(input.hydratedHtml);

	// GT1 raw is like '2011-01-02 13:23:21.364'; extractor truncates to 'YYYY-MM-DD HH:mm'.
	// Apply same truncation to GT1 so audit compares apples-to-apples.
	const gt1Raw = buyerGtFromHydrated(hydratedDoc as any, '摇号注册时间');
	const gt1Match = gt1Raw ? gt1Raw.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})/) : null;
	const gt1 = gt1Match ? `${gt1Match[1]} ${gt1Match[2]}` : gt1Raw;
	// body regex: 摇号注册时间：YYYY-MM-DD HH:MM[:SS[.MS]]
	const text = bodyText(hydratedDoc as any);
	const bm = text.match(/(?:买受人)?摇号注册时间[：:]\s*(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})/);
	const gt2 = bm ? `${bm[1]} ${bm[2]}` : null;

	const buyerExpected = isBuyerExpected(parsed);

	if (!buyerExpected) {
		return {
			field: 'buyer.lottery_registered',
			pass: expected === null,
			expected,
			groundTruths: [{ source: 'buyer absent', value: null, match: expected === null }],
		};
	}

	const groundTruths: FieldGroundTruth[] = [
		{ source: '.jp_detail_jjinfo .cont span 摇号注册时间', value: gt1, match: expected === gt1 },
		{ source: 'body regex 摇号注册时间', value: gt2, match: expected === gt2 },
	];
	return {
		field: 'buyer.lottery_registered',
		pass: expected !== null && groundTruths.every((g) => g.match),
		expected,
		groundTruths,
	};
}

function audit_ct2_image_count(input: AuditInput, parsed: ParsedMarkdown): FieldResult {
	const expectedCount = parsed.imageCount;
	const { document: hydratedDoc } = parseHTML(input.hydratedHtml);

	// GT1: count of img[bimg] elements
	const gt1 = hydratedDoc.querySelectorAll('img[bimg]').length;
	// GT2: inline JS tpzslist concat count
	const scriptsText = Array.from(hydratedDoc.querySelectorAll('script:not([src])'))
		.map((s) => s.textContent || '')
		.join('\n');
	const concatMatches = scriptsText.match(/\btpzslist\s*=\s*tpzslist\s*\+\s*['"][^'"]*<img[^>]+src=/g);
	const gt2 = concatMatches ? concatMatches.length : null;

	const groundTruths: FieldGroundTruth[] = [
		{ source: 'querySelectorAll img[bimg]', value: gt1, match: expectedCount === gt1 },
		{ source: 'inline JS tpzslist concat count', value: gt2, match: expectedCount === gt2 },
	];
	return {
		field: 'ct2_image_count',
		pass: groundTruths.every((g) => g.match),
		expected: expectedCount,
		groundTruths,
	};
}

// ──────────────────────────────────────────────────────────────────
// Section existence audit helpers & functions (#26-33)
// ──────────────────────────────────────────────────────────────────

function tabLinkExists(doc: Document, href: string): boolean {
	return !!doc.querySelector(`a[href="${href}"]`);
}

function textAreaValueLen(doc: Document, selector: string): number {
	const el = doc.querySelector(selector) as any;
	if (!el) return 0;
	// textarea content can be either .value or textContent
	const raw = (el.value ?? el.textContent ?? '').trim();
	if (!raw) return 0;
	// raw is HTML-encoded; for "≥100 chars" gating, raw length is sufficient
	return raw.length;
}

function htmlStripTagsLen(html: string): number {
	return html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().length;
}

function makeSectionAudit(
	fieldName: string,
	sectionHeader: string,
	predicate: (input: AuditInput, parsed: ParsedMarkdown) => boolean,
	gtDescriptor: string,
) {
	return function (input: AuditInput, parsed: ParsedMarkdown): FieldResult {
		const expectedPresent = parsed.sections.has(sectionHeader);
		const gtPresent = predicate(input, parsed);
		const pass = expectedPresent === gtPresent;
		return {
			field: fieldName,
			pass,
			expected: expectedPresent ? 'present' : 'absent',
			groundTruths: [{ source: gtDescriptor, value: gtPresent ? 'present' : 'absent', match: pass }],
		};
	};
}

const audit_section_关键信息 = makeSectionAudit(
	'section_关键信息',
	'## 关键信息',
	() => true,
	'unconditional (extractor always emits)',
);

function audit_section_标的物介绍(input: AuditInput, parsed: ParsedMarkdown): FieldResult {
	const { document: hydratedDoc } = parseHTML(input.hydratedHtml);
	const hasTab = tabLinkExists(hydratedDoc as any, '#bd_detail_tab_ct1');
	const textLen = textAreaValueLen(hydratedDoc as any, '#content_BDWJS');
	const gtPresent = hasTab && textLen >= 100;
	const expectedPresent = parsed.sections.has('## 标的物介绍');
	const pass = expectedPresent === gtPresent;
	return {
		field: 'section_标的物介绍',
		pass,
		expected: expectedPresent ? 'present' : 'absent',
		groundTruths: [{
			source: `a[href="#bd_detail_tab_ct1"] exists (${hasTab}) AND #content_BDWJS len=${textLen} (≥100=${textLen >= 100})`,
			value: gtPresent ? 'present' : 'absent',
			match: pass,
		}],
	};
}

function audit_section_图片展示(input: AuditInput, parsed: ParsedMarkdown): FieldResult {
	const { document: hydratedDoc } = parseHTML(input.hydratedHtml);
	const imgCount = hydratedDoc.querySelectorAll('img[bimg]').length;
	const gtPresent = imgCount > 0;
	const expectedPresent = parsed.sections.has('## 图片展示');
	const pass = expectedPresent === gtPresent;
	return {
		field: 'section_图片展示',
		pass,
		expected: expectedPresent ? 'present' : 'absent',
		groundTruths: [{
			source: `img[bimg].length = ${imgCount}`,
			value: gtPresent ? 'present' : 'absent',
			match: pass,
		}],
	};
}

function audit_section_司法处置公告(input: AuditInput, parsed: ParsedMarkdown): FieldResult {
	const len = input.ggnrXhr ? htmlStripTagsLen(input.ggnrXhr) : 0;
	const gtPresent = len >= 50;
	const expectedPresent = parsed.sections.has('## 司法处置公告');
	const pass = expectedPresent === gtPresent;
	return {
		field: 'section_司法处置公告',
		pass,
		expected: expectedPresent ? 'present' : 'absent',
		groundTruths: [{
			source: `audit XHR ggnr textContent len=${len} (≥50=${gtPresent})`,
			value: gtPresent ? 'present' : 'absent',
			match: pass,
		}],
	};
}

function audit_section_竞买须知(input: AuditInput, parsed: ParsedMarkdown): FieldResult {
	const { document: hydratedDoc } = parseHTML(input.hydratedHtml);
	const hasTab = tabLinkExists(hydratedDoc as any, '#bd_detail_tab_ct5');
	const ct5El = hydratedDoc.querySelector('#bd_detail_tab_ct5');
	const ct5Len = ct5El ? normalizeWs(ct5El.textContent).length : 0;
	const gtPresent = hasTab && ct5Len >= 100;
	const expectedPresent = parsed.sections.has('## 竞买须知');
	const pass = expectedPresent === gtPresent;
	return {
		field: 'section_竞买须知',
		pass,
		expected: expectedPresent ? 'present' : 'absent',
		groundTruths: [{
			source: `a[href="#bd_detail_tab_ct5"] exists (${hasTab}) AND #bd_detail_tab_ct5 textContent len=${ct5Len} (≥100=${ct5Len >= 100})`,
			value: gtPresent ? 'present' : 'absent',
			match: pass,
		}],
	};
}

function audit_section_竞价记录(input: AuditInput, parsed: ParsedMarkdown): FieldResult {
	// wtList HTML: 1 <tr> header + N data rows. Section should exist iff data rows > 0.
	const trCount = input.wtListXhr ? (input.wtListXhr.match(/<tr/gi) || []).length : 0;
	const dataRows = Math.max(0, trCount - 1);
	const gtPresent = dataRows >= 1;
	const expectedPresent = parsed.sections.has('## 竞价记录');
	const pass = expectedPresent === gtPresent;
	return {
		field: 'section_竞价记录',
		pass,
		expected: expectedPresent ? 'present' : 'absent',
		groundTruths: [{
			source: `wtList XHR data rows=${dataRows} (header excluded, ≥1=${gtPresent})`,
			value: gtPresent ? 'present' : 'absent',
			match: pass,
		}],
	};
}

function audit_section_竞价结果(input: AuditInput, parsed: ParsedMarkdown): FieldResult {
	const len = input.jjjgXhr ? htmlStripTagsLen(input.jjjgXhr) : 0;
	const gtPresent = len >= 50;
	const expectedPresent = parsed.sections.has('## 竞价结果');
	const pass = expectedPresent === gtPresent;
	return {
		field: 'section_竞价结果',
		pass,
		expected: expectedPresent ? 'present' : 'absent',
		groundTruths: [{
			source: `audit XHR jjjg textContent len=${len} (≥50=${gtPresent})`,
			value: gtPresent ? 'present' : 'absent',
			match: pass,
		}],
	};
}

function audit_section_联系方式(input: AuditInput, parsed: ParsedMarkdown): FieldResult {
	const { document: hydratedDoc } = parseHTML(input.hydratedHtml);
	const hasTab = tabLinkExists(hydratedDoc as any, '#bd_detail_tab_ct6');
	const ct6El = hydratedDoc.querySelector('#bd_detail_tab_ct6');
	const ct6Len = ct6El ? normalizeWs(ct6El.textContent).length : 0;
	// 联系方式 threshold: actual cbex pages can have as little as 30 chars
	// (单位+电话+地址 sparse format). 20 chars covers minimum useful contact.
	const gtPresent = hasTab && ct6Len >= 20;
	const expectedPresent = parsed.sections.has('## 联系方式');
	const pass = expectedPresent === gtPresent;
	return {
		field: 'section_联系方式',
		pass,
		expected: expectedPresent ? 'present' : 'absent',
		groundTruths: [{
			source: `a[href="#bd_detail_tab_ct6"] exists (${hasTab}) AND #bd_detail_tab_ct6 textContent len=${ct6Len} (≥20=${ct6Len >= 20})`,
			value: gtPresent ? 'present' : 'absent',
			match: pass,
		}],
	};
}

export function validateClip(input: AuditInput): AuditResult {
	const parsed = parseMarkdown(input.markdown);

	// XHR infra failure check (early exit per spec §4.8)
	if (input.ggnrXhr === null || input.wtListXhr === null || input.jjjgXhr === null) {
		return {
			id: input.id,
			status: 'audit_infrastructure_error',
			fieldResults: [],
		};
	}

	const fieldResults: FieldResult[] = [
		audit_title(input, parsed),
		audit_source(input, parsed),
		audit_subject_id(input, parsed),
		audit_status(input, parsed),
		audit_published(input, parsed),
		audit_description(input, parsed),
		audit_author(input, parsed),
		audit_tags(input, parsed),
		audit_created(input, parsed),
		audit_final_price(input, parsed),
		audit_start_price(input, parsed),
		audit_assess_price(input, parsed),
		audit_cap_price(input, parsed),
		audit_deposit(input, parsed),
		audit_bid_start(input, parsed),
		audit_signup_end(input, parsed),
		audit_end_time(input, parsed),
		audit_image(input, parsed),
		audit_bid_count(input, parsed),
		audit_followers(input, parsed),
		audit_views(input, parsed),
		audit_buyer_lottery_code(input, parsed),
		audit_buyer_lottery_count(input, parsed),
		audit_buyer_lottery_registered(input, parsed),
		audit_ct2_image_count(input, parsed),
		audit_section_关键信息(input, parsed),
		audit_section_标的物介绍(input, parsed),
		audit_section_图片展示(input, parsed),
		audit_section_司法处置公告(input, parsed),
		audit_section_竞买须知(input, parsed),
		audit_section_竞价记录(input, parsed),
		audit_section_竞价结果(input, parsed),
		audit_section_联系方式(input, parsed),
	];

	const allPass = fieldResults.every((r) => r.pass);
	return {
		id: input.id,
		status: allPass ? 'pass' : 'fail',
		fieldResults,
	};
}
