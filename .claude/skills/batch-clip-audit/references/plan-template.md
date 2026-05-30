# Plan Template — Batch Clip Audit

模板基于 `docs/superpowers/plans/2026-05-30-cbex-jpxkc-batch-audit-2238.md` 抽象。

## 文件名约定

`docs/superpowers/plans/YYYY-MM-DD-<site>-batch-audit-<listId>.md`

## Plan Header (必填)

```markdown
# <Site> 批量 audit <listId> Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 对 <site> <listUrl> 列表 N 个 detail URL 跑 e2e 裁剪 + N-point audit；自动闭环直到 PASS=100%；产出 REPORT.md 给阿杜唯一一次介入审核；通过后 ship + artifacts 持久保留。

**Architecture:** 三阶段 — Phase A 修 <site> extractor e2e bridge（若需）；Phase B 写 5 个 scripts 实现 list-fetch + N-point audit + chromium 复用 + 报告生成；Phase C 自动闭环 (任何 FAIL 走 5 类根因决策树 + 修代码 + 重跑) → REPORT.md → 阿杜审 → ship。

**Tech Stack:** TypeScript / vitest / playwright-extra + stealth / Node fs/http / linkedom (parseHTML for tests) / dayjs

**Spec:** `docs/superpowers/specs/YYYY-MM-DD-<site>-batch-audit-<listId>-design.md` (commit XXXXXX)
```

## Task 结构（22-task 模板）

按 cbex 任务实测验证：22 task 适用 N ≈ 500-1000 IDs 规模，可上下浮动。

### Task 0: Setup Worktree
- 建 `.claude/worktrees/<site>-batch-<listId>` branch
- `cd` 进 worktree
- `ln -s ../../../node_modules node_modules`
- `npm run build:chrome`

### Phase A (Task 1-6) — Extractor wire（若需要）

每 task 强制 TDD:
- Step 1: 写 failing test
- Step 2: 跑测试确认 FAIL
- Step 3: 实现
- Step 4: 跑测试确认 PASS
- Step 5: Commit

代表性 Phase A task:
- Task 1: extractor interface 加新字段（如 end_time）
- Task 2: extractor structured content 透出新字段
- Task 3: e2e bridge 用 build<Site>Frontmatter() 替换硬编码 fmExtra
- Task 4: 加 .gitignore `.claude/<site>-batch-<listId>/`
- Task 5: 跑 baseline e2e test 扩断言
- Task 6: 写 step-01a-phase-a-extractor-wire.md

如不需要 Phase A，跳到 Task 7 即可（Phase B 开始）。

### Phase B (Task 7-18) — Batch tool

- Task 7: scripts/<site>-list-fetcher.ts + test + list API fixture
- Task 8: scripts/e2e-clip-runner.ts 现有，**直接复用 startBatchSession/runRealClipBatch**（一般无需改动）
- **Task 8.4: 字段穷举（关键前置 #1）** — 按 audit-design.md「§ 字段穷举 SOP」从 4 个独立来源（markdown 全文 / extractor 源码 / fixture 用户视角 / 其他类似 site 字段表）发现该 site 的全部审计字段集合。字段数按 site 实际确定（**不能比照 cbex 选 33 个**）。最终 freeze 字段集合 N 落到 spec § 4.1 + 派 subagent review 是否有漏 + controller 自己 grep 验证。**绝对禁止「估计差不多就行」**。详 `references/audit-design.md` § 字段穷举 SOP。**留 step-01c-audit-field-discovery.md report**（含每来源识别字段列表 + 不审字段及理由）。
- **Task 8.5: 字段 audit 路径设计报告（关键前置 #2）** — 对 Task 8.4 穷举出的 N 个字段每个按 audit-design.md「§ 5-attempt 独立路径搜索 SOP」逐一搜索独立 A 路径，每字段写一份设计报告，路径设计报告全集落在 worktree `.claude/<site>-batch-<listId>/audit-field-design/<field>.md` 或 spec § 4 字段表统一汇总。**没写完字段路径设计报告不允许进 Task 9**。绝对禁止「找到 1 条 B 就交差」。详 `references/audit-design.md` § 5-attempt SOP + 报告模板。**留 step-01c2-audit-field-path-design.md report**。
- Task 9: scripts/<site>-audit-validator.ts 骨架 + parseMarkdown + types
- Task 10-13: 分组实现 N 个 audit functions — **按 Task 8.4 穷举出的实际字段集合分组**（frontmatter / 价格 / 时间 / 统计 / buyer / section / etc.），每组按 Task 8.5 设计报告的 GT path 实现。具体分几个 task / 每 task 几个字段按 N 实际值规划（cbex N=33 拆成 9+9+7+8；其他 site 自行规划）
- Task 14: scripts/<site>-audit-report.ts (REPORT.md generator)
- Task 15: scripts/<site>-batch-audit.ts CLI orchestrator
- Task 16: 写 step-01b-phase-b-batch-tool.md
- Task 17: 字段路径设计报告全集汇总进 spec § 4 + commit（如未提前合并） — 报告作为 audit 信度证据的一部分，是 REPORT.md 「E1. 字段表列出 N audit point GT 通过情况」节的支撑材料
- Task 18: 字段穷举 + 路径设计 double-check — 跑 sample audit 一张验证字段集合完整 + GT path 都通过；如发现新字段或缺 GT path 立刻回头补 Task 8.4 / Task 8.5（在 ship 前发现成本最低）

### Phase C (Task 17-19) — 执行 + 闭环

- Task 17: Round 1 — 跑全 N 张 audit
- Task 18: Fix Loop (runtime recursive — 5 类根因决策树 + step-fix-NN 报告)
- Task 19: Final verify 全 N 张 + 生成 REPORT.md

### Phase D (Task 20-21) — Ship

- Task 20: 报阿杜审 REPORT.md（唯一介入点）
- Task 21: Ship — 抢锁 + rsync + commit + push adu + 清 worktree

## Self-Review Notes (Plan 编写者填)

Plan 写完做 spec coverage / placeholder scan / type consistency 三项 self-review。详 `superpowers:writing-plans` skill。

## Phase B Task 10-13 拆分原则

按 spec §4 字段表的字段类分组，每 task 约 7-9 个 audit function（避免单 task 过大）：
- Task 10: frontmatter 字段（9 个左右）
- Task 11: 价格 + 时间 + image (9 个左右)
- Task 12: 统计 + buyer + 关联 (7 个左右)
- Task 13: section 存在性 (8 个左右)

如总 audit point ≠ 33，按 site 实际字段数调整。

## TDD 规范

每 audit function 实现遵循：

```typescript
// 1. Test first (在 src/utils/<site>-audit-validator.test.ts):
it('<field> passes (double A)', () => {
  const r = validateClip(input);
  const f = r.fieldResults.find((f) => f.field === '<field>');
  expect(f?.pass).toBe(true);
  expect(f?.groundTruths.length).toBe(2);
});

// 2. Implementation (在 scripts/<site>-audit-validator.ts):
function audit_<field>(input: AuditInput, parsed: ParsedMarkdown): FieldResult {
  const expected = parsed.frontmatter.<field>;
  const { document: hydratedDoc } = parseHTML(input.hydratedHtml);
  const li = parse<Site>ListItemHtml(input.listItemHtml);

  const gt1 = ...; // 路径 1 (e.g. list-item)
  const gt2 = ...; // 路径 2 (e.g. hydrated selector / body regex)

  const groundTruths: FieldGroundTruth[] = [
    { source: '<source 1 描述>', value: gt1, match: expected === gt1 },
    { source: '<source 2 描述>', value: gt2, match: expected === gt2 },
  ];
  return {
    field: '<field>',
    pass: groundTruths.every((g) => g.match),
    expected,
    groundTruths,
  };
}

// 3. Call in validateClip's fieldResults array
```

## 执行选择

Plan 写完转交 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans。
