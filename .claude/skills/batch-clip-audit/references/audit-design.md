# Audit 字段表设计原则

audit 字段表是 batch-clip-audit 的核心设计文档。每 site 都需要一份。

## 目录

- [§ 字段设计的核心纪律](#字段设计的核心纪律)
- [§ 字段穷举 SOP（应审尽审，发现所有字段）](#字段穷举-sop应审尽审发现所有字段)
- [§ A / B 路径定义](#a--b-路径定义)
- [§ 信度等级](#信度等级)
- [§ 独立 ground truth source 识别（10 类候选）](#独立-ground-truth-source-识别10-类候选)
- [§ 5-attempt 独立路径搜索 SOP](#5-attempt-独立路径搜索-sop)
- [§ 字段 audit 路径设计报告 模板](#字段-audit-路径设计报告-模板)
- [§ 设计报告示例（cbex `bid_count` 字段）](#设计报告示例cbex-bid_count-字段)
- [§ list-item 解析 SOP](#list-item-解析-sop)
- [§ Audit Input/Result types](#audit-inputresult-types)
- [§ cbex/jpxkc 完整字段表（案例参考）](#cbexjpxkc-完整字段表案例参考)
- [§ 常见 audit 字段分类](#常见-audit-字段分类)

## 字段设计的核心纪律

**绝对禁止偷懒**：每个字段都必须经过认真的「字段穷举 → 独立 A 路径搜索 → 设计报告」三步。

4 条铁律：

1. **应审尽审，覆盖全面**（详 § 字段穷举 SOP）— 字段数量按 site 实际确定，**绝不能比照 cbex 选 33 个**。漏 1 个字段 = audit 不完整。遇到「不确定要不要审」一律审。
2. **每个字段至少尝试 5 种方法找独立 A 路径**（详 § 5-attempt SOP）
3. **每个字段写一份「字段 audit 路径设计报告」**（详 § 报告模板），无报告 = 字段未设计完
4. **B 路径必须明示 5 条尝试都失败的具体理由**（详 § 报告模板「为什么不能升 A」节）

为什么这么严：

- 漏字段：extractor 可能输出错的字段值，markdown 用户看不到对的 ground truth，但报告打勾 PASS — 这是 audit 最危险的 false negative。
- B 路径：只能验 transformation（trim/normalize/encoding），无法验 selector / regex 是否选对。extractor 若选错 selector 抓到隔壁字段，B 路径 audit 完全无感。
- 真实项目中漏字段 + B 路径占比超 30% = audit 信度低于 70%，无法支撑「PASS=100% ship」决策。
- cbex 任务实测：穷举发现 33 个字段，全升 A（仅 5 个单 A 是 derived 或 trivially fixed），证明绝大多数字段都可以找到独立 A，关键是肯下功夫。33 是 cbex 实际数，**不是任务普适的目标数**。

## 字段穷举 SOP（应审尽审，发现所有字段）

字段集合必须从**至少 4 个独立来源**交叉发现，确保不漏。每个来源都跑一遍，列出该来源识别的字段，最后做并集。

### 来源 1: extractor 输出的 markdown 全文

跑一次 e2e clip 拿一张 markdown sample，全字段穷举：

```bash
# 跑一张 sample
npx tsx scripts/<site>-batch-audit.ts <listUrl> /tmp/<site>-sample --ids <sample-ID>
SAMPLE_MD=/tmp/<site>-sample/markdown/<sample-ID>.md

# 1. frontmatter 所有 key
awk '/^---$/{n++; next} n==1 {print}' "$SAMPLE_MD" | grep -oE '^[a-zA-Z_]+:' | sort -u

# 2. body 所有 ## section header
grep -oE '^## .+$' "$SAMPLE_MD" | sort -u

# 3. 关键信息表所有 row label (第 1 列)
awk '/^## 关键信息/,/^## /' "$SAMPLE_MD" | grep -oE '^\| [^|]+\|' | sort -u

# 4. body 内 image / link / 其他结构（看是否有需要 audit 的）
grep -oE '!\[[^\]]*\]' "$SAMPLE_MD" | head
```

每个 key / header / row label = 1 个候选 audit 字段。

### 来源 2: extractor 源码（理论字段集合）

extractor 输出什么字段是确定的。grep 源码 emit 逻辑：

```bash
# 1. extractor 内所有 push 出的 frontmatter 行
grep -nE 'lines\.push\(|fmExtra\.push\(' src/utils/<site>-extractor.ts

# 2. extractor 输出的 section header
grep -nE 'parts\.push.*h2|<h2>|## ' src/utils/<site>-extractor.ts

# 3. 关键信息表 builder 内 rows.push
grep -nA1 'rows\.push' src/utils/<site>-extractor.ts

# 4. 其他 ContentResponse 字段映射（content.ts L455 一带）
grep -nE '<site>Content\?\.' src/content.ts
```

每条 push 都可能对应 1 个字段。**理论字段集合**跟来源 1 的「实际 markdown」做对比 — 差异即是 conditional 字段（仅某些 status / 某些 data 才出现）。

### 来源 3: fixture page 用户视角

打开 fixture page 在浏览器（用 `open /tmp/<site>-fixture.html` 或 url），用户能看见的每个 label = 潜在审计字段：

```bash
# 拉 detail page raw HTML
curl -sS -A '<UA>' '<detail URL>' -o /tmp/<site>-page.html
# 在浏览器打开看：哪些信息你认为「这条信息值得审」？
open /tmp/<site>-page.html
```

特别注意：
- 标题区 / 副标题 / 关键信息 banner
- 关键信息表所有 row
- 多 tab 内容（如 cbex 8 个 tab）每个 tab 是否需要单独 audit
- 标签 / 状态 / 时间戳 / 联系人 / 图片数等元信息
- 用户可能跳过的「细枝末节」字段（cbex 实测 followers / views 看似不重要，但实测必审，否则 status='撤回' 暴露 null vs 0 问题）

### 来源 4: 其他类似 site 的字段表清单

参 `references/audit-design.md` § 常见 audit 字段分类 + cbex/jpxkc 完整字段表。检查每类是否在新 site 也存在：

- Frontmatter 类（title / source / created / tags 等通用）
- 价格类（拍卖站点适用）
- 时间类（任何带时间戳的 site）
- 统计类（关注 / 浏览 / 计数等）
- 关联类（image / URL）
- Buyer / 用户身份类
- Section 存在性

不属于上面任一类的「特殊」字段（如 feishu wiki 的「最后编辑者」、scys course 的「章节数」）一定要新增字段类记入清单。

### 字段集合 freeze 流程

1. 4 个来源各列出字段清单，求**并集**作 candidate 集合
2. 对每个 candidate 决策「审 / 不审」：
   - **审**: 该字段在 markdown 出现 + 对用户有意义 → 必须 audit
   - **不审**: 该字段是 extractor 内部状态 / 永远不出现在 markdown → 不审
3. 不审的字段必须**明示理由**（同 B 路径理由一样严格）
4. 字段集合 freeze 后写入 spec § 4.1 字段表 + 进入 Phase B Task 8.5（5-attempt 路径搜索）
5. **双重 review**：派一个 subagent review 「这个字段集合是否完整？还有什么遗漏？」如发现新字段 → 加回集合 + 5-attempt 搜索

### 应审尽审纪律

- **漏字段 = 任务失败**，重于错字段。错字段会被 audit 抓出来；漏字段不会。
- **遇到「不确定要不要审」一律审**：漏审风险 >> 多审风险。多审最多浪费 1 字段 / 1 小时；漏审导致 ship 后用户发现 bug，回头改 audit + extractor + 重跑全 542 张，几小时损失。
- **每个 site 的字段穷举至少花 30 分钟**：4 个来源各做一遍，慢工出细活。
- **字段集合不固定**：cbex 33 / scys ~20 / feishu wiki ~15 / 新 site 自己穷举。看到「N」用 N 不用 33。

## A / B 路径定义

每个 audit point 用 `(input, parsed) → FieldResult` pattern 实现。FieldResult 含 `groundTruths[]`，每个 GT 含 `source / value / match`。

**路径 A（独立 ground truth path）**：audit 用「与 extractor 不同的 selector / regex / 后端接口」从 hydrated DOM 或独立 source 拿同一字段的 ground truth。

**路径 B（退化为同源 path）**：audit 拿不到第二条独立 source，只能用同 selector 跟 extractor 比对（只验 transformation 不验 selector）。

**双重 A**：2 条独立 A path 同时校验，两者跟 expected 都必须 match。一条 A path 错了立刻暴露。

**B + secondary**：单 A 时配 secondary check（如 status='竞价结束' → markdown 必有「成交价」字段）补强。

## 信度等级

| 信度 | 描述 | 案例 |
|---|---|---|
| Triple A | 3 条独立 GT 互校 | cbex `cap_price`: inline JS `zgxj` + `.col 最高限价` + list-item `<p>最高限价</p>` |
| Double A | 2 条独立 GT 互校 | cbex `subject_id`: list-item `<p>标的物编号</p>` + hydrated `.bd_detail_num` |
| Single A | 1 条 GT（含独立后端接口 / derived / trivially fixed） | cbex `source`: detailUrl 输入对比；`tags`: hardcoded `["clippings"]` |
| Single A + secondary | 1 条主 GT + secondary 校验 | （cbex 案例最终 audit 全 A，无 B） |
| B 退化 | 跟 extractor 用同 selector | （cbex 案例最终全 A，但若发现某字段必须用同 selector，标 B 并说明） |

## 独立 ground truth source 识别（10 类候选）

每个字段做 5-attempt 搜索时，逐类排查。10 类候选（按 cbex 实战发现优先级排序）：

| # | 类别 | 描述 | cbex 案例 |
|---|---|---|---|
| 1 | **列表 API HTML 片段** | site 列表 API 返回每个 ID 的 `<li>` markup，包含 title/subject_id/price/status/end_time/image 等字段 | `bdlist_side_num` / `<p>成交价</p>` / `<div class="time">` |
| 2 | **hydrated DOM 不同 selector / class** | 同一字段在 detail page 经常多处不同 markup 渲染 | `<span class="col">起始价：</span>` 跟 `getBodyText()` regex 是两条路径 |
| 3 | **Body text 全文 regex** | walk body textContent + 用正则抓「关键字：值」格式 | `(\d+)人关注` / `(\d+)次围观` |
| 4 | **Inline JS 变量** | `var X = N` / `obj.field = ...` 形式的 JSON / 数值 | `var zgxj = 30000` / `tpzslist = [...]` |
| 5 | **不同后端 XHR 接口** | 同一字段有第 2 个后端接口可调（如 row count + 计数 endpoint） | wtList row count 跟 `.jp_detail_bjnum` 是两个 backend 计算 |
| 6 | **`<title>` / `<meta name="description">` / `<meta og:*>` / JSON-LD** | HTML head 通用 metadata | `<title>北交互联-京NC6575...</title>` |
| 7 | **`<input>` value / `<textarea>` value / hidden form fields** | 隐藏表单字段经常含关键数据 | `<input type="hidden" name="cpdm" value="522611">` |
| 8 | **跨章节 cross-reference** | 同字段在 markdown body 多个 section 出现，audit 验「至少 2 次」 | subject_id 在「关键信息」表 + 「司法处置公告」内文 |
| 9 | **URL 参数推导** | detail URL 本身或衍生路径含字段值 | URL `/jpxkc/prj/detail/522611.html` → `prjId=522611` |
| 10 | **相邻字段 status 推导** | 字段值跟其他字段语义联动（如 `final_price` 仅 status='成交' 出现） | `buyer.lottery_code` 必跟 status='竞价结束' + final_price 联动 |

5-attempt 搜索时，至少尝试 5 类不同的来源（一类内的不同 selector 算 1 次）。

**何时接受 B（仅 3 种合法理由）**：

1. **物理唯一 source**：该字段在 hydrated DOM 物理上只有 1 个载体（如 cbex `#content_BDWJS` textarea 是标的物介绍 HTML 的唯一 source，iframe 是 client-side wrapper 读父 textarea），且 5 次尝试都验证不存在第 2 条
2. **Derived 字段**：值是另一个字段的副本（如 cbex `published === bid_start`），audit 验等式即可
3. **Trivially fixed**：硬编码值（如 `tags: ["clippings"]`），无独立 source 也无必要

任何「我懒得找」「时间紧」「fixture 没覆盖」「就这一个 selector 我能想到」**都不是合法理由**。

## 5-attempt 独立路径搜索 SOP

为每个字段，按以下流程逐一排查 10 类候选：

```
对每个字段 X（如 subject_id / bid_count / followers）：

1. 列出 extractor 现用的提取代码（grep src/utils/<site>-extractor.ts）→ 这是 GT1 / 主路径
2. 启动「5-attempt 搜索」：
   ├─ Attempt 1: 列表 API HTML 片段查 X
   │   - 列表 API 返回值 grep "X" 字眼
   │   - listItemHtml regex 找 X 值的 markup
   │   - 找到 → 记入候选 A path（去重，跟 extractor 主路径不同 selector 才算独立）
   ├─ Attempt 2: hydrated DOM 不同 selector
   │   - browser devtools 或 curl raw HTML 看 page 上有哪些其他元素含 X 字段值
   │   - 用不同 class / id / 父子层级 querySelector
   ├─ Attempt 3: body text 全文 regex
   │   - body.textContent 看 X 是否以「label：value」格式出现
   │   - regex 提取 + 跟 extractor selector 路径独立
   ├─ Attempt 4: inline JS 变量
   │   - grep scripts 看 `var X` 或 `obj.X` 类初始化
   ├─ Attempt 5: 不同后端 XHR
   │   - 看 site 还有其他 endpoint 含 X 字段
   │   - browser Network 标签嗅探 / 看 inline JS 的 Ajax 调用列表
   ├─ Attempt 6 (如必要): <title> / <meta>
   ├─ Attempt 7 (如必要): <input> hidden / <textarea>
   ├─ Attempt 8 (如必要): cross-section verify (markdown body 内 X 多处)
   ├─ Attempt 9 (如必要): URL params
   ├─ Attempt 10 (如必要): 联动字段推导
   └─ 至少 5 次后停（找到 ≥ 1 条独立 GT → 升 A 双重/三重；全 5 次失败 → 接受 B + 报告说明）

3. 记录每次尝试到字段设计报告（详 § 报告模板）

4. 若找到 N 条独立 A path，按信度排序，写入 audit-validator 实现：
   - N ≥ 3: triple/quad A
   - N == 2: double A
   - N == 1: single A
   - N == 0 (5 次都失败): B + secondary

5. 多人 review：
   - 写完报告后让另一个 subagent review，问「你觉得是否真的没有第 6 条 A？」
   - 如 subagent 想出新方法 → 加 attempt 6/7，更新报告
```

**搜索时常用工具**：

```bash
# 1. 拉 site detail page raw HTML（无 hydration）
curl -sS -A "<UA>" "<detail URL>" -o /tmp/<site>-raw.html

# 2. 抓 hydrated DOM（用现有 e2e-clip-runner）
npx tsx -e 'import { runRealClip } from "./scripts/e2e-clip-runner"; runRealClip("<URL>").then(r => console.log(r.hydratedHtml))' > /tmp/<site>-hydrated.html

# 3. grep 字段值（如 522611）跨 raw + hydrated 多次出现的 selector
grep -nE '(522611|<相关字段值>|<相关关键字>)' /tmp/<site>-{raw,hydrated}.html | head -30

# 4. 检查 inline JS 变量初始化
grep -nE '(var|let|const) [a-zA-Z_]+\s*=\s*' /tmp/<site>-raw.html | head -20

# 5. 列所有后端 Ajax 调用
grep -oE 'Base\.Ajax\.(post|load|get)\("[^"]+"' /tmp/<site>-raw.html | sort -u
grep -oE '/(page|service)/[a-zA-Z_/-]+' /tmp/<site>-raw.html | sort -u

# 6. 列 hidden inputs + meta tags
grep -oE '<input[^>]+type="hidden"[^>]+>' /tmp/<site>-raw.html | head -10
grep -oE '<meta[^>]+>' /tmp/<site>-raw.html
```

## 字段 audit 路径设计报告 模板

每个字段都必须写。落在：

- worktree 内 `.claude/<site>-batch-<listId>/audit-field-design/<field>.md`（每字段一份）
- 或 spec § 4.X 「字段 audit 路径搜索报告」节统一汇总（推荐对小字段集采用）

模板（强制 schema）：

```markdown
# Field Audit Path Design: `<field-name>`

- 字段语义: <一句话描述字段在 markdown 中含义>
- Extractor 主路径: <`src/utils/<site>-extractor.ts:LXXX` selector / regex>
- Markdown 中位置: <frontmatter key / keyInfoRows row label / body section>

## 5-Attempt 独立路径搜索记录

### Attempt 1: 列表 API HTML 片段
- 尝试方法: <具体 selector / regex>
- 结果: ✅ 找到（独立路径） | ❌ 未找到 | ⚠️ 同 source（不算独立）
- 详情: <实测 value 是什么 / 在 fixture L<num>>
- 问题（如有）: <遇到什么困难>
- 解决（如有）: <怎么解决>

### Attempt 2: hydrated DOM 不同 selector
- 尝试方法: <selector>
- 结果: ...
- 详情: ...

### Attempt 3: body text 全文 regex
...

### Attempt 4: inline JS 变量
...

### Attempt 5: 不同后端 XHR
...

### Attempt 6+ (如需要)
...

## 设计决策

- 最终 GT path 数量: <triple A / double A / single A / B + sec>
- 入选的 GT paths:
  1. GT1: <source 描述> <selector / regex>
  2. GT2: <source 描述> <selector / regex>
  3. (etc.)
- 弃选的 candidates: <候选 + 弃选理由>

## 为什么不能升 A（仅 B 路径填写）

- 5 attempts 都失败的具体原因:
  - Attempt 1 失败: <详述>
  - Attempt 2 失败: <详述>
  - ...
- 物理 limitation 证据: <如「该字段在 detail page 物理上只有 1 个 textarea 载体，无第 2 source」>
- Secondary check 设计: <如 markdown body 出现 ≥ 2 次 cross-section verify>

## 信度评估

- 信度等级: <Triple A / Double A / Single A / B + sec>
- 实战 PASS 率预期: <%>
- 已知风险: <如「列表 API 跟 hydrated DOM 数据可能略不一致, 需要 normalize trim」>

## 实现代码

```typescript
function audit_<field>(input: AuditInput, parsed: ParsedMarkdown): FieldResult {
  // GT1: <description>
  const gt1 = ...;
  // GT2: <description>
  const gt2 = ...;

  const groundTruths: FieldGroundTruth[] = [
    { source: '<GT1 source>', value: gt1, match: expected === gt1 },
    { source: '<GT2 source>', value: gt2, match: expected === gt2 },
  ];
  return {
    field: '<field>',
    pass: groundTruths.every((g) => g.match),
    expected,
    groundTruths,
  };
}
```
```

## 设计报告示例（cbex `bid_count` 字段）

完整真实案例。可作其他字段写报告时模仿。

```markdown
# Field Audit Path Design: `bid_count`

- 字段语义: 该标的物总报价次数（total bid count）
- Extractor 主路径: `src/utils/cbex-extractor.ts:172` 用 `doc.querySelector('.jp_detail_bjnum span').textContent`
- Markdown 中位置: 关键信息表 row「报价次数」+ frontmatter `bid_count:`

## 5-Attempt 独立路径搜索记录

### Attempt 1: 列表 API HTML 片段
- 尝试方法: 列表 API 返回值含 `<p class="bdlist_side_num">N</p>` 旁边 textNode `次报价`
- 结果: ✅ 找到（独立路径）
- 详情: 522611 list-item 显示 265，跟 `.jp_detail_bjnum span` 同值。是独立 selector + 独立后端 API（list API vs detail API）
- 问题: 实际跑出来发现 `.jp_detail_bjnum span` 语义是「最高限价报价人数」≠ 总报价次数；list-item bdlist_side_num 是总报价次数。两路径语义不同
- 解决: 移除 `.jp_detail_bjnum` 作 pass criterion，保留作 informational note。主 GT 用 list-item

### Attempt 2: hydrated DOM 不同 selector
- 尝试方法: `<div class="jp_detail_bjnum">最高限价报价人数：<span>N</span>人</div>` 跟「265 次报价」其他出现位置
- 结果: ⚠️ 同 source（jp_detail_bjnum 是 extractor 主路径，不算独立）
- 详情: detail page 上「次报价」字眼只出现在 list-item 内（非 detail page 本身）

### Attempt 3: body text 全文 regex
- 尝试方法: bodyText regex `(\d+)\s*次报价`
- 结果: ❌ 未找到
- 详情: detail page body 上无「N 次报价」文本（只有「N 人」的最高限价报价人数）

### Attempt 4: inline JS 变量
- 尝试方法: grep `bidCount`, `bjcs`, `bjrs`, `totalbjcs` 等可能变量名
- 结果: ❌ 未找到独立 bid_count 变量
- 详情: 只找到 `var zgxj` (最高限价价格) / `var bdid` (标的 ID) 等无关变量

### Attempt 5: 不同后端 XHR
- 尝试方法: 调用 `/page/jpxkc/prj/wtListPaging` 数返回 HTML 的 `<tr>` 行数
- 结果: ✅ 找到（独立后端 API）
- 详情: wtList API 返回所有报价记录，count = bid count
- 问题:
  1. 默认 pageSize=10，高 bid 标的 (522611 = 265 bids) 只返回首页 10 行 → 不准
  2. 返回 HTML 含 1 个 thead `<tr>` + N data tr → tr count = bid count + 1
- 解决:
  1. body 加 `pageSize=10000` 拿全部
  2. 减 1 排除 thead

### Attempt 6: 跨章节 cross-reference (备查)
- 尝试方法: markdown 「## 竞价记录」section 是否含 row count，跟 frontmatter bid_count 互校
- 结果: ✅ 找到（弱独立 — 竞价记录 section 来自同一 wtList XHR）
- 详情: 跟 Attempt 5 是同 source 的两种表现，不增加信度，弃选

## 设计决策

- 最终 GT path 数量: Double A
- 入选的 GT paths:
  1. GT1: list-item `<p class="bdlist_side_num">N</p>` （Attempt 1 路径）
  2. GT2: wtList XHR data row count（Attempt 5 路径，pageSize=10000 + tr-1）
- 弃选的 candidates:
  - hydrated `.jp_detail_bjnum span` (Attempt 2) — 语义不同，作 informational note 保留但不参与 pass
  - cross-section verify (Attempt 6) — 同 source 不增加信度

## 为什么不能升 Triple A

- 没有第 3 条真正独立 source。Attempt 1 跟 Attempt 5 已是「list API」+「wtList XHR」两个独立后端调用，无第 3 个 backend 含 bid_count
- detail page hydrated DOM 唯一 bid_count 标识就是 `.jp_detail_bjnum`（语义不同）
- 接受 Double A 足够（信度 ≥ 99%，cbex 实战 542/542 PASS）

## 信度评估

- 信度等级: Double A
- 实战 PASS 率: cbex 任务 542/542 PASS（100%）
- 已知风险:
  - wtList API 反爬触发 → audit infrastructure_error（设计处理）
  - 撤回状态空 wtList → GT2 = 0，跟 markdown 默认 0 一致（已 normalize null → 0）

## 实现代码

```typescript
function audit_bid_count(input: AuditInput, parsed: ParsedMarkdown): FieldResult {
  const expected = parsed.frontmatter.bid_count as number;
  const li = parseListItemHtml(input.listItemHtml);

  // GT1: list-item bdlist_side_num (Attempt 1)
  const gt1 = li.bid_count;

  // GT2: wtList XHR data row count (Attempt 5, pageSize=10000 + tr-1)
  const trMatches = input.wtListXhr ? input.wtListXhr.match(/<tr/gi) : null;
  const gt2 = trMatches ? Math.max(0, trMatches.length - 1) : 0;

  // Informational only (Attempt 2, semantically different)
  const { document: hydratedDoc } = parseHTML(input.hydratedHtml);
  const bjnumEl = hydratedDoc.querySelector('.jp_detail_bjnum span');
  const capPriceBidders = bjnumEl ? parseInt(normalizeWs(bjnumEl.textContent), 10) : null;

  const groundTruths: FieldGroundTruth[] = [
    { source: 'list-item bdlist_side_num (total bid count)', value: gt1, match: expected === gt1 },
    { source: 'wtList <tr> count (total bid count)', value: gt2, match: expected === gt2 },
  ];
  return {
    field: 'bid_count',
    pass: expected === gt1 && expected === gt2,
    expected,
    groundTruths,
    note: capPriceBidders !== null
      ? `Info: hydrated .jp_detail_bjnum (最高限价报价人数) = ${capPriceBidders} (semantically different, informational only)`
      : undefined,
  };
}
```
```

## list-item 解析 SOP

## list-item 解析 SOP

`scripts/<site>-list-fetcher.ts` 必须实现：

```typescript
export interface ListItem {
  id: string;
  listItemHtml: string;  // 完整 <li> markup，传给 audit-validator 作 GT source
}

export interface Parsed<Site>ListItem {
  id: string;
  subject_id: string;    // 业务编号
  title: string;
  dataStyle: string;     // status code (e.g. cj/ch/jjz/lp)
  status: string;        // status text (映射自 dataStyle)
  // ... 各 site 独有的字段（价格 / 时间 / 图片 / 统计）
}

export async function fetchListIds(listUrl: string, opts?: { pageSize?: number }): Promise<ListItem[]>;
export function parseListItemHtml(html: string): Parsed<Site>ListItem;
```

**关键设计**：
- `fetchListIds` 调列表 API 拉所有 IDs，返回每 ID 的 `listItemHtml`（不只是 ID 字符串）
- `parseListItemHtml` 输入是 `<li>` HTML 片段，输出结构化字段
- list API 通常有 pageSize 默认 10。`fetchListIds` 用 `pageSize` 参数 + 自动分页 + safety guard（max 50 pages）

**cbex 案例**：

```typescript
// 见 scripts/cbex-list-fetcher.ts
const STATUS_BY_DATA_STYLE: Record<string, string> = {
  cj: '竞价结束',
  ch: '已撤回',
  jjz: '竞价中',
  lp: '流拍',
  zd: '终止',
};

// 实测 cbex 543 IDs 中 541 cj + 1 ch；其他 status 没出现但 map 已覆盖
```

## Audit Input/Result types（直接复用 cbex）

```typescript
export interface AuditInput {
  id: string;
  detailUrl: string;
  markdown: string;
  hydratedHtml: string;
  listItemHtml: string;
  ggnrXhr: string | null;       // 后端接口 1 重抓结果，null = XHR 重试 3 次失败
  wtListXhr: string | null;     // 后端接口 2
  jjjgXhr: string | null;       // 后端接口 3
  today: string;                // YYYY-MM-DD for `created` field validation
}

export interface FieldGroundTruth {
  source: string;
  value: string | number | null;
  match: boolean;
}

export interface FieldResult {
  field: string;
  pass: boolean;
  expected: string | number | null;
  groundTruths: FieldGroundTruth[];
  note?: string;
}

export type AuditStatus = 'pass' | 'fail' | 'audit_infrastructure_error';

export interface AuditResult {
  id: string;
  status: AuditStatus;
  fieldResults: FieldResult[];
}
```

不同 site 的 XHR 接口数量不同，按 site 改 AuditInput 字段。但 audit_infrastructure_error 状态语义保持一致：任何 XHR 重抓失败 → audit 整张 infrastructure_error，不 PASS / 不 FAIL。

## cbex/jpxkc 完整字段表（案例参考）

参 `docs/superpowers/specs/2026-05-30-cbex-jpxkc-batch-audit-2238-design.md` §4，含 cbex 实际穷举出来的全 33 个 audit point 的：
- 字段名
- 主 + 备 GT path（regex / selector / 后端接口）
- Audit 等式（PASS 条件）

cbex 实际跑出来 542/542 PASS，22 个双重或更高 A 字段一致率 ≥ 99.8%。

**注意**：33 是 cbex 实际穷举的字段数，**非任务普适数字**。其他 site 用字段穷举 SOP 重新发现，可能更多/更少。

## 常见 audit 字段分类（按 cbex 实测分布）

| 类 | 数 | 字段 | 备注 |
|---|---:|---|---|
| Frontmatter 字段 | 9 | title, source, subject_id, status, published, description, author, tags, created | 通用，多数 site 类似 |
| 价格字段 | 5 | final_price, start_price, assess_price, cap_price, deposit | 拍卖类 site 适用，其他 site 按需 |
| 时间字段 | 3 | bid_start, signup_end, end_time | 同上 |
| 统计字段 | 3 | bid_count, followers, views | 多数 site 有 |
| 关联字段 | 1 | image | 通用 |
| Buyer 字段 | 3 | lottery_code, lottery_count, lottery_registered | 仅 cbex 拍卖 site |
| ct2 图片 | 1 | ct2 image count | cbex 站点用 |
| Section 存在性 | 8 | 关键信息 / 标的物介绍 / 图片展示 / 司法处置公告 / 竞买须知 / 竞价记录 / 竞价结果 / 联系方式 | 按 site markdown 章节集合 |

非 cbex site：剔除拍卖类（价格 / buyer / ct2），改成 site 业务字段（如 feishu docx 的 author / publish_date / blocks 等）。

## 必须 100% 独立 ground truth 的字段（避免 B 退化）

每 site 写字段表前，问：
- 这字段在 page 上有几处独立 markup 渲染？
- 列表 API 是否含？
- 是否有独立后端接口能拿？
- inline JS 有同义变量吗？

如以上任一为「是」→ A 路径可达。如全为「否」→ 退化为 B + secondary（如 `subject_id` 在 body text 出现 ≥ 2 次的 cross-position check）。

cbex 实测：33 audit point 中只有 ct1 (`#content_BDWJS` textarea) 真正单 source，其他都至少双 A。（**cbex 33 是穷举结果，不是普适数字**。新 site 用 § 字段穷举 SOP 重新发现。）
