# Fix Loop — 自动诊断决策树 + SOP

Round 1 跑完，若 PASS < 100%，进 Fix Loop。Loop 无 round 上限，**禁止降级 audit 标准**。

## 问题归属 + 应修尽修 SOP（关键纪律）

### 问题归属判定

**核心规则**：在本 worktree 执行过程中**暴露**的任何问题，**都是本 worktree 需要解决的**。

**「不归我管」的常见错误想法**（cbex 任务真实暴露）：

| ❌ 错误想法 | ✅ 正确想法 |
|---|---|
| 「这是 pre-existing bug，不是我引入的」 | 「不管谁引入的，本 worktree 跑暴露 = 本 worktree 修」 |
| 「这是其他 worktree 遗留」 | 「在我跑的时候暴露了，就是我的 TODO」 |
| 「这是 extractor 缺陷我管不了」 | 「extractor 在 audit 中 FAIL，本 worktree 必须修 extractor」 |
| 「这是 audit 工具 bug 不影响 ship」 | 「audit 工具 bug 导致假 FAIL 也必须修」 |
| 「这是反爬触发不是代码 bug」 | 「反爬阻碍 audit 进行 = 本 worktree 必须搞定」 |
| 「这是 TS 编译警告不影响功能」 | 「webpack build 报 error 必修；warning 视情况修」 |

**例外（仅 1 种）**：阿杜在 brainstorm 明示「这次不修 X」 → 写进 spec § Out of Scope → 不修。其他都必修。

**cbex 任务真实案例**：
- Round 1 暴露 `e2e bridge 硬编码 description/image=""` 是 **pre-existing bug**（早期 weixin 任务时引入，与 cbex 无关）。**仍由 cbex 任务修复**（commit `f881ecfc`）。如果以「不归我管」推走，cbex audit 永远 fail。
- Phase B Task 8 暴露 `tsconfig.json rootDir` 限制使 cross-rootDir test 文件编译失败。**也是 pre-existing 设计缺陷**，新加测试文件暴露。**cbex 任务修了 tsconfig**（commit `3f64a32f`）。

### 应修尽修执行 SOP

每个暴露的问题走以下流程：

```
1. 列入本 worktree 「问题 TODO」清单
   - 写入 worktree-内的 .claude/<site>-batch-<listId>/issues.md 或 STEP report 的「遇到的问题」节
   - 不允许「记一下不处理」

2. 走根因诊断（fix-loop §5 类根因决策树）
   - 确认根因 + 影响范围 + 修复方案

3. 修代码 + verify
   - 改 extractor / audit / e2e / build / tsconfig（按根因）
   - commit fix
   - 跑 affected unit test
   - 跑 522611/522884 baseline regression
   - 跑 audit subset (上轮 FAIL IDs + 5 张随机 PASS 抽样) 防 regression

4. 若 step 3 失败（修法 1 不通）→ 换方法继续，绝不放弃
   - 在 step-fix report「尝试方法」节记录第 N 次尝试 + 失败原因
   - 换思路：参 § 换方法清单
   - **不允许「试 1 次不通就接受次优」**

5. 重复 4 直到问题真正解决
   - 验收标准：根因清楚 + 修复后所有 regression test 通过 + sample audit 实测确认

6. 写 step-fix-NN-<issue> report
   - 强制声明「问题真正解决」，不允许「workaround」「skip」「先这样」
```

### 修复失败时的「换方法清单」（不放弃）

修复失败时，按以下顺序换方法尝试，绝不放弃：

| 失败场景 | 换法 |
|---|---|
| extractor 改不通（如 selector 不准 / 字段语义错） | a) 改 audit-validator GT 适配该字段 b) 用第 2 条 GT 路径作主路径 c) 改 list-fetcher 解析作 GT d) 拉新后端 XHR 作 GT |
| audit GT 抓不出来 | a) 换不同 selector b) 换 inline JS 变量 c) 拉新后端 XHR d) body text regex 全文搜索 e) 跨 section cross-reference |
| TS 编译失败 | a) 改 tsconfig include/exclude/rootDir b) 用 type-only import c) 转 any 短期 + TODO 加测试 d) 拆 module |
| build webpack 失败 | a) 改 webpack.config.js entry / externals b) 加 module rule c) 改 tsconfig |
| e2e 反爬触发 | a) 加 jitter sleep (300-800ms) b) 换 UA / stealth args c) 加 cookie d) 降低并发到 1 e) 加 retry backoff |
| e2e bridge 拿不到字段 | a) 改 buildVariables 透传 b) 加 wait selector c) evaluate 等 inline JS 跑完 d) 改 content script 注入时机 |
| 测试因 fixture 不全失败 | a) 重新 curl 抓 fixture b) 多 IDs 抓多个 fixture 测试 c) 加测试 helper d) mock 不可避免依赖 |
| 多次尝试都不通 | 升级根因 6+（参 fix-loop.md §5 类根因决策树最后一类）：人肉查 hydrated.html + diffs.json + 浏览器实拍，扩展决策树到 7+ |

**关键**：清单不是穷尽的。任何字段 / 任何问题，都可以衍生出新方法。**核心：永不放弃**。

### 问题修复完成的硬标准

**「真正解决」≠「commit 了」**。完成的硬标准：

1. ✅ 根因明确写在 step-fix report（不是「不知道为什么但跑通了」）
2. ✅ 修复后 affected unit test 全过
3. ✅ 修复后 522611/522884 (或 site 对应 baseline) e2e 全过
4. ✅ 修复后 audit subset（上轮 FAIL IDs + 5 张抽样）全过
5. ✅ step-fix report 决策声明「妥协/接受次优 = 否」
6. ✅ 该问题加入 final verify 的回归覆盖

**「不算真正解决」的反面案例**：

- ❌「我加了 try/catch 吞掉错误，不报错就算修了」
- ❌「我把 audit threshold 改宽，不 FAIL 就算修了」
- ❌「我跳过了那个字段的 audit，其他都过就算修了」
- ❌「我标记 TODO 留给以后修，跑通就算修了」
- ❌「我加了 retry 100 次，能 PASS 一次就算修了」

任何看起来像 workaround 而非真修的 commit，本 worktree 验收**必须打回**重做。

## Sub-step 流程

每轮 Fix Loop 走以下 sub-step（cbex 任务实测有效）：

### Sub-step A: 聚类 FAIL

```bash
# 按字段聚类 FAIL
for f in .claude/<site>-batch-<listId>/diffs-fail/*.json; do
  jq -r '.fieldResults[] | select(.pass==false) | .field' "$f"
done 2>&1 | sort | uniq -c | sort -rn
```

Output 示例（cbex Round 1）：
```
 102 bid_count
   3 views
   3 followers
   1 section_竞价记录
   1 section_竞价结果
```

按字段 + 数量识别主因 vs 次因。

### Sub-step B: 抽样查根因

```bash
# 看 sample 失败详情
FIRST=$(ls .claude/<site>-batch-<listId>/diffs-fail/*.json | head -1)
jq '.fieldResults[] | select(.pass==false) | {field, expected, groundTruths}' "$FIRST"
```

对每个 FAIL field，走 §5 类根因决策树。

### Sub-step C: 修对应代码

按根因类型修：
- 根因 1 (extractor selector/regex 错) → `src/utils/<site>-extractor.ts`
- 根因 2 (audit validator normalize 不当) → `scripts/<site>-audit-validator.ts`
- 根因 3 (两份独立 source 真不一致) → 选「正确语义」那条作主 GT
- 根因 4 (audit GT 提取在某 status / 边界拿不到) → `scripts/<site>-audit-validator.ts` GT 提取逻辑
- 根因 5 (e2e bridge hydrated 不完整) → `scripts/e2e-clip-runner.ts` wait 策略
- 根因 6+ (未知模式) → 深挖（人肉查 hydrated.html + diffs.json + 浏览器实拍，扩展决策树）

**禁止**：因「根因不明」用降级 / 软 check / 容差 绕开。

### Sub-step D: 跑 affected unit test + 现有 baseline regression

```bash
npm test
npm run build:chrome && npm run test:e2e -- src/utils/<site>-extractor.e2e.test.ts
```

如新增 fix 破坏现有 baseline 断言（如字段值变化），按 fix 后实际值更新断言（**不是降级**，是反映正确语义）。

### Sub-step E: Commit fix

```bash
git add <changed files>
git commit -m "fix(<site>): <bug summary>

Root cause: <详述>

Fix: <详述>

Before: <state>
After: <state>"
```

### Sub-step F: 写 step-fix-NN report

参 step-report-template.md 格式。必填决策声明三项「否」。

### Sub-step G: Round N+1 (FAIL subset + sample)

```bash
# 拿上轮 FAIL IDs
FAIL_IDS=$(ls .claude/<site>-batch-<listId>/diffs-fail/*.json | xargs -I {} basename {} .json | tr '\n' ',' | sed 's/,$//')

# 加几张随机 PASS 抽样作 regression check（可选）
SAMPLE_IDS=$(jq -r '.items[].id' .claude/<site>-batch-<listId>/ids.json | shuf -n 5 | tr '\n' ',' | sed 's/,$//')

# 跑 subset
npx tsx scripts/<site>-batch-audit.ts \
  <listUrl> \
  .claude/<site>-batch-<listId>-round<N+1> \
  --ids "${FAIL_IDS},${SAMPLE_IDS}" \
  > .claude/<site>-batch-<listId>-round<N+1>/round-<N+1>.log 2>&1
```

### Sub-step H: 判定下一步

- subset 全 PASS → 跑 final verify (Phase C Task 19)
- subset 仍 FAIL → 回 Sub-step A

## 5 类根因决策树（详）

对每个 FAIL `{ id, field, expected, actual_GT1, actual_GT2, ... }`：

```
1) markdown 字段值 vs GT1 不等？

   ├─ markdown != GT1 && markdown != GT2 → 根因 1 (extractor 抓错)
   │   action: 修 src/utils/<site>-extractor.ts 对应字段提取
   │
   ├─ markdown == GT1 但 audit 判 FAIL → 根因 2 (audit validator 假 FAIL)
   │   action: 修 scripts/<site>-audit-validator.ts normalize 逻辑
   │   常见：
   │   - 时间格式不同（YYYY.MM.DD HH:mm vs YYYY-MM-DD HH:mm）
   │   - 价格单位（"¥30,000.00" vs 30000）
   │   - 空白字符（&nbsp; vs 空格）
   │
   ├─ markdown != GT1 == GT2 → 根因 1 (extractor 抓错，audit 对的)
   │   action: 同根因 1
   │
   └─ markdown == GT1 != GT2 → 根因 3 (两份独立 source 真不一致)
       禁止: 降级 audit / 软 check / 容差
       action: 深入分析为什么 GT1 ≠ GT2 →
         a) GT2 路径 selector 错（如 ct1 拿到了非 ct1 文本）→ 修 GT 提取
         b) cbex 后端两接口语义不同（如 list-item bdlist_side_num 跟
            wtList row count 实际语义不同）→ 选「正确语义」那条作主 GT，
            另一条作 verify 信号；extractor 抓错语义则修 extractor
         c) 其他 → 升根因 6+ 深挖

2) GT1 提取异常 (null/undefined/parse error)？
   → 根因 4 (audit GT 提取路径在某 status / 边界拿不到)
      action: 修 scripts/<site>-audit-validator.ts GT 提取逻辑
              考虑 status='ch' / 'lp' 等非主流 status 的 selector 形态差异

3) hydratedHtml 字段缺失？
   → 根因 5 (e2e bridge hydrated 不完整 / 时机不对)
      action: 修 scripts/e2e-clip-runner.ts wait 策略
              加更明确 wait selector / 加 evaluate 等到 inline JS 全跑完

4) 都不是？
   → 根因 6+ (未知模式)
      action: 不允许「算了」；必须深挖：
        - 人肉查 hydrated.html + diffs.json
        - 对比浏览器实拍跟 e2e snapshot 差异
        - 查 cbex 后端模板源码（view source mode）
        - 扩展决策树到根因 6/7/8...
      禁止: 因「根因不明」PASS / 软 check
```

## cbex 任务实测的根因案例

### 案例 1: bid_count 语义错（根因 1 + 3）

- markdown=10 (extractor 用 `.jp_detail_bjnum span`) ≠ list-item bdlist_side_num=11 ≠ wtList row count=11
- GT1 == GT2 但 markdown != GT1 → 根因 1
- 深入：`.jp_detail_bjnum` 语义是「最高限价报价人数」（cap-price bidders），不是总 bid count
- Fix: extractor 用 wtList row count override `top.stats.bid_count`
- 衍生发现：wtList API 默认 pageSize=10，高 bid count 标的（522611 = 265 bids）只返回首页 → 加 `&pageSize=10000`
- 进一步发现：wtList HTML 含 1 个 thead `<tr>` + N data rows → 减 1 排除 thead
- 移除 audit GT3（`.jp_detail_bjnum`）作 pass criterion（语义不同），保留作 informational note

参 cbex 任务 step-fix-02-bid-count-semantic.md。

### 案例 2: followers/views null vs 0（根因 4）

- 撤回状态页面无 `(\d+)人关注` text → audit GT1 = null
- markdown 用 extractor 默认 fallback = 0
- expected (0) ≠ GT (null) → FAIL
- Fix: audit normalize null → 0（匹配 extractor default）

### 案例 3: e2e bridge description/image 硬编码空（根因 5）

- e2e bridge `buildVariables({ description: '', image: '' })` 硬编码空，没传 extractor 的值
- markdown frontmatter `description: ` 空
- audit expect description === subject_id（fm 关联字段）→ FAIL
- Fix: bridge 改 `description: (result as any)?.description || ''`

### 案例 4: section 空数据仍 emit（根因 1）

- extractor 用 `if (wtListRaw)` 判 wtList 非空 emit 「## 竞价记录」section
- wtListRaw 是 thead-only HTML（无 data rows）也 truthy → emit 但内容空
- 撤回状态实际 0 bids → markdown 有 section 但 audit GT 用 data row count = 0 → FAIL
- Fix: extractor 改 `if (wtDataRowCount > 0)` 判 data row 数

## 防 regression 纪律

每次 fix subagent 派 prompt 必须含：

```
## CRITICAL: Don't undo previous task work

Tasks <列出已完成 task 编号> already added:
- <字段 X 在文件 Y 的 L<num>>
- <字段 Y 在文件 Z 的 L<num>>
- ...

**DO NOT TOUCH any of those.** This task only ADDS new things.
```

cbex 任务 Task 2 暴露：implementer 错把 Task 2 当 "move" 而不是 "add"，删了 Task 1 的字段。Spec reviewer 漏判定，Quality reviewer 反而合理化删除。Controller 必须自己 spot-check git diff。

## 不允许的 fix 决定

- ❌ threshold 改到「能通过就行」程度（如 ct6 ≥ 50 改 ≥ 1 字）
- ❌ 加 `try {} catch { return PASS }` 静默吞错
- ❌ 把 audit 字段从 strict equality 改成 `contains` / `startsWith` / `softEqual`
- ❌ 删 audit function（除非确认该字段真的不在 markdown 出现）
- ❌ 用「fixture 没覆盖」理由跳过实际页面验证
