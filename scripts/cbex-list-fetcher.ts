// scripts/cbex-list-fetcher.ts
//
// Fetch all detail IDs from a cbex zc_prjs list page via the
// /page/jpxkc/zc_prjs/prj_li XHR endpoint. Returns each ID's raw <li>
// markup which serves as an independent ground-truth source for audit
// (subject_id / title / status / prices / end_time / bid_count / image
// all visible in the list-item markup, parsed via parseListItemHtml).

const ENDPOINT = 'https://jpxkc.cbex.com/page/jpxkc/zc_prjs/prj_li';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const STATUS_BY_DATA_STYLE: Record<string, string> = {
	cj: '竞价结束',
	ch: '已撤回',
	jjz: '竞价中',
	lp: '流拍',
	zd: '终止',
};

export interface ListItem {
	id: string;
	listItemHtml: string;
}

export interface ParsedListItem {
	id: string;
	subject_id: string;
	title: string;
	dataStyle: string;
	status: string;
	cap_price: number;
	start_price?: number;
	final_price?: number;
	end_time: string;
	bid_count: number;
	image: string;
}

function parseListId(listUrl: string): string {
	const m = listUrl.match(/\/jpxkc\/zc_prjs\/(\d+)\.html$/);
	if (!m) throw new Error(`cbex list URL invalid: ${listUrl}`);
	return m[1];
}

async function fetchPage(listId: string, pageNo: number, pageSize: number): Promise<string> {
	const body = new URLSearchParams({
		id: listId,
		sortTag: '0',
		keyWord: '',
		czfy: '',
		zt: '',
		bzj: '',
		qsj: '',
		zgxj: '',
		pageNo: String(pageNo),
		pageSize: String(pageSize),
	}).toString();

	const res = await fetch(ENDPOINT, {
		method: 'POST',
		headers: {
			'User-Agent': UA,
			'Referer': `https://jpxkc.cbex.com/jpxkc/zc_prjs/${listId}.html`,
			'X-Requested-With': 'XMLHttpRequest',
			'Content-Type': 'application/x-www-form-urlencoded',
		},
		body,
	});

	if (!res.ok) throw new Error(`cbex list fetch HTTP ${res.status}`);
	return await res.text();
}

function extractItems(html: string): ListItem[] {
	const items: ListItem[] = [];
	const itemRe = /<li id="prj_li_(\d+)"[\s\S]*?<\/li>/g;
	let m: RegExpExecArray | null;
	while ((m = itemRe.exec(html)) !== null) {
		items.push({ id: m[1], listItemHtml: m[0] });
	}
	return items;
}

export async function fetchListIds(listUrl: string, opts?: { pageSize?: number }): Promise<ListItem[]> {
	const listId = parseListId(listUrl);
	const pageSize = opts?.pageSize ?? 100;
	const seen = new Set<string>();
	const result: ListItem[] = [];

	let pageNo = 1;
	while (true) {
		const html = await fetchPage(listId, pageNo, pageSize);
		const items = extractItems(html);
		if (items.length === 0) break;
		let newCount = 0;
		for (const item of items) {
			if (!seen.has(item.id)) {
				seen.add(item.id);
				result.push(item);
				newCount++;
			}
		}
		if (items.length < pageSize) break; // last page
		if (newCount === 0) break;           // safety guard
		pageNo++;
		if (pageNo > 50) throw new Error('cbex list fetch exceeded 50 pages — likely infinite loop');
	}

	return result;
}

function getMatchTrim(html: string, re: RegExp): string {
	const m = html.match(re);
	return m ? m[1].trim() : '';
}

function parsePriceYuan(text: string): number {
	const m = text.match(/[¥￥]?\s*([\d,]+(?:\.\d+)?)/);
	if (!m) return NaN;
	return parseFloat(m[1].replace(/,/g, ''));
}

export function parseListItemHtml(html: string): ParsedListItem {
	const id = getMatchTrim(html, /<li id="prj_li_(\d+)"/);
	const dataStyle = getMatchTrim(html, /data-style="([^"]+)"/);

	// title: <a class="title" ...>...</a>
	const title = getMatchTrim(html, /<a class="title"[^>]*>([^<]+)<\/a>/);

	// subject_id: <p>标的物编号：202512NC6575</p>
	const subject_id = getMatchTrim(html, /<p>标的物编号：([^<]+)<\/p>/);

	// status from data-style mapping; fallback to label_state_* textContent
	let status = STATUS_BY_DATA_STYLE[dataStyle] ?? '';
	if (!status) {
		const labelMatch = html.match(/<span class="label_state_[^"]*">([^<]+)<\/span>/);
		if (labelMatch) status = labelMatch[1].trim();
	}

	// final_price (status='cj' 成交): <p>成交价：<span ...>¥30,000.00</span></p>
	const finalMatch = html.match(/<p>成交价：<span[^>]*>([^<]+)<\/span><\/p>/);
	const final_price = finalMatch ? parsePriceYuan(finalMatch[1]) : undefined;

	// start_price (status≠成交): <p>起始价：<span ...>¥31,700.00</span></p>
	const startMatch = html.match(/<p>起始价：<span[^>]*>([^<]+)<\/span><\/p>/);
	const start_price = startMatch ? parsePriceYuan(startMatch[1]) : undefined;

	// cap_price: <p>最高限价：<span ...>¥30,000.00</span></p>
	const capMatch = html.match(/<p>最高限价：<span[^>]*>([^<]+)<\/span><\/p>/);
	const cap_price = capMatch ? parsePriceYuan(capMatch[1]) : NaN;

	// end_time: <div class="time">结束时间：2025-12-15 16:00:00</div>
	const end_time = getMatchTrim(html, /<div class="time">结束时间：([^<]+)<\/div>/);

	// bid_count: <p class="bdlist_side_num">265</p>
	const bidMatch = html.match(/<p class="bdlist_side_num">(\d+)<\/p>/);
	const bid_count = bidMatch ? parseInt(bidMatch[1], 10) : 0;

	// image: first <img data-original="..."> in the .thum block
	const image = getMatchTrim(html, /<img\s+data-original="([^"]+)"/);

	return {
		id,
		subject_id,
		title,
		dataStyle,
		status,
		cap_price,
		start_price,
		final_price,
		end_time,
		bid_count,
		image,
	};
}
