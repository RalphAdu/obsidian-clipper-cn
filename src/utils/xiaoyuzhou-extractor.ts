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
