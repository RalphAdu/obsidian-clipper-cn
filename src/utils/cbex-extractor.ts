// src/utils/cbex-extractor.ts

export interface CbexParsedUrl {
	prjId: string;
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
