---
name: batch-clip-audit
description: 批量 e2e 裁剪 + 字段级 audit（应审尽审，字段集合按 site 实际发现，cbex 实测 33 个但非固定数）+ 自动闭环直到 PASS=100% + 唯一一次阿杜介入审 REPORT.md 后 ship。Use when 用户要求批量裁剪某站点列表（如 cbex/jpxkc/zc_prjs/N.html 下所有标的、feishu 某 wiki 空间下所有 docx）并严格验证每张产物质量。本仓库已落地 cbex/jpxkc 的完整 reference impl（scripts/cbex-list-fetcher.ts + cbex-audit-validator.ts + cbex-audit-report.ts + cbex-batch-audit.ts，参 docs/superpowers/specs/2026-05-30-cbex-jpxkc-batch-audit-2238-design.md），其他站点按本 skill 描述的方法论复用工具链结构 + 重写 list-fetcher 跟 audit-validator。
---

# Batch Clip Audit

## 整体方法论

「批量 e2e 裁剪某站点列表 + 100% PASS audit + 出 REPORT.md 给阿杜审 + ship」的完整 SOP。

核心约束（阿杜在 cbex/jpxkc 任务明示，所有未来批量裁剪默认沿用）：

1. **整个流程仅 1 次阿杜介入** — 最后审 REPORT.md。其他全自动闭环。
2. **PASS 率必须 100%** — 任何 FAIL 走根因诊断 → 修代码 → 重跑，**无 round 上限**。
3. **禁止降级 audit 标准** — 绝不允许 strict→contains/soft/skip / 软 check / 容差宽放。
4. **每 step 留 step report** — 强制填「擅自降级/偷懒/妥协」三项「否」。
5. **artifacts 持久保留** — 同步到 main 仓库 `.gitignored` 目录，清 worktree 不影响。

## 触发场景

- 「批量裁剪 cbex/jpxkc/zc_prjs/<其他 listId>.html 的所有标的」
- 「feishu wiki 某空间所有 docx 批量裁剪 + audit」
- 「scys 某个 course 的所有 article 批量裁剪」
- 「批量裁剪 + 严格 audit」类需求

## 工作流总览（spec → plan → 执行）

按 superpowers 标准三段式：

1. **brainstorm**（superpowers:brainstorming）— 穷尽歧义：audit 严格度（必 = 完整内容对比）、ID 来源、失败处理（必 = 重试 3 次）、执行模式（必 = 串行 chromium 复用）、artifacts 落盘、工具沉淀（必 = `scripts/<site>-batch-audit.ts`）
2. **写 spec**（docs/superpowers/specs/YYYY-MM-DD-<site>-batch-audit-<listId>-design.md）— 用 `references/spec-template.md`
3. **写 plan**（docs/superpowers/plans/YYYY-MM-DD-<site>-batch-audit-<listId>.md）— 用 `references/plan-template.md`
4. **执行**（subagent-driven 或 inline）
5. **REPORT.md 唯一介入**
6. **Ship**（详 §Phase D）

## Phase 划分（Plan 内 task 分组的标准）

### Phase A — Extractor wire（若 extractor 已存在但 e2e bridge 不完整需要修）

针对场景：extractor 已有但 e2e bridge 输出的 frontmatter 不含 audit 所需字段。

典型改动：
- `src/content.ts` e2e bridge L864-868 类似位置：把简版 `fmExtra.push('subject_id: ...')` 改用 extractor 自带 `build<Site>Frontmatter()` 输出完整字段
- extractor 内部 `<Site>StructuredContent` interface 扩展，return 暴露所有 audit 需要的字段
- e2e bridge `buildVariables()` 透传 `result.description / image / published / ...`（**注意：很多站点 bridge 这块用硬编码 `''`，是 pre-existing 缺陷，cbex 任务 fix-01 中暴露**）

不需要时：跳过 Phase A，直接 Phase B。

### Phase B — Batch tooling

新增 4-5 个 scripts + 3 个 unit test：

```
scripts/
├─ <site>-list-fetcher.ts        # list URL → ID[] + listItemHtml[] (independent A path source)
├─ <site>-audit-validator.ts     # N-point audit；N = 字段穷举后的实际字段数（cbex 33 / scys 可能 ~20 / feishu wiki 可能 ~15）
├─ <site>-audit-report.ts        # REPORT.md generator (复用 cbex 的 BatchStats/ReportInput 结构)
├─ <site>-batch-audit.ts         # CLI orchestrator (e2e clip + XHR refetch + validate + progress.json)
└─ e2e-clip-runner.ts            # 现有 startBatchSession/runRealClipBatch 直接复用
src/utils/
├─ <site>-list-fetcher.test.ts
├─ <site>-audit-validator.test.ts
└─ <site>-audit-report.test.ts
```

**关键设计原则**：
- list-fetcher 必须从「列表 API 返回的 HTML 片段」提取每个 ID 的 `listItemHtml`，作为 audit 独立 ground truth source（不止用作 ID 列表）
- audit-validator 每个 audit point 走 `(input, parsed) → FieldResult` pattern，返回 `groundTruths[]` 数组（每个 GT 含 source / value / match）
- audit-validator 各 audit fn 优先用「双重或更高 A」（≥ 2 条独立 ground truth source 互校）
- batch-audit CLI 实现 3-retry e2e (5/10/20s backoff) + 3-retry XHR refetch + 增量 progress.json + `--ids ID1,ID2,...` subset mode + `--final-verify` mode

详 `references/audit-design.md`。

### Phase C — 执行 + 自动闭环

```
Round 1: 跑全 N 张 → 看 progress.json
  ├─ PASS=100% → Final verify → REPORT.md
  └─ 有 FAIL → 进 Fix Loop
       ├─ 聚类 FAIL 字段 (jq diffs-fail/*.json)
       ├─ 走 5 类根因决策树 (详 references/fix-loop.md)
       ├─ 修代码 (extractor / audit / bridge / e2e wait)
       ├─ commit fix
       ├─ Round N+1 (只跑上轮 FAIL subset)
       ├─ subset 全 PASS → 跑全量 final verify
       └─ subset 仍 FAIL → 回 Fix Loop
```

详 `references/fix-loop.md`。

### Phase D — Ship

阿杜审过 REPORT.md 回「通过」后：

1. cd 回 main，抢 ship lock
2. rsync 代码 worktree → main（**不**同步 audit artifacts，artifacts 走独立步骤）
3. rsync audit artifacts 到 main 的 `.claude/<site>-batch-<listId>/`（`.gitignore` 已加规则，不进 git）
4. git add 代码 + .gitignore，git commit
5. sanity check（npm test + npm run test:e2e + npm run build:chrome）失败回滚
6. git push adu
7. 释 ship lock
8. 清 worktree（git worktree remove + git branch -D）
9. 写 step-ship.md
10. 报阿杜「ship 完毕」+ artifact 路径

详 `references/ship-flow.md`。

## 关键文件参考

- `references/spec-template.md` — spec 11 节模板（目标、约束、架构、字段表、REPORT 格式、闭环流程、决策树、验收 checklist、边界场景）
- `references/plan-template.md` — plan 22-task 模板（Phase A/B/C/D 任务拆分 + TDD 步骤）
- `references/step-report-template.md` — step report 强制 schema（含决策声明强制三项）
- `references/audit-design.md` — audit 字段表设计原则（**字段穷举 SOP（应审尽审）** + A/B 路径定义 + 5-attempt 独立路径搜索 + 设计报告模板 + cbex 案例完整字段表）
- `references/fix-loop.md` — Fix Loop 5 类根因决策树 + 处理 SOP
- `references/ship-flow.md` — Ship 流程详细步骤 + 命令样例
- `references/cbex-reference.md` — cbex/jpxkc 完整 reference impl 路径索引（spec / plan / 代码 / artifacts），后续可直接复制 + 改 site-specific 内容

## 直接复用现有 cbex 工具链（同 site 不同 listId）

如果是 cbex/jpxkc 站点的不同 listId（如 zc_prjs/9999.html 而非 2238），**无需重写代码**，直接：

```bash
# 1. 建 worktree
git worktree add .claude/worktrees/cbex-batch-<新 listId> -b cbex-batch-<新 listId> main
cd .claude/worktrees/cbex-batch-<新 listId>
ln -s ../../../node_modules node_modules
npm run build:chrome

# 2. 加 .gitignore (如未存在)
echo ".claude/cbex-batch-<新 listId>/" >> .gitignore

# 3. 跑 (Round 1，不带 --final-verify)
npx tsx scripts/cbex-batch-audit.ts \
  https://jpxkc.cbex.com/jpxkc/zc_prjs/<新 listId>.html \
  .claude/cbex-batch-<新 listId>

# 4. 看 progress.json 跟 diffs-fail/，进 Fix Loop 或直接 final verify
# 5. Ship 按 §Phase D
```

新 listId 跑出来 FAIL 可能少 / 可能多。常见新 listId 暴露的边界（cbex 已修过，但新 listId 可能有未覆盖 status）：
- 新 `data-style` (e.g. `lp` 流拍 / `jjz` 竞价中)：list-fetcher `STATUS_BY_DATA_STYLE` map 加映射
- 新 buyer 字段格式：audit_buyer_lottery_* normalize 扩展
- 新 ct1/ct5/ct6 内容密度：threshold 校准

## 不同 site 复用（cbex 之外的 site）

如果是 feishu / scys / zsxq 类似批量场景：

1. 复制本仓库 `scripts/cbex-*.ts` 4 个 file 作模板
2. 改 list API endpoint + listItemHtml 解析逻辑（参 `references/audit-design.md` 第 § list-item 解析）
3. 改 audit point 字段表（先按字段穷举 SOP 重新发现该 site 的字段集合，**不能假设跟 cbex 一样 33 个**；多数 frontmatter 类 audit point 通用，价格/buyer/section 类要按 site 重做）
4. 复用 `scripts/e2e-clip-runner.ts` 现有 startBatchSession/runRealClipBatch（无需重写）
5. 复用 `scripts/cbex-audit-report.ts` 的 BatchStats/ReportInput types（直接 import）

## 强制纪律

### 通用纪律

- **brainstorm 阶段穷尽歧义**：所有需要阿杜决策的都问清楚，没问题数上限
- **绝不擅自降级 audit**：threshold 校准（heuristic 范围内调整）≠ 降级；strict→contains/soft/skip = 降级
- **每 step 留 step report**：包括 audit-round / fix / verify / ship，强制填决策声明
- **fix subagent 不继承 controller cwd**：dispatch 时 prompt 强制要求 first Bash command 是 `cd <worktree>`
- **fix subagent 必须显式 grep 既有功能不被破坏**：每次 fix prompt 加「CRITICAL: Don't undo previous tasks」段落 + 列出已加但不能删的字段/行/函数
- **controller spot-check diff**：subagent review 漏 regression（cbex 任务暴露），controller 必须自己 grep + read 关键 diff 验证

### 问题应修尽修（关键 — 任何暴露的问题都归本 worktree）

- **问题归属判定**：在本 worktree 执行过程中**暴露**的任何问题（不管是 pre-existing bug / 其他 worktree 遗留 / extractor 缺陷 / audit 工具 bug / e2e bridge 缺陷 / TS 编译错 / build 警告 / 反爬触发），**都是本 worktree 需要解决的**。「这是别人的 bug」「这是历史遗留」**都不是放弃修复的理由**
- **应修尽修**：每个暴露的问题都列入本 worktree TODO 列表 + commit 修到位。**不允许**「修个最关键的，剩下放着」「这个 bug 我跑通了就行」「这是 pre-existing 不归我管」
- **修复失败换方法继续**：如某方法修不动，**记录尝试过的方法 + 失败原因 → 换方法**。绝不允许「我试了一次不行就放弃」。常见可换方法：
  - extractor 改不通 → 改 audit-validator GT 适配
  - audit 改不通 → 反过来修 extractor 语义
  - 上游工具改不通 → 在 worktree 内 patch + 加测试 + 报告改完同步上游
  - 反爬触发 → 加 jitter sleep / 换 UA / 降低并发 / 加 cookie，**不**降低 audit 标准绕开
- **验收标准不可降低**：不能因为「修复过程困难」就：
  - 降低 audit threshold（e.g.「这字段验不过就改 contains」❌）
  - 剔除已 freeze 字段（e.g.「这字段太难审就跳过」❌）
  - 放低 PASS 率（e.g.「99% 也算 ship」❌）
  - 软化 fix loop 退出条件（e.g.「修 5 轮还不通就接受」❌）
- **问题修复标准 = 真正解决**：不是「commit 提交了」「测试不 fail 了」，而是：
  1. 根因清楚（参 fix-loop.md § 5 类根因决策树）
  2. 修复后跑 affected unit test + 522611/522884 baseline + audit subset 都过
  3. 写 step-fix report，强制声明「问题真正解决」（非「workaround」「skip」「先这样」）
  4. final verify 重跑整个 audit 集合验证修复确实生效

详 `references/fix-loop.md` § 问题归属 + 应修尽修 SOP。

### Audit 字段设计纪律（关键 — Phase B 写 audit-validator 前必读）

#### 应审尽审（字段集合穷举）

- **字段数量不固定**：cbex 实测 33 个，scys 可能 ~20，feishu wiki 可能 ~15，新 site 可能更多或更少。**绝不允许「我估计差不多了」或「比照 cbex 选 33 个」**。
- **必走「字段穷举 SOP」发现所有审计字段**：从 4 个独立来源交叉发现字段集合（详 `references/audit-design.md` § 字段穷举 SOP）：
  1. extractor 输出的 markdown 全文（grep frontmatter keys + body 所有「## ...」section + 关键信息表所有 row label）
  2. extractor 源码（grep 所有 push / lines.push / parts.push 调用）
  3. fixture page 用户视角的所有可见信息（用户在浏览器看到的每个 label 都是潜在审计字段）
  4. 其他类似 site 已实现字段表的「字段类别」清单
- **字段集合必须 freeze + 双重 review**：列完后让另一个 subagent review「是否有漏」+ controller 自己 grep 验证。漏 1 个 = audit 不完整。
- **遇到「不确定要不要审」时一律审**：如 frontmatter 偶尔出现的 optional 字段、page 上「不显眼」的角落字段、对话内的状态字段（如「该项目处于 X 阶段」）。漏审风险远高于多审风险。

#### A/B 路径设计

- **每个字段必须至少尝试 5 种方法找独立 A 路径**：不允许「找到 1 条 B 就交差」。5 种方法包括但不限于：列表 API 不同字段、hydrated DOM 不同 selector、inline JS 变量、不同后端 XHR 接口、`<title>` / `<meta>` / structured data、`<input>` value / `<textarea>` value、跨章节 cross-reference、URL 参数推导、相邻 status field 推导。详 `references/audit-design.md` § 5-attempt 独立路径搜索 SOP。
- **每个字段必须写一份「字段 audit 路径设计报告」**：含「该字段使用的 A/B 路径」「分别尝试了哪些方法获取 A 字段」「每条尝试遇到什么问题」「最终方案 + 理由」。无报告 = 字段未设计完。详 `references/audit-design.md` § 字段 audit 路径设计报告 模板。
- **设计报告全集落到 spec § 4.X**：每 site 都要写。可作 worktree 内 `step-01c-audit-field-design.md` 前置 step report，再合并进 spec。
- **B 路径必须明示理由**：仅以下条件下接受 B：
  - hydrated DOM 物理上只有 1 个 source（如某 textarea 唯一字段载体）
  - 字段是 derived（如 `published === bid_start`）或 trivially fixed（如 `tags: ["clippings"]`）
  - 5 次尝试都验证不存在第 2 条独立 source（且尝试记录在报告里）

参 `references/audit-design.md`（包含 字段穷举 SOP + 5-attempt SOP + 报告模板 + cbex 案例）。

## 与其他 skill 的关系

- 复用 `superpowers:brainstorming`（spec 前必须）
- 复用 `superpowers:writing-plans`（spec 后 → plan）
- 复用 `superpowers:subagent-driven-development`（plan 后 → 执行）
- 跟 `audit-extractor-ship` 互补：本 skill 用「字段级 audit」（无截图），audit-extractor-ship 用「视觉 audit」（含 sbs grid + subagent 看图）。同站点单 URL 临时验收用 audit-extractor-ship，批量 N 张同 site 列表用本 skill。
