# weixin mdnice 模板正则化 — Design

**日期**：2026-05-27
**触发**：用户报"https://mp.weixin.qq.com/s/HCBkgfIZkL939cQR67quEg 的采集效果不符合预期"
**Worktree**：`.claude/worktrees/weixin-mdnice-normalize` / `worktree-weixin-mdnice-normalize`

## 1. 背景

当前 `src/content.ts:66 extractWeChatArticleContent` 对 mp.weixin 文章只做三件事：

1. clone `#js_content`
2. `normalizeImageSources()` — 把 lazy-load `data-src` 等转标准 `src`
3. 删 `<script>` / `<style>`
4. `normalizePreBlockLineBreaks()`（weixin-helpers.ts）— mdnice 标准 `<pre><code>` 里 `<br>` → `\n`

然后 outerHTML → turndown。

**痛点**：mp.weixin 上最流行的排版编辑器 [mdnice](https://www.mdnice.com/) 用 **inline CSS style** 编码 markdown 语义（H1/H2/strong/code-block/footnote），不输出语义化标签。turndown 因此把 mdnice 文章退化成"一堆纯段落"——目标 URL HCBkgfIZ 就是典型 case：5.3KB markdown 里 **章节标题、小标题、代码块、inline 粗体、脚注、图片 caption、装饰垃圾全部识别失败**。

非 mdnice 的朴素 mp.weixin 文章（直接 `<h1>/<h2>/<pre>` 结构）当前管线工作正常，不在此次修复范围。本 spec 只针对 mdnice 编辑器产出。

**参考产物**：`tmp/weixin-recon-71508/product.md`（采集出的 5.3KB markdown）+ `tmp/weixin-recon-71508/hydrated.html`（hydration 后的 3.7MB DOM）。

## 2. 问题清单（10 类）

通过 hydrated DOM 实测 + 产物对照，归纳出 mdnice 模板 10 类痛点：

| # | 痛点 | 产物表现（行号 = `product.md`） | DOM 特征签名 |
|---|---|---|---|
| **A** | 章节大标题平了 | L33-35 `壹\n\n先采集\n\nInbox First` | 装饰大字（`font-size:120px; color:rgba(...,0.008)`）+ `<section>26px font-weight:700` 中文标题 + `<section>17px italic` 英文副标 |
| **B** | 小标题平了 | L41-43 `监听更新\n\nNode_ID: trigger` | 紫色 3px+12px+20px 条形装饰 + `<section>24px font-weight:700` 中文标题 + `<section>10px letter-spacing:3px uppercase color:#ab59ff` 副标 |
| **C** | mdnice "terminal" 伪代码块拆段 | L141-151, L189-205 | `<section>` 容器内含 lang badge（"terminal"/"TEXT" / 自定义如 "wechat-mp-monitor"）+ 多个 `<section>` 行（每行一句） |
| **D** | 图片 alt = caption 重复 | L21-23 `![信息过滤](url)\n\n信息过滤` | `<img alt="X">` 后紧跟 `<section>X</section>`（caption 段落） |
| **E** | 栏目分隔 anchor 当段落 | L31 `　WECHAT_MONITOR`, L119 `　EXPORT_AND_SKILL` | `<section>` 紫色 dot + `font-size:9px letter-spacing:4px uppercase color:#ab59ff` 全大写 anchor |
| **F** | `<sup>` 注脚标记内联 HTML 泄漏 | L135 `<sup style="display:inline-block;...">[1]</span></sup>` | mdnice `<sup style="font-size:11px;color:#ab59ff;font-weight:700">[N]</sup>` |
| **G** | Sources 列表没转 markdown footnote | L233-241 `\[1\]wechat-article-exporter\nhttps://...` | "Sources" small heading 下若干 `<p>` 元素，每个含 `[N]` 徽章 + 标题 + URL |
| **H** | `javascript:;` 内部锚点链接 | L197 `mp-monitor.py[#公众号监控脚本](javascript:;)` | `<a href="javascript:;">` 包文本 |
| **I** | 顶部 meta 行灌正文 | L11 `干货分享一言   Reading Time5 MINS` | 文章首个浅灰 card（`padding:10px 12px; background-color:rgb(244,244,240); text-align:center; white-space:nowrap`），左紫色徽章 + 右"Reading Time N MINS" |
| **J** | inline 粗体（紫色强调短语）丢失 | "**标题、封面、发布时间、原文链接。**" 在产物里变成普通段落 | `<span style="display:inline; color:#ab59ff; font-weight:600">` 包正文短语 |
| **K** | small heading "流程闭环"/"Sources" 拍平 | L115 `流程闭环` / L233 `Sources` 都是普通段落 | `<p style="font-size:10-11px; letter-spacing:2-3px; text-transform:uppercase; color:#ab59ff; font-weight:700">` |

**附加副作用**：mdnice 内的转义字符（`Node\_ID`、`\[01\]` 等）来自 turndown 默认 escape 行为 + 段落内含特殊字符。修 D/E/J 后大部分会自然消失，剩余少数（`Node_ID:` 在副标识里）通过 normalize 阶段把它从 inline span 改成 `<em>` 来绕开 turndown escape。

## 3. 设计

### 3.1 Pipeline

不引入新 extractor。在 `content.ts:66 extractWeChatArticleContent` 中插入一个总入口 `normalizeMdniceArticle(articleClone)`，调用顺序：

```ts
const articleClone = article.cloneNode(true) as HTMLElement;
normalizeImageSources(articleClone as unknown as Document);
articleClone.querySelectorAll('script, style').forEach(el => el.remove());
normalizeMdniceArticle(articleClone);            // NEW — 10 类 normalize
normalizePreBlockLineBreaks(articleClone);       // existing — mdnice 标准 <pre><code>
return articleClone.outerHTML;
```

**关键决策**：所有 normalize 都是 **DOM rewrite**（用 `replaceWith` / `replaceChild` 把 mdnice 容器换成语义化 `<h1>/<h2>/<pre>/<strong>/<sup>/<figure>` 等），让下游 turndown 自动产生正确 markdown。**不**手写 markdown 拼接，避免引入新的 escape/格式分歧。

### 3.2 weixin-helpers.ts 新增 10 个函数

每个函数都接 `(root: ParentNode): void`，在 `root` 子树内查找匹配模式并就地 mutate DOM。**遵循项目 Helper API 设计原则**（CLAUDE.md "Helper API 设计原则"章节）— 一律 DOM 输入，禁止 raw HTML string。

#### 3.2.1 `normalizeMdniceSectionCards(root)` — 处理 I + E

**识别**：`<section>` 元素，inline style 同时含 `padding: 10px 12px` 且 `background-color: rgb(244, 244, 240)`（顶部 meta card） **或** `<section>` 元素含 紫色 dot + `letter-spacing:4px+ uppercase color:#ab59ff` 子元素（栏目 anchor）。

**操作**：直接 `el.remove()`。

**风险控制**：这两个 card 模板在 mdnice 编辑器里只用于装饰；如果文章本身用了相同浅灰背景的内容卡（罕见），可能误删。通过额外条件 *也含 "Reading Time" 文本 或 文本全大写下划线*（如 `WECHAT_MONITOR`） 收紧。

#### 3.2.2 `normalizeMdniceChapterHeadings(root)` — 处理 A

**识别**：`<section>` 含子结构：
- 大字装饰 span：`font-size:120px` 且 `color:rgba(...,0.008)` 或 `color:rgba(236,223,252,*)`（壹/贰/叁）
- 紧邻一个 `<span>` 内嵌两个 `<section>`：第一个 `font-size:26px; font-weight:700`（中文标题），第二个 `font-size:17px; font-style:italic`（英文副标）

**操作**：替换整个外层 `<section>` 为：
```html
<h1>{中文标题文本}</h1>
<p><em>{英文副标文本}</em></p>
```

如果只有中文标题没有英文副标（少数 case），只输出 `<h1>`。

#### 3.2.3 `normalizeMdniceSubHeadings(root)` — 处理 B

**识别**：`<section>` 含子结构：
- 紫色装饰条 span（`width:3px+; background-color:#ab59ff` 或 `#caa1ff`）
- 紧邻 `<span>` 内嵌两个 `<section>`：第一个 `font-size:24px; font-weight:700`，第二个 `font-size:10px; letter-spacing:3px; text-transform:uppercase; color:rgba(171,89,255,*)`

**操作**：替换整个 `<section>` 为：
```html
<h2>{中文标题}</h2>
<p><em>{副标 — 已 lowercase}</em></p>
```

副标按惯例 lowercase（`Node_ID: trigger` 而非 `NODE_ID: TRIGGER` —— uppercase 是 CSS `text-transform`，源 DOM text 实际就是 `Node_ID: trigger`，已正确）。

#### 3.2.4 `normalizeMdniceSmallHeadings(root)` — 处理 K

**识别**：`<p>` 直接 inline style 同时含 `font-size:10-12px` + `letter-spacing:2-3px` + `text-transform:uppercase` + `color:#ab59ff` + `font-weight:700`。

**操作**：替换为 `<h3>{原文本}</h3>`。

#### 3.2.5 `normalizeMdniceCodeBlocks(root)` — 处理 C

**识别**：`<section>` 子结构：
- 包含 lang badge：一个 `<span>` 含 `letter-spacing:1.2px+; text-transform:uppercase; color/background` 紫色组合，textContent 是 lang 字（"terminal" / "TEXT" / "wechat-mp-monitor" 等）
- 后跟若干 `<section>` 兄弟节点（代码行）

**操作**：
1. lang 判定：badge text 全 `[a-zA-Z0-9_-]` 且非 "TEXT"（"TEXT" 在 mdnice 里是占位 lang，转 markdown 用 fenced 但不带 lang）→ 用作 fence lang；否则 fence 用 `text` 或空。
2. 收集 lang badge 之后的所有 `<section>` 行 → 提取 textContent → 用 `\n` 拼接。
3. 替换整个外层 `<section>` 为：
```html
<pre><code class="language-{lang}">{拼接的行}</code></pre>
```

**边界情况**：如果代码"行"里嵌 `<code>` inline tag（如目录树的 `mp-monitor.py`），保留其文本；如果嵌 `<a href="javascript:;">`（处理 H），剥成纯文本。

**lang 命名约定**：
- mdnice 双 badge（`terminal` + `TEXT`） → 用第二个 `TEXT` 但 fallback 到 `text`
- mdnice 双 badge（`wechat-mp-monitor` + `TEXT`） → file name 是 mdnice "文件名"标识，不是 lang；只用第二个 badge `TEXT` → fallback `text`

#### 3.2.6 `normalizeMdniceImageCaptions(root)` — 处理 D

**识别**：`<img alt="X">` 紧邻下一个兄弟 `<section>` 或 `<p>`，其 textContent.trim() === alt.trim()。

**操作**：删除兄弟 caption 节点（保留 img alt 作为 markdown 的 alt 文本，turndown 输出 `![X](url)` 已包含 caption 语义）。

**保守**：如果 alt 是空或者文本不完全 equal（前后空白除外），不动。

#### 3.2.7 `normalizeMdniceInlineBold(root)` — 处理 J

**识别**：`<span style="display:inline; ...; font-weight:600">`（也 match `font-weight: bold` / `font-weight:700` 等，只要不是 block-level 元素）。

**操作**：把该 `<span>` 替换为 `<strong>{textContent}</strong>`，**但**先确认该 span 不在 `<h1>` / `<h2>` / `<h3>` 子树里（heading 内不需要 strong；按调用顺序 inlineBold 是最后一步，此时所有 heading 都已落地为语义化标签）。

**收紧**：要求 inline span 满足 `display:inline` 且 textContent 长度 ≥ 2，避免误识别装饰单字 span。

#### 3.2.8 `normalizeMdniceJavascriptLinks(root)` — 处理 H

**识别**：`<a href="javascript:;">` 或 `<a href^="javascript:">`。

**操作**：用其 textContent 替换该 `<a>` 节点。

#### 3.2.9 `normalizeMdniceFootnotes(root)` — 处理 F + G

**两阶段**：
1. **Inline sup 标记**：`<sup style="...">[N]</sup>` → `<sup>[^N]</sup>`，让 turndown 输出 `[^N]`（带方括号脱出会被 `\`-escape，所以用 placeholder 字符串技巧，详见实现 task）。
2. **Sources 列表**：在 root 末尾查找 `<p>` text 严格等于 "Sources" 且 style 含小字 uppercase 特征（K 已处理过的 `<h3>Sources</h3>` 在此 helper 调用前还未发生 — 顺序在 `normalizeMdniceArticle` 内保证：footnotes 在 smallHeadings 之前调用 — 见 3.2.11）。从该节点开始往下，每个含 `[N]` 徽章 + 标题 + 链接的 `<p>` 收集为 footnote 定义。

   产物 markdown 期望：
   ```
   [^1]: wechat-article-exporter — https://github.com/wechat-article/wechat-article-exporter
   [^2]: wechat-article-exporter-api — https://down.mptext.top/dashboard/api
   ```

   做法：删除原 Sources 标题 + 那批 `<p>`，文末追加 `<div data-footnotes-block>`，每个 footnote 是一行 `[^N]: 标题 — URL`。turndown 直接吐成普通段落，但用户在 Obsidian 里 `[^1]` 跳转到这里会自动渲染成 footnote 区。

   **简化决策**：不强行用 GFM footnote 语法（turndown-plugin-gfm 已用但不一定 enable footnotes），改成手工拼好放到 `<div>` 让 turndown 输出纯文本一行一条 — Obsidian 会识别 markdown 的 `[^N]: ...` 模式。

#### 3.2.10 `normalizeMdniceArticle(root)` — 总入口

调用顺序（依赖关系）：

```ts
export function normalizeMdniceArticle(root: ParentNode): void {
  normalizeMdniceJavascriptLinks(root);    // 1. 剥 a[href=javascript:;] — 在 code block 收集前
  normalizeMdniceSectionCards(root);       // 2. 删 I + E 装饰 card
  normalizeMdniceChapterHeadings(root);    // 3. <section> 装饰大字 → H1
  normalizeMdniceSubHeadings(root);        // 4. <section> 紫色条 → H2
  normalizeMdniceFootnotes(root);          // 5. 必须在 smallHeadings 之前 — 它要找原 Sources <p>
  normalizeMdniceSmallHeadings(root);      // 6. <p>10-11px uppercase → H3
  normalizeMdniceCodeBlocks(root);         // 7. <section>+lang badge → <pre><code>
  normalizeMdniceImageCaptions(root);      // 8. 必须最后 — 此时 caption 仍是 raw text
  normalizeMdniceInlineBold(root);         // 9. 残余 inline bold → <strong>
}
```

### 3.3 测试策略

#### 3.3.1 单测 — `src/utils/weixin-helpers.test.ts` 扩展

每个新 normalize 函数加 2-3 个 fixture-based 单测：
- 正向：mdnice 模板 input → 期望 DOM 输出
- 负向：非 mdnice DOM（朴素 weixin `<h1>` 等）→ 不动

DOM input 用 `parseHTML(str).document` 喂（per CLAUDE.md "Helper API 设计原则 — 测试调用"）。

#### 3.3.2 E2E — `src/utils/weixin-extractor.e2e.test.ts` 扩展

现在 e2e 只跑 `SPLTD-hFAsyYAA7V1lU8OA`（无 mdnice 装饰的朴素文章）。**改成两个 URL 并行测**：

- URL A（保留）：`SPLTD-hFAsyYAA7V1lU8OA` — 朴素 mp.weixin，保证不退化
- URL B（新增）：`HCBkgfIZkL939cQR67quEg` — mdnice 模板，验证修复

URL B 的硬断言：
- frontmatter `published: 2026-05-25`
- markdown 含 `# 先采集`、`# 怎么搭的`（H1 × 2）
- markdown 含 `## 监听更新`、`## 后筛选`、`## 沉淀到笔记里`、`## 先解决采集这一步`、`## 封装成了一个 Skill`（H2 × 5）
- markdown 含 `### 流程闭环`、`### Sources`（H3 × 2）
- markdown 含 `**标题、封面、发布时间、原文链接。**`（inline strong）
- markdown 不含 `WECHAT_MONITOR`、`EXPORT_AND_SKILL`、`Reading Time`（栏目 anchor + meta 已删）
- markdown 不含 `<sup style=` 内联 HTML
- markdown 不含 `javascript:;`
- 至少 2 个 fenced code block（` ```text `+ 内容）— terminal step list + directory tree
- 不含两遍的 caption（每张图 alt 后紧跟同文本段落 → 0 次）
- 含 `[^1]:` 和 `[^2]:` 两条 footnote 定义

URL A 的硬断言：保留现有所有断言（PARA 树、no escaped backtick、no `<span>`、auditWeixinClip mismatches=0）。

### 3.4 视觉 audit（ship 时）

按 [[reference_audit_extractor_ship]] 跑 audit-extractor-ship skill，URL = HCBkgfIZ；ground truth 是浏览器手工裁剪的产物 vs. 自动跑的产物，10 项 checklist 应全 PASS。

## 4. 风险 / 回归

| 风险 | 缓解 |
|---|---|
| 误把朴素 weixin DOM 当 mdnice 模板（例如某用户随机用了浅灰背景） | 每个 normalize 用复合签名（多个 style 属性 + 紫色 #ab59ff 同时 match）；URL A 回归保证朴素文章不退化 |
| mdnice 改版导致样式签名失效 | normalize 函数都 return void，找不到模式时 silent no-op；最差情况退化到当前行为，不会比现在更糟 |
| Footnote 区位置错误导致 Obsidian 不渲染 | 用 markdown 标准 `[^N]: ...` 语法（Obsidian/CommonMark 都识别）；放在文档末尾 |
| inline bold 误把装饰单字 span 转 strong | 长度 ≥ 2 + `display:inline` 双条件收紧 |
| code block 把非代码内容（如长 prose）误识别为 fenced | 要求容器同时含 mdnice lang badge（小 uppercase letter-spacing 紫色）；普通文章 prose 不会有这种 badge |

## 5. Ship checklist 模板（实施完后 paste）

```
## Weixin mdnice normalize — Ship Acceptance

### T5-1 Build
- [ ] npm run build:chrome / build:firefox / build:safari 三个都 PASS
- [ ] dist/ build-marker.txt 时间戳新于 source 最后改动

### T5-2 Tests
- [ ] npm test → 574+ pass, 3 pre-existing fail unchanged
- [ ] npm run test:e2e → SPLTD-hF + HCBkgfIZ 都 PASS（贴尾部输出）

### T5-3 Manual clip (golden path)
- [ ] Chrome 装 dist/，clip HCBkgfIZ → Obsidian.app 截图 paste
- [ ] Chrome clip SPLTD-hF（朴素 weixin 回归）→ Obsidian.app 截图 paste

### T5-4 Visual audit
- [ ] audit-extractor-ship URL=HCBkgfIZ → REPORT.md 10 项 checklist 贴 ship 消息
```
