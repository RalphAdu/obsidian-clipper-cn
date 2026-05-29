// src/utils/cbex-extractor.ts

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
	if (nums.length < 5) return '';
	const [y, mo, d, h, mi] = nums;
	return `${y}-${pad(mo)}-${pad(d)} ${pad(h)}:${pad(mi)}`;
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
