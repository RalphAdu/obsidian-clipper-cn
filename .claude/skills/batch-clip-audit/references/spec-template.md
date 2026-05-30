# Spec Template — Batch Clip Audit

模板基于 `docs/superpowers/specs/2026-05-30-cbex-jpxkc-batch-audit-2238-design.md` 抽象，适用任何 site 的批量裁剪 + audit spec。

## 文件名约定

`docs/superpowers/specs/YYYY-MM-DD-<site>-batch-audit-<listId>-design.md`

例：
- `docs/superpowers/specs/2026-05-30-cbex-jpxkc-batch-audit-2238-design.md`
- `docs/superpowers/specs/2026-06-15-feishu-wiki-batch-audit-spc-abc123-design.md`

## 节结构（11 节）

```markdown
# <Site> 批量 audit — <listId / 列表标识> Design Spec

- **日期**：YYYY-MM-DD
- **依赖**：<site> extractor 状态（已 ship / 需新建 / 需修 wire）
- **触发任务**：阿杜要求 <列表 URL> 下所有 N 个 detail URL 跑批量 e2e 裁剪 + audit
- **关联约束**：[[feedback_*]] 链接

## 1. 目标与约束

### 1.1 目标 — 跑 N 张 detail URL + 33 (或对应数) audit point 全 PASS + 出 REPORT.md
### 1.2 Scope (in) — 修 extractor wire / 新增 4 个 scripts / 自动闭环 / 全程 step report
### 1.3 Scope (out) — 跨 listId 复用、视觉 audit、非本任务 extractor 改动
### 1.4 关键约束表 (C1-C10)
| ID | 约束 | 来源 |
| C1 | 全自动闭环；仅最终审 REPORT.md 1 次阿杜介入 | 阿杜本任务明示 |
| C2 | PASS 率 100% | 阿杜本任务明示 |
| C3 | 禁止降级 audit 标准 | 阿杜本任务明示 |
| C4 | 无 round 上限 | 阿杜本任务明示 |
| C5 | 每 step 留 step report | 阿杜本任务明示 |
| C6 | artifacts 同步到 main 持久保留（不进 git） | 阿杜本任务明示 |
| C7 | worktree 强制 | [[feedback_feature_ship_workflow]] |
| C8 | Phase A scope 范围说明 | [[feedback_e2e_bridge_path_double_wire]] |
| C9 | ship 锁 FIFO + session 隔离 | [[feedback_ship_lock_mechanism]] |
| C10 | git push adu 可，git push origin 不可 | [[user_collab_norms]] |

## 2. 架构与文件布局

### 2.1 代码改动（进 git）
- src/utils/<site>-extractor.ts (Phase A 改动列表)
- src/utils/<site>-extractor.test.ts
- src/utils/<site>-audit-validator.test.ts
- src/content.ts (e2e bridge wire)
- scripts/<site>-list-fetcher.ts
- scripts/<site>-audit-validator.ts
- scripts/<site>-audit-report.ts
- scripts/<site>-batch-audit.ts
- .gitignore (加 ".claude/<site>-batch-<listId>/")

### 2.2 Audit artifacts 路径（不进 git，持久保留）
.claude/<site>-batch-<listId>/REPORT.md, ids.json, progress.json, markdown/*.md, diffs-fail/*.json, hydrated-fail/*.html, step-reports/*.md

### 2.3 文件职责（每 file 一行说明）

## 3. 数据流

### 3.1 单张 audit 数据流
clip + XHR refetch + listItemHtml → validateClip → AuditResult

### 3.2 Round 流程
fetchListIds → batch session → for each ID (clip → XHR → validate → progress.json)

## 4. Audit 字段表（核心，N audit point — N 按 site 实际穷举数）

### 4.0 字段穷举报告（应审尽审，必写）

按 audit-design.md「§ 字段穷举 SOP」从 4 个独立来源发现该 site 全部审计字段：

**来源 1 — extractor 输出的 markdown 全文**：
- 识别字段（列表）: ...

**来源 2 — extractor 源码 emit 逻辑**：
- 识别字段（列表）: ...

**来源 3 — fixture page 用户视角**：
- 识别字段（列表）: ...

**来源 4 — 其他类似 site 字段表清单**：
- 识别字段（列表）: ...

**4 来源并集** = N 个字段（cbex 实测 33；其他 site 按实际）

**字段集合 freeze**（每字段标「审 / 不审」+ 不审字段明示理由）:

| # | 字段 | 审 / 不审 | 不审字段的理由 |
|---|---|---|---|
| 1 | <field> | 审 | — |
| 2 | <field> | 不审 | <为什么不审：如 extractor 内部状态、永不进 markdown 等> |
| ... | | | |

**Double-check**: 派 subagent / controller 自己再 grep 看是否漏字段。漏 1 个 = audit 不完整。

### 4.1 字段表（summary 视图）

每 audit point 一行：
| # | 字段 | Ground truth (主+备 A 路径) | Audit 等式（PASS 条件） | 信度 |

### 4.2 字段 audit 路径搜索报告（每字段一份，强制）

按 audit-design.md「5-attempt 独立路径搜索 SOP」对每个字段做搜索 + 设计 + 写报告。每字段一份子节（或外链到 worktree `.claude/<site>-batch-<listId>/audit-field-design/<field>.md`）。

报告 schema 见 audit-design.md「字段 audit 路径设计报告 模板」。**绝对禁止**：找到 1 条 B 就交差。每字段必须 5 次尝试 + 报告。

#### 4.2.1 `<field-1>` 路径设计

（按 audit-design.md 模板写）

#### 4.2.2 `<field-2>` 路径设计

...

（每字段一节，共 N 节，N = audit point 总数）

### 4.3 Audit 信度小结
- N audit point 中 A 路径数量统计:
  - Triple A: M1 个
  - Double A: M2 个
  - Single A (derived/trivial/XHR/structural): M3 个
  - B + secondary: M4 个（若有，必须 4.2 报告说明为何无法升 A）
- 总体信度评估: <%>

### 4.4 Cross-validation report

每个字段「为什么 5-attempt 不能升更多 A」必须在 4.2 报告里有 explicit explanation。spec reviewer / quality reviewer 必检查 4.2 报告完整性。

详 audit-design.md 字段表设计原则。

## 5. REPORT.md 报告格式

模板见 cbex-audit-report.ts 的 buildReport()。包括：
1. 验收 checklist (A1-F3)
2. 总览 (PASS/FAIL/e2e_error/audit_infra_error 4 类计数)
3. 字段统计表（N audit point × M IDs 通过情况，N 按 site 穷举数）
4. 决策声明汇总（擅自降级 0 / 偷懒 0 / 妥协 0）
5. 全程审计追溯（step reports 表）
6. e2e_error / audit_infra_error 列表（若有）
7. extractor follow-up 建议

## 6. 全自动闭环流程

STEP 1 写代码 (Phase A + B) → STEP 2 Round 1 → STEP 3 PASS=100%?
  → YES: STEP 6 final verify → STEP 7 报阿杜
  → NO: STEP 4 自动诊断 + 修 → STEP 5 Round N+1 → 回 STEP 3
→ STEP 8 ship + artifact 同步 + 清 worktree

详 fix-loop.md + ship-flow.md。

## 7. 自动诊断决策树 + Step Report 机制

### 7.1 5 类根因决策树（详 fix-loop.md）
### 7.2 Step Report 强制 schema（详 step-report-template.md）

## 8. 阿杜最终验收 checklist (A1-F3)

A 数据完整性 / B audit 标准未降级 / C 闭环完整性 / D 代码质量 / E audit 信度证据 / F artifact 持久化

## 9. Phase A 改动详细（明示 diff）

如有 Phase A，列具体改动 diff 代码块。

## 10. 边界场景策略

### 10.1 Detail page 404（cbex 真下架）
### 10.2 chromium reuse 实现
### 10.3 同源 snapshot 严格性
### 10.4 后端反爬

## 11. Out of Scope（明示 follow-up）
```

## 关键设计决策清单（每 spec 必答）

写 spec 前，brainstorm 阶段必须穷尽以下决策（cbex 任务 6 个问题样例）：

1. **Audit 严格度**：必选「完整内容对比」（字段级，N 个字段按穷举数确定，应审尽审），禁选视觉/抽样/松散
2. **ID 来源**：自动嗅探列表 API / 用户提供
3. **失败处理**：必选「重试 3 次（5/10/20s backoff）」
4. **执行模式**：必选「单 chromium 串行复用」（runRealClipBatch）
5. **Artifacts 落盘策略**：必选「全留到 .claude/<site>-batch-<listId>/」
6. **工具沉淀**：必选「进 scripts/ 当 CLI，可复用其他 listId」
7. **Chrome 复用**：必选「runRealClipBatch」
8. **Ground truth 路径策略**：必选 A 独立路径（不可行字段标 (B) + secondary）
