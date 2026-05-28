export interface XiaoyuzhouParsedUrl {
  type: 'episode' | null;
  episodeId: string | null;
}

export function isXiaoyuzhouEpisodeUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      (u.hostname === 'www.xiaoyuzhoufm.com' || u.hostname === 'xiaoyuzhoufm.com') &&
      /^\/episode\/[A-Za-z0-9]+\/?$/.test(u.pathname)
    );
  } catch {
    return false;
  }
}

export function parseXiaoyuzhouUrl(url: string): XiaoyuzhouParsedUrl {
  if (!isXiaoyuzhouEpisodeUrl(url)) return { type: null, episodeId: null };
  try {
    const u = new URL(url);
    const m = u.pathname.match(/^\/episode\/([A-Za-z0-9]+)\/?$/);
    return { type: 'episode', episodeId: m ? m[1] : null };
  } catch {
    return { type: null, episodeId: null };
  }
}

export function canonicalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/$/, '')}`;
  } catch {
    return url;
  }
}

export function formatDuration(iso: string): string {
  if (!iso || typeof iso !== 'string') return '';
  // ISO 8601 duration: PT[h]H[m]M[s]S
  const m = iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return '';
  const h = parseInt(m[1] || '0', 10);
  const min = parseInt(m[2] || '0', 10);
  const s = parseInt(m[3] || '0', 10);
  // 把超过 60 分钟的部分进位到小时
  const totalSec = h * 3600 + min * 60 + s;
  if (totalSec === 0 && !m[1] && !m[2] && !m[3]) return '';
  const hh = Math.floor(totalSec / 3600);
  const mm = Math.floor((totalSec % 3600) / 60);
  const ss = totalSec % 60;
  return [hh, mm, ss].map(n => String(n).padStart(2, '0')).join(':');
}

export function normalizeDate(text: string): string {
  if (!text) return '';
  const trimmed = text.trim();
  // 中文点号格式 2025.6.18
  let m = trimmed.match(/^(\d{4})\.(\d{1,2})\.(\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  // ISO 格式 2025-06-18
  m = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return '';
}

export function parseEpisodeNumber(title: string): string {
  if (!title) return '';
  const m = title.match(/^([Ee][Pp]?\d+)[.\s．。]/);
  return m ? m[1] : '';
}

export function rewriteTimestamps(articleEl: Element, audioUrl: string): void {
  if (!audioUrl) return;
  const anchors = Array.from(articleEl.querySelectorAll('a.timestamp'));
  for (const el of anchors) {
    const sec = el.getAttribute('data-timestamp');
    if (!sec || !/^\d+$/.test(sec)) continue;
    el.setAttribute('href', `${audioUrl}#t=${sec}`);
  }
}
