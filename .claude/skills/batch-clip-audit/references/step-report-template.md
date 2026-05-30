# Step Report Template — Batch Clip Audit

每 step（code-phase / audit-round / fix / verify / ship）强制留一份 step report，含决策声明三项「否」必填。

## 目录约定

`.claude/<site>-batch-<listId>/step-reports/step-<step-id>-<slug>.md`

## 命名规则

| Step 类型 | 文件名格式 | 示例 |
|---|---|---|
| code-phase-A | step-01a-phase-a-<desc>.md | step-01a-phase-a-extractor-wire.md |
| **audit-field-discovery** | step-01c-audit-field-discovery.md | step-01c-audit-field-discovery.md（必，字段穷举 4 来源 + freeze + double-check） |
| **audit-field-path-design** | step-01c2-audit-field-path-design.md | step-01c2-audit-field-path-design.md（必，summarize 所有字段 5-attempt 搜索结果） |
| code-phase-B | step-01b-phase-b-<desc>.md | step-01b-phase-b-batch-tool.md |
| audit-round | step-NN-audit-round-NN.md | step-02-audit-round-01.md, step-03-audit-round-02-subset.md |
| fix | step-fix-NN-<bug-summary>.md | step-fix-01-bridge-and-thresholds.md |
| verify | step-final-verify.md | step-final-verify.md |
| ship | step-ship.md | step-ship.md |

## 模板（强制 schema）

```markdown
# Step <step-id> — <title>

- 时间：YYYY-MM-DD HH:MM → HH:MM（耗时 X 分钟）
- worktree 状态：commit SHA `<hash>` on branch `<branch>`
- 类型：[code-phase-A | code-phase-B | audit-round | fix | verify | ship]
- 上游依赖 step：[step-XX] | 无（首 step）
- 下游影响 step：[step-YY] | 末 step

## 目标

<本 step 想达成什么具体结果>

## 工作内容

<具体做了哪些事，按时间序>

## 遇到的问题

- P1: <问题描述>
- P2: ...
（若无问题填「无」）

## 解决方案

- P1 → <对应解决方案>
- P2 → ...

## 验收标准

- [ ] 标准 1
- [ ] 标准 2
- ...

## 验收结果

- ✅ 标准 1: <如何满足、证据>
- ✅ 标准 2: ...

## 决策声明（强制填写）

- 擅自降级 audit 标准：**否** ✓
- 偷懒/跳步：**否** ✓
- 妥协/接受次优：**否** ✓
- **问题应修尽修（仅 fix / audit-round / verify / ship step 必填）**：**是** ✓（本 step 中暴露的所有问题都已修复 + verify 通过 + 满足「真正解决」硬标准） | **否**（列出未修问题 + 理由：仅「阿杜在 brainstorm 明示不修」是合法理由；其他都必须回头补修）
- **字段集合应审尽审（仅 audit-field-discovery + code-phase-B step 必填）**：**是** ✓（已按 4 来源穷举，所有候选字段都决策审 / 不审 + 派 review 验证完整） | **否**（说明哪些字段穷举不足 → 回头补 + 报告）
- **字段 5-attempt 充分搜索（仅 audit-field-path-design + code-phase-B step 必填）**：**是** ✓（已对每字段做满 5 次独立路径尝试 + 每字段写报告） | **否**（说明哪些字段尝试不足 → 回头补搜索 + 报告）

> 任何一项「是」（前 3 项）或「否」（第 4-6 项）必须详述 + 触发条件 + 兜底方案。本任务约定：检测到要打「是/否」必须先回 STEP 4 重做，**不允许 step 通过**。

## 后续影响

<本 step 输出对下一 step 的约束/输入>

## 产物清单

- code commits: <SHA list>（按时间序）
- new files: <path list>
- modified files: <path list>
- audit artifacts (if applicable): <path list>
```

## 决策声明 4 项的判定标准

**擅自降级 audit 标准**：

- ❌ 是的情况：
  - 把 audit 等式从 `expected === gt` 改成 `expected.includes(gt)` 或 `Math.abs(expected - gt) < tolerance`
  - 把 strict 字段 audit 改成 `skip` 或 `softCheck`
  - 在 audit-validator code 加 TODO / FIXME / HACK 标记 audit 跳过
- ✅ 否的情况：
  - threshold 校准（heuristic 范围内，e.g. ct6 textContent ≥ 50 → 20 因实测发现 50 太严）
  - 移除语义错的 GT（如 cbex `.jp_detail_bjnum` = 最高限价报价人数 ≠ 总报价次数，作 informational note 而非 pass criterion）— 这是「audit 信度修正」不是降级
  - GT null normalize 到 default 值（如 0），匹配 extractor 默认 fallback

**偷懒/跳步**：

- ❌ 是：少写 audit function / 缺 test / 跳过 fix loop 直接 final verify / 漏写 step report
- ✅ 否：按 plan 完成所有 task，每 step 都有完整 report

**妥协/接受次优**：

- ❌ 是：因为「修不动」用次优方案、用静默 fallback 隐藏问题、threshold 改到「能通过就行」程度
- ✅ 否：每个根因都修到位 + 修法符合设计原则

**字段集合应审尽审（仅 audit-field-discovery + code-phase-B step 必填）**：

- ❌ 否的情况:
  - 只查 1-3 个来源就 freeze 字段集合（没做满 4 来源）
  - 拿 cbex 33 字段直接套用，没按 site 重新穷举
  - 漏字段（漏审风险 >> 多审风险）
  - 没派 subagent / controller review 字段集合是否有漏
  - 不审字段没明示理由
- ✅ 是的情况:
  - 已从 4 个独立来源（markdown 全文 / extractor 源码 / fixture 用户视角 / 其他类似 site 清单）求并集
  - 每候选字段都决策「审 / 不审」+ 不审字段明示理由（严格度同 B 路径理由）
  - 已派 subagent review + controller 自己 grep 验证完整
  - 字段集合 freeze 后写进 spec § 4.0

**字段 5-attempt 充分搜索（仅 audit-field-path-design + code-phase-B step 必填）**：

- ❌ 否的情况:
  - 某字段只做 1-4 次尝试就接受 B 路径
  - 某字段「我觉得没有 A」直接跳过 attempt，没有逐一排查 10 类候选
  - 字段路径设计报告写得不完整（缺尝试详情 / 缺问题/解决 / 缺信度评估）
  - 报告中「Attempt N 失败」只写「未找到」未写具体原因
- ✅ 是的情况:
  - 每个 audit 字段都按 audit-design.md 模板写报告
  - 每字段至少 5 attempts 排查 ≥ 5 类候选
  - 找到 A 升 A；5 attempt 失败 + 实证「物理无第 2 source」才接受 B
  - 报告含 GT path 实现代码 + 信度评估

任何一项「是」（前 3 项）或「否」（第 4-6 项）必须先回 fix loop 重做，**不允许 step 通过**。

**「问题应修尽修」决策声明的详细判定标准**:

- ❌ 否的情况（不允许）:
  - 「这是 pre-existing bug 不归我管」「这是别的 worktree 遗留」
  - 加 try/catch 吞错 / 设静默 fallback 隐藏问题
  - 降 audit threshold 让 FAIL 变 PASS
  - 跳过字段 audit / 剔除已 freeze 字段
  - 标 TODO 留以后修，跑通就放过
  - 加 retry 100 次能 PASS 一次就当修了
  - 修 1 次失败放弃 → 接受次优 / 软化标准
- ✅ 是的情况:
  - 所有 step 暴露的问题（含 pre-existing / 其他 worktree 遗留）都已修
  - 每修都满足「真正解决」硬标准（根因清楚 + regression 全过 + sample audit 实测通过）
  - 修法失败 N 次都换方法继续，记录在 step-fix report「尝试方法」节
  - 唯一例外：阿杜在 brainstorm 明示「这次不修 X」 + 写入 spec § Out of Scope

详 `references/fix-loop.md` § 问题归属 + 应修尽修 SOP。

## 在 REPORT.md 全程审计追溯节的索引格式

每 step 在 REPORT.md 「全程审计追溯」表里一行：

```markdown
| <step-id> | <type> | [step-reports/step-<file>.md](step-reports/step-<file>.md) | <一句话摘要> |
```

例：
```markdown
| 02 | audit-round | [step-reports/step-02-audit-round-01.md](step-reports/step-02-audit-round-01.md) | Round 1 全 542: PASS 437 / FAIL 105 (主因 102 bid_count + 3 followers + 3 views + 2 section) |
```
