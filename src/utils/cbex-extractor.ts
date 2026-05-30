// src/utils/cbex-extractor.ts

import { createMarkdownContent } from 'defuddle/full';

export interface CbexParsedUrl {
	prjId: string;
}

// ── Top-level field types ─────────────────────────────────────────────────────

export interface CbexPrices {
	start_price?: number;
	assess_price?: number;
	cap_price?: number;
	deposit?: number;
	final_price?: number;
}

export interface CbexBuyer {
	lottery_code?: string;
	lottery_count?: string;
	lottery_registered?: string;
}

export interface CbexStats {
	followers: number;
	views: number;
	bid_count: number;
}

export interface CbexTopFields {
	title: string;
	subject_id: string;
	status: string;
	end_time: string;
	bid_start: string;
	signup_end: string;
	prices: CbexPrices;
	buyer: CbexBuyer;
	stats: CbexStats;
}

export function isCbexPrjDetailUrl(url: string): boolean {
	try {
		const u = new URL(url);
		return u.hostname === 'jpxkc.cbex.com' && /^\/jpxkc\/prj\/detail\/\d+\.html$/.test(u.pathname);
	} catch {
		return false;
	}
}

export function parseCbexUrl(url: string): CbexParsedUrl | null {
	if (!isCbexPrjDetailUrl(url)) return null;
	const u = new URL(url);
	const m = u.pathname.match(/^\/jpxkc\/prj\/detail\/(\d+)\.html$/);
	return m ? { prjId: m[1] } : null;
}

export interface CbexParams {
	bdid: string;
	cpdm: string;
	zgxj: string;
	jjcc: string;
}

const PARAM_PATTERNS: Record<keyof CbexParams, RegExp> = {
	bdid: /\bbdid\s*[:=]\s*['"]?(\d+)/i,
	cpdm: /\bcpdm\s*[:=]\s*['"]?(\d+)/i,
	zgxj: /\bzgxj\s*[:=]\s*['"]?(\d+(?:\.\d+)?)/i,
	jjcc: /\bjjcc\s*[:=]\s*['"]?(\d+)/i,
};

export function extractCbexParams(doc: ParentNode): CbexParams | null {
	const scripts = Array.from(doc.querySelectorAll('script:not([src])'));
	const all = scripts.map((s) => s.textContent || '').join('\n');
	const out: Partial<CbexParams> = {};
	for (const [k, re] of Object.entries(PARAM_PATTERNS) as [keyof CbexParams, RegExp][]) {
		const m = all.match(re);
		if (!m) return null;
		out[k] = m[1];
	}
	return out as CbexParams;
}

// ── Top-level field extractors ────────────────────────────────────────────────

function pad(s: string): string {
	return s.padStart(2, '0');
}

function getBodyText(doc: ParentNode): string {
	return (doc as unknown as { body?: { textContent?: string | null }; textContent?: string | null }).body?.textContent
		?? (doc as unknown as { textContent?: string | null }).textContent
		?? '';
}

export function extractTitle(doc: ParentNode): string {
	return (doc.querySelector('.bd_detail_name')?.textContent || '').trim();
}

export function extractSubjectId(doc: ParentNode): string {
	const raw = (doc.querySelector('.bd_detail_num')?.textContent || '').trim();
	return raw.replace(/^标的物编号[：:]\s*/, '');
}

export function extractStatus(doc: ParentNode): string {
	return (doc.querySelector('.state_mark')?.textContent || '').trim();
}

export function extractEndTime(doc: ParentNode): string {
	const nums = Array.from(doc.querySelectorAll('.bd_detail_state_over .time_num'))
		.map((el) => (el.textContent || '').trim());
	if (nums.length < 6) return '';
	const [y, mo, d, h, mi, s] = nums;
	return `${y}-${pad(mo)}-${pad(d)} ${pad(h)}:${pad(mi)}:${pad(s)}`;
}

export function extractBidStartTime(doc: ParentNode): string {
	const text = getBodyText(doc);
	const m = text.match(/竞价开始时间[：:]\s*(\d{4})[.\-](\d{1,2})[.\-](\d{1,2})\s+(\d{1,2}):(\d{2})/);
	if (!m) return '';
	return `${m[1]}-${pad(m[2])}-${pad(m[3])} ${pad(m[4])}:${m[5]}`;
}

export function extractSignupEndTime(doc: ParentNode): string {
	const text = getBodyText(doc);
	const m = text.match(/报名及保证金报名费交纳截止时间[：:]\s*(\d{4})年(\d{1,2})月(\d{1,2})日(\d{1,2})时(\d{1,2})分/);
	if (!m) return '';
	return `${m[1]}-${pad(m[2])}-${pad(m[3])} ${pad(m[4])}:${pad(m[5])}`;
}

function parsePrice(text: string): number | null {
	const m = text.match(/[¥￥]?\s*([\d,]+(?:\.\d+)?)/);
	if (!m) return null;
	return parseFloat(m[1].replace(/,/g, ''));
}

export function extractPrices(doc: ParentNode): CbexPrices {
	const text = getBodyText(doc);
	const out: CbexPrices = {};
	const labelToKey: Array<[RegExp, keyof CbexPrices]> = [
		[/起始价[：:]([^评最保本竞报关围]+)/, 'start_price'],
		[/评估价[：:]([^起最保本竞报关围]+)/, 'assess_price'],
		[/最高限价[：:]([^起评保本竞报关围]+)/, 'cap_price'],
		[/保证金[：:]([^起评最本竞报关围]+)/, 'deposit'],
		[/本标的物成交价[：:]([^起评最保竞报关围]+)/, 'final_price'],
	];
	for (const [re, key] of labelToKey) {
		const m = text.match(re);
		if (m) {
			const p = parsePrice(m[1]);
			if (p !== null) out[key] = p;
		}
	}
	return out;
}

export function extractBuyerInfo(doc: ParentNode): CbexBuyer {
	const text = getBodyText(doc);
	const out: CbexBuyer = {};
	const mCode = text.match(/(?:买受人)?摇号申请编码[：:]\s*(\d+)/);
	if (mCode) out.lottery_code = mCode[1];
	const mCnt = text.match(/(?:买受人)?摇号次数[：:]\s*(\d+)/);
	if (mCnt) out.lottery_count = mCnt[1];
	const mReg = text.match(/(?:买受人)?摇号注册时间[：:]\s*(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})/);
	if (mReg) out.lottery_registered = `${mReg[1]} ${mReg[2]}`;
	return out;
}

export function extractStats(doc: ParentNode): CbexStats {
	const bidCount = parseInt(
		(doc.querySelector('.jp_detail_bjnum span')?.textContent || '0').trim(),
		10,
	) || 0;

	// followers: <span class="num" id="focusPrj_countId">411</span>人关注
	const followersEl = doc.querySelector('#focusPrj_countId');
	const followers = followersEl
		? parseInt((followersEl.textContent || '0').trim(), 10) || 0
		: 0;

	// views: scan all span.num elements for the one followed by 次围观 text
	// The DOM is: <span class="num">124489</span>次围观
	let views = 0;
	const numSpans = Array.from(doc.querySelectorAll('span.num'));
	for (const span of numSpans) {
		const next = span.nextSibling;
		if (next && next.nodeType === 3 /* TEXT_NODE */ && (next.textContent || '').trim().startsWith('次围观')) {
			views = parseInt((span.textContent || '0').trim(), 10) || 0;
			break;
		}
	}

	return {
		followers,
		views,
		bid_count: bidCount,
	};
}

export function extractCbexTopFields(doc: ParentNode): CbexTopFields {
	return {
		title: extractTitle(doc),
		subject_id: extractSubjectId(doc),
		status: extractStatus(doc),
		end_time: extractEndTime(doc),
		bid_start: extractBidStartTime(doc),
		signup_end: extractSignupEndTime(doc),
		prices: extractPrices(doc),
		buyer: extractBuyerInfo(doc),
		stats: extractStats(doc),
	};
}

export function extractTpzslist(doc: ParentNode): string[] {
	const scripts = Array.from(doc.querySelectorAll('script:not([src])'));
	const all = scripts.map((s) => s.textContent || '').join('\n');

	// Form 1: `var tpzslist = ["url1","url2",...]` — JSON array of string URLs
	const mJson = all.match(/\btpzslist\s*=\s*(\[[^\]]*\])/);
	if (mJson) {
		try {
			const parsed = JSON.parse(mJson[1]);
			if (Array.isArray(parsed)) {
				return parsed.filter((u): u is string => typeof u === 'string');
			}
		} catch {
			// fall through to form 2
		}
	}

	// Form 2: string concatenation — `tpzslist = tpzslist + '<img src="...">'`
	// Extract all src= values from those concatenation lines
	const urls: string[] = [];
	const concatRe = /\btpzslist\s*=\s*tpzslist\s*\+\s*['"][^'"]*<img[^>]+src=['"]([^'"]+)['"]/g;
	let m: RegExpExecArray | null;
	while ((m = concatRe.exec(all)) !== null) {
		urls.push(m[1]);
	}
	return urls;
}

export async function fetchCbexTabContent(
	endpoint: string,
	body: string,
	fetchImpl: typeof fetch = fetch,
): Promise<string> {
	const res = await fetchImpl(endpoint, {
		method: 'POST',
		credentials: 'include',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
			'X-Requested-With': 'XMLHttpRequest',
		},
		body,
	});
	if (!res.ok) {
		throw new Error(`cbex tab fetch failed: ${endpoint} status=${res.status}`);
	}
	return await res.text();
}

export function extractBdwjsHtml(doc: ParentNode): string {
	const ta = doc.querySelector('#content_BDWJS') as HTMLTextAreaElement | null;
	if (!ta) return '';
	// In a real browser, textarea.value returns decoded HTML (entities resolved).
	// In linkedom (test env), .value is not decoded — fall back to decoding via
	// a temp div's innerHTML→textContent trick which works in both environments.
	const raw = ((ta as unknown as { value?: string }).value ?? ta.textContent ?? '').trim();
	if (!raw) return '';
	// If the content contains HTML entities, decode them using a temp element.
	if (raw.includes('&lt;') || raw.includes('&amp;') || raw.includes('&gt;')) {
		const d = (doc as unknown as Document).createElement('div');
		d.innerHTML = raw;
		return (d.textContent ?? '').trim();
	}
	return raw;
}

// ── HTML-fragment → Markdown converters (Task 8) ──────────────────────────────
// Each tab (ct4/ct7/ct8) gets its own named export so Task 11 can add
// per-section post-processing without touching the other converters.

export function ct4FragmentToMarkdown(fragment: string, baseUrl: string): string {
	return createMarkdownContent(fragment, baseUrl).trim();
}

export function ct7FragmentToMarkdown(fragment: string, baseUrl: string): string {
	return createMarkdownContent(fragment, baseUrl).trim();
}

export function ct8FragmentToMarkdown(fragment: string, baseUrl: string): string {
	return createMarkdownContent(fragment, baseUrl).trim();
}

// ── Frontmatter YAML builder (Task 9) ────────────────────────────────────────

export interface CbexFrontmatterInput {
	title: string;
	url: string;
	subject_id: string;
	status: string;
	start_price?: number;
	assess_price?: number;
	cap_price?: number;
	deposit?: number;
	final_price?: number;
	bid_start: string;
	signup_end: string;
	end_time?: string;
	bid_count: number;
	followers: number;
	views: number;
	created: string;
}

function yamlEscape(s: string): string {
	return `"${s.replace(/"/g, '\\"')}"`;
}

export function buildCbexFrontmatter(input: CbexFrontmatterInput): string {
	const lines: string[] = ['---'];
	lines.push(`title: ${yamlEscape(input.title)}`);
	lines.push(`url: ${yamlEscape(input.url)}`);
	lines.push(`source: cbex`);
	lines.push(`subject_id: ${yamlEscape(input.subject_id)}`);
	lines.push(`status: ${input.status}`);
	if (input.final_price !== undefined) lines.push(`final_price: ${input.final_price}`);
	if (input.start_price !== undefined) lines.push(`start_price: ${input.start_price}`);
	if (input.assess_price !== undefined) lines.push(`assess_price: ${input.assess_price}`);
	if (input.cap_price !== undefined) lines.push(`cap_price: ${input.cap_price}`);
	if (input.deposit !== undefined) lines.push(`deposit: ${input.deposit}`);
	lines.push(`bid_start: ${yamlEscape(input.bid_start)}`);
	lines.push(`signup_end: ${yamlEscape(input.signup_end)}`);
	if (input.end_time) lines.push(`end_time: ${yamlEscape(input.end_time)}`);
	lines.push(`bid_count: ${input.bid_count}`);
	lines.push(`followers: ${input.followers}`);
	lines.push(`views: ${input.views}`);
	lines.push(`created: ${input.created}`);
	lines.push('---');
	return lines.join('\n') + '\n';
}

// ── Structured content (Task 11) ─────────────────────────────────────────────

export interface CbexStructuredContent {
	// Generic fields (participates in ContentResponse fallback chain)
	title: string;
	author: string;        // always '' for cbex
	description: string;   // use subject_id
	published: string;     // use bid_start
	image: string;         // first image of tpzslist, absolute
	site: string;          // 'cbex'
	source: string;        // canonical URL
	content: string;       // assembled markdown body (NO frontmatter — content.ts adds that)
	wordCount: number;     // content.length

	// Proprietary fields (extractedContent dict for template engine)
	end_time: string;      // YYYY-MM-DD HH:mm:ss from .bd_detail_state_over .time_num
	bid_start: string;
	signup_end: string;
	prices: CbexPrices;
	stats: CbexStats;
	subject_id: string;
	status: string;
}

export async function extractCbexStructuredContent(
	doc: Document,
	url: string,
	fetchImpl: typeof fetch = fetch,
): Promise<CbexStructuredContent> {
	if (!isCbexPrjDetailUrl(url)) throw new Error(`cbex: not a cbex prj detail URL: ${url}`);
	const parsed = parseCbexUrl(url)!;
	const params = extractCbexParams(doc as unknown as ParentNode);
	if (!params) throw new Error('cbex: required params (bdid/cpdm/zgxj/jjcc) not found in inline scripts');

	const top = extractCbexTopFields(doc as unknown as ParentNode);

	// Fetch all 3 XHR endpoints in parallel; tolerate per-endpoint failure.
	const safeFetch = async (endpoint: string, body: string): Promise<string> => {
		try {
			return await fetchCbexTabContent(endpoint, body, fetchImpl);
		} catch {
			return '';
		}
	};

	const [ggnrRaw, wtListRaw, jjjgRaw] = await Promise.all([
		safeFetch('/page/jpxkc/prj/ggnr', `BDID=${params.bdid}`),
		// pageSize=10000 to capture ALL bid records (default would paginate at 10
		// rows, yielding wrong tr-count for high-bid auctions like 522611's 265 bids).
		safeFetch('/page/jpxkc/prj/wtListPaging', `cpdm=${parsed.prjId}&zgxj=${params.zgxj}&type=all&pageNo=1&pageSize=10000`),
		safeFetch('/page/jpxkc/prj/jjjgListPaging', `id=${parsed.prjId}&jjcc=${params.jjcc}&pageNo=1&pageSize=10`),
	]);

	// Override bid_count from wtList data row count.
	// `.jp_detail_bjnum span` is 最高限价报价人数 (cap-price bidders), NOT total
	// bid count. wtList HTML structure: 1 <tr> header (with <th>) + N <tr> data
	// rows (with <td>). Subtract 1 from total tr count to get true bid count.
	const wtTrCount = wtListRaw ? (wtListRaw.match(/<tr/gi) || []).length : 0;
	const wtDataRowCount = Math.max(0, wtTrCount - 1);
	if (wtDataRowCount > 0) {
		top.stats.bid_count = wtDataRowCount;
	}

	const baseUrl = new URL(url).origin;

	// ct1 标的物介绍 (from hidden textarea — already HTML)
	const ct1Html = extractBdwjsHtml(doc as unknown as ParentNode);
	// ct2 图片展示 (from inline JS)
	const ct2Imgs = extractTpzslist(doc as unknown as ParentNode).map((u) =>
		u.startsWith('http') ? u : `${baseUrl}${u.startsWith('/') ? '' : '/'}${u}`,
	);
	// Wrap each image in <figure> — Defuddle's Readability cleaner strips bare
	// <p><img></p> as decorative; <figure> persuades it the images are content.
	const ct2Html = ct2Imgs.map((u, i) => `<figure><img src="${u}" alt="标的物图${i + 1}" /></figure>`).join('\n');
	// ct5 竞买须知 (already-rendered HTML)
	const ct5Html = ((doc as unknown as ParentNode).querySelector('#bd_detail_tab_ct5')?.innerHTML || '').trim();
	// ct6 联系方式 (already-rendered HTML)
	const ct6Html = ((doc as unknown as ParentNode).querySelector('#bd_detail_tab_ct6')?.innerHTML || '').trim();

	const keyInfoHtml = buildKeyInfoTableHtml({
		subject_id: top.subject_id,
		status: top.status,
		start_price: top.prices.start_price,
		assess_price: top.prices.assess_price,
		cap_price: top.prices.cap_price,
		final_price: top.prices.final_price,
		deposit: top.prices.deposit,
		bid_start: top.bid_start,
		signup_end: top.signup_end,
		buyer: top.buyer,
		stats: top.stats,
	});

	const parts: string[] = [`<h1>${escapeHtml(top.title)}</h1>`, '<h2>关键信息</h2>', keyInfoHtml];
	if (ct1Html) parts.push('<h2>标的物介绍</h2>', ct1Html);
	if (ct2Html) parts.push('<h2>图片展示</h2>', ct2Html);
	const ggnrHasContent = ggnrRaw && ggnrRaw.replace(/<[^>]+>/g, '').trim().length >= 50;
	const jjjgHasContent = jjjgRaw && jjjgRaw.replace(/<[^>]+>/g, '').trim().length >= 50;
	if (ggnrHasContent) parts.push('<h2>司法处置公告</h2>', ggnrRaw);
	if (ct5Html) parts.push('<h2>竞买须知</h2>', ct5Html);
	if (wtDataRowCount > 0) parts.push('<h2>竞价记录</h2>', wtListRaw);
	if (jjjgHasContent) parts.push('<h2>竞价结果</h2>', jjjgRaw);
	if (ct6Html) parts.push('<h2>联系方式</h2>', ct6Html);
	const body = parts.join('\n');

	return {
		title: top.title,
		author: '',
		description: top.subject_id,
		published: top.bid_start,
		image: ct2Imgs[0] || '',
		site: 'cbex',
		source: url,
		content: body,
		wordCount: body.length,
		end_time: top.end_time,
		bid_start: top.bid_start,
		signup_end: top.signup_end,
		prices: top.prices,
		stats: top.stats,
		subject_id: top.subject_id,
		status: top.status,
	};
}

// ── Key-info table ────────────────────────────────────────────────────────────

export interface KeyInfoInput {
	subject_id: string;
	status: string;
	start_price?: number;
	assess_price?: number;
	cap_price?: number;
	final_price?: number;
	deposit?: number;
	bid_start: string;
	signup_end: string;
	buyer: CbexBuyer;
	stats: CbexStats;
}

function formatYuan(n: number): string {
	return `¥${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function escapeHtml(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function buildKeyInfoTable(i: KeyInfoInput): string {
	const rows: Array<[string, string]> = [
		['标的物编号', i.subject_id],
		['竞价状态', i.status],
	];
	if (i.start_price !== undefined) rows.push(['起始价', formatYuan(i.start_price)]);
	if (i.assess_price !== undefined) rows.push(['评估价', formatYuan(i.assess_price)]);
	if (i.cap_price !== undefined) rows.push(['最高限价', formatYuan(i.cap_price)]);
	if (i.final_price !== undefined) rows.push(['成交价', formatYuan(i.final_price)]);
	if (i.deposit !== undefined) rows.push(['保证金', formatYuan(i.deposit)]);
	rows.push(['竞价开始时间', i.bid_start]);
	rows.push(['报名截止时间', i.signup_end]);
	if (i.buyer.lottery_code) rows.push(['买受人摇号编码', i.buyer.lottery_code]);
	if (i.buyer.lottery_count) rows.push(['买受人摇号次数', i.buyer.lottery_count]);
	if (i.buyer.lottery_registered) rows.push(['买受人摇号注册时间', i.buyer.lottery_registered]);
	rows.push(['关注数', String(i.stats.followers)]);
	rows.push(['围观数', String(i.stats.views)]);
	rows.push(['报价次数', String(i.stats.bid_count)]);
	const lines = ['| 项目 | 内容 |', '|---|---|'];
	for (const [k, v] of rows) lines.push(`| ${k} | ${v} |`);
	return lines.join('\n');
}

export function buildKeyInfoTableHtml(i: KeyInfoInput): string {
	const rows: Array<[string, string]> = [
		['标的物编号', i.subject_id],
		['竞价状态', i.status],
	];
	if (i.start_price !== undefined) rows.push(['起始价', formatYuan(i.start_price)]);
	if (i.assess_price !== undefined) rows.push(['评估价', formatYuan(i.assess_price)]);
	if (i.cap_price !== undefined) rows.push(['最高限价', formatYuan(i.cap_price)]);
	if (i.final_price !== undefined) rows.push(['成交价', formatYuan(i.final_price)]);
	if (i.deposit !== undefined) rows.push(['保证金', formatYuan(i.deposit)]);
	rows.push(['竞价开始时间', i.bid_start]);
	rows.push(['报名截止时间', i.signup_end]);
	if (i.buyer.lottery_code) rows.push(['买受人摇号编码', i.buyer.lottery_code]);
	if (i.buyer.lottery_count) rows.push(['买受人摇号次数', i.buyer.lottery_count]);
	if (i.buyer.lottery_registered) rows.push(['买受人摇号注册时间', i.buyer.lottery_registered]);
	rows.push(['关注数', String(i.stats.followers)]);
	rows.push(['围观数', String(i.stats.views)]);
	rows.push(['报价次数', String(i.stats.bid_count)]);
	const trs = rows.map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`).join('');
	return `<table><thead><tr><th>项目</th><th>内容</th></tr></thead><tbody>${trs}</tbody></table>`;
}
