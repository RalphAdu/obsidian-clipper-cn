# 知识星球（zsxq.com）专项提取器 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 `wx.zsxq.com` topic 详情页与专栏文章页写专项提取器，调用 `api.zsxq.com` JSON 接口拉取正文 + 全部嵌套评论，渲染为语义完整的 Markdown：`<e>` 内嵌标签（hashtag/mention/emoji/web）转 markdown 文本、图片 base64 内嵌、评论以 Obsidian 原生 callout 嵌套。

**Architecture:** 新建 `src/utils/zsxq-extractor.ts`：URL 解析 → 同源 fetch `api.zsxq.com` topic + 分页评论 → 解析 zsxq 自定义 `<e>` 内嵌标签 → 重建评论树（按 `parent_comment_id`）→ 渲染 callout markdown → 图片三级 fallback。`src/content.ts` 加 zsxq 分支与既有 feishu/scys 同模式。

**Tech Stack:** TypeScript / Vitest / 同源 fetch (`credentials: 'include'`) / Chrome `host_permissions` 跨域降级 / 自动化迭代回路（chrome.alarms hot-reload + page-world test bridge + HTTP receiver + claude-in-chrome MCP）

**Spec:** [`docs/superpowers/specs/2026-05-17-zsxq-extractor-design.md`](../specs/2026-05-17-zsxq-extractor-design.md)

## 自动化基础设施（沿用 scys 同款）

本 plan 复用 cn 仓库已有的飞书/scys 裁剪自动化三件套，把 Task 0 fixture 抓取与 Task 10 端到端验收做成**全自动循环**。一次性人工：用户首次手动加载 dev build 到 chrome（5 秒）+ 已在 `wx.zsxq.com` 登录。

- **Hot-reload (`chrome.alarms`)**：webpack rebuild → 扩展自动 reload；content.ts 需 tab navigate 才重新注入
- **Page-world test bridge**（`src/content.ts` 末尾，line ~616）：监听 `window.postMessage({type:'__obsidianClipperTestExtract__',testId,uploadUrl})` 触发完整提取管线；当前仅在 feishu/lark/scys origin 响应，本 plan Task 9 扩展支持 `wx.zsxq.com`
- **HTTP receiver**（`/tmp/recv_server.py`）：临时启动，接收大 markdown / fixture，单次 POST 后自动 shutdown
- **chrome MCP javascript_tool**：page world 触发 bridge + poll localStorage 拿短摘要

---

## File Structure

| 操作 | 路径 | 责任 |
|---|---|---|
| 新建 | `src/utils/zsxq-extractor.ts` | URL 判定 / API 调用 / `<e>` 解析 / 评论树重建 / 渲染主模块 |
| 新建 | `src/utils/zsxq-extractor.test.ts` | 单测，覆盖各子模块 |
| 新建 | `src/utils/fixtures/zsxq-topic-185414442218552.json` | 真实 topic API 响应 |
| 新建 | `src/utils/fixtures/zsxq-comments-185414442218552.json` | 真实评论 API 响应（多页合并） |
| 修改 | `src/content.ts`（line ~277 / ~620 / ~629） | 接入 zsxq 分支 + 扩展 page-world test bridge origin |
| 修改 | `src/manifest.chrome.json` | `host_permissions` 加 `api.zsxq.com` + zsxq 图床域 |
| 修改 | `src/manifest.firefox.json` | 同上 |
| 修改 | `src/manifest.safari.json` | 同上 |
| 可能修改 | `src/background.ts` | 若 L1 跨域失败，加 `fetchZsxqApi` / `fetchZsxqImageAsBase64` action handler |

**复用（不修改）**：scys 的 `blobToDataUrl` 模式（必要时拷贝相同实现到 zsxq-extractor，避免跨模块依赖）

---

## Task 0 实测结果（已完成）

| 项目 | 实测确认 |
|---|---|
| Topic API | `GET https://api.zsxq.com/v2/topics/{id}/info`（注意 `/info` 后缀）→ `{ succeeded, resp_data: { topic, type } }` |
| Comments API | `GET https://api.zsxq.com/v2/topics/{id}/comments?count=30[&end_time=ISO]`，**默认按 desc 排序**；`sort=asc` 实测返回空数组 |
| 评论结构 | 嵌套：top-level `comments[]`，每条带 `replied_comments[]`（即子回复）。**深度恒为 2**（reply 无子 reply）。回复节点含 `parent_comment_id` + `repliee` |
| Topic 正文 | `topic.talk.text` 是 **205 字摘要**，不是全文；正文全文在 `https://articles.zsxq.com/id_{article_id}.html` 的 `<div class="content ql-editor">` 节点 |
| Article body API | `GET /v2/articles/{id}` 返回 `权限不足`（code 1030），**不能用**；改抓 articles.zsxq.com 的 HTML，解析 `.ql-editor` 节点 |
| 签名头 | 不需要自定义头，content-script `credentials: 'include'` 同源 fetch 即可 |
| 图床域名 | 两个：`https://images.zsxq.com/*`（头像/普通图）+ `https://article-images.zsxq.com/*`（文章正文图） |
| Article HTML 抓取 | 来自 articles.zsxq.com 跨 origin；从 wx.zsxq.com 直接 fetch 会触发 CORS（实测 "Failed to fetch"），**必须走 background fetch + host_permissions** |

**Fixture 文件（已落地）**：
- `src/utils/fixtures/zsxq-topic-185414442218552.json` — topic /info 响应
- `src/utils/fixtures/zsxq-comments-185414442218552.json` — comments 全部页拼合（54 条总数：27 top + 27 nested）
- `src/utils/fixtures/zsxq-article-qleditor-0rpvzt86eie6.html` — 文章 `.ql-editor` 节点 outerHTML（10162 字符 HTML / 6560 字符纯文本）

**关键字段名实测**：

Topic：`succeeded, resp_data.topic.{type, topic_id, talk: {owner: {user_id, name, avatar_url}, text, images?, files?, article?: {title, article_id, article_url, inline_article_url}}, likes_count, comments_count}`

Comment（top-level）：`{comment_id, create_time(ISO8601), text, owner: {user_id, name, avatar_url, location?, alias?}, likes_count, group_owner_liked, topic_owner_liked, rewards_count, sticky, images?, replies_count, replied_comments?: ZsxqReply[]}`

Reply：`{comment_id, parent_comment_id, create_time, text, owner: {...}, repliee: {user_id, name, avatar_url}, likes_count, ...}`

---

## Task 0: 准备真实 API fixture（全自动） — ✅ 已完成（见上方实测结果）

跳过 Task 0 步骤；fixture 已 commit `1ec9161`。

---

## Task 0 原始流程（仅供回归参考，不再执行）

**前提**：claude-in-chrome MCP 已连接、`wx.zsxq.com` 在某 tab 已登录会话有效

**Files:**
- Create: `/tmp/recv_server.py`（临时）
- Create: `src/utils/fixtures/zsxq-topic-185414442218552.json`
- Create: `src/utils/fixtures/zsxq-comments-185414442218552.json`

- [ ] **Step 1: 写 receiver 脚本（落 fixture 用）**

Create `/tmp/recv_server.py`：

```python
#!/usr/bin/env python3
"""One-shot HTTP receiver: writes POST body to file, then shuts down."""
import sys, http.server, socketserver

OUT_PATH, PORT = sys.argv[1], int(sys.argv[2])

class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(n)
        with open(OUT_PATH, 'wb') as f:
            f.write(body)
        self.send_response(200); self.send_header('Access-Control-Allow-Origin','*'); self.end_headers()
        self.wfile.write(b'ok')
        import threading; threading.Thread(target=self.server.shutdown, daemon=True).start()
    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin','*')
        self.send_header('Access-Control-Allow-Methods','POST,OPTIONS')
        self.send_header('Access-Control-Allow-Headers','Content-Type')
        self.end_headers()
    def log_message(self, *a): pass

with socketserver.TCPServer(('127.0.0.1', PORT), H) as srv:
    srv.serve_forever()
```

- [ ] **Step 2: 用 DevTools 抓取实际 API 路径 / 鉴权 / 字段名**

用 claude-in-chrome MCP（参 `mcp__claude-in-chrome__tabs_context_mcp`）找 wx.zsxq.com 标签 ID，在该 tab 跑：

```js
// 用 Performance.getEntriesByType('resource') 列出所有 zsxq API 请求
performance.getEntriesByType('resource')
  .filter(e => e.name.includes('zsxq.com') && e.initiatorType === 'fetch')
  .map(e => ({ name: e.name, status: 'unknown' }))
  .slice(0, 30);
```

Expected：包含若干形如 `https://api.zsxq.com/v2/...` 的条目。**人工/Agent 记录实际 path**，回填到本 plan §"关键不确定点"。

如果该 tab 之前未浏览过 topic 详情，先 `mcp__claude-in-chrome__navigate` 到测试 URL `https://wx.zsxq.com/group/1824528822/topic/185414442218552`、等待 3 秒、再执行上面的 performance 查询。

- [ ] **Step 3: 抓 topic fixture**

```bash
mkdir -p src/utils/fixtures
lsof -i:17923 -t 2>/dev/null | xargs -r kill -9 2>/dev/null
nohup python3 /tmp/recv_server.py "$(pwd)/src/utils/fixtures/zsxq-topic-185414442218552.json" 17923 > /tmp/recv-zsxq-topic.log 2>&1 < /dev/null &
disown
sleep 0.5
```

`javascript_tool`（在 `wx.zsxq.com` origin 内跑——content-script 同源 fetch api.zsxq.com 时浏览器自动带 cookie；若被 SameSite 拦截，改在 api.zsxq.com origin 内跑或换成方案 B 见 §故障排除）：

```js
fetch('https://api.zsxq.com/v2/topics/185414442218552', { credentials: 'include' })
  .then(r => r.json())
  .then(d => fetch('http://127.0.0.1:17923/', { method: 'POST', body: JSON.stringify(d, null, 2) }))
  .then(r => 'uploaded: ' + r.status)
  .catch(e => 'error: ' + e.message);
```

Expected: `"uploaded: 200"`。

**故障排除**：
- 若 `succeeded: false` 或 401 → 检查 `document.cookie`，若空说明 zsxq 把 cookie 设为 `HttpOnly + SameSite=None`，content-script 跨 origin fetch 仍应该带 cookie（content-script 是浏览器特权上下文）。若仍 401，说明 zsxq 校验自定义签名头：跳到 Task 0 Step 6 抓签名头。
- 若 CORS error → 实测说明同源策略阻断；同样跳到 Step 6。

- [ ] **Step 4: 抓评论 fixture（分页合并）**

先用 javascript_tool 探一次拿到 `comments_count` 和第一页评论结构：

```js
fetch('https://api.zsxq.com/v2/topics/185414442218552/comments?count=30&sort=asc', { credentials: 'include' })
  .then(r => r.json())
  .then(d => JSON.stringify({ total: d?.resp_data?.topic?.comments_count, page1_len: d?.resp_data?.comments?.length, first: d?.resp_data?.comments?.[0] }, null, 2));
```

记录评论分页参数（可能是 `end_time` / `start_time` / `page`，看返回字段决定）。然后启动 receiver 抓全部页：

```bash
lsof -i:17923 -t 2>/dev/null | xargs -r kill -9 2>/dev/null
nohup python3 /tmp/recv_server.py "$(pwd)/src/utils/fixtures/zsxq-comments-185414442218552.json" 17923 > /tmp/recv-zsxq-comments.log 2>&1 < /dev/null &
disown
sleep 0.5
```

```js
(async () => {
  const all = [];
  let endTime = undefined;
  for (let i = 0; i < 50; i++) {
    const url = new URL('https://api.zsxq.com/v2/topics/185414442218552/comments');
    url.searchParams.set('count', '30');
    url.searchParams.set('sort', 'asc');
    if (endTime) url.searchParams.set('end_time', endTime);
    const r = await fetch(url.toString(), { credentials: 'include' });
    const j = await r.json();
    const page = j?.resp_data?.comments ?? [];
    all.push(...page);
    if (page.length < 30) break;
    endTime = page[page.length - 1].create_time;
  }
  return fetch('http://127.0.0.1:17923/', {
    method: 'POST',
    body: JSON.stringify({ resp_data: { comments: all }, _meta: { pageCount: Math.ceil(all.length / 30) } }, null, 2),
  }).then(r => 'uploaded: ' + r.status + ' total: ' + all.length);
})();
```

Expected: `"uploaded: 200 total: <N>"`，N 等于 topic 的 `comments_count`。

- [ ] **Step 5: 验证 fixture 完整性**

```bash
jq '.resp_data.topic.type, .resp_data.topic.talk.text[:200], (.resp_data.topic.talk.images // [] | length)' src/utils/fixtures/zsxq-topic-185414442218552.json
jq '.resp_data.comments | length, [.[] | .text[:50]] | .[0:3]' src/utils/fixtures/zsxq-comments-185414442218552.json
```

Expected：
- topic.type 应为 `"talk"` / `"q&a"` / `"task"` / `"solution"` 之一
- talk.text 非空且包含中文
- comments 数组长度 = topic.comments_count

**确认评论结构**（关键：判断 `parent_comment_id` 字段是否存在）：

```bash
jq '.resp_data.comments[] | {comment_id, parent_comment_id, repliee: .repliee.name, owner: .owner.name, len: (.text | length)}' src/utils/fixtures/zsxq-comments-185414442218552.json | head -30
```

记录：
- 评论 id 字段名（`comment_id` / `id` / 其他）
- 父子关系字段（`parent_comment_id` / 仅 `repliee.user_id` / 其他）
- 用户名字段位置（`owner.name` / `user.name`）
- 时间字段（ISO8601 / unix）

**回填到本 plan + spec**：在 §"关键不确定点" 表格更新「假设」列与「验证」列的实际值；在 Task 2/3/4/5 中将此字段名替换为实测值。

- [ ] **Step 6: （仅当 Step 3 失败时）抓签名头与降级路径**

如果 Step 3 的 fetch 在浏览器 console 报 401 或 CORS error，用 DevTools Network 看 SPA 自身的 topic 请求 headers，记录所有 `x-` 前缀自定义头。然后选其一：

- **A. 复用 SPA fetch 客户端**：检查 `window.fetch` 是否被 zsxq SPA 包装；如是，调用包装后版本即可
- **B. 用 chrome.declarativeNetRequest 注入 header**：在 background 注册规则，给所有 `api.zsxq.com` 请求注入实测捕获的固定头（如果头是静态 token 而非时变签名）
- **C. background fetch + manifest host_permissions**：在 background context fetch，浏览器自动带 cookie，绕开 page CORS

Step 6 是逃生通道，Step 3 通过时跳过。**Task 0 完成判定 = fixture 文件落地**，不强制走 Step 6。

- [ ] **Step 7: Commit fixture + 回填 spec/plan**

```bash
git add -f src/utils/fixtures/zsxq-topic-185414442218552.json src/utils/fixtures/zsxq-comments-185414442218552.json
git add docs/superpowers/plans/2026-05-17-zsxq-extractor.md docs/superpowers/specs/2026-05-17-zsxq-extractor-design.md
git commit -m "test: add zsxq topic + comments API fixtures (topic 185414442218552); finalize API field mapping"
```

---

## Task 1: URL 判定与解析

**Files:**
- Create: `src/utils/zsxq-extractor.ts`
- Create: `src/utils/zsxq-extractor.test.ts`

- [ ] **Step 1: 写失败测试**

`src/utils/zsxq-extractor.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { isZsxqTopicUrl, isZsxqArticleUrl, parseZsxqUrl } from './zsxq-extractor';

describe('isZsxqTopicUrl', () => {
  it('matches wx.zsxq.com topic URL', () => {
    expect(isZsxqTopicUrl('https://wx.zsxq.com/group/1824528822/topic/185414442218552')).toBe(true);
  });
  it('matches with trailing slash', () => {
    expect(isZsxqTopicUrl('https://wx.zsxq.com/group/1824528822/topic/185414442218552/')).toBe(true);
  });
  it('rejects article URL', () => {
    expect(isZsxqTopicUrl('https://wx.zsxq.com/group/1824528822/article/185414442218552')).toBe(false);
  });
  it('rejects group home', () => {
    expect(isZsxqTopicUrl('https://wx.zsxq.com/group/1824528822')).toBe(false);
  });
  it('rejects non-zsxq host', () => {
    expect(isZsxqTopicUrl('https://example.com/group/1/topic/2')).toBe(false);
  });
  it('rejects malformed URL', () => {
    expect(isZsxqTopicUrl('not a url')).toBe(false);
  });
});

describe('isZsxqArticleUrl', () => {
  it('matches wx.zsxq.com article URL', () => {
    expect(isZsxqArticleUrl('https://wx.zsxq.com/group/1824528822/article/12345')).toBe(true);
  });
  it('rejects topic URL', () => {
    expect(isZsxqArticleUrl('https://wx.zsxq.com/group/1824528822/topic/12345')).toBe(false);
  });
});

describe('parseZsxqUrl', () => {
  it('parses topic URL', () => {
    expect(parseZsxqUrl('https://wx.zsxq.com/group/1824528822/topic/185414442218552'))
      .toEqual({ kind: 'topic', groupId: '1824528822', topicId: '185414442218552' });
  });
  it('parses article URL', () => {
    expect(parseZsxqUrl('https://wx.zsxq.com/group/1824528822/article/123'))
      .toEqual({ kind: 'article', groupId: '1824528822', articleId: '123' });
  });
  it('returns null for unknown shape', () => {
    expect(parseZsxqUrl('https://wx.zsxq.com/group/1824528822')).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试验证失败**

```bash
npx vitest run src/utils/zsxq-extractor.test.ts
```

Expected: FAIL with `Cannot find module './zsxq-extractor'`

- [ ] **Step 3: 实现 URL 判定与解析**

Create `src/utils/zsxq-extractor.ts`：

```ts
import { createLogger } from './logger';

const logger = createLogger('zsxq-extractor');

const ZSXQ_TOPIC_RE = /^\/group\/(\d+)\/topic\/(\d+)\/?$/;
const ZSXQ_ARTICLE_RE = /^\/group\/(\d+)\/article\/(\d+)\/?$/;

export function isZsxqTopicUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.hostname !== 'wx.zsxq.com') return false;
    return ZSXQ_TOPIC_RE.test(u.pathname);
  } catch {
    return false;
  }
}

export function isZsxqArticleUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.hostname !== 'wx.zsxq.com') return false;
    return ZSXQ_ARTICLE_RE.test(u.pathname);
  } catch {
    return false;
  }
}

export type ZsxqUrlInfo =
  | { kind: 'topic'; groupId: string; topicId: string }
  | { kind: 'article'; groupId: string; articleId: string };

export function parseZsxqUrl(url: string): ZsxqUrlInfo | null {
  try {
    const u = new URL(url);
    if (u.hostname !== 'wx.zsxq.com') return null;
    const t = u.pathname.match(ZSXQ_TOPIC_RE);
    if (t) return { kind: 'topic', groupId: t[1], topicId: t[2] };
    const a = u.pathname.match(ZSXQ_ARTICLE_RE);
    if (a) return { kind: 'article', groupId: a[1], articleId: a[2] };
    return null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: 跑测试验证通过**

```bash
npx vitest run src/utils/zsxq-extractor.test.ts
```

Expected: PASS (10 tests)

- [ ] **Step 5: Commit**

```bash
git add src/utils/zsxq-extractor.ts src/utils/zsxq-extractor.test.ts
git commit -m "feat(zsxq): add URL detection and parsing for topic/article pages"
```

---

## Task 2: 内嵌 `<e>` 标签解析（hashtag/mention/emoji/web）

**Files:**
- Modify: `src/utils/zsxq-extractor.ts`
- Modify: `src/utils/zsxq-extractor.test.ts`

- [ ] **Step 1: 写失败测试**

追加到 `zsxq-extractor.test.ts`：

```ts
import { parseZsxqInlineText } from './zsxq-extractor';

describe('parseZsxqInlineText', () => {
  it('returns plain text unchanged', () => {
    expect(parseZsxqInlineText('hello world 你好')).toBe('hello world 你好');
  });

  it('converts <e type="hashtag" .../> with URL-encoded title', () => {
    const input = 'foo <e type="hashtag" hid="1" title="%23AI%20%E5%B7%A5%E5%85%B7%23"/> bar';
    expect(parseZsxqInlineText(input)).toBe('foo #AI 工具# bar');
  });

  it('converts <e type="mention" .../> to @name', () => {
    const input = '感谢 <e type="mention" uid="42" title="%40%E9%99%88%E5%A4%A7"/> 的分享';
    expect(parseZsxqInlineText(input)).toBe('感谢 @陈大 的分享');
  });

  it('converts <e type="emoji" .../> when title is the emoji char', () => {
    const input = 'haha <e type="emoji" title="%F0%9F%98%80"/>';
    expect(parseZsxqInlineText(input)).toBe('haha 😀');
  });

  it('converts <e type="web" href=... title=.../> to markdown link', () => {
    const input = 'see <e type="web" href="https://x.com" title="%E5%B7%A5%E5%85%B7%E9%9B%86"/>';
    expect(parseZsxqInlineText(input)).toBe('see [工具集](https://x.com)');
  });

  it('handles <br> as newline', () => {
    expect(parseZsxqInlineText('line1<br>line2<br/>line3')).toBe('line1\nline2\nline3');
  });

  it('decodes &amp; &lt; &gt; &quot;', () => {
    expect(parseZsxqInlineText('a &amp; b &lt;c&gt; &quot;d&quot;')).toBe('a & b <c> "d"');
  });

  it('falls back to [表情] when emoji title cannot decode', () => {
    const input = '<e type="emoji" eid="custom_123"/>';
    expect(parseZsxqInlineText(input)).toBe('[表情]');
  });

  it('strips unknown <e> types silently', () => {
    expect(parseZsxqInlineText('a <e type="weird" foo="bar"/> b')).toBe('a  b');
  });

  it('preserves order with multiple inline tags mixed with text', () => {
    const input = '<e type="hashtag" title="%23T1%23"/> 中间 <e type="mention" title="%40U1"/> 尾';
    expect(parseZsxqInlineText(input)).toBe('#T1# 中间 @U1 尾');
  });
});
```

- [ ] **Step 2: 跑测试验证失败**

```bash
npx vitest run src/utils/zsxq-extractor.test.ts -t parseZsxqInlineText
```

Expected: FAIL with `parseZsxqInlineText is not a function`

- [ ] **Step 3: 实现 parseZsxqInlineText**

追加到 `src/utils/zsxq-extractor.ts`：

```ts
// zsxq 在 talk.text / comment.text 中使用自定义 <e .../> 内嵌标签表达
// hashtag / mention / emoji / 外链。本函数把它们转换为 markdown 纯文本。
//
// 不依赖 DOMParser（content-script 与 node test 都要能跑），改用正则解析。
// <e> 是自闭合标签（不会嵌套），用单次正则替换即可。
export function parseZsxqInlineText(html: string): string {
  if (!html) return '';

  const decodeHtmlEntities = (s: string): string => s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');

  const decodeAttr = (raw: string | undefined): string => {
    if (!raw) return '';
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  };

  const getAttr = (tag: string, name: string): string | undefined => {
    const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
    return m ? m[1] : undefined;
  };

  // 1. 把 <br> / <br/> 替换为 \n
  let out = html.replace(/<br\s*\/?>/gi, '\n');

  // 2. 替换 <e ... /> 标签
  out = out.replace(/<e\b[^>]*\/?>/g, (tag) => {
    const type = getAttr(tag, 'type');
    const title = decodeAttr(getAttr(tag, 'title'));
    const href = getAttr(tag, 'href');
    switch (type) {
      case 'hashtag':
        // title 已含两端 #（如 "#AI 工具#"）
        return title || '';
      case 'mention':
        // title 已含 @（如 "@陈大"）
        return title || '';
      case 'emoji':
        // title 通常是 URL-encoded 的 emoji 字符；解码后就是表情字符本身
        // 兜底：title 缺失或解码失败 → "[表情]"
        return title || '[表情]';
      case 'web':
        if (href && title) return `[${title}](${href})`;
        if (href) return href;
        return title || '';
      default:
        return '';
    }
  });

  // 3. HTML 实体解码（注意：必须在 <e> 处理之后，因为 title 是 URL-encoded 而非 HTML-encoded）
  out = decodeHtmlEntities(out);

  return out;
}
```

- [ ] **Step 4: 跑测试验证通过**

```bash
npx vitest run src/utils/zsxq-extractor.test.ts -t parseZsxqInlineText
```

Expected: PASS (10 tests)

- [ ] **Step 5: Commit**

```bash
git add src/utils/zsxq-extractor.ts src/utils/zsxq-extractor.test.ts
git commit -m "feat(zsxq): parse zsxq inline <e> tags (hashtag/mention/emoji/web) to markdown text"
```

---

## Task 3: Topic JSON 类型 + Topic markdown 渲染

**前提**：Task 0 已经完成，且 fixture 中的字段名已经回填到 §"关键不确定点"。如果 fixture 中字段名与本 Task 假设不符，**先改本 Task 的类型定义**再写测试。

**Files:**
- Modify: `src/utils/zsxq-extractor.ts`
- Modify: `src/utils/zsxq-extractor.test.ts`

- [ ] **Step 1: 写失败测试（用真实 fixture）**

追加到 `zsxq-extractor.test.ts`：

```ts
import { renderZsxqTopicMarkdown } from './zsxq-extractor';
import topicFixture from './fixtures/zsxq-topic-185414442218552.json';

describe('renderZsxqTopicMarkdown (real fixture)', () => {
  const topic = (topicFixture as any).resp_data.topic;

  it('returns non-empty markdown for the fixture topic', () => {
    const md = renderZsxqTopicMarkdown(topic);
    expect(md.length).toBeGreaterThan(50);
  });

  it('preserves Chinese text from talk.text', () => {
    const md = renderZsxqTopicMarkdown(topic);
    // 抽 talk.text 头部 20 字符，去 <e> 标签后应在 markdown 里出现
    const rawText: string = topic.talk?.text || topic.question?.text || '';
    const sample = rawText.replace(/<e[^>]*\/?>/g, '').replace(/<br\s*\/?>/g, ' ').slice(0, 20).trim();
    if (sample) expect(md).toContain(sample.slice(0, 10));
  });

  it('emits image placeholder for each image in talk.images', () => {
    const md = renderZsxqTopicMarkdown(topic);
    const imageCount = (topic.talk?.images || topic.question?.images || []).length;
    const tokenCount = (md.match(/feishu-image:\/\/zsxq:/g) || []).length;
    expect(tokenCount).toBe(imageCount);
  });
});

describe('renderZsxqTopicMarkdown (synthetic)', () => {
  it('renders type=talk with text only', () => {
    const topic: any = {
      type: 'talk',
      talk: { owner: { user_id: 1, name: 'X' }, text: 'hello' },
    };
    expect(renderZsxqTopicMarkdown(topic)).toContain('hello');
  });

  it('renders type=q&a as 提问 + 回答 sections', () => {
    const topic: any = {
      type: 'q&a',
      question: { owner: { user_id: 1, name: 'Q' }, text: 'question?' },
      answer:   { owner: { user_id: 2, name: 'A' }, text: 'answer.' },
    };
    const md = renderZsxqTopicMarkdown(topic);
    expect(md).toContain('提问');
    expect(md).toContain('question?');
    expect(md).toContain('回答');
    expect(md).toContain('answer.');
  });

  it('renders files as markdown list', () => {
    const topic: any = {
      type: 'talk',
      talk: {
        owner: { user_id: 1, name: 'X' },
        text: 'see file',
        files: [{ file_id: 1, name: 'doc.pdf', download_url: 'https://x.com/doc.pdf' }],
      },
    };
    expect(renderZsxqTopicMarkdown(topic)).toContain('📎 [doc.pdf](https://x.com/doc.pdf)');
  });
});
```

- [ ] **Step 2: 跑测试验证失败**

```bash
npx vitest run src/utils/zsxq-extractor.test.ts -t renderZsxqTopicMarkdown
```

Expected: FAIL with `renderZsxqTopicMarkdown is not a function`

- [ ] **Step 3: 实现类型 + 渲染**

追加到 `src/utils/zsxq-extractor.ts`：

```ts
export interface ZsxqImage {
  image_id?: number;
  thumbnail?: { url: string };
  large?: { url: string };
  original?: { url: string };
}

export interface ZsxqFile {
  file_id?: number;
  name: string;
  download_url: string;
  size?: number;
}

export interface ZsxqUser {
  user_id: number;
  name: string;
  avatar_url?: string;
}

export interface ZsxqBody {
  owner: ZsxqUser;
  text: string;
  images?: ZsxqImage[];
  files?: ZsxqFile[];
  article?: { title: string; article_url: string };
}

export interface ZsxqTopic {
  topic_id: number;
  type: string; // 'talk' | 'q&a' | 'task' | 'solution' (实测可能有变体)
  group?: { group_id: number; name: string };
  create_time: string;
  talk?: ZsxqBody;
  question?: ZsxqBody;
  answer?: ZsxqBody;
  task?: ZsxqBody;
  solution?: ZsxqBody;
  likes_count?: number;
  comments_count?: number;
}

// 把 ZsxqImage 转换为带 zsxq: 前缀 token 的 <img> 占位符，
// 由后续 resolveZsxqImages 替换为 base64。
function renderImagePlaceholder(img: ZsxqImage): string {
  // 优先 original > large > thumbnail
  const url = img.original?.url || img.large?.url || img.thumbnail?.url;
  if (!url) return '';
  const token = `zsxq:${encodeURIComponent(url)}`;
  // 与 scys 同一占位符协议：HTML <img>，src 用 feishu-image:// 前缀
  const alt = String(img.image_id ?? '');
  return `<img alt="${alt}" src="feishu-image://${token}"/>`;
}

function renderFileLine(f: ZsxqFile): string {
  return `- 📎 [${f.name}](${f.download_url})`;
}

function renderBody(body: ZsxqBody | undefined): string {
  if (!body) return '';
  const parts: string[] = [];
  if (body.text) parts.push(parseZsxqInlineText(body.text));
  if (body.images && body.images.length) {
    parts.push(body.images.map(renderImagePlaceholder).filter(Boolean).join('\n'));
  }
  if (body.files && body.files.length) {
    parts.push(body.files.map(renderFileLine).join('\n'));
  }
  if (body.article) {
    parts.push(`> 关联文章：[${body.article.title}](${body.article.article_url})`);
  }
  return parts.filter(Boolean).join('\n\n');
}

export function renderZsxqTopicMarkdown(topic: ZsxqTopic): string {
  switch (topic.type) {
    case 'q&a': {
      const q = renderBody(topic.question);
      const a = renderBody(topic.answer);
      const qBlock = q ? `**🙋 提问** · ${topic.question?.owner?.name ?? ''}\n\n${q}` : '';
      const aBlock = a ? `**💡 回答** · ${topic.answer?.owner?.name ?? ''}\n\n${a}` : '';
      return [qBlock, aBlock].filter(Boolean).join('\n\n');
    }
    case 'task':
      return renderBody(topic.task ?? topic.talk);
    case 'solution':
      return renderBody(topic.solution ?? topic.talk);
    case 'talk':
    default:
      return renderBody(topic.talk);
  }
}
```

- [ ] **Step 4: 跑测试验证通过**

```bash
npx vitest run src/utils/zsxq-extractor.test.ts -t renderZsxqTopicMarkdown
```

Expected: PASS（fixture 测试 3 个 + synthetic 3 个 = 6）

如果 fixture 测试因字段名不符失败：根据 Step 0.5 的 jq 输出，把 ZsxqTopic / ZsxqBody 的字段名调整到与 fixture 一致再回到 Step 4。

- [ ] **Step 5: Commit**

```bash
git add src/utils/zsxq-extractor.ts src/utils/zsxq-extractor.test.ts
git commit -m "feat(zsxq): render topic body to markdown (text + images + files + article link)"
```

---

## Task 4: 评论分页抓取 + 树重建

**Files:**
- Modify: `src/utils/zsxq-extractor.ts`
- Modify: `src/utils/zsxq-extractor.test.ts`

- [ ] **Step 1: 写失败测试**

追加到 `zsxq-extractor.test.ts`：

```ts
import { reconstructCommentTree, ZsxqComment } from './zsxq-extractor';

describe('reconstructCommentTree', () => {
  it('returns empty array for empty input', () => {
    expect(reconstructCommentTree([])).toEqual([]);
  });

  it('treats comments without parent_comment_id as roots', () => {
    const flat: ZsxqComment[] = [
      { comment_id: 1, text: 'A', owner: { user_id: 10, name: 'X' }, create_time: 't1', likes_count: 0 },
      { comment_id: 2, text: 'B', owner: { user_id: 11, name: 'Y' }, create_time: 't2', likes_count: 0 },
    ];
    const tree = reconstructCommentTree(flat);
    expect(tree.length).toBe(2);
    expect(tree[0].replies).toEqual([]);
    expect(tree[1].replies).toEqual([]);
  });

  it('nests by parent_comment_id', () => {
    const flat: ZsxqComment[] = [
      { comment_id: 1, text: 'root', owner: { user_id: 10, name: 'X' }, create_time: 't1', likes_count: 0 },
      { comment_id: 2, text: 'reply1', owner: { user_id: 11, name: 'Y' }, create_time: 't2', likes_count: 0, parent_comment_id: 1 },
      { comment_id: 3, text: 'reply2', owner: { user_id: 12, name: 'Z' }, create_time: 't3', likes_count: 0, parent_comment_id: 2 },
    ];
    const tree = reconstructCommentTree(flat);
    expect(tree.length).toBe(1);
    expect(tree[0].replies.length).toBe(1);
    expect(tree[0].replies[0].replies.length).toBe(1);
    expect(tree[0].replies[0].replies[0].text).toBe('reply2');
  });

  it('preserves insertion order among siblings', () => {
    const flat: ZsxqComment[] = [
      { comment_id: 1, text: 'root', owner: { user_id: 10, name: 'X' }, create_time: 't1', likes_count: 0 },
      { comment_id: 2, text: 'r1', owner: { user_id: 11, name: 'Y' }, create_time: 't2', likes_count: 0, parent_comment_id: 1 },
      { comment_id: 3, text: 'r2', owner: { user_id: 12, name: 'Z' }, create_time: 't3', likes_count: 0, parent_comment_id: 1 },
    ];
    const tree = reconstructCommentTree(flat);
    expect(tree[0].replies.map(r => r.text)).toEqual(['r1', 'r2']);
  });

  it('makes orphan replies (missing parent) into roots', () => {
    const flat: ZsxqComment[] = [
      { comment_id: 5, text: 'orphan', owner: { user_id: 10, name: 'X' }, create_time: 't1', likes_count: 0, parent_comment_id: 999 },
    ];
    const tree = reconstructCommentTree(flat);
    expect(tree.length).toBe(1);
    expect(tree[0].text).toBe('orphan');
  });
});

describe('reconstructCommentTree (real fixture)', () => {
  it('builds a tree whose total node count equals input length', () => {
    const commentsFixture = require('./fixtures/zsxq-comments-185414442218552.json');
    const flat: ZsxqComment[] = commentsFixture.resp_data.comments;
    const tree = reconstructCommentTree(flat);
    const count = (nodes: any[]): number => nodes.reduce((n, x) => n + 1 + count(x.replies), 0);
    expect(count(tree)).toBe(flat.length);
  });
});
```

- [ ] **Step 2: 跑测试验证失败**

```bash
npx vitest run src/utils/zsxq-extractor.test.ts -t reconstructCommentTree
```

Expected: FAIL with `reconstructCommentTree is not a function`

- [ ] **Step 3: 实现类型 + reconstructCommentTree**

追加到 `src/utils/zsxq-extractor.ts`：

```ts
export interface ZsxqComment {
  comment_id: number;
  text: string;
  owner: ZsxqUser;
  repliee?: ZsxqUser;
  parent_comment_id?: number;
  create_time: string; // ISO8601
  likes_count: number;
  images?: ZsxqImage[];
}

export interface ZsxqCommentNode extends ZsxqComment {
  replies: ZsxqCommentNode[];
}

export function reconstructCommentTree(flat: ZsxqComment[]): ZsxqCommentNode[] {
  if (!flat || flat.length === 0) return [];
  const byId = new Map<number, ZsxqCommentNode>();
  // 先按输入顺序建节点（保留兄弟顺序）
  for (const c of flat) {
    byId.set(c.comment_id, { ...c, replies: [] });
  }
  const roots: ZsxqCommentNode[] = [];
  for (const c of flat) {
    const node = byId.get(c.comment_id);
    if (!node) continue;
    const parentId = c.parent_comment_id;
    if (parentId != null && byId.has(parentId)) {
      byId.get(parentId)!.replies.push(node);
    } else {
      // 无 parent_comment_id 或 parent 不在 fixture 内（孤儿）→ 当根处理
      roots.push(node);
    }
  }
  return roots;
}
```

- [ ] **Step 4: 跑测试验证通过**

```bash
npx vitest run src/utils/zsxq-extractor.test.ts -t reconstructCommentTree
```

Expected: PASS（5 个 synthetic + 1 个 fixture = 6）

如果 fixture 测试失败（节点丢失），说明评论的父子字段名不是 `parent_comment_id`。检查 fixture 实际字段：

```bash
jq '[.resp_data.comments[] | keys] | unique | flatten | unique' src/utils/fixtures/zsxq-comments-185414442218552.json
```

把 ZsxqComment 接口 + `reconstructCommentTree` 内 `c.parent_comment_id` 替换为实测字段名。

- [ ] **Step 5: Commit**

```bash
git add src/utils/zsxq-extractor.ts src/utils/zsxq-extractor.test.ts
git commit -m "feat(zsxq): reconstruct nested comment tree from flat API list"
```

---

## Task 5: 评论 markdown 渲染（callout 嵌套）

**Files:**
- Modify: `src/utils/zsxq-extractor.ts`
- Modify: `src/utils/zsxq-extractor.test.ts`

- [ ] **Step 1: 写失败测试**

追加到 `zsxq-extractor.test.ts`：

```ts
import { renderZsxqCommentTreeMarkdown } from './zsxq-extractor';

describe('renderZsxqCommentTreeMarkdown', () => {
  it('renders empty tree as empty string', () => {
    expect(renderZsxqCommentTreeMarkdown([], 0)).toBe('');
  });

  it('renders single root comment as callout', () => {
    const tree = reconstructCommentTree([
      { comment_id: 1, text: 'hello', owner: { user_id: 10, name: '叁斤' }, create_time: '2026-05-10T10:00:00.000+0800', likes_count: 9 },
    ]);
    const md = renderZsxqCommentTreeMarkdown(tree, 1);
    expect(md).toContain('## 💬 全部评论（1 条）');
    expect(md).toContain('> [!quote]+ **叁斤** · 9 ❤️ · 2026-05-10');
    expect(md).toContain('> hello');
  });

  it('omits ❤️ when likes_count = 0', () => {
    const tree = reconstructCommentTree([
      { comment_id: 1, text: 'x', owner: { user_id: 10, name: 'X' }, create_time: '2026-05-10T10:00:00.000+0800', likes_count: 0 },
    ]);
    const md = renderZsxqCommentTreeMarkdown(tree, 1);
    expect(md).not.toContain('❤️');
    expect(md).toContain('> [!quote]+ **X** · 2026-05-10');
  });

  it('nests a one-level reply with > > prefix', () => {
    const flat: ZsxqComment[] = [
      { comment_id: 1, text: 'root', owner: { user_id: 10, name: 'A' }, create_time: '2026-05-10T10:00:00.000+0800', likes_count: 0 },
      { comment_id: 2, text: 'reply', owner: { user_id: 11, name: 'B' }, create_time: '2026-05-11T10:00:00.000+0800', likes_count: 2, parent_comment_id: 1 },
    ];
    const md = renderZsxqCommentTreeMarkdown(reconstructCommentTree(flat), 2);
    expect(md).toContain('> > **B** · 2 ❤️ · 2026-05-11');
    expect(md).toContain('> > reply');
  });

  it('nests two-level reply with > > > prefix', () => {
    const flat: ZsxqComment[] = [
      { comment_id: 1, text: 'l0', owner: { user_id: 10, name: 'A' }, create_time: '2026-05-10T10:00:00.000+0800', likes_count: 0 },
      { comment_id: 2, text: 'l1', owner: { user_id: 11, name: 'B' }, create_time: '2026-05-11T10:00:00.000+0800', likes_count: 0, parent_comment_id: 1 },
      { comment_id: 3, text: 'l2', owner: { user_id: 12, name: 'C' }, create_time: '2026-05-12T10:00:00.000+0800', likes_count: 0, parent_comment_id: 2 },
    ];
    const md = renderZsxqCommentTreeMarkdown(reconstructCommentTree(flat), 3);
    expect(md).toContain('> > > **C** · 2026-05-12');
    expect(md).toContain('> > > l2');
  });

  it('parses <e> tags inside comment text', () => {
    const flat: ZsxqComment[] = [
      {
        comment_id: 1,
        text: 'see <e type="hashtag" title="%23T%23"/>',
        owner: { user_id: 10, name: 'X' },
        create_time: '2026-05-10T10:00:00.000+0800',
        likes_count: 0,
      },
    ];
    const md = renderZsxqCommentTreeMarkdown(reconstructCommentTree(flat), 1);
    expect(md).toContain('> see #T#');
  });

  it('embeds comment image placeholders', () => {
    const flat: ZsxqComment[] = [
      {
        comment_id: 1,
        text: 'pic',
        owner: { user_id: 10, name: 'X' },
        create_time: '2026-05-10T10:00:00.000+0800',
        likes_count: 0,
        images: [{ image_id: 7, large: { url: 'https://img.zsxq.com/7' } }],
      },
    ];
    const md = renderZsxqCommentTreeMarkdown(reconstructCommentTree(flat), 1);
    expect(md).toMatch(/feishu-image:\/\/zsxq:/);
  });
});
```

- [ ] **Step 2: 跑测试验证失败**

```bash
npx vitest run src/utils/zsxq-extractor.test.ts -t renderZsxqCommentTreeMarkdown
```

Expected: FAIL with `renderZsxqCommentTreeMarkdown is not a function`

- [ ] **Step 3: 实现 callout 渲染**

追加到 `src/utils/zsxq-extractor.ts`：

```ts
function formatZsxqDate(isoOrUnix: string | number): string {
  const d = typeof isoOrUnix === 'number' ? new Date(isoOrUnix * 1000) : new Date(isoOrUnix);
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function prefixLines(text: string, prefix: string): string {
  return text.split('\n').map(line => prefix + line).join('\n');
}

// depth=0 → "> "（顶级 callout body 行前缀）
// depth=1 → "> > "（一级回复）
// depth=2 → "> > > "（二级回复）
function calloutPrefix(depth: number): string {
  return '> '.repeat(depth + 1);
}

function renderCommentBody(node: ZsxqCommentNode): string {
  const parts: string[] = [];
  if (node.text) parts.push(parseZsxqInlineText(node.text));
  if (node.images && node.images.length) {
    parts.push(node.images.map(renderImagePlaceholder).filter(Boolean).join('\n'));
  }
  return parts.filter(Boolean).join('\n\n');
}

function renderCommentNode(node: ZsxqCommentNode, depth: number): string {
  const date = formatZsxqDate(node.create_time);
  const likes = node.likes_count > 0 ? ` · ${node.likes_count} ❤️` : '';
  const name = node.owner?.name ?? `匿名#${node.owner?.user_id ?? '?'}`;

  // 顶级（depth=0）：用 [!quote]+ 起头；嵌套层（depth>=1）：仅用粗体 header
  const header = depth === 0
    ? `> [!quote]+ **${name}**${likes} · ${date}`
    : `${calloutPrefix(depth)}**${name}**${likes} · ${date}`;

  const bodyText = renderCommentBody(node);
  const bodyLines = bodyText ? prefixLines(bodyText, calloutPrefix(depth)) : '';

  const blank = calloutPrefix(depth).trimEnd(); // 空 callout 行（用作 body / 子回复间隔）
  const sections: string[] = [header];
  if (bodyLines) sections.push(bodyLines);

  for (const reply of node.replies) {
    sections.push(blank);
    sections.push(renderCommentNode(reply, depth + 1));
  }
  return sections.join('\n');
}

export function renderZsxqCommentTreeMarkdown(tree: ZsxqCommentNode[], total: number): string {
  if (tree.length === 0) return '';
  const blocks = tree.map(node => renderCommentNode(node, 0));
  // 主评论之间隔一个空行
  return `\n\n---\n\n## 💬 全部评论（${total} 条）\n\n${blocks.join('\n\n')}\n`;
}
```

- [ ] **Step 4: 跑测试验证通过**

```bash
npx vitest run src/utils/zsxq-extractor.test.ts -t renderZsxqCommentTreeMarkdown
```

Expected: PASS（7 tests）

- [ ] **Step 5: Commit**

```bash
git add src/utils/zsxq-extractor.ts src/utils/zsxq-extractor.test.ts
git commit -m "feat(zsxq): render comment tree as nested Obsidian callouts"
```

---

## Task 6: 图片三级 fallback resolveZsxqImages

**Files:**
- Modify: `src/utils/zsxq-extractor.ts`
- Modify: `src/utils/zsxq-extractor.test.ts`

- [ ] **Step 1: 写失败测试（mock fetch）**

追加到 `zsxq-extractor.test.ts`：

```ts
import { resolveZsxqImages } from './zsxq-extractor';

describe('resolveZsxqImages', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('returns html unchanged when no zsxq: token present', async () => {
    const html = '<p>plain</p>';
    expect(await resolveZsxqImages(html)).toBe(html);
  });

  it('replaces zsxq: token with base64 data URL on L1 success', async () => {
    const url = 'https://img.zsxq.com/test.jpg';
    const fakeBlob = new Blob([new Uint8Array([1,2,3,4])], { type: 'image/jpeg' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(fakeBlob),
    }));
    const html = `<img src="feishu-image://zsxq:${encodeURIComponent(url)}"/>`;
    const out = await resolveZsxqImages(html);
    expect(out).toMatch(/^<img src="data:image\/jpeg;base64,/);
    expect(out).not.toContain('feishu-image://zsxq:');
  });

  it('falls back to raw URL when L1 + L2 both fail (L3)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403 }));
    const rawUrl = 'https://img.zsxq.com/x.jpg';
    const token = `zsxq:${encodeURIComponent(rawUrl)}`;
    const html = `<img src="feishu-image://${token}"/>`;
    const out = await resolveZsxqImages(html);
    // L2 在 node 测试环境中 browser.runtime 不可用 → L3 把 token 降级为原 URL
    expect(out).toBe(`<img src="${rawUrl}"/>`);
  });
});
```

- [ ] **Step 2: 跑测试验证失败**

```bash
npx vitest run src/utils/zsxq-extractor.test.ts -t resolveZsxqImages
```

Expected: FAIL with `resolveZsxqImages is not a function`

- [ ] **Step 3: 实现 L1 + L2 fallback**

追加到 `src/utils/zsxq-extractor.ts` 顶部 import：

```ts
import browser from 'webextension-polyfill';
```

然后追加在文件末尾：

```ts
async function blobToDataUrl(blob: Blob): Promise<string> {
  // 避免 FileReader（node 测试无 jsdom）
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
  const base64 = btoa(bin);
  const mime = blob.type || 'image/png';
  return `data:${mime};base64,${base64}`;
}

async function fetchZsxqImageL1(token: string): Promise<string | null> {
  const url = decodeURIComponent(token.replace(/^zsxq:/, ''));
  try {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) {
      logger.warn(`[zsxq-img L1] HTTP ${res.status} for ${url.slice(0, 80)}`);
      return null;
    }
    const blob = await res.blob();
    return await blobToDataUrl(blob);
  } catch (err) {
    logger.warn(`[zsxq-img L1] fetch error: ${String(err)}`);
    return null;
  }
}

export async function resolveZsxqImages(html: string): Promise<string> {
  const tokenPattern = /feishu-image:\/\/(zsxq:[^"'\s>]+)/g;
  const tokens = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(html)) !== null) {
    tokens.add(match[1]);
  }
  if (tokens.size === 0) return html;

  const replacements = new Map<string, string>();

  // L1: content-script 同源 fetch
  await Promise.all(
    Array.from(tokens).map(async (token) => {
      const dataUrl = await fetchZsxqImageL1(token);
      if (dataUrl) replacements.set(token, dataUrl);
    })
  );

  // L2: 未解析的 token 走 background fetch（凭 host_permissions 跨 CORS）
  const unresolved = Array.from(tokens).filter(t => !replacements.has(t));
  if (unresolved.length > 0 && typeof browser !== 'undefined' && browser.runtime?.sendMessage) {
    const urlsToTokens = new Map<string, string>();
    for (const t of unresolved) {
      urlsToTokens.set(decodeURIComponent(t.replace(/^zsxq:/, '')), t);
    }
    try {
      const resp = await browser.runtime.sendMessage({
        action: 'fetchZsxqImagesAsBase64',
        urls: Array.from(urlsToTokens.keys()),
      }) as { success?: boolean; results?: Record<string, string> } | undefined;
      if (resp?.success && resp.results) {
        for (const [url, dataUrl] of Object.entries(resp.results)) {
          const token = urlsToTokens.get(url);
          if (token && dataUrl) replacements.set(token, dataUrl);
        }
      }
    } catch (err) {
      logger.warn(`[zsxq-img L2] error: ${String(err)}`);
    }
  }

  // 替换；未替换的保留原 feishu-image://zsxq:... 占位符（L3：保留 URL）
  let resolved = html;
  for (const [token, dataUrl] of replacements) {
    resolved = resolved.split(`feishu-image://${token}`).join(dataUrl);
  }
  // L3：仍未替换的 token 退化为原 URL（裸 src），保证 markdown 至少能加载
  resolved = resolved.replace(tokenPattern, (_m, tok) => {
    const url = decodeURIComponent(String(tok).replace(/^zsxq:/, ''));
    return url;
  });
  return resolved;
}
```

- [ ] **Step 4: 跑测试验证通过**

```bash
npx vitest run src/utils/zsxq-extractor.test.ts -t resolveZsxqImages
```

Expected: PASS（3 tests）

- [ ] **Step 5: Commit**

```bash
git add src/utils/zsxq-extractor.ts src/utils/zsxq-extractor.test.ts
git commit -m "feat(zsxq): three-level image fallback (L1 same-origin / L2 background / L3 raw URL)"
```

---

## Task 7: API 抓取 + 顶层 extractor 装配

**Files:**
- Modify: `src/utils/zsxq-extractor.ts`

- [ ] **Step 1: 实现 API 抓取**

追加到 `src/utils/zsxq-extractor.ts`：

```ts
const ZSXQ_API_BASE = 'https://api.zsxq.com';

async function fetchZsxqTopic(topicId: string): Promise<ZsxqTopic | null> {
  try {
    const res = await fetch(`${ZSXQ_API_BASE}/v2/topics/${topicId}`, { credentials: 'include' });
    if (!res.ok) {
      logger.warn(`[topic] HTTP ${res.status}`);
      return null;
    }
    const json = await res.json();
    const topic = json?.resp_data?.topic;
    if (!topic) {
      logger.warn(`[topic] unexpected response shape`);
      return null;
    }
    return topic as ZsxqTopic;
  } catch (err) {
    logger.warn(`[topic] fetch error: ${String(err)}`);
    return null;
  }
}

async function fetchZsxqAllComments(topicId: string): Promise<ZsxqComment[]> {
  const all: ZsxqComment[] = [];
  let endTime: string | undefined;
  const PAGE_CAP = 50;
  for (let i = 0; i < PAGE_CAP; i++) {
    const url = new URL(`${ZSXQ_API_BASE}/v2/topics/${topicId}/comments`);
    url.searchParams.set('count', '30');
    url.searchParams.set('sort', 'asc');
    if (endTime) url.searchParams.set('end_time', endTime);
    try {
      const res = await fetch(url.toString(), { credentials: 'include' });
      if (!res.ok) {
        logger.warn(`[comments page=${i}] HTTP ${res.status}`);
        break;
      }
      const json = await res.json();
      const page: ZsxqComment[] = json?.resp_data?.comments ?? [];
      if (page.length === 0) break;
      all.push(...page);
      if (page.length < 30) break;
      endTime = page[page.length - 1].create_time;
    } catch (err) {
      logger.warn(`[comments page=${i}] fetch error: ${String(err)}`);
      break;
    }
  }
  return all;
}
```

⚠️ Task 0 fixture 抓取时如发现 API path / 字段名与上面不符，**回到这里调整**再继续。

- [ ] **Step 2: 实现顶层 extractZsxqStructuredContent**

继续追加：

```ts
export interface ZsxqStructuredContent {
  title: string;
  author: string;
  content: string;
  wordCount: number;
}

function buildZsxqTitle(topic: ZsxqTopic): string {
  // 取正文首段前 40 字作为 title
  const body = topic.talk ?? topic.question ?? topic.task ?? topic.solution;
  const raw = body?.text ?? '';
  const plain = parseZsxqInlineText(raw).replace(/\n/g, ' ').trim();
  if (plain.length === 0) return 'zsxq 帖子';
  return plain.length > 40 ? plain.slice(0, 40) + '…' : plain;
}

function buildZsxqAuthor(topic: ZsxqTopic): string {
  const body = topic.talk ?? topic.question ?? topic.task ?? topic.solution;
  return body?.owner?.name ?? '';
}

function countZsxqWords(topic: ZsxqTopic, comments: ZsxqComment[]): number {
  const allText: string[] = [];
  for (const body of [topic.talk, topic.question, topic.answer, topic.task, topic.solution]) {
    if (body?.text) allText.push(parseZsxqInlineText(body.text));
  }
  for (const c of comments) {
    if (c.text) allText.push(parseZsxqInlineText(c.text));
  }
  return allText.join(' ').length;
}

export async function extractZsxqStructuredContent(doc: Document): Promise<ZsxqStructuredContent | null> {
  const parsed = parseZsxqUrl(doc.URL);
  if (!parsed) return null;
  // Article path TBD：Task 0 实测 article API 后再决定如何分支；
  // 当前仅实现 topic
  if (parsed.kind !== 'topic') {
    logger.warn(`[extract] article kind not yet implemented; falling back to defuddle`);
    return null;
  }

  const topic = await fetchZsxqTopic(parsed.topicId);
  if (!topic) return null;

  const commentsFlat = await fetchZsxqAllComments(parsed.topicId);
  const tree = reconstructCommentTree(commentsFlat);
  const total = topic.comments_count ?? commentsFlat.length;

  let body = renderZsxqTopicMarkdown(topic);
  let commentsMd = renderZsxqCommentTreeMarkdown(tree, total);
  const wordCount = countZsxqWords(topic, commentsFlat);

  // 把 markdown 全文（含图片占位符）走一遍 image resolver
  let content = body + commentsMd;
  content = await resolveZsxqImages(content);

  return {
    title: buildZsxqTitle(topic),
    author: buildZsxqAuthor(topic),
    content,
    wordCount,
  };
}
```

- [ ] **Step 3: 跑完整单测**

```bash
npx vitest run src/utils/zsxq-extractor.test.ts
```

Expected: 全部 PASS（Task 1-6 累计 30+ tests）

- [ ] **Step 4: Commit**

```bash
git add src/utils/zsxq-extractor.ts
git commit -m "feat(zsxq): top-level extractor — fetch topic + comments, render to markdown"
```

---

## Task 8: manifest host_permissions（三浏览器同步）

**Files:**
- Modify: `src/manifest.chrome.json`
- Modify: `src/manifest.firefox.json`
- Modify: `src/manifest.safari.json`

- [ ] **Step 1: 加 api.zsxq.com + 图床域到 chrome manifest**

Modify `src/manifest.chrome.json` 的 `host_permissions` 数组（原为 `["<all_urls>", "http://*/*", "https://*/*", "https://scys.com/*", "https://*.aliyuncs.com/*"]`）：

```json
"host_permissions": [
  "<all_urls>",
  "http://*/*",
  "https://*/*",
  "https://scys.com/*",
  "https://*.aliyuncs.com/*",
  "https://api.zsxq.com/*",
  "https://images.zsxq.com/*"
]
```

⚠️ Task 0 实测确认 zsxq 实际图床域名（可能是 `*.zsxq.com` / 腾讯 COS `*.myqcloud.com` / 其他），如不是 `images.zsxq.com` 则用实测值替换。

- [ ] **Step 2: firefox + safari manifest 同步**

`src/manifest.firefox.json` 与 `src/manifest.safari.json` 的 `host_permissions` 同样追加两行（`api.zsxq.com` + 图床域）。

- [ ] **Step 3: 验证 manifest 仍是有效 JSON**

```bash
for f in src/manifest.chrome.json src/manifest.firefox.json src/manifest.safari.json; do
  echo "=== $f ==="
  python3 -c "import json,sys; json.load(open('$f'))" && echo OK
done
```

Expected：三行 `=== file ===` + 三行 `OK`

- [ ] **Step 4: Commit**

```bash
git add src/manifest.chrome.json src/manifest.firefox.json src/manifest.safari.json
git commit -m "feat(zsxq): grant host_permissions for api.zsxq.com + image CDN"
```

---

## Task 9: content.ts 接入 + page-world test bridge 扩展

**Files:**
- Modify: `src/content.ts`

- [ ] **Step 1: 加 import**

在 `src/content.ts` line 16（既有 scys import 后）添加：

```ts
import { extractZsxqStructuredContent, isZsxqTopicUrl, isZsxqArticleUrl } from './utils/zsxq-extractor';
```

- [ ] **Step 2: 加 zsxq 分支到主路径（line ~277）**

在 `const scysContent = ...` 之后并列添加：

```ts
const zsxqContent = (isZsxqTopicUrl(document.URL) || isZsxqArticleUrl(document.URL))
  ? await extractZsxqStructuredContent(document).catch((error) => {
      contentLogger.warn('Failed to extract zsxq structured content', { error: String(error) });
      return null;
    })
  : null;
```

- [ ] **Step 3: 合并到 ContentResponse（line ~354）**

把 response 对象的对应行改为：

```ts
author: bilibiliContent?.author || feishuContent?.author || scysContent?.author || zsxqContent?.author || defuddled.author,
content: bilibiliContent?.structuredHtml || feishuContent?.content || scysContent?.content || zsxqContent?.content || weChatArticleContent || defuddled.content,
// ...
site: bilibiliContent ? 'Bilibili' : feishuContent ? 'Feishu' : scysContent ? 'Scys' : zsxqContent ? 'ZSXQ' : defuddled.site,
title: bilibiliContent?.title || feishuContent?.title || scysContent?.title || zsxqContent?.title || defuddled.title,
wordCount: bilibiliContent?.wordCount || feishuContent?.wordCount || scysContent?.wordCount || zsxqContent?.wordCount || defuddled.wordCount,
```

description 行保持不变（Defuddle 兜底；专项提取器目前都不返回 description）。

- [ ] **Step 4: 扩展 page-world test bridge（line ~620）**

`src/content.ts` 当前 line 620 `if (!/feishu\.cn$|larksuite\.com$|^scys\.com$/.test(origin)) return;` 改为：

```ts
if (!/feishu\.cn$|larksuite\.com$|^scys\.com$|wx\.zsxq\.com$/.test(origin)) return;
```

line 626-638 的路由逻辑改为加 zsxq 分支：

```ts
// Route by URL: scys.com → scys-extractor; feishu/lark → feishu-extractor; wx.zsxq.com → zsxq-extractor.
let result: { title?: string; content?: string } | null = null;
let source: 'scys' | 'feishu' | 'zsxq' | null = null;
if (isScysCourseUrl(document.URL) || isScysDocxUrl(document.URL) || isScysArticleUrl(document.URL)) {
  result = await extractScysStructuredContent(document);
  source = 'scys';
} else if (isFeishuDocUrl(document.URL)) {
  result = await extractFeishuStructuredContent(document);
  source = 'feishu';
} else if (isZsxqTopicUrl(document.URL) || isZsxqArticleUrl(document.URL)) {
  result = await extractZsxqStructuredContent(document);
  source = 'zsxq';
} else {
  localStorage.setItem(key, JSON.stringify({ status: 'error', error: 'unsupported url for bridge' }));
  return;
}
```

line ~667 `site:` 的三目改为加 zsxq 分支：

```ts
site: source === 'scys' ? 'Scys' : source === 'feishu' ? 'Feishu' : source === 'zsxq' ? 'ZSXQ' : '',
```

- [ ] **Step 5: 重新 build dev 版**

```bash
npm run dev:chrome &
DEV_PID=$!
sleep 8
kill $DEV_PID 2>/dev/null
ls -la dist/content.js dist/background.js | awk '{print $9, $5}'
```

Expected：两个文件存在且大小 > 100KB

- [ ] **Step 6: Commit**

```bash
git add src/content.ts
git commit -m "feat(zsxq): wire zsxq extractor into content.ts dispatch and page-world test bridge"
```

---

## Task 10: 端到端自动化迭代回路（验收）

**Files:**
- Read: `src/utils/fixtures/zsxq-topic-185414442218552.json`
- Read: `src/utils/fixtures/zsxq-comments-185414442218552.json`
- Write: `/tmp/zsxq-bridge-result.json`（每轮迭代覆盖）

**前提**：
- `npm run dev:chrome` 在 watch；扩展已加载 dist/；wx.zsxq.com 已登录
- claude-in-chrome MCP 可用
- Task 8 manifest 已 reload（dev 自动）

**自动化每轮迭代序列**：build → navigate → bridge trigger → poll localStorage → upload result → diff against fixture → 不通过 → 改 zsxq-extractor → 重 build

- [ ] **Step 1: 启动 receiver 接收 bridge 输出**

```bash
mkdir -p /tmp/zsxq-iter
lsof -i:17924 -t 2>/dev/null | xargs -r kill -9 2>/dev/null
nohup python3 /tmp/recv_server.py "/tmp/zsxq-iter/result.json" 17924 > /tmp/recv-zsxq-iter.log 2>&1 < /dev/null &
disown
sleep 0.5
```

- [ ] **Step 2: 在 wx.zsxq.com 触发 bridge**

用 claude-in-chrome 找到（或新建）`wx.zsxq.com/group/1824528822/topic/185414442218552` 这个 tab，在 page world 跑：

```js
(async () => {
  const testId = 'zsxq-iter-' + Date.now();
  const key = '__obsidianClipperTestResult__:' + testId;
  window.postMessage({ type: '__obsidianClipperTestExtract__', testId }, '*');
  // poll up to 30s
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 500));
    const raw = localStorage.getItem(key);
    if (!raw) continue;
    const r = JSON.parse(raw);
    if (r.status === 'running') continue;
    // upload
    await fetch('http://127.0.0.1:17924/', { method: 'POST', body: JSON.stringify(r, null, 2) });
    localStorage.removeItem(key);
    return 'done: ' + r.status;
  }
  return 'timeout';
})();
```

Expected: `"done: complete"`（或类似——具体看 `src/content.ts` line ~700 写入的 status 值；如不匹配，按实际值调整）

- [ ] **Step 3: 读取 bridge 输出 + 跑验收脚本**

```bash
ls -la /tmp/zsxq-iter/result.json
jq '. | {status, title, popupMatchesBridge, hasComments: (.popupMarkdown // .markdown | contains("💬 全部评论"))}' /tmp/zsxq-iter/result.json
```

Expected：
- `status` 非 error
- `title` 非空、不等于"知识星球 \| 深度连接铁杆粉丝…"
- `popupMatchesBridge: true`（确保 content.ts 接入正确）
- `hasComments: true`

- [ ] **Step 4: 跑验收清单脚本**

Create `scripts/zsxq-verify.py`：

```python
#!/usr/bin/env python3
"""Verify zsxq clipped markdown against API fixtures."""
import json, re, sys
from pathlib import Path

RESULT = Path('/tmp/zsxq-iter/result.json')
TOPIC_FIXTURE = Path('src/utils/fixtures/zsxq-topic-185414442218552.json')
COMMENTS_FIXTURE = Path('src/utils/fixtures/zsxq-comments-185414442218552.json')

def main():
    r = json.loads(RESULT.read_text())
    md = r.get('popupMarkdown') or r.get('markdown') or ''
    topic = json.loads(TOPIC_FIXTURE.read_text())['resp_data']['topic']
    comments = json.loads(COMMENTS_FIXTURE.read_text())['resp_data']['comments']

    checks = []
    # 1. title 非空且不是站点 title
    title = r.get('title', '')
    checks.append(('title_present', bool(title) and '深度连接铁杆粉丝' not in title))
    # 2. 评论区头部存在
    checks.append(('comments_header', f"## 💬 全部评论（{topic.get('comments_count', len(comments))} 条）" in md))
    # 3. 至少一条评论的用户名出现
    if comments:
        first_author = comments[0].get('owner', {}).get('name', '')
        if first_author:
            checks.append(('first_comment_author', first_author in md))
    # 4. 图片占位符已全部 resolve（无残留 feishu-image:// 或 zsxq:）
    checks.append(('no_image_placeholder', 'feishu-image://' not in md and 'zsxq:' not in md))
    # 5. 嵌套回复至少 1 处（>>> 形态）
    has_nested = bool(re.search(r'^> >', md, re.MULTILINE))
    checks.append(('has_nested_reply', has_nested))
    # 6. 正文文字长度合理
    body_end = md.find('## 💬 全部评论')
    body = md[:body_end] if body_end > 0 else md
    checks.append(('body_length_ok', len(body) >= 100))
    # 7. 评论数 >= API comments_count
    rendered_comments = len(re.findall(r'^> \[!quote\]\+', md, re.MULTILINE))
    expected = topic.get('comments_count', len(comments))
    # 允许 ±5% 误差（API 偶尔有删评论）
    checks.append(('comment_count_ok', rendered_comments >= max(1, int(expected * 0.95))))

    passed = sum(1 for _, ok in checks if ok)
    print(f"\n{'='*50}\nVerification: {passed}/{len(checks)} passed\n{'='*50}\n")
    for name, ok in checks:
        print(f"  [{'✓' if ok else '✗'}] {name}")

    if passed < len(checks):
        sys.exit(1)
    print("\n✓ All checks passed")

if __name__ == '__main__':
    main()
```

```bash
chmod +x scripts/zsxq-verify.py
python3 scripts/zsxq-verify.py
```

Expected：`✓ All checks passed`

- [ ] **Step 5: 迭代——失败则定位**

如果 Step 4 有 ✗：
- `title_present` 失败 → 检查 `extractZsxqStructuredContent` 是否被调用：在 chrome devtools 看 content.ts 日志 `[zsxq-extractor]`。如果根本没触发，回 Task 9 检查 import / 分支
- `comments_header` 失败 → 检查 `renderZsxqCommentTreeMarkdown` 输出是否被 popupMarkdown 路径吃掉
- `no_image_placeholder` 失败 → L1 + L2 都失败，查 chrome console 看 `[zsxq-img L1]` / `[zsxq-img L2]` warn 日志；如是 CORS 错误，去 Task 8 加图床域到 host_permissions
- `has_nested_reply` 失败 → 检查评论 fixture 中是否真有嵌套（jq）；若有，检查 `reconstructCommentTree` 的 parent 字段名是否对
- `comment_count_ok` 失败 → 检查 `fetchZsxqAllComments` 的分页参数；可能是 `end_time` 字段格式错

每次改完代码 → webpack watch 会自动 rebuild → 等 3 秒 → 回 Step 2 重跑。

- [ ] **Step 6: 5 次连跑稳定性验证**

成功一次后，连跑 5 次（每轮重新 navigate + bridge），全部通过才算稳定：

```bash
for i in 1 2 3 4 5; do
  echo "=== Run $i ==="
  # 启动 receiver
  lsof -i:17924 -t 2>/dev/null | xargs -r kill -9 2>/dev/null
  nohup python3 /tmp/recv_server.py "/tmp/zsxq-iter/result.json" 17924 > /dev/null 2>&1 < /dev/null & disown
  sleep 0.5
  # 此处用 claude-in-chrome MCP 跑 Step 2 的 JS（每轮新 testId）
  echo "TODO: run bridge JS via mcp"
  sleep 2
  python3 scripts/zsxq-verify.py || { echo "FAIL on run $i"; exit 1; }
done
```

实际操作时由 Agent 用 `mcp__claude-in-chrome__javascript_tool` 反复触发，每轮验证；这里 bash 脚本仅作 scaffold。

- [ ] **Step 7: Commit verify script**

```bash
git add scripts/zsxq-verify.py
git commit -m "test(zsxq): add e2e verification script comparing clipped md vs API fixture"
```

- [ ] **Step 8: 全量 build + 跑全部测试（确认无回归）**

```bash
npm test
npm run build:chrome
```

Expected：
- `npm test`：所有 vitest tests PASS（zsxq-extractor 新增 30+ tests 不破坏既有 scys/feishu/bilibili 测试）
- `npm run build:chrome`：产出 `dist/` + `builds/*.zip`，无错误

- [ ] **Step 9: 最终 commit**

```bash
git status  # 检查无残留改动
git log --oneline -10  # 检查 commit 历史清晰
```

Expected：从 Task 1 开始约 10 个 commits，最后一个是 Task 7 的 verify script。如发现还有未 commit 的 zsxq-extractor 改动（迭代时手动修复的），用一个收尾 commit：

```bash
git add -A
git commit -m "fix(zsxq): final iteration adjustments for end-to-end stability"
```

---

## 完成判定

满足以下全部条件后视为 plan 完成：

- [ ] `npx vitest run src/utils/zsxq-extractor.test.ts` 全 PASS（>= 30 tests）
- [ ] `npm test` 全仓库无回归
- [ ] `npm run build:chrome` 成功产出 dist/
- [ ] `python3 scripts/zsxq-verify.py` 连续 5 次通过
- [ ] Spec §5.3 验收清单全部勾选（图片 base64、评论嵌套、`<e>` 标签解析、title 正确等）
- [ ] 同测试 URL 在浏览器手动按扩展图标也能裁剪出与 bridge 输出一致的 .md 文件到 Obsidian

---

## 故障排除速查

| 现象 | 排查 |
|---|---|
| Task 0 Step 3 `fetch` 返回 401 / "succeeded:false" | zsxq 校验签名头；走 Task 0 Step 6 抓签名 → 改 `fetchZsxqTopic` 用 background fetch + declarativeNetRequest 注入头 |
| Task 0 fetch 返回 CORS error | content-script 跨 origin 被拦；改在 `api.zsxq.com` origin 内直接跑（先 navigate 到 `https://api.zsxq.com/v2/topics/{id}` ——但通常不行），或改 background fetch |
| 评论 fixture 拿到一半就停 | 分页参数 `end_time` 格式不对；改用 `index` / `page` 参数（看 fixture 中第一页末尾响应里 SPA 自身发的下一页请求 URL） |
| `reconstructCommentTree` fixture 测试节点丢失 | 字段不叫 `parent_comment_id`；jq 看实际字段名 |
| Task 10 Step 4 `comments_header` 失败但 zsxq-extractor 单测全过 | content.ts 的 buildVariables 路径覆盖了 content；检查 §S6 的 `popupMatchesBridge: true` 是否真的 true |
| Task 10 图片占位符残留 | L1 失败（CORS 或登录失效）+ L2 失败（host_permissions 没加图床域）；先在 chrome devtools network 看 `img.zsxq.com` 请求实际状态 |

---

## YAGNI 边界（明确不做）

- ❌ 文件实际下载（仅 markdown 链接）
- ❌ Article 路径正文渲染（Task 7 Step 2 当前 return null 退化到 Defuddle，Task 0 实测 article API 后另开 plan 补完）
- ❌ Safari/Firefox 验证（先在 Chrome 验证；Safari/Firefox 留到回归测试）
- ❌ 评论作者头像 / 「赞过的人」列表 / 精华标记
- ❌ topic 内嵌视频提取
