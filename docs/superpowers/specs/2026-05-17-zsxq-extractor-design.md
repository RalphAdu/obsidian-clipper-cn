# 知识星球（zsxq.com）专项提取器 设计文档

**日期**：2026-05-17
**目标**：在剪存 `wx.zsxq.com` 的 topic 详情页与专栏文章页时，调用 zsxq 后端 JSON API 拿到 topic / comments 结构化数据，渲染为语义完整的 Markdown：正文文字、@/#/emoji 内嵌符号、图片 base64 内嵌、评论与全部嵌套回复以 Obsidian callout 形式追加。

## 1. 问题陈述

测试 URL：`https://wx.zsxq.com/group/1824528822/topic/185414442218552`

当前（无 zsxq 专项提取器，走通用 Defuddle 流水线）的保存结果存在以下问题：

| 类别 | 浏览器渲染 | 当前 md 输出 | 原因 |
|---|---|---|---|
| 正文 | topic 完整文字 | **几乎空白**（仅有应用骨架文字 / 登录提示） | `wx.zsxq.com` 是纯 SPA，正文由 XHR 拉 JSON 后由 JS 注入，Defuddle 解析 SSR HTML 时正文 DOM 还不存在 |
| 评论 | 全部主评论 + 嵌套回复 | 完全缺失 | 同上，且评论 API 分页 |
| 图片 | CDN URL 加载正常 | 即便侥幸抓到 URL，zsxq 图床为临时签名 URL（约 1-2h 过期），落入 Obsidian 后无 Referer/cookie 加载失败 | 通用流水线不做图片下载 |
| 内嵌 `<e>` 标签（hashtag/mention/emoji） | 渲染为 `#话题#`/`@用户`/表情字符 | 即便 SPA 渲染完成，`<e>` 内嵌标签的语义在通用流水线里会被压成纯文本失序 | Defuddle 无 zsxq 自定义标签知识 |
| frontmatter `title` | topic 首句或自动摘要 | 错误抓到「知识星球 \| 深度连接铁杆粉丝…」（站点宣传 title） | 同上 |

## 2. 设计概览

**关键思路**：写 `zsxq-extractor.ts`，负责 (1) URL 触发判定、(2) 调 `api.zsxq.com` JSON 接口、(3) 把 zsxq 自定义 `<e>` 内嵌标签转 markdown 文本、(4) 重建评论树、(5) 图片三级 fallback 下载。**不复用** feishu/scys 的 block 渲染器（zsxq 是 type-tag 而非 block-tree 结构），但**复用** scys 的图片下载与评论 callout 渲染形态。

```
content.ts 触发裁剪
  ↓ isZsxqTopicUrl(url) || isZsxqArticleUrl(url) === true
zsxq-extractor.extractZsxqStructuredContent(doc)
  ├─ parseZsxqUrl(url) → { groupId, topicId | articleId, kind: 'topic' | 'article' }
  ├─ fetchZsxqTopic(topicId) | fetchZsxqArticle(...)
  │   └─ 同源 fetch(api.zsxq.com/..., { credentials: 'include' })
  ├─ renderZsxqTopicMarkdown(topic) → 正文 markdown
  │   ├─ parseZsxqInlineText(html) → markdown（处理 <e type="hashtag|mention|emoji"/>、<br>、原生段落）
  │   ├─ renderTopicImages(topic.images) → 图片占位
  │   └─ renderTopicFiles(topic.files) → 文件列表
  ├─ fetchZsxqAllComments(topicId) → 扁平 Comment[]（跨页累积）
  ├─ reconstructCommentTree(comments) → CommentNode[]（按 repliee 重建父子）
  ├─ renderCommentTreeMarkdown(tree) → 评论区 markdown（callout 嵌套）
  ├─ resolveZsxqImages(html) → 三级 fallback：L1 同源 fetch / L2 background 凭 host_permissions 跨域 / L3 保留 URL
  └─ return { title, author, content: 正文 + 评论区, wordCount, description: '' }
  ↓ ZsxqStructuredContent
content.ts 合并到 response（与 feishuContent / scysContent / bilibiliContent 同模式）
  ↓
template renderer → obsidian-note-creator → Obsidian
```

## 3. 详细设计

### 3.1 触发判定

```ts
export function isZsxqTopicUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'wx.zsxq.com') return false;
    return /^\/group\/\d+\/topic\/\d+\/?$/.test(parsed.pathname);
  } catch {
    return false;
  }
}

export function isZsxqArticleUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'wx.zsxq.com') return false;
    return /^\/group\/\d+\/article\/\d+\/?$/.test(parsed.pathname);
  } catch {
    return false;
  }
}
```

其他 zsxq 页面（小组首页 `/group/{gid}/`、用户主页、文件库）→ 返回 false → 走通用 Defuddle 流水线，零干扰。

### 3.2 URL 解析

```ts
export function parseZsxqUrl(url: string):
  | { kind: 'topic'; groupId: string; topicId: string }
  | { kind: 'article'; groupId: string; articleId: string }
  | null
```

### 3.3 API 调用与鉴权

**主路径（content script 同源 fetch）**：

```ts
async function fetchZsxqTopic(topicId: string): Promise<ZsxqTopic | null> {
  const resp = await fetch(`https://api.zsxq.com/v2/topics/${topicId}`, {
    credentials: 'include',
  });
  if (!resp.ok) return null;
  const json = await resp.json();
  return json.resp_data?.topic ?? null;
}
```

**预期 API 路径**（实施第一步先用浏览器 devtools 实测确认；如与预期不符调整）：

| 目的 | 预测路径 | 备注 |
|---|---|---|
| topic 详情 | `GET /v2/topics/{topicId}` | |
| topic 评论分页 | `GET /v2/topics/{topicId}/comments?count=30&sort=asc` | `count`/`sort`/`end_time` 参数 |
| article 详情 | `GET /v2/groups/{groupId}/topics/{articleId}` 或 `/v2/articles/{articleId}` | 实施时实测确认 |

**关键不确定点**：zsxq 是否对 API 请求校验自定义签名头（如 `x-request-id` / `x-signature` / `x-timestamp`）。两种情况的应对：

- **不需要签名**：content script 直接 `fetch(..., { credentials: 'include' })` 即可（content_scripts 跨 origin 调 api.zsxq.com 时浏览器自动带 Cookie，前提是该 Cookie 是 `SameSite=None; Secure`，由 zsxq 服务端决定）。
- **需要签名**：降级到 **background fetch**，三份 manifest 的 `host_permissions` 添加 `https://api.zsxq.com/*`，让 background 凭扩展身份发请求绕开 CORS。鉴权头由扩展从已捕获的请求里复用，或通过 `chrome.scripting.executeScript({ world: 'MAIN' })` 在页面 runtime 内调 zsxq SPA 自带的 fetch 包装函数（已含签名）——若 zsxq 把 fetch 客户端挂载在全局变量上则可用，否则改抓 Cookie + 手动签名（最坏情况）。

**实施第一步固化此选择**：浏览器 DevTools 抓包看 1 次实际请求头是否含 `x-xxx` 自定义头。

**失败兜底**：`fetchZsxqTopic` 抛错或返回 null → `extractZsxqStructuredContent` 返回 null → content.ts 用 `??` 兜底走 Defuddle 路径（等价于当前行为，零退化）。

### 3.4 Topic JSON 结构（实测前的预期，第一步要 fixture 校准）

```ts
interface ZsxqTopic {
  topic_id: number;
  type: 'talk' | 'q&a' | 'task' | 'solution';
  group: { group_id: number; name: string };
  create_time: string; // ISO8601
  talk?: {
    owner: { user_id: number; name: string; avatar_url: string };
    text: string;             // 含 <e ... /> 内嵌标签、<br>、原生换行
    images?: ZsxqImage[];
    files?: ZsxqFile[];
    article?: { title: string; article_url: string };
  };
  question?: { owner: ZsxqUser; text: string; images?: ZsxqImage[] };
  answer?:   { owner: ZsxqUser; text: string; images?: ZsxqImage[] };
  task?: { owner: ZsxqUser; text: string; images?: ZsxqImage[] };
  // ... 其他字段
  likes_count: number;
  comments_count: number;
}

interface ZsxqImage {
  image_id: number;
  thumbnail: { url: string; width: number; height: number };
  large:     { url: string; width: number; height: number };
  original?: { url: string; width: number; height: number };
}

interface ZsxqFile {
  file_id: number;
  name: string;
  size: number;
  download_url: string;
}
```

### 3.5 内嵌标签解析 `parseZsxqInlineText(html: string): string`

zsxq 的 `text` 字段不是纯文本，含三类自定义内嵌标签：

| 标签 | 例 | markdown 输出 |
|---|---|---|
| hashtag | `<e type="hashtag" hid="123" title="%23AI%20Tools%23"/>` | `#AI Tools#`（hid 丢弃；title 是 URL-encoded） |
| mention | `<e type="mention" uid="567" title="%40陈大"/>` | `@陈大` |
| emoji | `<e type="emoji" title="%F0%9F%98%80"/>` 或 `<e type="emoji" eid="..."/>` | `😀`（解码 title 即可；eid 形式查表回退到 `[表情]`） |
| web | `<e type="web" href="..." title="..."/>` | `[title](href)` |

实现：
```ts
function parseZsxqInlineText(html: string): string {
  // 1. <e .../> → 对应 markdown 文本
  // 2. <br> / <br/> → \n
  // 3. 其他原生 HTML 字符实体解码
  // 4. 用 DOMParser 解析，遍历节点流，按规则替换
}
```

测试用合成 fixture 覆盖每种标签 + 混合场景。

### 3.6 Markdown 正文渲染 `renderZsxqTopicMarkdown(topic): string`

| topic.type | 输出形态 |
|---|---|
| `talk` | `talk.text` 解析后追加图片 + 文件列表 + 关联 article |
| `q&a` | `**🙋 提问**`（question.owner.name）正文 → `**💡 回答**` 正文 |
| `task` | 同 talk |
| `solution` | 同 talk，可能含「针对：{原 task 链接}」头 |

图片用 `<img alt="{image_id}" src="zsxq:{encodeURIComponent(large.url)}"/>` 占位符（与 scys `scys:` 前缀同思路），由 `resolveZsxqImages` 阶段替换为 base64。

文件以 markdown 列表呈现 `- 📎 [{name}]({download_url})`，**不**下载（YAGNI）。

### 3.7 评论树重建与渲染

**API 形态预期**（实施第一步确认）：评论分页接口返回**扁平数组 + repliee 字段**指父：

```ts
interface ZsxqComment {
  comment_id: number;
  text: string;
  owner: { user_id: number; name: string };
  repliee?: { user_id: number; name: string };  // 仅一级回复指向主评论的被回复人
  parent_comment_id?: number;                    // 关键：实测确认这个字段
  create_time: string;
  likes_count: number;
  images?: ZsxqImage[];
}
```

如果 `parent_comment_id` 字段不存在，zsxq 可能用其他方式表达父子关系（实测时确认；若 API 只给一级深度的 repliee.user_id，可能要按时间+用户名启发式重建——但实测概率小）。

**分页抓全**：

```ts
async function fetchZsxqAllComments(topicId: string): Promise<ZsxqComment[]> {
  const all: ZsxqComment[] = [];
  let endTime: string | undefined;
  for (let i = 0; i < 50; i++) {  // 上限 50 次 = 1500 条评论硬上限
    const url = new URL(`https://api.zsxq.com/v2/topics/${topicId}/comments`);
    url.searchParams.set('count', '30');
    url.searchParams.set('sort', 'asc');
    if (endTime) url.searchParams.set('end_time', endTime);
    const resp = await fetch(url.toString(), { credentials: 'include' });
    if (!resp.ok) break;
    const json = await resp.json();
    const page: ZsxqComment[] = json.resp_data?.comments ?? [];
    if (page.length === 0) break;
    all.push(...page);
    endTime = page[page.length - 1].create_time;
    if (page.length < 30) break;
  }
  return all;
}
```

**树重建**：

```ts
interface ZsxqCommentNode extends ZsxqComment { replies: ZsxqCommentNode[] }
function reconstructCommentTree(flat: ZsxqComment[]): ZsxqCommentNode[] {
  const byId = new Map<number, ZsxqCommentNode>();
  for (const c of flat) byId.set(c.comment_id, { ...c, replies: [] });
  const roots: ZsxqCommentNode[] = [];
  for (const node of byId.values()) {
    const parent = node.parent_comment_id ? byId.get(node.parent_comment_id) : undefined;
    if (parent) parent.replies.push(node);
    else roots.push(node);
  }
  return roots;
}
```

**Markdown 输出**（沿用 scys §3.8）：

```markdown
---

## 💬 全部评论（70 条）

> [!quote]+ **叁斤** · 9 ❤️ · 2026-05-10
> 评论正文（已 parseZsxqInlineText）
>
> > **杨树亮** · 2 ❤️ · 2026-05-11
> > 一级回复正文
> >
> > > **Gaby** · 2026-05-12
> > > 二级回复正文
>
> > **飞鱼** · 1 ❤️ · 2026-05-11
> > 另一条一级回复
```

实现 `renderCommentNode(node, depth)` 递归，depth 控制 `>` 前缀数量。

### 3.8 图片三级 fallback

完全复用 scys §3.5 设计：

| 层级 | 上下文 | 操作 |
|---|---|---|
| L1 | content script | `fetch(url, { credentials: 'include' })` → blob → base64 |
| L2 | background（凭 host_permissions） | `fetch(url)` 在 service worker 上下文，绕过 page CORS |
| L3 | — | 保留原 URL（与不做提取等价，不退化） |

复用 scys 已有的 `resolveScysImages` 形态，函数名改为 `resolveZsxqImages`，识别 `zsxq:` 前缀的 token。

host_permissions 实施时按实测的图床域名加入；预测是 `https://images.zsxq.com/*` 或 `https://*.zsxq.com/*`，可能还有腾讯 COS 中转 `https://*.myqcloud.com/*`。

### 3.9 元数据契约

| 字段 | 来源 | 失败兜底 |
|---|---|---|
| `title` | topic 首段前 40 字 + 省略号；专栏 article 用 `article.title` | `doc.title` |
| `author` | `topic.talk.owner.name`（或 `question.owner.name`） | 空字符串 |
| `content` | `renderZsxqTopicMarkdown` + 评论区拼接 | — |
| `wordCount` | 正文（去 `<e>` 后）+ 评论纯文本拼接后 split 字数 | 0 |
| `description` | 显式空串（覆盖 Defuddle 抓到的「知识星球｜深度连接铁杆粉丝…」） | — |

### 3.10 接入点

`src/content.ts` line ~277 在 scysContent 分支后并列添加：

```ts
const zsxqContent = (isZsxqTopicUrl(document.URL) || isZsxqArticleUrl(document.URL))
  ? await extractZsxqStructuredContent(document).catch((error) => {
      contentLogger.warn('Failed to extract zsxq structured content', { error: String(error) });
      return null;
    })
  : null;
```

`response` 对象的合并行（line ~354-370）追加 `?? zsxqContent?.{title,author,content,wordCount}`，`site` 增加 `zsxqContent ? 'ZSXQ' : ...`，`description` 在 zsxqContent 存在时强制为 `''`。

## 4. 标题层级映射

zsxq topic 通常是单段叙事文，**没有内嵌标题**。设计上：

- frontmatter `title` 用 topic 首段截断
- content 不输出 `# 标题`，直接从段落开始；评论区以 `## 💬 全部评论（N 条）` 起头

专栏文章 (`/article/`) 可能含 markdown 标题（待第一步实测的 API response 确认）；若有则按其 markdown 原样传递。

## 5. 测试策略

### 5.1 单元测试 `src/utils/zsxq-extractor.test.ts`

- `isZsxqTopicUrl` / `isZsxqArticleUrl`：正反例
- `parseZsxqUrl`：三种 URL 形态
- `parseZsxqInlineText`：covering hashtag/mention/emoji/web/原生 br/嵌套
- `reconstructCommentTree`：扁平 → 树（含多层嵌套、孤儿评论、空数组、循环引用防护）
- **Fixture 集成测试**：保存第一步实测得到的 API 响应到
  - `src/utils/fixtures/zsxq-topic-185414442218552.json`
  - `src/utils/fixtures/zsxq-comments-185414442218552.json`
  
  跑 `renderZsxqTopicMarkdown + renderCommentTreeMarkdown` 输出，断言含全部主评论用户名、所有嵌套层级、所有图片占位
- `resolveZsxqImages`：mock fetch，断言 `zsxq:`-prefixed token 被替换为 base64
- 失败路径：API 抛错 → `extractZsxqStructuredContent` 返回 null；评论 API 失败时正文仍能返回（评论与正文解耦）

### 5.2 端到端自动化迭代回路（用户核心要求）

新建 `scripts/zsxq-clip-loop.sh`（仅本地用）。单轮迭代序列：

1. `npm run build:chrome` → `dist/`
2. dev `build-marker` 机制自动 reload 扩展（参 BACKLOG §2.7）
3. `claude-in-chrome` navigate 到测试 URL，等 DOM ready
4. 触发裁剪（命令快捷键 / 手动按图标）
5. 等 `obsidian://` 协议写入笔记文件
6. Read 生成的 .md
7. 跑断言脚本对比浏览器 API 真值 vs md
8. 有差异 → 改 zsxq-extractor → 回 1；全 pass → 停

### 5.3 验收清单（停止迭代条件）

- [ ] frontmatter `title` 非空、非站点默认 title、≈ topic 首段截断
- [ ] frontmatter `author` = topic.talk.owner.name
- [ ] frontmatter `description` = 空
- [ ] 正文文字字符数 vs API `topic.talk.text` 解 `<e>` 后纯文本字符数差距 < 2%
- [ ] 所有 hashtag `<e>` 渲染为 `#话题#`
- [ ] 所有 mention `<e>` 渲染为 `@用户`
- [ ] 所有 emoji `<e>` 渲染为表情字符
- [ ] 所有正文图片为 `data:image/...;base64,...`（无 zsxq CDN URL 残留）
- [ ] 所有附件文件为 `📎 [{name}]({download_url})` 列表项
- [ ] 评论区以 `## 💬 全部评论（X 条）` 起头，X = `topic.comments_count`
- [ ] 抓取到的评论数 = `topic.comments_count`（分页抓全）
- [ ] 嵌套回复保留所有层级（`> > ` / `> > > ` 等）
- [ ] 每条评论 callout 行含 owner.name + 点赞数（>0 时）+ 日期
- [ ] 评论内图片为 base64（与正文图片同处理）
- [ ] 评论内 `<e>` 标签同样转 markdown 文本
- [ ] 测试 URL 跑 5 次结果稳定（无随机失败）

## 6. 文件清单

| 操作 | 路径 |
|---|---|
| 新建 | `src/utils/zsxq-extractor.ts` |
| 新建 | `src/utils/zsxq-extractor.test.ts` |
| 新建 | `src/utils/fixtures/zsxq-topic-185414442218552.json` |
| 新建 | `src/utils/fixtures/zsxq-comments-185414442218552.json` |
| 修改 | `src/content.ts`（line ~277 加 zsxq 分支） |
| 修改 | `src/manifest.chrome.json`（host_permissions 加 `api.zsxq.com` + 图床域） |
| 修改 | `src/manifest.firefox.json`（同上） |
| 修改 | `src/manifest.safari.json`（同上） |
| 可能修改 | `src/background.ts`（若需 background fetch 降级，添加 `fetchZsxqApi` / `fetchZsxqImageAsBase64` action handler） |
| 新建 | `scripts/zsxq-clip-loop.sh`（端到端迭代脚本） |

## 7. 实现顺序（6 步交付）

1. **抓 API 真值**：浏览器 DevTools 抓 1 次实际请求，把 topic + comments 响应保存为 fixture；同时确认是否需要签名头、图床域名
2. **基础骨架**：`isZsxqTopicUrl` / `isZsxqArticleUrl` / `parseZsxqUrl` + 单测
3. **内嵌标签解析与正文渲染**：`parseZsxqInlineText` + `renderZsxqTopicMarkdown`，fixture 测试覆盖 talk/q&a 两种 type
4. **评论分页 + 树重建 + callout 渲染**：`fetchZsxqAllComments` + `reconstructCommentTree` + `renderCommentTreeMarkdown` + fixture 测试
5. **图片 L1**：content-script 同源 fetch；接 `resolveZsxqImages`
6. **接入 + 自动化迭代闭环**：`content.ts` 加分支，dev build，跑 §5.3 验收清单直至全 pass；过程中遇 CORS 拦截再补 L2

## 8. 风险与回滚

| 风险 | 影响 | 缓解 |
|---|---|---|
| zsxq API 需要自定义签名头 | content-script fetch 401 | 降级 background fetch + `host_permissions: api.zsxq.com`；若签名仍卡 → `executeScript MAIN world` 调用 SPA 自带 fetch 包装函数 |
| 评论 API 字段名与预期不符（如 `parent_comment_id` 不存在） | 评论树重建失败 | 第一步抓 fixture 时立即修正预期；最坏情况按时间+用户名启发式重建 |
| 图片 CDN CORS 拦截 | 图片 base64 失败 | L1→L2→L3 三级 fallback；L3 = 保留 URL（24h 内有效） |
| 未登录访问 | API 401 | 返回 null → 回退 Defuddle，不阻塞 |
| zsxq 改 API 路径或字段名 | 提取失败 | API 失败回退 Defuddle，不退化于当前；warn 日志 |
| topic.type 出现新值（如 question_summary） | 该 topic 渲染空 | `renderZsxqTopicMarkdown` 的 default 分支输出 raw text + warn |
| Safari/Firefox 行为差异 | 跨浏览器构建失败 | 最后一步统一跑 `npm test` + `npm run build` |
| 误触发非 topic/article 页 | 干扰其他子页 | `isZsxqTopicUrl`/`isZsxqArticleUrl` 严格匹配 |
| 评论数极多（>1500） | 多页串行 API 调用慢 | 上限 50 次循环（30 条/页 = 1500 条硬上限）；超出时 warn |
| 用户隐私（公开评论含真实用户名） | 笔记落地后用户名留存 | 评论与原页面公开可见一致，未引入新隐私面；用户掌控笔记后续分享 |

**回滚**：提取器是新增模块，未触动通用 Defuddle 路径。回滚 = 删除 `content.ts` 中新增的 import + zsxq 分支（约 8 行），或在 `isZsxqTopicUrl` 永远 return false。零侵入。

## 9. 非目标（YAGNI 边界）

- ❌ 文件实际下载（仅以 markdown 列表呈现链接）
- ❌ 视频内容提取（如 zsxq 内嵌视频）
- ❌ 提问悬赏金额、付费提问等元数据
- ❌ 评论的「赞过的人」头像列表
- ❌ 小组首页、用户主页、文件库等其他 zsxq 页面
- ❌ 多个 topic 批量保存
- ❌ 评论的精华标记、置顶标记
- ❌ 跨浏览器在 Safari 上验证（先在 Chrome 验证，Safari 留到回归测试）

## 10. 与既有提取器的关系

| 既有提取器 | 复用部分 | 不复用部分 |
|---|---|---|
| `scys-extractor.ts` | 图片三级 fallback 形态、评论 callout markdown 模板、文件骨架与命名规范、自动化迭代脚本形态、host_permissions 思路 | block-tree 渲染（zsxq 用 type-tag 非 block） |
| `feishu-extractor.ts` | 不直接复用 | block 渲染管线 |
| `bilibili-extractor.ts` | 文件骨架参考 | 视频专用逻辑 |
| `content-extractor.ts` | 接入点（line ~277）、ContentResponse 合并模式 | — |

zsxq 提取器是**独立模块**，与既有提取器零代码耦合，仅在 `content.ts` 的 dispatch 处并列存在。
