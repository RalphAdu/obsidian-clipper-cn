# cbex/jpxkc 批量 audit — 京牌小客车 zc_prjs/2238 (542 标的) Design Spec

- **日期**：2026-05-30
- **依赖**：cbex extractor 已 ship（参 BACKLOG §2.26 / 已 merge 至 main）
- **触发任务**：阿杜要求对 `zc_prjs/2238.html` 列表下所有 542 个 detail URL 跑批量 e2e 裁剪 + 完整内容对比 audit，PASS 率必须 100% 才出 REPORT.md
- **关联约束**：
  - [[feedback_feature_ship_workflow]] worktree 强制；本任务额外约定**整个流程仅一次阿杜介入**（最后审 REPORT.md）
  - [[feedback_extractor_acceptance]] 不许擅自 PASS / 不许悄悄降级
  - [[feedback_e2e_bridge_path_double_wire]] Phase A 改 extractor 主路径必同步改 e2e bridge
  - [[feedback_specs_plans_local_only]] spec 进 git，本次 audit artifacts 通过 .gitignore 不进 git 但同步到 main 持久保留

---

## 1. 目标与约束

### 1.1 目标

对 `https://jpxkc.cbex.com/jpxkc/zc_prjs/2238.html` 列表页所有 542 个 detail URL：

1. 跑真 chrome + 已 build 扩展的 e2e 裁剪
2. 把 markdown 全部保留盘
3. 对每张 markdown 做「**完整内容对比**」audit（33 audit point × 542 张 = 17,886 个 audit check），全部 PASS
4. 产出 REPORT.md（阿杜唯一一次介入审）+ 33-point 字段统计 + 全程 step report 审计追溯
5. 阿杜审过后合并 main + push + artifact 同步到 main 持久保留 + 清理 worktree

### 1.2 Scope（in）

- 修 cbex-extractor 的 wire 缺陷（`buildCbexFrontmatter` dead code、`end_time` 字段未输出到 markdown）
- 新增 5 个 scripts（list fetcher / audit validator / report builder / batch orchestrator / e2e batch runner 改造）
- 自动闭环：跑 audit → 修任何根因 → 重跑直到 PASS=100%
- 全程审计追溯：每 step 留 step report

### 1.3 Scope（out — 但记入 follow-up）

- 跨 listId 复用（本任务 hardcode listId=2238；但 scripts/cbex-list-fetcher.ts 设计成接受 listUrl 参数支持复用）
- cbex extractor 的非本次任务暴露的优化（仅修 audit FAIL 暴露的 root cause）
- 视觉 audit（本任务用结构 + 字段对比，无截图比对）

### 1.4 关键约束

| ID | 约束 | 来源 |
|---|---|---|
| C1 | 全自动闭环；除最终审 REPORT.md 外**0 次阿杜介入** | 阿杜本任务明示 |
| C2 | PASS 率必须 **100%** 才出 REPORT.md | 阿杜本任务明示 |
| C3 | **禁止**降级 audit 标准 / 偷懒 / 妥协 / 软 check / 容差放宽 | 阿杜本任务明示 |
| C4 | 任何 FAIL 必须深入分析根因，5 类决策树都不适用就深挖 6+ 类，**无 round 上限** | 阿杜本任务明示 |
| C5 | 每 step 留独立 step report (md)，含「决策声明」节强制填「擅自降级/偷懒/妥协」三项 | 阿杜本任务明示 |
| C6 | audit artifacts 同步到 main 持久保留（但不进 git，通过 `.gitignore` 排除） | 阿杜本任务明示 |
| C7 | worktree 强制：`.claude/worktrees/cbex-batch-audit/` | [[feedback_feature_ship_workflow]] |
| C8 | Phase A 改 extractor 主路径 = 必同步改 e2e bridge（双 wire） | [[feedback_e2e_bridge_path_double_wire]] |
| C9 | ship 锁 FIFO + session 隔离接力 | [[feedback_ship_lock_mechanism]] |
| C10 | git push adu 可主动；git push origin 不允许；本任务可主动合 main（阿杜审过 REPORT.md 后） | [[user_collab_norms]] + 本任务明示 |

---

## 2. 架构与文件布局

### 2.1 代码改动（进 git）

```
src/utils/
├─ cbex-extractor.ts                          ← Phase A 改：CbexFrontmatterInput +end_time;
│                                               buildCbexFrontmatter 输出 end_time:
├─ cbex-extractor.test.ts                     ← Phase A 扩 end_time 单测
└─ cbex-audit-validator.test.ts               ← Phase B 新增（fixture-based 单测）

src/content.ts                                ← Phase A 改主路径 + e2e bridge 双 wire
                                                buildCbexFrontmatter 替换硬编码 frontmatter

scripts/
├─ e2e-clip-runner.ts                         ← Phase B 小改：增 runRealClipBatch
├─ cbex-list-fetcher.ts                       ← Phase B 新增
├─ cbex-audit-validator.ts                    ← Phase B 新增
├─ cbex-audit-report.ts                       ← Phase B 新增
└─ cbex-batch-audit.ts                        ← Phase B 新增（CLI 入口）

.gitignore                                    ← 加 ".claude/cbex-batch-2238/" 一行
```

### 2.2 Audit Artifacts 路径（不进 git，持久保留）

```
.claude/cbex-batch-2238/                     ← 全 .gitignored
├─ REPORT.md                                  ← 最终报告
├─ ids.json                                   ← 542 ID 列表 + 每 ID 的 list-item HTML snapshot
├─ progress.json                              ← Round 跑时实时进度
├─ markdown/
│   ├─ 521474.md
│   ├─ 521849.md
│   └─ ... (542 张)
├─ diffs-fail/                                ← Round 中间产物；final round 应为空
│   └─ <ID>.json
├─ hydrated-fail/                             ← Round 中间产物；final round 应为空
│   └─ <ID>.html
└─ step-reports/
    ├─ step-01a-phase-a-extractor-wire.md
    ├─ step-01b-phase-b-batch-tool.md
    ├─ step-02-audit-round-01.md
    ├─ step-fix-NN-*.md
    ├─ ... (N 份)
    └─ step-final-verify.md
```

### 2.3 文件职责

| 文件 | 职责 |
|---|---|
| `scripts/cbex-list-fetcher.ts` | `fetchListIds(listUrl: string): Promise<{ id: string; listItemHtml: string }[]>` — POST `/page/jpxkc/zc_prjs/prj_li` 分页拉全 IDs + 保留每个 list-item HTML（用作 audit 独立 ground truth source 之一） |
| `scripts/cbex-audit-validator.ts` | `validateClip(markdown: string, hydratedHtml: string, listItemHtml: string, detailUrl: string, ggnrXhr: string, wtListXhr: string, jjjgXhr: string): AuditResult` — 33-point 字段级 audit |
| `scripts/cbex-audit-report.ts` | `buildReport(results: AuditResult[], stepReports: StepReportMeta[], stats: BatchStats): string` — REPORT.md generator |
| `scripts/cbex-batch-audit.ts` | CLI 编排：fetchListIds → runRealClipBatch → 对每 ID 做 audit XHR 重抓 + validate → 检 PASS 率 → 若 < 100% 自动调用根因诊断 + 修代码 + Round N+1 → 出 REPORT.md |
| `scripts/e2e-clip-runner.ts`（改） | 增 `runRealClipBatch(urls: string[], opts): Promise<ClipResult[]>` — 单 chromium 实例 + 每 URL 新 page 复用，性能 ~3x |

---

## 3. 数据流

### 3.1 单张 audit 的数据流

```
detailUrl: https://jpxkc.cbex.com/jpxkc/prj/detail/{ID}.html

  ↓ clip in batch session (复用 chromium)
clip = {
  markdown: string,         ← e2e bridge 跑 extractor 出的 markdown（frontmatter + body）
  hydratedHtml: string,     ← document.documentElement.outerHTML 那刻 snapshot
  durationMs: number
}

  ↓ audit-time XHR refetch (独立路径 ground truth)
ggnrXhr   = POST /page/jpxkc/prj/ggnr        body=BDID=<bdid>
wtListXhr = POST /page/jpxkc/prj/wtListPaging body=cpdm=<prjId>&zgxj=<zgxj>&type=all
jjjgXhr   = POST /page/jpxkc/prj/jjjgListPaging body=id=<prjId>&jjcc=<jjcc>&pageNo=1&pageSize=10

  ↓ listItemHtml (来自 Phase 1 拉的 ids.json)
listItemHtml: <li id="prj_li_{ID}" ...>...</li>

  ↓ validateClip(...)
auditResult = {
  id: string,
  pass: boolean,             ← 33 audit point 全 PASS 才 true
  fieldResults: [{
    field: string,
    pass: boolean,
    expected: string,         ← markdown 值
    groundTruths: [
      { source: 'list-item', value: string, match: boolean },
      { source: 'col-span',  value: string, match: boolean },
      { source: 'body-regex', value: string, match: boolean },
      // ...
    ],
    note: string?
  }],
  attempts: number,           ← e2e_error 重试次数
  durationMs: number
}
```

### 3.2 Round 流程

```
$ npx tsx scripts/cbex-batch-audit.ts \
    https://jpxkc.cbex.com/jpxkc/zc_prjs/2238.html \
    .claude/cbex-batch-2238

Phase 1: fetchListIds
  POST /page/jpxkc/zc_prjs/prj_li pageSize=100 × 6 pages → 542 unique IDs
  write ids.json = [{ id, listItemHtml }, ...]

Phase 2: Round 1
  startBatchSession(chromium, dist/ extension)
  for each id in ids:
    for attempt in 1..3:
      try { clip = clipInSession(detailUrl, wait=.bd_detail_name, timeout=120s); break }
      catch { sleep [5, 10, 20][attempt-1] sec }
    if all attempts failed:
      record { id, status: 'e2e_error', error, attempts: 3 }
      continue
    write markdown/{id}.md ← clip.markdown
    audit-time XHR refetch ggnr/wtList/jjjg (retry × 3)
      if all 3 retries failed: status='audit_infrastructure_error'
    auditResult = validateClip(markdown, hydratedHtml, listItemHtml, detailUrl, xhrs)
    if !auditResult.pass:
      write diffs-fail/{id}.json + hydrated-fail/{id}.html
    write progress.json (incremental)
  endBatchSession

Phase 3: PASS rate check
  if pass count < 542:
    enter STEP 4 (auto-diagnose + fix loop)
  else:
    proceed to Phase 6 (final verify)

Phase 4: 自动诊断 + 修复（见 §7）
Phase 5: Round N+1 (only failed subset + sample) → 若 subset PASS 跑 full → Phase 3

Phase 6: Final verify
  Round 全跑 → PASS=100% → 写 REPORT.md

Phase 7: 报阿杜审 REPORT.md（**唯一介入点**）

Phase 8: 阿杜「通过」→ ship + artifact 同步 + worktree 清理
```

---

## 4. Audit 字段表（33 audit point）

每个 audit point 写明：
- **GT 列**：Ground truth 提取代码思路（可有多条独立 A 路径 = 双重 A）
- **Audit 等式**：何时判 PASS

### 4.1 Frontmatter 字段（9 个）

| # | 字段 | Ground truth | Audit 等式 |
|---|---|---|---|
| 1 | `title` | GT1: `hydratedDoc.querySelector('title').textContent.replace(/^北交互联-/, '').trim()`<br>GT2: `listItemDoc.querySelector('a.title').textContent.trim()`<br>GT3: `hydratedDoc.querySelector('.bd_detail_name').textContent.trim()` | `fm.title === GT1 === GT2 === GT3` (normalize 空白后) |
| 2 | `source` | GT: `detailUrl` (e2e 输入) | `fm.source === GT` |
| 3 | `subject_id` | GT1: `listItemDoc.querySelector('.cont .info p').match(/标的物编号：(.+)/)[1]`<br>GT2: `hydratedDoc.querySelector('.bd_detail_num').textContent.replace(/^标的物编号：/, '').trim()` | `fm.subject_id === GT1 === GT2` |
| 4 | `status` | GT1: `STATUS_MAP[listItem.dataset.style]` (cj→`成交` / ch→`已撤回` / ...)<br>GT2: `listItemDoc.querySelector('.label_state_*').textContent`<br>GT3: `hydratedDoc.querySelector('.state_mark').textContent.trim()` | `fm.status === GT1 === GT2 === GT3` |
| 20 | `published` | GT: derived = `fm.bid_start` | `fm.published === fm.bid_start` |
| 21 | `description` | GT: derived = `fm.subject_id` | `fm.description === fm.subject_id` |
| 22 | `author` | GT: 空（cbex 无作者） | `fm.author === '' || fm.author === undefined` |
| 23 | `tags` | GT: `['clippings']` | `JSON.stringify(fm.tags.sort()) === '["clippings"]'` |
| 24 | `created` | GT: `dayjs().format('YYYY-MM-DD')` (today) | `/^\d{4}-\d{2}-\d{2}$/.test(fm.created) && fm.created === today` |

### 4.2 价格字段（5 个，全双重 A）

| # | 字段 | Ground truth | Audit 等式 |
|---|---|---|---|
| 5 | `final_price` (status='成交' 出现) | GT1: `listItem.querySelector('.info p:contains("成交价") span').textContent.replace(/[¥,]/g,'')`<br>GT2: bodyText regex `本标的物成交价：[¥￥]?([\d,.]+)` | status='成交' → `parseFloat(fm.final_price) === parseFloat(GT1) === parseFloat(GT2)`；其他 status → markdown 必无该字段 |
| 6 | `start_price` | GT1: `hydratedDoc.querySelector('.col')` 中 textContent 含「起始价」的 → 提取 `[¥￥]?([\d,.]+)`<br>GT2: bodyText regex `起始价：[¥￥]?([\d,.]+)` | `parseFloat(fm.start_price) === parseFloat(GT1) === parseFloat(GT2)` |
| 7 | `assess_price` | GT1: `.col` 含「评估价」<br>GT2: bodyText regex `评估价：` | 同 6 结构 |
| 8 | `cap_price` | GT1: inline JS `\bzgxj\s*[:=]\s*['"]?(\d+\.?\d*)`<br>GT2: `.col` 含「最高限价」<br>GT3: list-item `<p>最高限价：</p>` | `fm.cap_price === GT1 === GT2 === GT3` (triple A) |
| 9 | `deposit` | GT1: `.col` 含「保证金」<br>GT2: bodyText regex `保证金：` | 同 6 结构 |

### 4.3 时间字段（3 个，全双重 A）

| # | 字段 | Ground truth | Audit 等式 |
|---|---|---|---|
| 10 | `bid_start` | GT1: `.col` 含「竞价开始时间」textContent → regex `(\d{4})[.\-](\d{1,2})[.\-](\d{1,2})\s+(\d{1,2}):(\d{2})`<br>GT2: bodyText regex 同上 | `normalizeDateTime(GT1) === fm.bid_start === normalizeDateTime(GT2)` |
| 11 | `signup_end` | GT1: `hydratedDoc.querySelector('.jp_detail_joininfo .cont p .color_theme.fwb').textContent.match(/(\d{4})年(\d{1,2})月(\d{1,2})日(\d{1,2})时(\d{1,2})分/)`<br>GT2: bodyText regex `报名及保证金报名费交纳截止时间：` | 同 10 结构 |
| 12 | `end_time` | GT1: `listItem.querySelector('.time').textContent.match(/结束时间：(.+)/)[1]`<br>GT2: 5 个 `.bd_detail_state_over .time_num` 拼接 (year-month-day hour:min) | `fm.end_time === GT1 === GT2` |

### 4.4 统计字段（3 个）

| # | 字段 | Ground truth | Audit 等式 |
|---|---|---|---|
| 13 | `bid_count` | GT1: `parseInt(listItem.querySelector('.bdlist_side_num').textContent)`<br>GT2: `wtListXhr` 解析 `<tr>` 行数<br>GT3: `hydratedDoc.querySelector('.jp_detail_bjnum span').textContent` | `fm.bid_count === GT1 === GT3` (extractor 路径)；并必须 `GT1 === GT2` (语义验证 — 若 不等暴露 extractor 抓的 .jp_detail_bjnum 语义不对) |
| 14 | `followers` | GT1: bodyText regex `(\d+)人关注`<br>GT2: `hydratedDoc.querySelector('#focusPrj_countId').textContent` | 同源 snapshot → `fm.followers === GT1 === GT2` strict equality（e2e bridge 在 clip 那刻 hydrated DOM 跟 markdown 同时 snapshot，followers 这种动态值在同 snapshot 内必相等） |
| 15 | `views` | GT1: bodyText regex `(\d+)次围观`<br>GT2: `span.num + textNode(/次围观/)` 提取 | 同 14 结构 |

### 4.5 关联字段（1 个）

| # | 字段 | Ground truth | Audit 等式 |
|---|---|---|---|
| 16 | `image` | GT1: `listItem.querySelector('a.thum img').dataset.original`<br>GT2: inline JS `tpzslist[0]` | `fm.image` 跟 `absoluteUrl(GT1)` 或 `absoluteUrl(GT2)` 之一精确匹配（缩略图跟大图 path 可能不同但同 file ID 前缀） |

### 4.6 Buyer 字段（3 个，仅 status='成交' 出现，全双重 A）

| # | 字段 | Ground truth | Audit 等式 |
|---|---|---|---|
| 17 | `buyer.lottery_code` | GT1: `Array.from(hydratedDoc.querySelectorAll('.jp_detail_jjinfo .cont span')).find(s => s.textContent.startsWith('摇号申请编码：')).textContent.replace(/^摇号申请编码：/, '').trim()`<br>GT2: bodyText regex `(?:买受人)?摇号申请编码：(\d+)` | 关键信息表 row「买受人摇号编码」=== GT1 === GT2；status≠成交 时 markdown 必无该 row |
| 18 | `buyer.lottery_count` | GT1: `.cont span` 摇号次数<br>GT2: bodyText regex | 同 17 结构 |
| 19 | `buyer.lottery_registered` | GT1: `.cont span` 摇号注册时间<br>GT2: bodyText regex | 同 17 结构 |

### 4.7 ct2 图片相关（1 个）

| # | 字段 | Ground truth | Audit 等式 |
|---|---|---|---|
| 25 | ct2 image count | GT1: `hydratedDoc.querySelectorAll('img[bimg]').length`<br>GT2: inline JS tpzslist concat array length (参 `extractTpzslist` form 2 regex) | `markdownImgCount === GT1 === GT2`; 且每张 markdown 图 URL 都能在 `querySelectorAll('img[bimg]').map(el=>el.getAttribute('bimg'))` 列表里找到（file ID 子串匹配，因 `_NDAwLDQwMA==.jpg` 这种缩略图后缀有变种） |

### 4.8 Section 存在性（8 个）

| # | section | Ground truth | Audit 等式 |
|---|---|---|---|
| 26 | `## 关键信息` | 无条件必有（extractor 永远输出） | `markdownHasSection('## 关键信息')` |
| 27 | `## 标的物介绍` | GT1: `hydratedDoc.querySelector('a[href="#bd_detail_tab_ct1"]')` 存在<br>GT2: `#content_BDWJS.value` decode 后 textContent 长度 ≥ 100 字 | (GT1 ∧ GT2) → markdown 必有该 section；反 → 必无 |
| 28 | `## 图片展示` | GT: `hydratedDoc.querySelectorAll('img[bimg]').length > 0` | GT → markdown 必有；反 → 必无 |
| 29 | `## 司法处置公告` | GT: `audit 重抓 ggnrXhr` textContent ≥ 50 字 | GT → markdown 必有；XHR 3 次重试失败 → 整张 status='audit_infrastructure_error' |
| 30 | `## 竞买须知` | GT1: `hydratedDoc.querySelector('a[href="#bd_detail_tab_ct5"]')` 存在<br>GT2: `#bd_detail_tab_ct5` innerHTML textContent ≥ 100 字 | (GT1 ∧ GT2) → markdown 必有 |
| 31 | `## 竞价记录` | GT: `audit 重抓 wtListXhr` 含 `<tr` count ≥ 1 | GT → markdown 必有；XHR 3 次失败 → infra err |
| 32 | `## 竞价结果` | GT: `audit 重抓 jjjgXhr` 非空 textContent ≥ 50 字 | GT → markdown 必有；XHR 3 次失败 → infra err |
| 33 | `## 联系方式` | GT1: `a[href="#bd_detail_tab_ct6"]` 存在<br>GT2: `#bd_detail_tab_ct6` innerHTML textContent ≥ 50 字 | (GT1 ∧ GT2) → markdown 必有 |

### 4.9 Audit 信度小结

- 33 audit point **全部 A 路径**（无 B+sec / 无软 check）
- 约 **22 个 audit point 有双重或更高 A**（GT1 + GT2 [+ GT3] 互相校验）：#1, #3, #4, #5-9, #10-12, #13-15, #16, #17-19, #25, #27, #30, #33
- 约 **11 个单 A**：
  - 6 个 **derived/trivially fixed**：#2 source, #20 published, #21 description, #22 author, #23 tags, #24 created
  - 3 个 **后端 XHR 重抓**（独立后端调用作为 ground truth）：#29 司法处置公告, #31 竞价记录, #32 竞价结果
  - 2 个 **结构推断**：#26 ## 关键信息存在性（无条件必有）, #28 ## 图片展示存在性（img[bimg] count > 0 判断）

---

## 5. REPORT.md 报告格式

模板见 §8 验收 checklist 一节嵌入的样例。关键节：

1. **验收 checklist**（A1-F3 全 ✅ 才能签字）
2. **总览**（PASS/FAIL/e2e_error/audit_infra_err 4 类计数）
3. **字段 audit 统计表**（33 audit point × 542 张 在 GT1/GT2 通过率）
4. **决策声明汇总**（擅自降级 0 / 偷懒 0 / 妥协 0）
5. **全程审计追溯**（每 step report 链 + 摘要）
6. **extractor follow-up 建议**（audit 暴露的 extractor 改进点，供下个 worktree spec）

---

## 6. 全自动闭环流程（无介入、无降级）

### 6.1 整体步骤

```
STEP 1: 写代码（worktree 内）
  ├─ Phase A: 修 extractor wire
  │   - CbexFrontmatterInput +end_time?: string
  │   - buildCbexFrontmatter 输出 end_time: 行（条件 push）
  │   - content.ts 主路径：cbex 分支 fmExtra 改用 buildCbexFrontmatter 完整 17 行
  │   - content.ts e2e bridge：同步改（双 wire）
  │   - cbex-extractor.test.ts 扩 end_time
  │   - 加 .gitignore: ".claude/cbex-batch-2238/"
  │
  └─ Phase B: 写批量工具
      - scripts/cbex-list-fetcher.ts + test
      - scripts/cbex-audit-validator.ts + test (src/utils/cbex-audit-validator.test.ts)
      - scripts/cbex-audit-report.ts
      - scripts/cbex-batch-audit.ts
      - scripts/e2e-clip-runner.ts: runRealClipBatch
  
  Self-check: npm test PASS ∧ npm run test:e2e PASS (522611/522884) ∧ npm run build:chrome 成功
  失败 → 自查代码 → 重跑直到通过 → 留 step-01a / step-01b report

STEP 2: Round 1 — 跑全 542 张 audit（worktree 内）
  - 创建 step-02-audit-round-01.md

STEP 3: PASS=100% ?
  YES → STEP 6
  NO  → STEP 4

STEP 4: 自动诊断 + 修 root cause（见 §7 决策树）
  对每个 FAIL field 走 5 类决策树 → 修对应代码 → commit (本地 worktree branch)
  → 跑 affected unit test + 522611/522884 e2e regression
  → 留 step-fix-NN-<bug-summary>.md report
  禁止降级 audit 标准；禁止 round 上限触发 give-up；禁止报阿杜介入

STEP 5: Round N+1 — 只跑上轮 FAIL 子集 + 5 张抽样 (regression 防护)
  → subset 全 PASS → 跑全 542 final verify → STEP 3
  → subset 仍 FAIL → STEP 4
  留 step-NN-audit-round-NN.md report

STEP 6: Final verify 跑全 542（在 worktree 内）+ 生成 REPORT.md
  Pre-condition: npm run build:chrome 重新跑（用当前 worktree HEAD 的 extractor）
  Run: npx tsx scripts/cbex-batch-audit.ts <listUrl> .claude/cbex-batch-2238 --final-verify
  Outputs: REPORT.md
  留 step-final-verify.md report

STEP 7: 报阿杜审 REPORT.md（**唯一阿杜介入点**）
  消息格式见 Design § 6 STEP 7

STEP 8: 阿杜回「通过」之后
  ├─ 8.1: 抢 .ship-lock.json (O_EXCL atomic)
  ├─ 8.2: rsync 代码 worktree → main (9 代码文件 + .gitignore)
  ├─ 8.3: rsync audit artifacts → main/.claude/cbex-batch-2238/ (不进 git)
  ├─ 8.4: git add 代码 + .gitignore → git commit
  ├─ 8.5: sanity (npm test + npm run test:e2e + npm run build:chrome)
  │       失败 → 回滚 commit → 回 STEP 4
  ├─ 8.6: git push adu (不 push origin)
  ├─ 8.7: release ship 锁
  └─ 8.8: 清理 worktree
        - git worktree remove .claude/worktrees/cbex-batch-audit
        - 删 worktree branch
        - main/.claude/cbex-batch-2238/ 永久保留（与 worktree 解耦）
        - 留 step-ship.md report
        - 报阿杜「ship + artifact 持久化 + worktree 清理 完毕」
```

### 6.2 跨 round 性能优化

- Round 1 跑全 542（用 runRealClipBatch 复用 chromium：~5s 启动 + 542 × 15s ≈ 2h 15m）
- Round 2..N 只跑上轮 FAIL 子集 + 5 张抽样（少数情况：~5min 一轮）
- final verify 跑全 542（~2h 15m）

总耗时：理想 ~2-3h，多轮 fix 可能 ~5-8h（视 bug 复杂度）。后台跑，阿杜不需在线。

### 6.3 修 bug 不引入 regression

每次 STEP 4 修代码后必须跑：

1. 改动文件对应 unit test（如改 extractor → cbex-extractor.test.ts）
2. 522611 + 522884 e2e baseline（防 extractor 改坏既有通过用例）
3. Round N FAIL 子集 + 5 张随机 PASS 抽样（防修一个 bug 引入另一个）

全通过才能进 Round N+1。

---

## 7. 自动诊断决策树 + Step Report 机制

### 7.1 5 类根因决策树

对每个 FAIL `{ id, field, expected (markdown), groundTruths: [{ source, value, match }] }`：

```
1) markdown 字段值 vs GT1 不等 ?
   ├─ markdown ≠ GT1 ∧ markdown ≠ GT2 → 根因 1 (extractor 抓错)
   │   action: 修 src/utils/cbex-extractor.ts 对应字段 selector/regex
   │
   ├─ markdown == GT1 但 audit 判 FAIL → 根因 2 (audit validator 假 FAIL)
   │   action: 修 scripts/cbex-audit-validator.ts normalize
   │
   ├─ markdown ≠ GT1 == GT2 → 根因 1 (extractor 抓错，audit 路径选对)
   │   action: 同根因 1
   │
   └─ markdown == GT1 ≠ GT2 → 根因 3 (两份独立 source 真不一致)
       禁止: 降级 audit / 软 check / 容差
       action: 深入分析为什么 GT1 ≠ GT2 →
         a) GT2 路径 selector 选错（如 ct1 文本拿到了非 ct1 文本）→ 修 GT 提取
         b) cbex 后端两接口逻辑不一致（如 list-item bdlist_side_num 跟
            wtList row count 语义不同）→ 选「正确语义」那条作主 GT，
            另一条作 verify 信号；extractor 选错语义则修 extractor
         c) 其他 → 升根因 6+ 深挖

2) GT1 提取异常 (null/undefined/parse error) ?
   → 根因 4 (audit GT 提取路径在某 status / 边界拿不到)
      action: 修 scripts/cbex-audit-validator.ts GT 提取逻辑
              考虑 status='ch' / 'lp' 等非主流 status 下 selector 形态差异

3) hydratedHtml 字段缺失 ?
   → 根因 5 (e2e bridge hydrated 不完整)
      action: 修 scripts/e2e-clip-runner.ts wait 策略
              加更明确 wait selector / 加 evaluate(等到 inline JS 全部跑完)

4) 都不是 ?
   → 根因 6+ (未知模式)
      action: 不允许"算了"；必须深挖：
        - 人肉查 hydrated.html + diffs.json
        - 对比浏览器实拍跟 e2e snapshot 差异
        - 查 cbex 后端模板源码（如 view source 模式）
        - 扩展决策树到根因 6/7/8...
      禁止：因「根因不明」而 PASS 或软 check
```

### 7.2 Step Report 强制 schema

**目录**：`.claude/cbex-batch-2238/step-reports/`

**命名规则**：

| 类型 | 文件名格式 |
|---|---|
| 代码 step | `step-NN<a/b>-<phase-name>.md` |
| audit round | `step-NN-audit-round-NN.md` |
| fix step | `step-fix-NN-<bug-summary-kebab>.md` |
| final verify | `step-final-verify.md` |
| ship | `step-ship.md` |

**模板**：

```markdown
# Step NN — <title>

- 时间：2026-MM-DD HH:MM:SS → HH:MM:SS (耗时 X 分钟)
- worktree 状态：commit SHA <hash> on branch worktree-cbex-batch-audit
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

> 任何一项「是」必须详述 + 触发条件 + 兜底方案。本任务约定：检测到要打「是」必须先回 STEP 4 重做，**不允许 step 通过**。

## 后续影响

<本 step 输出对下一 step 的约束/输入>

## 产物清单

- code commits: <SHA list>
- new files: <path list>
- modified files: <path list>
- audit artifacts (if applicable): <path list>
```

### 7.3 Step Report 在 REPORT.md 的索引

REPORT.md 「全程审计追溯」节按时间序列出每个 step report 链接 + 一句摘要，便于阿杜验收时点入查证。

---

## 8. 阿杜最终验收 checklist（A1-F3）

REPORT.md 顶部固定该 checklist。阿杜审时按它逐条核对，**任何一条不通过都不签字**。

### A. 数据完整性

- A1. 列表 ID 总数 = `N`（理论 542；若 cbex 中途下架某 ID 走 §10.1 流程从集合移除，则 N < 542。REPORT 总览必须明示 N + 移除 ID 清单 + 移除原因）
- A2. markdown/ 目录文件数 = N（无遗漏）
- A3. ids.json 含全 N 个 ID + 每个 ID 对应的 list-item HTML snapshot
- A4. 每张 markdown 都通过 33 audit point（PASS=100% / N=N）
- A5. e2e_error = 0
- A6. audit_infrastructure_error = 0

### B. Audit 标准未被降级（强制审计）

- B1. REPORT「决策声明汇总」标明：擅自降级 0 / 偷懒 0 / 妥协 0
- B2. 所有 step reports 的「决策声明」节全填「否」
- B3. scripts/cbex-audit-validator.ts 不含 TODO / FIXME / HACK / 「容差」「软 check」「skip」类注释
- B4. 33 audit point 中无任何字段从 strict equality 降为 contains / soft / skip（git log 比对最终版 vs 初版 validator code）

### C. 闭环完整性

- C1. step-reports/ 含每一 round + 每一 fix 的 report
- C2. Round 编号无空洞；从 Round 1 到 final-verify 完整有序
- C3. 每个 fix step report 关联回触发的 Round FAIL 列表 + 修复后下一 round 验证结果
- C4. final-verify step 的 audit 结果跟 REPORT 总览数字一致

### D. 代码质量

- D1. npm test PASS
- D2. npm run test:e2e PASS (522611 + 522884 baseline)
- D3. npm run build:chrome 成功
- D4. Phase A 改 extractor 主路径 + e2e bridge 双 wire（git diff 体现）
- D5. cbex-audit-validator.test.ts 存在 + 覆盖每个 GT 提取路径 + 每个 audit 等式 + status='cj' / 'ch' / 其他 status 边界

### E. Audit 信度证据

- E1. REPORT「字段表」列出 33 audit point 在 542 张里 GT1/GT2 PASS 次数
- E2. 28 个双重 A 字段中，至少 90% 的 ID 上两条 A 路径都对得上（证明双重 A 实战有效）
- E3. 若发现 GT1 ≠ GT2 但 markdown PASS 单条 GT：REPORT 必须明示哪条 GT 被采纳 + 为什么 + 另一条不一致的根因

### F. Artifact 持久化

- F1. 阿杜签字后，artifact 已同步到 main/.claude/cbex-batch-2238/
- F2. worktree 已清理（git worktree list 无 cbex-batch-audit）
- F3. git push adu 成功（adu remote 最新 commit 含本任务代码）

---

## 9. Phase A 改动详细（明示 diff）

### 9.1 src/utils/cbex-extractor.ts

```diff
 export interface CbexFrontmatterInput {
 	title: string;
 	url: string;
 	subject_id: string;
 	status: string;
 	start_price?: number;
 	assess_price?: number;
 	cap_price?: number;
 	deposit?: number;
 	final_price?: number;
 	bid_start: string;
 	signup_end: string;
+	end_time?: string;          // 新增 optional
 	bid_count: number;
 	followers: number;
 	views: number;
 	created: string;
 }
 // 注：buyer.lottery_* 字段保持在关键信息表 markdown body 内（不进 frontmatter），
 //     跟当前 buildKeyInfoTable 一致；本任务 audit #17/#18/#19 验关键信息表 row 而非 frontmatter。
 
 export function buildCbexFrontmatter(input: CbexFrontmatterInput): string {
 	const lines: string[] = ['---'];
 	lines.push(`title: ${yamlEscape(input.title)}`);
 	lines.push(`url: ${yamlEscape(input.url)}`);
 	lines.push(`source: cbex`);
 	lines.push(`subject_id: ${yamlEscape(input.subject_id)}`);
 	lines.push(`status: ${input.status}`);
 	if (input.final_price !== undefined) lines.push(`final_price: ${input.final_price}`);
 	// ...
 	lines.push(`bid_start: ${yamlEscape(input.bid_start)}`);
 	lines.push(`signup_end: ${yamlEscape(input.signup_end)}`);
+	if (input.end_time) lines.push(`end_time: ${yamlEscape(input.end_time)}`);
 	lines.push(`bid_count: ${input.bid_count}`);
 	lines.push(`followers: ${input.followers}`);
 	lines.push(`views: ${input.views}`);
 	lines.push(`created: ${input.created}`);
 	lines.push('---');
 	return lines.join('\n') + '\n';
 }
```

### 9.2 src/content.ts

**主路径**：删除 L862-867 硬编码 fmExtra 简版 frontmatter；改成调 buildCbexFrontmatter 输出完整 17 行（拼到 obsidianNote 模板里）。需要重构 obsidianNote 拼接，使 cbex 分支用 buildCbexFrontmatter 的输出，其他 source 维持原逻辑。

**e2e bridge**：L864-868 同步改，复制相同逻辑。

具体改动 plan 阶段细化。

### 9.3 src/utils/cbex-extractor.test.ts

```diff
 describe('buildCbexFrontmatter', () => {
   it('outputs end_time when provided', () => {
+    const yaml = buildCbexFrontmatter({
+      ...minimalInput,
+      end_time: '2025-12-15 16:00:00',
+    });
+    expect(yaml).toMatch(/^end_time: "2025-12-15 16:00:00"$/m);
+  });
+  it('omits end_time when undefined', () => {
+    const yaml = buildCbexFrontmatter({
+      ...minimalInput,
+    });
+    expect(yaml).not.toMatch(/^end_time:/m);
+  });
+  it('outputs lottery_code/count/registered when provided', () => { ... });
+  it('omits lottery_* when undefined', () => { ... });
 });
```

---

## 10. 边界场景策略（spec 内决定）

### 10.1 Detail page 404（cbex 真下架）

策略：

1. e2e clip 拿到 HTTP 404 → 重试 3 次确认（每次间隔 5/10/20s，跟 e2e_error 通用重试）
2. 3 次仍 404 → 在 STEP 4 触发**子诊断**：重新调列表 API `/page/jpxkc/zc_prjs/prj_li` 查该 ID 是否还在
3. 若**列表 API 已无此 ID** → cbex 已下架该标的，**从 audit 集合移除**，记录到 step report「ID 已下架移除」节，REPORT 总数从 542 改为实际有效数（如 541），并在 REPORT 顶部 `## 总览` 明示
4. 若**列表 API 仍有此 ID 但 detail 404** → cbex 后端真不一致，**继续无限 retry**（每轮间隔指数 backoff 上限 1h），不签字直到 cbex 修复（这是 cbex bug 非本工具 bug，但本工具不允许「软通过」）

### 10.2 runRealClipBatch 实现细节（plan 阶段决定）

- new page per URL（每 URL 新 page，URL 结束 close page）vs page pool（复用 page）
- 默认 new page per URL（实现简单，避免 chrome page 状态泄漏）；plan 时 verify MV3 extension service worker 在 batch 模式下行为正常

### 10.3 followers / views 同源 snapshot 严格性

- e2e bridge 跑 extractor 时 hydratedHtml 抓取顺序：必须 `document.documentElement.outerHTML` 抓取在 extractor 跑完后立即执行（同一 microtask 内）
- 若两个值真不一致（implementation bug），属根因 5（e2e bridge 时序错），按 §7.1 修

### 10.4 cbex 后端反爬（长时跑出现）

- 表现：详情页 HTTP 429 / 503 / 内容返回但缺少 hydrated 字段
- 处理：在 STEP 4 升根因 5（e2e/网络异常）；可加 jitter sleep（300-800ms 随机）、降低批量并发（本任务串行不存在并发问题，但若反爬触发可加每 URL 之间 sleep）
- 不允许通过降低 audit 严格性绕开反爬

---

## 11. Out of Scope（明示 follow-up）

- 视觉 audit（截图对比）
- 跨 listId 通用（本任务 hardcode 2238，scripts 设计接受 listUrl 参数即可未来复用）
- cbex extractor 非本次任务暴露的优化
- 把 `audit-results/` 之类 tracked 目录加入 docs/ tree（本任务 artifact 不进 git，未来若决定要 track 再单独 spec）
