import { createLogger } from './logger';

const logger = createLogger('scys-extractor');

export function isScysCourseUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		if (parsed.hostname !== 'scys.com') return false;
		if (!/^\/course\/detail\/\d+/.test(parsed.pathname)) return false;
		return /^\d+$/.test(parsed.searchParams.get('chapterId') ?? '');
	} catch {
		return false;
	}
}

export function parseScysUrl(url: string): { courseId: number; chapterId: number } | null {
	try {
		const parsed = new URL(url);
		const pathMatch = parsed.pathname.match(/^\/course\/detail\/(\d+)/);
		const chapterIdStr = parsed.searchParams.get('chapterId');
		if (!pathMatch || !chapterIdStr || !/^\d+$/.test(chapterIdStr)) return null;
		return { courseId: parseInt(pathMatch[1], 10), chapterId: parseInt(chapterIdStr, 10) };
	} catch {
		return null;
	}
}
