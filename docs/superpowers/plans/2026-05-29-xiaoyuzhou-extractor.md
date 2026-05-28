# 小宇宙专项 extractor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 `xiaoyuzhoufm.com/episode/<id>` 单集页加专项 extractor：frontmatter 加播客元数据（audioUrl / duration / podcast / episodeNumber）；shownote 时间戳变可点 markdown 链接（指向音频直链 `#t=14` fragment）；评论以 HTML 嵌套 `<blockquote>` 形态注入正文末尾（含用户名 / 日期 / 点赞数 / 置顶 / 嵌套回复）。

**Architecture:** 新建 `src/utils/xiaoyuzhou-extractor.ts`，参照 bilibili-extractor 的 pattern：extractor 返回 `XiaoyuzhouStructuredContent`（含 HTML `content` 字段），由 `content.ts` 主路径走 turndown 转 markdown。错误 throw → content.ts catch → `ContentResponse.extractorWarnings[]` → popup banner。

**Tech Stack:** TypeScript / vitest / linkedom（测试 DOM）/ webextension-polyfill / playwright（e2e）

**Spec reference:** [`docs/superpowers/specs/2026-05-29-xiaoyuzhou-extractor-design.md`](../specs/2026-05-29-xiaoyuzhou-extractor-design.md)

**Worktree:** `.claude/worktrees/xiaoyuzhou-extractor/`（由主 session 用 `git worktree add` 创建后，subagent 进 worktree 执行）

---

## 文件结构

| 路径 | 责任 |
|---|---|
| `src/utils/xiaoyuzhou-extractor.ts` (new, ~400 行) | URL 路由 + 工具函数 + DOM 解析 + 评论展开 + 主 extractor 入口 |
| `src/utils/xiaoyuzhou-extractor.test.ts` (new, ~300 行) | 单元 + 集成测试（fixture HTML） |
| `src/utils/xiaoyuzhou-extractor.e2e.test.ts` (new, ~80 行) | 真 chrome e2e（小宇宙公开页，不需登录） |
| `src/utils/fixtures/xiaoyuzhou-episode-6850d2ed.html` (new) | 脱敏 SSR HTML fixture |
| `src/content.ts` (modify) | 路由分支 + 字段 fallback + extractedContent 注入 + bridge 双 wire |
| `src/utils/content-extractor.ts` (modify) | popup 路径 extractor 调度 |

---

## Task 1: URL 路由工具函数（骨架）

**Goal:** 创建 extractor 骨架，含 `isXiaoyuzhouEpisodeUrl` / `parseXiaoyuzhouUrl` / `canonicalizeUrl` 三个纯函数 + 测试。

**Files:**
- Create: `src/utils/xiaoyuzhou-extractor.ts`
- Create: `src/utils/xiaoyuzhou-extractor.test.ts`

- [ ] **Step 1: 写测试 (xiaoyuzhou-extractor.test.ts)**

```typescript
import { describe, it, expect } from 'vitest';
import {
  isXiaoyuzhouEpisodeUrl,
  parseXiaoyuzhouUrl,
  canonicalizeUrl,
} from './xiaoyuzhou-extractor';

describe('isXiaoyuzhouEpisodeUrl', () => {
  it('matches www.xiaoyuzhoufm.com/episode/<id>', () => {
    expect(isXiaoyuzhouEpisodeUrl('https://www.xiaoyuzhoufm.com/episode/6850d2ed4abe6e29cb814160')).toBe(true);
  });
  it('matches with share token query', () => {
    expect(isXiaoyuzhouEpisodeUrl('https://www.xiaoyuzhoufm.com/episode/6850d2ed4abe6e29cb814160?s=REDACTED')).toBe(true);
  });
  it('rejects /podcast/<id>', () => {
    expect(isXiaoyuzhouEpisodeUrl('https://www.xiaoyuzhoufm.com/podcast/6388760f22567e8ea6ad070f')).toBe(false);
  });
  it('rejects other hosts', () => {
    expect(isXiaoyuzhouEpisodeUrl('https://example.com/episode/123')).toBe(false);
  });
  it('rejects malformed URL', () => {
    expect(isXiaoyuzhouEpisodeUrl('not a url')).toBe(false);
  });
});

describe('parseXiaoyuzhouUrl', () => {
  it('extracts episodeId', () => {
    expect(parseXiaoyuzhouUrl('https://www.xiaoyuzhoufm.com/episode/6850d2ed4abe6e29cb814160?s=token'))
      .toEqual({ type: 'episode', episodeId: '6850d2ed4abe6e29cb814160' });
  });
  it('returns null for non-episode URL', () => {
    expect(parseXiaoyuzhouUrl('https://example.com')).toEqual({ type: null, episodeId: null });
  });
});

describe('canonicalizeUrl', () => {
  it('strips all query params', () => {
    expect(canonicalizeUrl('https://www.xiaoyuzhoufm.com/episode/abc?s=token&t=120'))
      .toBe('https://www.xiaoyuzhoufm.com/episode/abc');
  });
  it('strips fragment', () => {
    expect(canonicalizeUrl('https://www.xiaoyuzhoufm.com/episode/abc#section'))
      .toBe('https://www.xiaoyuzhoufm.com/episode/abc');
  });
  it('passes invalid URL through unchanged', () => {
    expect(canonicalizeUrl('not a url')).toBe('not a url');
  });
});
```

- [ ] **Step 2: 跑测试验证 fail**

```bash
npx vitest run src/utils/xiaoyuzhou-extractor.test.ts
```

Expected: 所有测试 FAIL（"Cannot find module"）

- [ ] **Step 3: 实现（xiaoyuzhou-extractor.ts）**

```typescript
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
```

- [ ] **Step 4: 跑测试验证 pass**

```bash
npx vitest run src/utils/xiaoyuzhou-extractor.test.ts
```

Expected: 全部 PASS（10/10）

- [ ] **Step 5: Commit**

```bash
git add src/utils/xiaoyuzhou-extractor.ts src/utils/xiaoyuzhou-extractor.test.ts
git commit -m "feat(xiaoyuzhou): URL routing helpers (isXiaoyuzhouEpisodeUrl/parseXiaoyuzhouUrl/canonicalizeUrl)"
```

---

## Task 2: 格式化工具函数（formatDuration / normalizeDate / parseEpisodeNumber）

**Goal:** 三个纯字符串处理函数。

**Files:**
- Modify: `src/utils/xiaoyuzhou-extractor.ts`
- Modify: `src/utils/xiaoyuzhou-extractor.test.ts`

- [ ] **Step 1: 加测试**

```typescript
// 在 test 文件末尾追加
import { formatDuration, normalizeDate, parseEpisodeNumber } from './xiaoyuzhou-extractor';

describe('formatDuration', () => {
  it('formats minutes-only', () => {
    expect(formatDuration('PT614M')).toBe('10:14:00');
  });
  it('formats seconds-only', () => {
    expect(formatDuration('PT45S')).toBe('00:00:45');
  });
  it('formats hours+minutes+seconds', () => {
    expect(formatDuration('PT2H30M5S')).toBe('02:30:05');
  });
  it('formats sub-hour minutes', () => {
    expect(formatDuration('PT45M30S')).toBe('00:45:30');
  });
  it('returns empty for invalid input', () => {
    expect(formatDuration('')).toBe('');
    expect(formatDuration('not iso')).toBe('');
  });
});

describe('normalizeDate', () => {
  it('normalizes Chinese dot format', () => {
    expect(normalizeDate('2025.6.18')).toBe('2025-06-18');
    expect(normalizeDate('2025.12.12')).toBe('2025-12-12');
  });
  it('passes ISO date through', () => {
    expect(normalizeDate('2025-06-18')).toBe('2025-06-18');
  });
  it('returns empty for invalid', () => {
    expect(normalizeDate('')).toBe('');
    expect(normalizeDate('garbage')).toBe('');
  });
});

describe('parseEpisodeNumber', () => {
  it('extracts E-prefix number', () => {
    expect(parseEpisodeNumber('E112.这期节目献给每一位喜欢投资和求真的听友')).toBe('E112');
  });
  it('extracts EP-prefix number', () => {
    expect(parseEpisodeNumber('EP42. xxx')).toBe('EP42');
  });
  it('returns empty when no prefix', () => {
    expect(parseEpisodeNumber('随便一个标题')).toBe('');
  });
});
```

- [ ] **Step 2: 实现**

```typescript
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
```

- [ ] **Step 3: 跑测试**

```bash
npx vitest run src/utils/xiaoyuzhou-extractor.test.ts
```

Expected: 全部 PASS（含新加 11 个）

- [ ] **Step 4: Commit**

```bash
git add src/utils/xiaoyuzhou-extractor.ts src/utils/xiaoyuzhou-extractor.test.ts
git commit -m "feat(xiaoyuzhou): formatDuration/normalizeDate/parseEpisodeNumber helpers"
```

---

## Task 3: 保存 fixture HTML

**Goal:** 把脱敏的 SSR HTML 落到 `src/utils/fixtures/`，后续测试用 linkedom parseHTML 喂这个 fixture。

**Files:**
- Create: `src/utils/fixtures/xiaoyuzhou-episode-6850d2ed.html`

- [ ] **Step 1: curl 拿 SSR HTML + 脱敏**

```bash
curl -s "https://www.xiaoyuzhoufm.com/episode/6850d2ed4abe6e29cb814160" \
  -A "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" \
  -o /tmp/xyz-raw.html

# 验证完整性
wc -c /tmp/xyz-raw.html  # 期望 ~420K
grep -c 'application/ld+json' /tmp/xyz-raw.html  # 期望 1
grep -c 'class="jsx-[0-9]* timestamp"' /tmp/xyz-raw.html  # 期望 > 50
grep -c 'class="jsx-[0-9]* comment"' /tmp/xyz-raw.html  # 期望 > 20
```

- [ ] **Step 2: 脱敏并保存**

```bash
python3 -c "
import re
src = open('/tmp/xyz-raw.html').read()
sanitized = re.sub(r'\?s=[A-Za-z0-9._=+/-]{8,}', '?s=REDACTED_SHARE_TOKEN', src)
sanitized = re.sub(r'eyJ[A-Za-z0-9._=+/-]{15,}', 'REDACTED_JWT_LIKE', sanitized)
print('share tokens after:', len(re.findall(r'\?s=eyJ', sanitized)))  # 期望 0
print('jwt-like after:', len(re.findall(r'eyJ[A-Za-z0-9._-]{15,}', sanitized)))  # 期望 0
open('src/utils/fixtures/xiaoyuzhou-episode-6850d2ed.html', 'w').write(sanitized)
print('written:', len(sanitized))
"
```

- [ ] **Step 3: Commit**

```bash
git add src/utils/fixtures/xiaoyuzhou-episode-6850d2ed.html
git commit -m "test(xiaoyuzhou): SSR HTML fixture for episode 6850d2ed (sanitized)"
```

---

## Task 4: rewriteTimestamps（DOM 时间戳改写）

**Goal:** 把 shownote 内的 `<a class="timestamp" data-timestamp="14">00:14</a>`（无 href）改写为 `<a href="audio_url#t=14">00:14</a>`，让 Defuddle 不要剥它。

**Files:**
- Modify: `src/utils/xiaoyuzhou-extractor.ts`
- Modify: `src/utils/xiaoyuzhou-extractor.test.ts`

- [ ] **Step 1: 加测试**

```typescript
// 测试文件加 import
import { parseHTML } from 'linkedom';
import { rewriteTimestamps } from './xiaoyuzhou-extractor';

describe('rewriteTimestamps', () => {
  const audioUrl = 'https://media.example.com/x.m4a';

  it('adds href to timestamp anchors with data-timestamp', () => {
    const { document } = parseHTML(
      '<article><span><a class="timestamp" data-timestamp="14">00:14</a> 标题</span></article>'
    );
    const article = document.querySelector('article')!;
    rewriteTimestamps(article, audioUrl);
    const a = article.querySelector('a.timestamp')!;
    expect(a.getAttribute('href')).toBe(`${audioUrl}#t=14`);
    expect(a.textContent).toBe('00:14');
  });

  it('handles multiple timestamps', () => {
    const { document } = parseHTML(`<article>
      <a class="timestamp" data-timestamp="14">00:14</a>
      <a class="timestamp" data-timestamp="330">05:30</a>
      <a class="timestamp" data-timestamp="3600">01:00:00</a>
    </article>`);
    const article = document.querySelector('article')!;
    rewriteTimestamps(article, audioUrl);
    const anchors = Array.from(article.querySelectorAll('a.timestamp'));
    expect(anchors.map(a => a.getAttribute('href'))).toEqual([
      `${audioUrl}#t=14`,
      `${audioUrl}#t=330`,
      `${audioUrl}#t=3600`,
    ]);
  });

  it('skips anchors without data-timestamp', () => {
    const { document } = parseHTML(
      '<article><a class="timestamp">00:14</a></article>'
    );
    const article = document.querySelector('article')!;
    rewriteTimestamps(article, audioUrl);
    expect(article.querySelector('a.timestamp')!.getAttribute('href')).toBeNull();
  });

  it('skips when audioUrl empty', () => {
    const { document } = parseHTML(
      '<article><a class="timestamp" data-timestamp="14">00:14</a></article>'
    );
    const article = document.querySelector('article')!;
    rewriteTimestamps(article, '');
    expect(article.querySelector('a.timestamp')!.getAttribute('href')).toBeNull();
  });

  it('skips invalid data-timestamp values', () => {
    const { document } = parseHTML(
      '<article><a class="timestamp" data-timestamp="abc">x</a></article>'
    );
    const article = document.querySelector('article')!;
    rewriteTimestamps(article, audioUrl);
    expect(article.querySelector('a.timestamp')!.getAttribute('href')).toBeNull();
  });
});
```

- [ ] **Step 2: 实现**

```typescript
export function rewriteTimestamps(articleEl: Element, audioUrl: string): void {
  if (!audioUrl) return;
  const anchors = Array.from(articleEl.querySelectorAll('a.timestamp'));
  for (const el of anchors) {
    const sec = el.getAttribute('data-timestamp');
    if (!sec || !/^\d+$/.test(sec)) continue;
    el.setAttribute('href', `${audioUrl}#t=${sec}`);
  }
}
```

- [ ] **Step 3: 跑测试**

```bash
npx vitest run src/utils/xiaoyuzhou-extractor.test.ts
```

Expected: 全部 PASS

- [ ] **Step 4: Commit**

```bash
git add src/utils/xiaoyuzhou-extractor.ts src/utils/xiaoyuzhou-extractor.test.ts
git commit -m "feat(xiaoyuzhou): rewriteTimestamps adds href to timestamp anchors"
```

---

## Task 5: parseComments + buildCommentsHtml

**Goal:** 解析评论 DOM 树（含嵌套回复 + 置顶 + 用户名 + 日期 + 点赞）→ 渲染嵌套 `<blockquote>` HTML。

**Files:**
- Modify: `src/utils/xiaoyuzhou-extractor.ts`
- Modify: `src/utils/xiaoyuzhou-extractor.test.ts`

- [ ] **Step 1: 加测试（parseComments）**

```typescript
import { parseComments, buildCommentsHtml, XiaoyuzhouComment } from './xiaoyuzhou-extractor';

describe('parseComments', () => {
  it('parses top-level comment with metadata', () => {
    const html = `<section>
      <div class="jsx-x comment">
        <div class="jsx-x info">
          <a class="jsx-x name">厚望</a>
          <div class="jsx-x pub-time">2025.12.12</div>
          <a class="jsx-x like"><div class="jsx-x count">25</div></a>
        </div>
        <div class="jsx-x pinned">置顶</div>
        <div class="jsx-x text-wrap">帮老南吆喝一声：望岳投资招聘</div>
      </div>
    </section>`;
    const { document } = parseHTML(html);
    const result = parseComments(document.querySelector('section')!);
    expect(result).toHaveLength(1);
    expect(result[0].user).toBe('厚望');
    expect(result[0].publishedAt).toBe('2025-12-12');
    expect(result[0].likeCount).toBe(25);
    expect(result[0].pinned).toBe(true);
    expect(result[0].body).toContain('帮老南吆喝');
  });

  it('parses nested replies', () => {
    const html = `<section>
      <div class="jsx-x comment">
        <div class="jsx-x info">
          <a class="name">吞不须</a>
          <div class="pub-time">2025.6.18</div>
          <a class="like"><div class="count">468</div></a>
        </div>
        <div class="text-wrap">你还卷</div>
        <div class="replies">
          <div class="jsx-x comment">
            <div class="jsx-x info">
              <a class="name">猫咪麻麻</a>
              <div class="pub-time">2025.6.18</div>
              <a class="like"><div class="count">10</div></a>
            </div>
            <div class="text-wrap">你也卷</div>
          </div>
        </div>
      </div>
    </section>`;
    const { document } = parseHTML(html);
    const result = parseComments(document.querySelector('section')!);
    expect(result).toHaveLength(1);
    expect(result[0].user).toBe('吞不须');
    expect(result[0].replies).toHaveLength(1);
    expect(result[0].replies[0].user).toBe('猫咪麻麻');
    expect(result[0].replies[0].body).toContain('你也卷');
  });

  it('handles missing fields gracefully', () => {
    const html = `<section><div class="comment"><div class="text-wrap">orphan</div></div></section>`;
    const { document } = parseHTML(html);
    const result = parseComments(document.querySelector('section')!);
    expect(result[0]).toMatchObject({
      user: '',
      publishedAt: '',
      likeCount: 0,
      pinned: false,
    });
  });

  it('returns empty for no comments', () => {
    const { document } = parseHTML('<section></section>');
    expect(parseComments(document.querySelector('section')!)).toEqual([]);
  });
});

describe('buildCommentsHtml', () => {
  it('generates h2 + blockquote', () => {
    const tree: XiaoyuzhouComment[] = [{
      user: '厚望', publishedAt: '2025-12-12', likeCount: 25, pinned: true,
      body: '帮老南吆喝一声', replies: []
    }];
    const html = buildCommentsHtml(tree);
    expect(html).toContain('<h2>评论</h2>');
    expect(html).toContain('<blockquote>');
    expect(html).toContain('📌 置顶');
    expect(html).toContain('<strong>📌 置顶 厚望</strong>');
    expect(html).toContain('2025-12-12');
    expect(html).toContain('👍 25');
    expect(html).toContain('帮老南吆喝一声');
  });

  it('renders nested blockquote for replies', () => {
    const tree: XiaoyuzhouComment[] = [{
      user: '吞不须', publishedAt: '2025-06-18', likeCount: 468, pinned: false,
      body: '你还卷',
      replies: [{
        user: '猫咪麻麻', publishedAt: '2025-06-18', likeCount: 10, pinned: false,
        body: '你也卷', replies: []
      }]
    }];
    const html = buildCommentsHtml(tree);
    // outer blockquote contains inner blockquote (nesting)
    expect(html).toMatch(/<blockquote>[\s\S]*<blockquote>[\s\S]*猫咪麻麻[\s\S]*<\/blockquote>[\s\S]*<\/blockquote>/);
  });

  it('returns empty when no comments', () => {
    expect(buildCommentsHtml([])).toBe('');
  });

  it('escapes HTML in body / username', () => {
    const tree: XiaoyuzhouComment[] = [{
      user: '<script>', publishedAt: '2025-01-01', likeCount: 0, pinned: false,
      body: 'a & b <i>', replies: []
    }];
    const html = buildCommentsHtml(tree);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp;');
  });
});
```

- [ ] **Step 2: 实现**

```typescript
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
  // 顶层 .comment = 其最近 .comment ancestor 为 null（无嵌套上层）
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
```

- [ ] **Step 3: 跑测试**

```bash
npx vitest run src/utils/xiaoyuzhou-extractor.test.ts
```

Expected: 全部 PASS（含新加 9 个）

- [ ] **Step 4: Commit**

```bash
git add src/utils/xiaoyuzhou-extractor.ts src/utils/xiaoyuzhou-extractor.test.ts
git commit -m "feat(xiaoyuzhou): parseComments + buildCommentsHtml (nested blockquote)"
```

---

## Task 6: extractXiaoyuzhouStructuredContent 主函数（含必填 interface）

**Goal:** 主 extractor 入口：JSON-LD parse、meta tag fallback、rewriteTimestamps、parseComments、组装 structuredHtml。**XiaoyuzhouStructuredContent 接口 + producer 同一 task**（按 `feedback_plan_required_field_ordering`）。

**Files:**
- Modify: `src/utils/xiaoyuzhou-extractor.ts`
- Modify: `src/utils/xiaoyuzhou-extractor.test.ts`

- [ ] **Step 1: 加集成测试（用 fixture）**

```typescript
import * as fs from 'fs';
import * as path from 'path';
import { extractXiaoyuzhouStructuredContent } from './xiaoyuzhou-extractor';

const fixturePath = path.join(__dirname, 'fixtures/xiaoyuzhou-episode-6850d2ed.html');

describe('extractXiaoyuzhouStructuredContent (integration with fixture)', () => {
  let doc: Document;
  beforeAll(() => {
    const html = fs.readFileSync(fixturePath, 'utf-8');
    doc = parseHTML(html).document as unknown as Document;
    Object.defineProperty(doc, 'URL', { value: 'https://www.xiaoyuzhoufm.com/episode/6850d2ed4abe6e29cb814160', configurable: true });
  });

  it('extracts title with E112 prefix preserved', async () => {
    const result = await extractXiaoyuzhouStructuredContent(doc);
    expect(result.title).toMatch(/^E112\./);
    expect(result.title).toContain('喜欢投资和求真的听友');
  });

  it('extracts podcast metadata', async () => {
    const result = await extractXiaoyuzhouStructuredContent(doc);
    expect(result.podcast).toBe('面基');
    expect(result.author).toBe('面基');
    expect(result.episodeNumber).toBe('E112');
    expect(result.podcastUrl).toMatch(/^https:\/\/www\.xiaoyuzhoufm\.com\/podcast\//);
  });

  it('extracts audio URL and duration', async () => {
    const result = await extractXiaoyuzhouStructuredContent(doc);
    expect(result.audioUrl).toMatch(/^https:\/\/media\.xyzcdn\.net\/.+\.m4a$/);
    expect(result.duration).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it('canonicalizes source URL (strip query)', async () => {
    const result = await extractXiaoyuzhouStructuredContent(doc);
    expect(result.source).toBe('https://www.xiaoyuzhoufm.com/episode/6850d2ed4abe6e29cb814160');
  });

  it('description truncated to 200 chars', async () => {
    const result = await extractXiaoyuzhouStructuredContent(doc);
    expect(result.description.length).toBeLessThanOrEqual(200);
    expect(result.description.length).toBeGreaterThan(0);
  });

  it('site is 小宇宙', async () => {
    const result = await extractXiaoyuzhouStructuredContent(doc);
    expect(result.site).toBe('小宇宙');
  });

  it('content contains audio embed + article + comments h2', async () => {
    const result = await extractXiaoyuzhouStructuredContent(doc);
    expect(result.content).toContain('<img src="https://media.xyzcdn.net');
    expect(result.content).toContain('<h2>评论</h2>');
    expect(result.content).toContain('<blockquote>');
  });

  it('article timestamps rewritten with href', async () => {
    const result = await extractXiaoyuzhouStructuredContent(doc);
    // structuredHtml 中 timestamp anchor 现在应有 href=audio#t=...
    expect(result.content).toMatch(/<a[^>]+href="https:\/\/media\.xyzcdn\.net\/[^"]+#t=\d+"[^>]*class="[^"]*timestamp/);
  });

  it('wordCount > 0', async () => {
    const result = await extractXiaoyuzhouStructuredContent(doc);
    expect(result.wordCount).toBeGreaterThan(100);
  });
});

describe('extractXiaoyuzhouStructuredContent error paths', () => {
  it('throws when JSON-LD missing', async () => {
    const { document } = parseHTML('<html><body></body></html>');
    Object.defineProperty(document, 'URL', { value: 'https://www.xiaoyuzhoufm.com/episode/x', configurable: true });
    await expect(extractXiaoyuzhouStructuredContent(document as any)).rejects.toThrow(/JSON-LD/i);
  });
});
```

- [ ] **Step 2: 实现 interface + 主函数 + JSON-LD parser**

```typescript
// 在 xiaoyuzhou-extractor.ts 加：

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
  if (article) rewriteTimestamps(article, audioUrl);

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
```

- [ ] **Step 3: 跑测试**

```bash
npx vitest run src/utils/xiaoyuzhou-extractor.test.ts
```

Expected: 所有断言 PASS（含 9 个集成 + 1 个错误路径）

- [ ] **Step 4: Commit**

```bash
git add src/utils/xiaoyuzhou-extractor.ts src/utils/xiaoyuzhou-extractor.test.ts
git commit -m "feat(xiaoyuzhou): extractXiaoyuzhouStructuredContent main entry + interface"
```

---

## Task 7: content.ts 接入（路由 + fallback + 注入 + bridge 双 wire）

**Goal:** 把 extractor 接进 content.ts 主路径 + popup 路径 + e2e bridge 路径，三处都要。

**Files:**
- Modify: `src/content.ts`
- Modify: `src/utils/content-extractor.ts`

- [ ] **Step 1: import + popup-path 路由**

在 `src/content.ts` L14 周围（其它 extractor import 处）加：

```typescript
import { extractXiaoyuzhouStructuredContent, isXiaoyuzhouEpisodeUrl } from './utils/xiaoyuzhou-extractor';
```

在 `src/content.ts` L277+ 的 extractor 调度块（参考 `bilibiliContent` 那段），紧跟在 docsQQContent 之后加：

```typescript
const xiaoyuzhouContent = isXiaoyuzhouEpisodeUrl(document.URL)
  ? await extractXiaoyuzhouStructuredContent(document).catch((error) => {
      const msg = error instanceof Error ? error.message : String(error);
      extractorWarnings.push(`Xiaoyuzhou: ${msg}`);
      return null;
    })
  : null;
```

- [ ] **Step 2: 专有变量注入**

在 `src/content.ts` L336-343 的 `if (bilibiliContent) { ... }` 块之后加：

```typescript
if (xiaoyuzhouContent) {
  extractedContent.audioUrl = xiaoyuzhouContent.audioUrl;
  extractedContent.duration = xiaoyuzhouContent.duration;
  extractedContent.podcast = xiaoyuzhouContent.podcast;
  extractedContent.podcastUrl = xiaoyuzhouContent.podcastUrl;
  extractedContent.episodeNumber = xiaoyuzhouContent.episodeNumber;
}
```

- [ ] **Step 3: fallback chain (L425-443)**

在 `src/content.ts` 的 `const response: ContentResponse = { ... }` 字段链中，每个相关字段把 `xiaoyuzhouContent?.X` 加到 fallback 顺序里（紧跟 bilibili 之后即可）：

```typescript
author: bilibiliContent?.author || xiaoyuzhouContent?.author || feishuContent?.author || /* ... */ defuddled.author,
content: bilibiliContent?.structuredHtml || xiaoyuzhouContent?.content || feishuContent?.content || /* ... */ defuddled.content,
description: bilibiliContent?.description || xiaoyuzhouContent?.description || defuddled.description,
image: bilibiliContent?.image || xiaoyuzhouContent?.image || defuddled.image,
published: bilibiliContent?.published || xiaoyuzhouContent?.published || feishuContent?.published || /* ... */ defuddled.published,
site: bilibiliContent ? 'Bilibili' : xiaoyuzhouContent ? '小宇宙' : feishuContent ? 'Feishu' : /* ... */ defuddled.site,
title: bilibiliContent?.title || xiaoyuzhouContent?.title || feishuContent?.title || /* ... */ defuddled.title,
wordCount: docsQQContent?.wordCount || bilibiliContent?.wordCount || xiaoyuzhouContent?.wordCount || /* ... */ defuddled.wordCount,
```

（注意：本步只增加 `xiaoyuzhouContent?` 节点，**不要**重排现有 fallback 顺序）

- [ ] **Step 4: popup-path 路由分支 (L705+)**

`content.ts` 的 popup 路径路由表（"Route by URL: scys → ..." 注释之后的 if-else 链）加：

```typescript
} else if (isXiaoyuzhouEpisodeUrl(document.URL)) {
  extractedStructured = await extractXiaoyuzhouStructuredContent(document).catch((error) => {
    extractorWarnings?.push(`Xiaoyuzhou: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  });
}
```

（具体写法对齐其它分支同位置）

- [ ] **Step 5: e2e bridge 路径 (L641+)**

按 `feedback_e2e_bridge_path_double_wire`：content.ts 内 `__obsidianClipperTestExtract__` 监听器需要镜像主路径调 `extractXiaoyuzhouStructuredContent`。检查现有 `bilibiliContent` 在 bridge 里如何写（grep），加同形态 xiaoyuzhou 分支。

```bash
grep -n "bilibili\|__obsidianClipperTestExtract__\|onWindowMessage" src/content.ts | head -20
```

按 bilibili 同形态注入。

- [ ] **Step 6: content-extractor.ts 镜像（popup path 已在 L4-L7 复用，但需要确认）**

```bash
grep -n "bilibili\|extractor" src/utils/content-extractor.ts | head -10
```

如果 content-extractor.ts 也有 extractor 调度（参考 bilibili），加同形态。

- [ ] **Step 7: tsc 编译检查**

```bash
npx tsc --noEmit
```

Expected: 0 错误

- [ ] **Step 8: 全套 unit test**

```bash
npm test
```

Expected: 全 PASS（新旧测试都过）

- [ ] **Step 9: Commit**

```bash
git add src/content.ts src/utils/content-extractor.ts
git commit -m "feat(xiaoyuzhou): wire extractor into content.ts (popup/bridge/fallback chain)"
```

---

## Task 8: e2e 测试

**Goal:** 真 chrome + extension + 公开页 URL 端到端验证。

**Files:**
- Create: `src/utils/xiaoyuzhou-extractor.e2e.test.ts`

- [ ] **Step 1: 写 e2e 测试**

参考 `src/utils/weixin-extractor.e2e.test.ts` 的形态写：

```typescript
import { describe, it, expect } from 'vitest';
import { runRealClip } from './fixtures/e2e-runner';  // 现有的 e2e helper

describe('Xiaoyuzhou e2e (real chrome + extension)', () => {
  it('clips a public episode page', { timeout: 120_000 }, async () => {
    const { markdown, hydratedHtml, durationMs } = await runRealClip(
      'https://www.xiaoyuzhoufm.com/episode/6850d2ed4abe6e29cb814160'
    );

    // frontmatter
    expect(markdown).toMatch(/^---\n[\s\S]+?\n---/);  // frontmatter present
    // markdown 主体
    expect(markdown).toContain('面基');  // podcast name
    expect(markdown).toMatch(/!\[\]\(https:\/\/media\.xyzcdn\.net\/.+\.m4a\)/);  // audio embed
    // 时间戳 markdown 链接
    const timestampLinks = markdown.match(/\[\d{1,2}:\d{2}(?::\d{2})?\]\(https:\/\/media\.xyzcdn\.net\/[^)]+#t=\d+\)/g) || [];
    expect(timestampLinks.length).toBeGreaterThan(10);
    // 评论章节
    expect(markdown).toContain('## 评论');
    const commentLines = markdown.match(/^>.+/gm) || [];
    expect(commentLines.length).toBeGreaterThan(5);
    // 不应该有空 markdown link
    expect(markdown).not.toMatch(/\[\]\([^)]*\)/);
  });
});
```

- [ ] **Step 2: 跑 e2e**

```bash
npm run test:e2e -- xiaoyuzhou-extractor.e2e
```

Expected: PASS。失败时检查 console / hydratedHtml 抽样定位（可能反爬、可能 bridge 没双 wire）。

- [ ] **Step 3: Commit**

```bash
git add src/utils/xiaoyuzhou-extractor.e2e.test.ts
git commit -m "test(xiaoyuzhou): e2e via real chrome extension"
```

---

## Task 9: build 验证 + 手动浏览器抽样

**Goal:** ship 前最后一关——build 通过 + 手动 chrome 装扩展跑一次确认产物长得对。

- [ ] **Step 1: build**

```bash
npm run build:chrome
```

Expected: 退出码 0；`dist/content.js` 存在、size 合理（~600KB-1MB）

- [ ] **Step 2: 装扩展并手测**

阿杜在 macOS Chrome 装 `dist/` extension（chrome://extensions → 加载已解压扩展），打开测试 URL `https://www.xiaoyuzhoufm.com/episode/6850d2ed4abe6e29cb814160`，触发裁剪，确认 markdown：
- frontmatter 含 audioUrl / duration / podcast / episodeNumber
- 顶部有 `![](audio_url)` audio 播放器
- shownote 时间戳是可点的 markdown link
- 末尾有 `## 评论` 章节 + 嵌套 blockquote 回复

如果发现差异 → 回 Task 6/7 修。

- [ ] **Step 3: 无 commit（这一步纯验证）**

---

## Task 10: ship 阶段（worktree 收尾 + 抢锁 + 报验收）

按 `feedback_feature_ship_workflow` + `feedback_ship_lock_mechanism`：

- [ ] **Step 1: 在 worktree 跑全套**

```bash
# 在 .claude/worktrees/xiaoyuzhou-extractor/
npm test          # unit
npm run test:e2e  # e2e
npm run build:chrome
```

- [ ] **Step 2: 抢 ship 锁**

参考 BACKLOG / memory 里 `feedback_ship_lock_mechanism` 的 FIFO + O_EXCL 流程。

- [ ] **Step 3: rsync worktree dist/ + src/ 到 main**

抢到锁后把 worktree 的 src/ 和 dist/ rsync 回 main checkout。

- [ ] **Step 4: 报验收 checklist (T5-1..4)**

按 `feedback_extractor_acceptance` 的模板，paste：
- T5-1 build: `npm run build:chrome` 退出码 0
- T5-2 e2e: `npm run test:e2e` PASS（含 trace 到 Obsidian.app 真截图）
- T5-3 vitest: `npm test` PASS
- T5-4 视觉 audit: 用 `audit-extractor-ship` skill 派 subagent 跑 4 个 URL

- [ ] **Step 5: 等阿杜验收**

阿杜回「通过」前不合 main、不 push、不释锁。

---

## Self-Review（plan 写完，对照 spec 自检）

**Spec coverage 扫一遍**：

| Spec 章节 | Plan 任务 |
|---|---|
| §3.1 数据流 ①-⑨ | Task 6 完整实现 |
| §3.2 错误 throw | Task 6 测试 + Task 7 catch |
| §4 文件结构 | 全 task 文件路径明确 |
| §5.1 API 接口 | Task 1 (URL) / Task 2 (helpers) / Task 4 (rewrite) / Task 5 (parse/build) / Task 6 (main + interface) |
| §6 数据映射表 | Task 6 集成测试逐字段断言 |
| §7 时间戳 rewrite | Task 4 |
| §8 评论抓取（展开 + parse） | Task 5 (parse) + Task 6 (expandAllComments) |
| §9 HTML 模板 | Task 6 组装 structuredHtml |
| §10.1 单测 | Task 1/2/4/5/6 |
| §10.2 e2e | Task 8 |
| §10.3 bridge 双 wire | Task 7 Step 5 |
| §11 content.ts 接入 | Task 7 |
| §12 content-extractor.ts | Task 7 Step 6 |
| §13 风险 | jsx-hash 用语义 class 选择器（Task 5）；展开 sleep guard（Task 6 expandAllComments）；e2e timeout 120s（Task 8） |
| §14 ship checklist | Task 10 |

**Placeholder scan**：无 TODO/TBD/XXX；类型一致；commit message 都给了。

**Type consistency**：`XiaoyuzhouComment` / `XiaoyuzhouStructuredContent` / `XiaoyuzhouParsedUrl` 三个接口跨 task 名字一致；`buildCommentsHtml` / `parseComments` / `extractXiaoyuzhouStructuredContent` 等函数签名在多 task 引用都对齐。

**必填字段 + producer 同 task**：Task 6 同时落地 `XiaoyuzhouStructuredContent` interface（含 14 个全必填字段）+ producer 函数 — 满足 `feedback_plan_required_field_ordering`。Task 7 只新增 optional 字段（`extractedContent.audioUrl` 等是 `[key: string]: string` 灵活字典 + extractorWarnings 已是 optional），不会造成中间 tsc 编译断裂。
