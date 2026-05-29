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
