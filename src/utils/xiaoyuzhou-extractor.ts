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

// ---------------------------------------------------------------------------
// Comment parsing
// ---------------------------------------------------------------------------

export interface XiaoyuzhouComment {
  user: string;
  publishedAt: string;
  likeCount: number;
  pinned: boolean;
  body: string;
  replies: XiaoyuzhouComment[];
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getTextOf(el: Element | null, sel: string): string {
  return el?.querySelector(sel)?.textContent?.trim() || '';
}

function parseSingleComment(el: Element): XiaoyuzhouComment {
  const user = getTextOf(el, '.name');
  const publishedAt = normalizeDate(getTextOf(el, '.pub-time'));
  const likeText = getTextOf(el, '.like .count') || getTextOf(el, '.count');
  const likeCount = parseInt(likeText, 10) || 0;
  const pinned = !!el.querySelector('.pinned');
  // body = .text-wrap or fallback to direct text content excluding metadata
  let body = getTextOf(el, '.text-wrap');
  if (!body) {
    // fallback: clone and strip metadata nodes
    const clone = el.cloneNode(true) as Element;
    clone.querySelectorAll('.info, .pinned, .replies, .comment, svg, img').forEach(n => n.remove());
    body = (clone.textContent || '').trim();
  }
  const repliesContainer = el.querySelector(':scope > .replies');
  const replyEls = repliesContainer
    ? Array.from(repliesContainer.querySelectorAll(':scope > .comment'))
    : [];
  const replies = replyEls.map(parseSingleComment);
  return { user, publishedAt, likeCount, pinned, body, replies };
}

export function parseComments(root: Element): XiaoyuzhouComment[] {
  // Top-level .comment = those whose nearest .comment ancestor is null
  const all = Array.from(root.querySelectorAll('.comment'));
  const topLevel = all.filter(c => !c.parentElement?.closest('.comment'));
  return topLevel.map(parseSingleComment);
}

function renderCommentHtml(c: XiaoyuzhouComment): string {
  const pinTag = c.pinned ? '📌 置顶 ' : '';
  const header = `<p><strong>${escapeHtml(pinTag + c.user)}</strong> · ${escapeHtml(c.publishedAt)} · 👍 ${c.likeCount}</p>`;
  const bodyParas = c.body
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => `<p>${escapeHtml(line)}</p>`)
    .join('');
  const childHtml = c.replies.map(renderCommentHtml).join('');
  return `<blockquote>${header}${bodyParas}${childHtml}</blockquote>`;
}

export function buildCommentsHtml(comments: XiaoyuzhouComment[]): string {
  if (!comments.length) return '';
  return ['<h2>评论</h2>', ...comments.map(renderCommentHtml)].join('\n');
}
