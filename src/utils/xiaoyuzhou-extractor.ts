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

// 小宇宙 SSR DOM 里 article 包含装饰元素：订阅播客按钮、头像等都被
// 包成 <a href=""><img></a>。turndown 把这种结构转成 [](src) 空 markdown
// 链接（因为 alt 字段为空或转后丢失）。提前 unwrap 拆成裸 <img>，
// 让 turndown 出 ![alt](src) 或 ![](src) 但不再产生显式的 [](url)。
// 注意：必须在 rewriteTimestamps 之后调用，否则会误拆 timestamp anchor
// （timestamp anchor 没有 img 子元素，所以即便顺序反了也不会被这个函数误判，
// 但稳定起见保持 timestamp → unwrap 的顺序）。
export function unwrapAnchorImages(articleEl: Element): void {
  const anchors = Array.from(articleEl.querySelectorAll('a'));
  for (const a of anchors) {
    const children = Array.from(a.children);
    if (children.length === 1 && children[0].tagName === 'IMG') {
      a.replaceWith(children[0]);
    }
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

// ---------------------------------------------------------------------------
// JSON-LD helpers
// ---------------------------------------------------------------------------

interface JsonLdPodcastEpisode {
  '@type'?: string;
  name?: string;
  description?: string;
  datePublished?: string;
  timeRequired?: string;
  url?: string;
  associatedMedia?: { contentUrl?: string };
  partOfSeries?: { name?: string; url?: string };
}

function parseJsonLd(doc: ParentNode): JsonLdPodcastEpisode | null {
  const scripts = Array.from(doc.querySelectorAll('script[type="application/ld+json"]'));
  for (const s of scripts) {
    try {
      const data = JSON.parse(s.textContent || '');
      if (data && (data['@type'] === 'PodcastEpisode' || data.associatedMedia)) {
        return data;
      }
    } catch {
      // skip malformed
    }
  }
  return null;
}

function getMetaContent(doc: ParentNode, key: string): string {
  const el = doc.querySelector(`meta[property="${key}"], meta[name="${key}"]`);
  return el?.getAttribute('content') || '';
}

function truncate(s: string, n: number): string {
  if (!s) return '';
  if (s.length <= n) return s;
  return s.slice(0, n);
}

function getDocUrl(doc: Document): string {
  return (doc.URL as string) || (doc as any).location?.href || '';
}

async function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function expandAllComments(doc: Document): Promise<void> {
  // 浏览器 runtime 才跑；测试环境（linkedom）没有 window.scrollTo，跳过
  if (typeof window === 'undefined' || typeof (doc as any).body?.scrollHeight !== 'number') return;
  let prev = 0;
  for (let i = 0; i < 10; i++) {
    try { window.scrollTo(0, document.body.scrollHeight); } catch {}
    await sleep(800);
    const count = doc.querySelectorAll('.comment').length;
    if (count === prev) break;
    prev = count;
  }
  // 点击「共 X 条回复」展开按钮
  const expanders = Array.from(doc.querySelectorAll('*')).filter(el => {
    const t = el.textContent?.trim() || '';
    return /^共\d+条回复$/.test(t) && typeof (el as HTMLElement).click === 'function';
  });
  const max = Math.min(expanders.length, 100);
  for (let i = 0; i < max; i++) {
    try { (expanders[i] as HTMLElement).click(); } catch {}
    await sleep(300);
  }
}

// ---------------------------------------------------------------------------
// Main extractor interface + function
// ---------------------------------------------------------------------------

export interface XiaoyuzhouStructuredContent {
  // 通用字段（参与 ContentResponse fallback chain）
  title: string;
  author: string;
  description: string;
  published: string;
  image: string;
  site: string;
  source: string;
  content: string;
  wordCount: number;

  // 专有字段（注入 extractedContent，用户模板可用）
  audioUrl: string;
  duration: string;
  podcast: string;
  podcastUrl: string;
  episodeNumber: string;
}

export async function extractXiaoyuzhouStructuredContent(
  doc: Document
): Promise<XiaoyuzhouStructuredContent> {
  const url = getDocUrl(doc);

  const ld = parseJsonLd(doc);
  if (!ld) {
    throw new Error('Xiaoyuzhou: JSON-LD PodcastEpisode not found');
  }

  // 通用字段
  const title = ld.name || getMetaContent(doc, 'og:title') || doc.title || '';
  const podcastName = ld.partOfSeries?.name || '';
  const author = podcastName;
  const description = truncate((ld.description || '').trim(), 200);
  const published = ld.datePublished || '';
  const image = getMetaContent(doc, 'og:image') || '';
  const site = '小宇宙';
  const source = canonicalizeUrl(url);

  // 专有字段
  const audioUrl = ld.associatedMedia?.contentUrl || getMetaContent(doc, 'og:audio') || '';
  const duration = formatDuration(ld.timeRequired || '');
  const podcast = podcastName;
  const podcastUrl = ld.partOfSeries?.url || '';
  const episodeNumber = parseEpisodeNumber(title);

  // 展开 + parse 评论（仅浏览器 runtime）
  await expandAllComments(doc);

  // 改写 article 内的 timestamp
  const article = doc.querySelector('article');
  if (article) {
    rewriteTimestamps(article, audioUrl);
    unwrapAnchorImages(article);
  }

  // 评论根 = body（评论散落在 body 各处，但都有 .comment 类）
  const commentsRoot = doc.body || doc;
  const comments = parseComments(commentsRoot as Element);
  const commentsHtml = buildCommentsHtml(comments);

  // 组装 structuredHtml
  const audioEmbed = audioUrl ? `<p><img src="${escapeHtml(audioUrl)}" alt="" /></p>` : '';
  const articleHtml = article ? article.outerHTML : '';
  const content = [audioEmbed, articleHtml, commentsHtml].filter(Boolean).join('\n');

  // wordCount: article + comments 的纯文本长度
  const articleText = article?.textContent || '';
  const commentsText = comments.map(c => c.body + c.replies.map(r => r.body).join('')).join('');
  const wordCount = (articleText + commentsText).length;

  return {
    title, author, description, published, image, site, source, content, wordCount,
    audioUrl, duration, podcast, podcastUrl, episodeNumber,
  };
}
