---
name: audit-extractor-ship
description: 自动派 subagent 隔离比对 extractor ship 验收的 Obsidian markdown 跟浏览器原页（sbs grid 截图），输出含 10 项 checklist 的汇总报告给主 session paste 到 ship checklist T5-2。Use when 用户说"用 audit-extractor-ship 跑这几个 URL"、"audit ship"、"做视觉验收"，或在 extractor ship 流程到 T5 视觉 audit 步骤需要避免主 session 直接 Read 大量 grid 截图爆 context 时。
---

# audit-extractor-ship: extractor ship 视觉验收 (subagent 隔离版)

**Why this skill exists**: 主 session 直接 Read sbs grid（每张 ~3-4K vision token）累积超 30 张就触发 ECONNRESET / 200K context 上限。本 skill 把"看 grid"动作下沉到分片 subagent，每片 ≤7 张 grid，并行执行；主 session 只看汇总。

**Spec**: `docs/superpowers/specs/2026-05-24-audit-via-subagents-design.md`

## 输入

用户自然语言触发，提供 URL 列表（每 URL 对应 Obsidian vault + relative md path）。例：

> 用 audit-extractor-ship skill 跑 scys A URL：
> - https://scys.com/articleDetail/xq_topic/55188248452852824，vault=Reading，md=Inbox/scys-A

或多 URL 一起：

> 跑 audit-extractor-ship 6 URL：(列表 ...)

## 执行步骤（按序）

### Step 1: Pre-flight

- 生成 `RUN_ID=$(date +%Y%m%d-%H%M%S)`，确保后续命令一致
- 用 Bash 检查每个 URL 对应 `~/Documents/Obsidian /<vault>/<md-rel-path>.md` 存在。任一不存在 → 报告"请先手工裁剪 / 跑 e2e-clip-runner"并 stop（不要尝试自动裁剪）
- 验证 `scripts/audit-prepare.sh` `scripts/audit-summarize.ts` 都存在

### Step 2: 采集 grid（每 URL 一次）

对每个 URL 跑：

```bash
scripts/audit-prepare.sh "<vault>" "<md-rel-path>" "<url>" --run-id "$RUN_ID" \
  [--profile <pw-profile-dir>]  \
  [--scroll-selector <css>]
```

- scys URL 需要 `--profile .scys-pw-profile`（spec-b1 已配好的 Playwright persistent profile）
- scys course chapter 需要 `--scroll-selector '.feishu-doc-content'`（内嵌滚动容器）
- 其他 URL 默认不加 flag

每个 URL 的脚本最后一行 stdout 是 `AUDIT_PREPARE_OK url-slug=... n_grids=N md_lines=L grid_dir=...`。解析它得到 N 和 grid_dir。

### Step 3: 分片计算

对每个 URL：

- 每片最多 7 张 grid（控制 vision token ≤ 28K，安全冗余 60%+）
- `S = ceil(N / 7)`（slice 数量）
- md 行按比例切：slice p 负责 md 行 `((p-1) * L / S + 1)` 到 `(p * L / S)`，p 从 1 到 S
- 输出文件路径 `/tmp/audit-${RUN_ID}/<url-slug>/slice-${p}.json`

### Step 4: 并行派 Agent

**所有 URL 的所有 slice 一起 spawn**（一个 message 多个 Agent 工具调用）。每个 subagent：

- subagent_type: `general-purpose`
- description: `audit slice <p>/<S> of <url-slug>`
- prompt: 用下方 Step 4.1 模板，替换 placeholder

#### Step 4.1: Subagent prompt 模板

```
你是 extractor ship 验收的视觉比对 subagent。你只负责一片 grid 的比对，不要做范围外的事。

## 输入
- URL: {url}
- Grid 范围: 第 {slice_start} 张到第 {slice_end} 张（共 {n} 张 sbs grid，左半 = browser 原页、右半 = obsidian 渲染）
- Grid 文件路径模板: /tmp/audit-{run_id}/{url_slug}/grids/sbs-{NN}.png（NN 是 01-{n_total} 两位数）
- 你负责的 grid 编号: {slice_start} 到 {slice_end}
- 对应 markdown 文件: {md_full_path}
- Markdown 行范围: 第 {md_line_start} 到 {md_line_end} 行

## 你要做
1. 用 Read 工具读你负责的 {n_slice} 张 grid（**只**读这些，不要读其他 grid，否则会爆 context）
2. 用 Read 工具读 markdown 文件的 {md_line_start}-{md_line_end} 行（用 offset + limit 参数）
3. 对照"检查 checklist"10 项，对你这片**每一项**判断：
   - 本片是否出现该类型元素？没出现 → na
   - 出现了 → browser 半屏 vs obsidian 半屏 vs markdown 三方是否一致？一致 → pass，有差 → fail，看不清 → unknown
4. 所有 fail 项写到 diffs[]，给出 grid 文件名 + 位置（如"右半中段 / 表格第 3 行"）+ 简短描述
5. 不算 fail 的情况：颜色差、图片精确位置差、CSS 渲染差

## 检查 checklist（10 项，每项必须给状态）

| ID | 维度 | 关注点 |
|---|---|---|
| frontmatter | YAML frontmatter | 作者 / publish 日期 / 标题 / 标签 |
| heading | 标题层级 + 编号 | h1/h2/h3 ↔ # / ## / ### |
| list | 列表 | 嵌套深度、有序/无序、项数 |
| table | 表格 | 行列数、单元格文本 |
| code | 代码块 | 语言标签、是否截断 |
| bold_italic | 加粗 / 斜体 | 位置、范围 |
| image | 图片 | 数量、alt、嵌入成功 |
| quote | 引用块 | blockquote 边界 |
| link | 链接 | href、文本完整 |
| comment | 评论区 | 评论数、评论文本 |

## 输出（严格 JSON，用 Write 工具写到 /tmp/audit-{run_id}/{url_slug}/slice-{slice_id}.json）

{
  "url": "{url}",
  "slice": "{slice_id}",
  "grid_range": [{slice_start}, {slice_end}],
  "status": "PASS" | "FAIL" | "NEEDS_REVIEW" | "ERROR",
  "checklist": {
    "frontmatter": "pass" | "fail" | "na" | "unknown",
    "heading": "...",
    "list": "...",
    "table": "...",
    "code": "...",
    "bold_italic": "...",
    "image": "...",
    "quote": "...",
    "link": "...",
    "comment": "..."
  },
  "diffs": [
    {"grid": "sbs-NN.png", "location": "...", "category": "table", "severity": "blocker" | "warn" | "info", "desc": "..."}
  ],
  "notes": "(可选)"
}

status 派生：
- 任一 checklist = fail → FAIL
- 任一 unknown（且无 fail）→ NEEDS_REVIEW
- 全 pass / na → PASS
- 文件读不到 / 范围对不上 → ERROR + diffs[].desc 描述

## 纪律
- 不要 Read 范围外的 grid（爆 context）
- 不要分析 git / 改代码 / 跑测试
- 不确定就标 unknown，不要静默标 pass
- 写完 JSON 文件后简短确认（一行）即可
```

### Step 5: 汇总

所有 subagent 完成后：

```bash
scripts/audit-summarize.ts --run-id "$RUN_ID" \
  --run-dir "/tmp/audit-${RUN_ID}" \
  --out "/tmp/audit-${RUN_ID}/REPORT.md"
echo "Summarize exit: $?"
```

- exit 0 = 全 PASS → 进 Step 6
- exit 1 = 有 FAIL 或 NEEDS_REVIEW → 进 Step 7 复核闸

### Step 6: 全 PASS — 输出 ship checklist T5-2 块

```bash
cat /tmp/audit-${RUN_ID}/REPORT.md
```

把内容 paste 到主 session 输出，告诉用户："audit 全 PASS，可作为 ship checklist T5-2 证据 paste"。

### Step 7: 有 FAIL/NEEDS_REVIEW — 复核闸

**不要假装通过**（违反 fail-closed 铁律）。

1. cat REPORT.md 给用户看完整内容
2. 提取"整体复核清单"里需主 session Read 的 grid path
3. 告诉用户："以下 grid 需主 session 复核 — `<path1> <path2> ...`。请用户决定：(a) 主 session Read 这些复核 / (b) 修 extractor / (c) 修 audit normalize / (d) 终止 ship"
4. 等用户决定 — 不要自作主张

### Step 8: 失败处理

- 任一 subagent 抛错 → 报"subagent X 失败"+ paste error，不假装通过
- 任一 grid 读不到 → 报采集步骤异常
- audit-prepare 失败 → 报 exit code 含义（参考 audit-prepare.sh 头部注释）

## 重要纪律（fail-closed）

- subagent 报 PASS 后，主 session **仍按 `feedback_extractor_acceptance.md` T5 视觉抽样最终复核**（本 skill 不取代铁律，是它的执行手段）
- 不要为了"过 audit"调整 prompt 或省略 checklist 项
- 复核闸不通过不能 ship

## 调用示例

> 用 audit-extractor-ship skill 跑 scys A URL：
> - https://scys.com/articleDetail/xq_topic/55188248452852824，vault=Reading，md=Inbox/scys-A，profile=.scys-pw-profile

Claude 解析后按上述 8 step 执行，最后输出 REPORT.md 内容 + 状态说明。
