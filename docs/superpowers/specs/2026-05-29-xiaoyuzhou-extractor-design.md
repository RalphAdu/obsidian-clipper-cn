# Spec — 小宇宙（xiaoyuzhoufm.com）专项 extractor

**日期**：2026-05-29
**作者**：阿杜 + Claude
**目标**：让浏览器扩展在 `https://www.xiaoyuzhoufm.com/episode/<id>` 页面触发裁剪时，绕过 Defuddle 通用通路，输出包含 podcast 专有元数据（音频直链 / 时长 / 所属播客 / 单集编号）、原位时间戳跳转链接、完整评论（含嵌套回复）的高保真 markdown。

---

## 1. 背景

### 1.1 问题诊断（已验证）

用户报问题：「为什么裁剪没有评论部分，以及中间的时间轴丢失时间部分，frontmatter 也缺信息」。在浏览器实测：

- **评论丢失（结构性剔除）**：评论 DOM 在 `<article>` **之外**（挂在 `<section>` 同级），Defuddle 的「主内容定位」原则只取 `<article>` 而丢弃外围 section。
- **时间戳被吃**：小宇宙时间戳 DOM 为 `<a class="timestamp" data-timestamp="14">00:14</a>`（无 `href`），Defuddle sanitize 阶段把无 href 的 `<a>` 元素**整个移除**（连带 `00:14` 文本）。原生 turndown 不会做这件事——已验证。Defuddle 产物里 `timestampOccur: 0`、`timestamp` 类名也消失。
- **frontmatter 缺播客元数据**：通用通道完全不识别 `og:audio`、`partOfSeries`、`timeRequired` 等播客字段；`description` 字段还错位取了站点 meta 而不是单集 JSON-LD description。

### 1.2 同模式参考

`feishu-extractor`（OpenAPI）/ `scys-extractor`（cookie）/ `weixin-extractor`（DOM 路径）/ `bilibili-extractor`（同样是媒体类、有时间章节）。本 extractor 走 **DOM 路径**（小宇宙数据全在页面 JSON-LD + DOM 里，不需要外部 API）。

## 2. 范围

### 2.1 MVP 范围（本 spec）

- **URL**：仅 `https://www.xiaoyuzhoufm.com/episode/<id>`（episode 单集页）
- **数据源**：页面 JSON-LD（`<script type="application/ld+json">`）+ `<meta>` + DOM
- **输出覆盖**：
  - frontmatter 通用字段（title / author / published / description / image / site / source）
  - 专项变量（audioUrl / duration / podcast / podcastUrl / episodeNumber）
  - 正文：audio embed → shownote 原文（时间戳 rewrite 为 markdown 链接） → 评论
  - 评论：含嵌套回复，markdown 引用块缩进；含用户名 / 日期 / 点赞数 / 置顶标签

### 2.2 Out of MVP（不做）

- 其它 URL 类型：`/podcast/<id>`（播客主页）、用户主页、搜索页等
- 评论里的 emoji 反应聚合统计
- 历史评论（被作者删除的）
- 评论作者头像 / 主播标记
- 分集合集 / 系列剧集列表

## 3. 架构总览

### 3.1 数据流

```
用户在 xiaoyuzhoufm.com/episode/<id> 触发裁剪
  ↓
content.ts: isXiaoyuzhouEpisodeUrl(url) → true
  ↓
extractXiaoyuzhouStructuredContent(document)  ← xiaoyuzhou-extractor.ts 主入口
  ↓
  ① parseJsonLd(doc)               拿 PodcastEpisode 结构化数据
                                     title / name / datePublished / description
                                     / image / partOfSeries.name+url
                                     / timeRequired / associatedMedia.contentUrl
  ② parseMetaTags(doc)             兜底取 og:image / og:audio / og:title
  ③ parseEpisodeNumber(title)      从 "E112.xxxx" 抠 "E112"
  ④ formatDuration("PT614M")       → "10:14:00"
  ⑤ rewriteTimestamps(articleEl,   把 <a class="timestamp" data-timestamp="14">00:14</a>
       audioUrl)                     改写为 <a href="audio_url#t=14">00:14</a>
                                     避开 Defuddle 「无 href anchor 剥离」
  ⑥ expandAllComments(doc)         模拟滚动到底 + 点击所有「共 X 条回复」
  ⑦ parseComments(commentsRoot)    递归 parse .comment 节点为 CommentNode 树
  ⑧ buildCommentsHtml(tree)        递归生成 HTML 嵌套 <blockquote> 节
  ⑨ buildStructuredHtml(           audio embed + shownote(rewritten) + commentsMd
       audioUrl, article, commentsMd)
  ↓
返回 XiaoyuzhouStructuredContent {
  title, author, description, published, image, site,
  audioUrl, duration, podcast, podcastUrl, episodeNumber,
  source, content: structuredHtml, wordCount
}
  ↓
content.ts → 现有 createMarkdownContent (turndown) → postProcessExtractorMarkdown → obsidian://
```

### 3.2 设计原则（跟 bilibili 对齐）

- extractor **返回 HTML**（structuredHtml），由主流程 turndown 转 markdown → 复用现有后处理
- **通用字段**（title/author/description/published/image/site）走 content.ts 字段 fallback chain（426-443 行）参与 frontmatter
- **专有字段**（audioUrl/duration/podcast/podcastUrl/episodeNumber）注入 `extractedContent`（content.ts:336-343 同一处），用户模板里 `{{audioUrl}}` 等 token 可直接 resolve
- 错误一律 **throw**（禁止 return null 软失败），由 content.ts catch → `ContentResponse.extractorWarnings[]` → popup 顶部黄色 banner（参考 `project_extractor_warning_banner` / `feedback_extractor_silent_fallback`）

## 4. 文件结构

```
src/utils/
├── xiaoyuzhou-extractor.ts           ← 新建主文件（预计 400-600 行）
├── xiaoyuzhou-extractor.test.ts      ← vitest 单测（parse + markdown 生成）
└── xiaoyuzhou-extractor.e2e.test.ts  ← playwright e2e（真 chrome 跑 URL）

src/content.ts                        ← 加 isXiaoyuzhouEpisodeUrl 路由分支 + 字段 fallback
src/utils/content-extractor.ts        ← popup 路径也加 extractor 调度
```

## 5. 接口与类型

### 5.1 公开 API

```typescript
export interface XiaoyuzhouParsedUrl {
  type: 'episode' | null;
  episodeId: string | null;
}

export interface XiaoyuzhouComment {
  user: string;
  publishedAt: string;     // "2025-06-18" normalized
  likeCount: number;       // 数字，0 也保留
  pinned: boolean;         // 置顶标签
  body: string;            // markdown-safe 纯文本（保留 emoji）
  replies: XiaoyuzhouComment[];  // 递归
}

export interface XiaoyuzhouStructuredContent {
  // 通用（fallback chain 用）
  title: string;            // "E112.这期节目献给每一位喜欢投资和求真的听友"
  author: string;           // podcast series name, e.g. "面基"
  description: string;      // JSON-LD description 前 200 字
  published: string;        // ISO datePublished
  image: string;            // cover image
  site: string;             // "小宇宙"
  source: string;           // canonical URL (strip query string)
  content: string;          // structuredHtml: audio embed + shownote + comments
  wordCount: number;

  // 专有（注入 extractedContent，用户模板可用）
  audioUrl: string;         // .m4a 直链
  duration: string;         // "HH:MM:SS"
  podcast: string;          // 同 author，但语义独立
  podcastUrl: string;       // 节目主页
  episodeNumber: string;    // "E112"，未匹配则空串
}

export function isXiaoyuzhouEpisodeUrl(url: string): boolean;
export function parseXiaoyuzhouUrl(url: string): XiaoyuzhouParsedUrl;
export async function extractXiaoyuzhouStructuredContent(
  doc: Document
): Promise<XiaoyuzhouStructuredContent>;

// 子函数（导出以便测试）
export function formatDuration(iso: string): string;        // "PT614M" → "10:14:00"
export function normalizeDate(text: string): string;        // "2025.6.18" → "2025-06-18"
export function parseEpisodeNumber(title: string): string;  // "E112.xxx" → "E112"
export function canonicalizeUrl(url: string): string;       // strip ?s=...
export function rewriteTimestamps(
  articleEl: Element,
  audioUrl: string
): void;                                                     // mutates DOM in-place
export function buildCommentsHtml(
  comments: XiaoyuzhouComment[]
): string;                                                   // HTML nested <blockquote>
```

### 5.2 内部辅助

```typescript
// JSON-LD schema 子集（PodcastEpisode）
interface JsonLdPodcastEpisode {
  '@type': 'PodcastEpisode';
  name?: string;
  description?: string;
  datePublished?: string;
  timeRequired?: string;
  url?: string;
  associatedMedia?: { contentUrl?: string; '@type'?: string };
  partOfSeries?: { name?: string; url?: string; '@type'?: string };
}

// 评论 DOM 解析中间态
interface CommentDomCue {
  el: Element;
  depth: number;  // 0 = 顶层，1+ = 嵌套
}
```

## 6. 数据来源映射

| 字段 | 来源 | 处理 |
|---|---|---|
| `title` | JSON-LD `name` ‖ `og:title` ‖ `document.title` | 保留 `E112.` 前缀 |
| `author` | JSON-LD `partOfSeries.name` | 例 "面基" |
| `published` | JSON-LD `datePublished` | ISO 不变 |
| `description` | JSON-LD `description` | 截前 200 字 + 末尾 trailing whitespace strip |
| `image` | JSON-LD episode 没有 → fallback `og:image` | URL 直接 |
| `site` | 固定 | `"小宇宙"` |
| `source` | `location.href` → `canonicalizeUrl` | 只保留 protocol+host+`/episode/<id>` |
| `audioUrl` | JSON-LD `associatedMedia.contentUrl` ‖ `og:audio` | URL 直接 |
| `duration` | JSON-LD `timeRequired` | `formatDuration` 转 HH:MM:SS |
| `podcast` | JSON-LD `partOfSeries.name` | 同 author |
| `podcastUrl` | JSON-LD `partOfSeries.url` | URL 直接 |
| `episodeNumber` | `title` 正则 `^(E\d+)\.` | 匹配返回 `E112`，否则空串 |

## 7. 时间戳 rewrite 细节

### 7.1 原 DOM

```html
<span>
  <a class="timestamp" data-timestamp="14">00:14</a>
  一场10小时的马拉松，也是开始的结束
</span>
```

### 7.2 rewrite 实现

```typescript
function rewriteTimestamps(articleEl: Element, audioUrl: string): void {
  if (!audioUrl) return;  // 没有 audioUrl 就保留原文本（Defuddle 仍会剥，但至少不引入空 [](url)）
  for (const el of Array.from(articleEl.querySelectorAll('a.timestamp'))) {
    const sec = el.getAttribute('data-timestamp');
    if (!sec || !/^\d+$/.test(sec)) continue;
    el.setAttribute('href', `${audioUrl}#t=${sec}`);
  }
}
```

### 7.3 调用时机

`rewriteTimestamps` **必须在调 Defuddle/createMarkdownContent 之前**（即 extractor 内、组装 structuredHtml 之前）。

### 7.4 验证

turndown 单独跑 `<a href="audio_url#t=14">00:14</a>` → `[00:14](audio_url#t=14)`（已实测）。Defuddle 整体跑产物里 `[](url)` 计数应为 0、`mdLinkWithTimestamp` 计数应 > 50。

## 8. 评论抓取

### 8.1 DOM 形态（实测）

```
section.css-yr3tbw                ← 评论区根（class hash 可能变；用结构+文本匹配兜底）
└── .comment (顶层，21+ 条)
    ├── .info
    │   ├── a.avatar-container > img.avatar
    │   ├── .center
    │   │   ├── a.name              ← 用户名 "厚望"
    │   │   └── .pub-time           ← 日期 "2025.6.18"
    │   └── a.like > .count         ← 点赞数 "468"
    ├── （置顶标识 ← 待 8.4 处理）
    ├── ＜正文文本节点＞
    └── （嵌套回复 .comment 子节点 / "共 X 条回复" 展开按钮）
```

### 8.2 展开流程

```typescript
async function expandAllComments(doc: Document): Promise<void> {
  if (typeof window === 'undefined') return;  // 测试环境跳过

  // Step 1: 滚动到底直到评论数不再增长（最多 10 轮，每轮 800ms）
  let prevCount = 0;
  for (let i = 0; i < 10; i++) {
    window.scrollTo(0, document.body.scrollHeight);
    await sleep(800);
    const count = doc.querySelectorAll('.comment').length;
    if (count === prevCount) break;
    prevCount = count;
  }

  // Step 2: 点开所有「共 X 条回复」展开按钮
  const expanders = Array.from(doc.querySelectorAll('*')).filter(
    el => /^共\d+条回复$/.test(el.textContent?.trim() || '') && (el as HTMLElement).click
  );
  for (const el of expanders) {
    (el as HTMLElement).click();
    await sleep(300);
  }
}
```

### 8.3 解析（parseComments）

```typescript
function parseComments(root: Element): XiaoyuzhouComment[] {
  // 找顶层 .comment（其父非 .comment）
  const all = Array.from(root.querySelectorAll('.comment'));
  const topLevel = all.filter(c => !c.parentElement?.closest('.comment'));
  return topLevel.map(parseSingleComment);
}

function parseSingleComment(el: Element): XiaoyuzhouComment {
  const user = el.querySelector('.name')?.textContent?.trim() || '';
  const publishedAt = normalizeDate(el.querySelector('.pub-time')?.textContent || '');
  const likeText = el.querySelector('.like .count')?.textContent?.trim() || '0';
  const likeCount = parseInt(likeText, 10) || 0;
  const pinned = !!el.querySelector('.pinned')
    || (el.textContent || '').includes('置顶');  // 兜底文本匹配
  const body = extractCommentBody(el);  // 剥掉 .info / .pinned / 子 .comment 后的文本
  const replies = Array.from(el.querySelectorAll(':scope > .comment, :scope > * > .comment'))
    .map(parseSingleComment);
  return { user, publishedAt, likeCount, pinned, body, replies };
}
```

### 8.4 置顶检测

DOM 里「置顶」是单独样式标签节点。**初版实现**采用兜底方案：在评论 outerHTML 或顶部 metadata 节点的文本里查找 `"置顶"` 字串（非正文部分），匹配则 `pinned = true`。后续 audit 实测如果发现 false-positive（如用户名含「置顶」），改成定位特定 class 节点（须先 DOM 实测查到准确 class）。

### 8.5 HTML 生成

```typescript
function buildCommentsHtml(comments: XiaoyuzhouComment[]): string {
  if (!comments.length) return '';
  return ['<h2>评论</h2>', ...comments.map(renderCommentHtml)].join('\n');
}

function renderCommentHtml(c: XiaoyuzhouComment): string {
  const pinTag = c.pinned ? '📌 置顶 ' : '';
  const header = `<p><strong>${escapeHtml(pinTag + c.user)}</strong> · ${c.publishedAt} · 👍 ${c.likeCount}</p>`;
  // body 可能多段；按段落拆分 paragraph
  const bodyParas = c.body
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => `<p>${escapeHtml(line)}</p>`)
    .join('');
  const childHtml = c.replies.map(renderCommentHtml).join('');
  return `<blockquote>${header}${bodyParas}${childHtml}</blockquote>`;
}
```

turndown 标准 rule 把嵌套 `<blockquote>` → `>` / `>>` / `>>>` 自动处理。

## 9. 正文结构（structuredHtml）

extractor 返回 HTML `content` 字段，由主路径 turndown 转 markdown（与所有现有 extractor 一致）。

### 9.1 HTML 模板

```html
<!-- ① audio embed —— turndown rule: img → ![](src) → Obsidian audio player -->
<p><img src="{{audioUrl}}" alt="" /></p>

<!-- ② shownote 原 article（时间戳已 rewrite 为有 href 的 a） -->
<article>
  ... 原 shownote 内容（含 <a href="audio_url#t=14">00:14</a>） ...
</article>

<!-- ③ 评论章节 —— turndown rule: h2 → ## / blockquote nest → > >> >>> -->
<h2>评论</h2>
<blockquote>
  <p><strong>📌 置顶 厚望</strong> · 2025-12-12 · 👍 25</p>
  <p>帮老南吆喝一声：【望岳投资招聘分析师】...</p>
  <blockquote>
    <p><strong>回复者</strong> · 2025-06-18 · 👍 N</p>
    <p>回复正文</p>
    <blockquote>
      <p><strong>嵌套回复者</strong> · 2025-06-18 · 👍 N</p>
      <p>嵌套内容</p>
    </blockquote>
  </blockquote>
</blockquote>
<blockquote>
  <p><strong>吞不须</strong> · 2025-06-18 · 👍 468</p>
  <p>你还卷，你还卷...</p>
</blockquote>
```

### 9.2 关键设计

- **HTML 嵌套 `<blockquote>` → turndown 自动转 `>` 嵌套** — 不需要在 extractor 内跑 turndown，主路径统一处理
- **`<p><img>` → `![](url)` audio embed** — Obsidian 识别 `.m4a` 后缀自动渲染音频播放器
- **评论 metadata 用 `<strong>` + 文本节点** — 比纯 markdown 字符串拼接更安全（不会被后续 markdown post-process 破坏）
- **评论 HTML 生成由 `buildCommentsHtml` 完成（§5.1）**，返回字符串供 §3.1 步骤 ⑨ 拼接

## 10. 测试策略

### 10.1 单元测试（`xiaoyuzhou-extractor.test.ts`）

| 测试 | 输入 | 断言 |
|---|---|---|
| `formatDuration` | `"PT614M"` / `"PT45S"` / `"PT2H30M5S"` | `"10:14:00"` / `"00:00:45"` / `"02:30:05"` |
| `normalizeDate` | `"2025.6.18"` / `"2025.12.12"` | `"2025-06-18"` / `"2025-12-12"` |
| `parseEpisodeNumber` | `"E112.xxx"` / `"无前缀标题"` | `"E112"` / `""` |
| `canonicalizeUrl` | URL with `?s=<TOKEN>` query | host + `/episode/<id>`，无 query |
| `rewriteTimestamps` | fixture HTML 含 `<a class="timestamp" data-timestamp="14">00:14</a>` | DOM mutated；`a` 现在有 `href="audio_url#t=14"` |
| `parseComments` | fixture 含 nested .comment | tree 结构正确（顶层条数、嵌套深度、每条用户/日期/赞数） |
| `buildCommentsHtml` | mock tree | HTML 含嵌套 `<blockquote>`；置顶节点带 `📌 置顶`；嵌套层数与 reply 深度一致 |
| `extractXiaoyuzhouStructuredContent`（集成）| linkedom parseHTML fixture | 所有 12 字段值正确 |

Fixture 文件：`src/utils/fixtures/xiaoyuzhou-episode-6850d2ed.html`（脱敏：strip `?s=...` query 后保存）。

### 10.2 E2E 测试（`xiaoyuzhou-extractor.e2e.test.ts`）

按 spec B 现有 e2e 框架（`runRealClip` helper）：

- URL: `https://www.xiaoyuzhoufm.com/episode/6850d2ed4abe6e29cb814160`（不带 `?s=`）
- 不需要登录（小宇宙 episode 页是 public）
- 断言：
  - markdown 含 `![](https://media.xyzcdn.net/...m4a)` audio embed
  - markdown 含 `[00:14](https://media.xyzcdn.net/...m4a#t=14)` 时间戳链接（计数 > 10）
  - markdown 含 `## 评论` 章节标题
  - markdown 评论部分含 `> **` blockquote 引用块（计数 > 5）
  - frontmatter 含 `audioUrl: https://media.xyzcdn.net/...m4a`
  - frontmatter 含 `duration: 10:14:00`
  - frontmatter 含 `podcast: 面基`
  - frontmatter 含 `episodeNumber: E112`

### 10.3 Bridge path 双 wire 检查

按 `feedback_e2e_bridge_path_double_wire`：content.ts 的 `__obsidianClipperTestExtract__` 监听器要镜像主路径调 `extractXiaoyuzhouStructuredContent`，避免「unit test pass / e2e fail」。

## 11. content.ts 接入点（精确行号 + 改动）

| 位置 | 改动 |
|---|---|
| L14 周围 | `import { extractXiaoyuzhouStructuredContent, isXiaoyuzhouEpisodeUrl } from './utils/xiaoyuzhou-extractor';` |
| L277 周围（extractor 调度块） | 加 `const xiaoyuzhouContent = isXiaoyuzhouEpisodeUrl(document.URL) ? await extractXiaoyuzhouStructuredContent(document).catch(msg => { extractorWarnings.push(`Xiaoyuzhou: ${msg}`); return null; }) : null;` |
| L336-343（专有变量注入） | 加 `if (xiaoyuzhouContent) { extractedContent.audioUrl = ...; extractedContent.duration = ...; extractedContent.podcast = ...; extractedContent.podcastUrl = ...; extractedContent.episodeNumber = ...; }` |
| L426-443（fallback chain） | 把 `xiaoyuzhouContent?.title / author / description / published / image / site / content / wordCount` 串进 fallback 链 |
| L705 起的路由表（popup 侧） | 加 `else if (isXiaoyuzhouEpisodeUrl(document.URL)) { ... extractXiaoyuzhouStructuredContent ... }` 分支 |
| L641+ bridge `__obsidianClipperTestExtract__` 监听器 | 镜像增加 xiaoyuzhou 路由 |

## 12. content-extractor.ts 接入点

L65 周围（fetch 阻止逻辑）：xiaoyuzhou 不需要走 fetch，跳过即可（与 bilibili 同）。

**专有变量不需要扩 ContentResponse interface**——`extractedContent` 字段在两处 interface 都是 `{ [key: string]: string }`（灵活字典），直接 `extractedContent.audioUrl = ...` 即可。bilibili 同样未加 transcript/bvid 等字段到 interface。

## 13. 风险与开放问题

### 13.1 评论 jsx-XXXXXXXX class hash 不稳定

页面源 class 含 React jsx-hash（如 `jsx-532826724 comment`）。**实现时用 stable 选择器**：`.comment` / `.name` / `.pub-time` / `.like` / `.count` 都是语义类（不含 hash），可用。仅 `.css-yr3tbw` 这类 emotion CSS-in-JS hash 不能依赖——用结构匹配兜底（找包含 `.comment` 后代的 section / div）。

### 13.2 评论展开可能被反爬识别

`window.scrollTo` + 大量 click 在短时间内可能触发反爬。**护栏**：每轮 sleep ≥ 300ms；最多 10 轮滚动 / 100 个 expander click（防 unbounded loop）；如果 expander 数 > 100 直接放弃展开剩余，记日志。

### 13.3 turndown 二次处理评论引用块

见 §9.1：plan 阶段 PoC 后定方案。

### 13.4 e2e timeout

10 小时大集评论上百条 + 展开需要时间，e2e timeout 设 60s（默认 30s 不够）。

## 14. 验收 checklist（ship 阶段必走）

按 `feedback_extractor_acceptance` 的 T5-1..4：

- **T5-1 build**：`npm run build:chrome` 退出码 0；产物 `dist/content.js` 大小合理
- **T5-2 e2e**：`npm run test:e2e` 关键 assertion 全 PASS；trace 到 Obsidian.app 截图
- **T5-3 vitest**：`npm test` PASS（含 xiaoyuzhou-extractor.test.ts 全套断言）
- **T5-4 视觉 audit**：用 `audit-extractor-ship` skill 跑 4 个 URL，subagent 隔离对比 obsidian markdown vs 浏览器原页，输出 REPORT.md

## 15. 落地后更新

- `BACKLOG.md` §2 加经验沉淀（Defuddle 无 href anchor 剥离 / 评论 DOM 在 article 外 / 时间戳 rewrite pattern）
- `MEMORY.md` 加 `project_xiaoyuzhou_episode_data.md`（DOM 形态、JSON-LD 字段、jsx-hash 不稳定 hint）
- `CLAUDE.md`「专项提取器」段落加 xiaoyuzhou
