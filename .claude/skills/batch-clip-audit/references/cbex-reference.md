# cbex/jpxkc Reference Implementation Paths

完整 reference impl 路径索引（cbex/jpxkc 2238 任务，2026-05-30 完成，542/542 PASS）。后续任务可以 grep / Read 这些文件作设计参考。

## Spec / Plan

- spec: `docs/superpowers/specs/2026-05-30-cbex-jpxkc-batch-audit-2238-design.md`（11 节完整 spec）
- plan: `docs/superpowers/plans/2026-05-30-cbex-jpxkc-batch-audit-2238.md`（22 task / 123 step）

## 代码（已合并到 main）

| 文件 | 行数 | 职责 |
|---|---:|---|
| `src/utils/cbex-extractor.ts` | ~510 | extractor 核心；含 build<>Frontmatter / extract<>StructuredContent / extract<>TopFields / 各字段提取 helper |
| `src/utils/cbex-extractor.test.ts` | ~400 | 41 个 unit test + 1 个 integration test |
| `src/utils/cbex-extractor.e2e.test.ts` | ~100 | 522611/522884 真 chrome e2e baseline，15 个 it |
| `src/content.ts` L17-20 import + L863-908 cbex e2e bridge | ~45 行 cbex 分支 | wire build<>Frontmatter |
| `scripts/cbex-list-fetcher.ts` | ~150 | list API + parseListItemHtml |
| `scripts/cbex-audit-validator.ts` | ~1000 | 33 audit function + 各 helper |
| `scripts/cbex-audit-report.ts` | ~200 | buildReport(REPORT.md generator) |
| `scripts/cbex-batch-audit.ts` | ~280 | CLI orchestrator |
| `scripts/e2e-clip-runner.ts` | ~300 | startBatchSession / runRealClipBatch / runRealClip |
| `src/utils/cbex-list-fetcher.test.ts` | ~50 | parseListItemHtml test |
| `src/utils/cbex-audit-validator.test.ts` | ~270 | parseMarkdown + 33-point integration test |
| `src/utils/cbex-audit-report.test.ts` | ~100 | buildReport unit test |
| `src/utils/fixtures/cbex-prj_li-p1.html` | ~48KB | list API fixture (cbex p1 含 16 IDs) |
| `tsconfig.json` | exclude rule | `"src/**/*.test.ts"`, `"scripts/**"` |
| `.gitignore` | 1 line | `.claude/cbex-batch-2238/` |

## Audit artifacts（已 ship 到 main 的 .gitignored 路径）

- `.claude/cbex-batch-2238/REPORT.md` — 最终报告
- `.claude/cbex-batch-2238/ids.json` — 542 IDs + listItemHtml snapshot
- `.claude/cbex-batch-2238/progress.json` — final state (pass=542)
- `.claude/cbex-batch-2238/final-verify.log`
- `.claude/cbex-batch-2238/markdown/*.md` — 542 张
- `.claude/cbex-batch-2238/step-reports/*.md` — 7 个 step report
- `.claude/cbex-batch-2238/diffs-fail/` 空 (final verify 后)
- `.claude/cbex-batch-2238/hydrated-fail/` 空

## Step Reports（7 个，按时间序）

| Step | 类型 | 摘要 |
|---|---|---|
| step-01a-phase-a-extractor-wire.md | code-phase-A | Phase A: 修 extractor wire — CbexFrontmatterInput +end_time, e2e bridge 用 buildCbexFrontmatter, 6 commits |
| step-01b-phase-b-batch-tool.md | code-phase-B | Phase B: 5 scripts + 3 unit test, 33-point audit 实现 |
| step-02-audit-round-01.md | audit-round | Round 1 全 542: PASS 437 / FAIL 105 |
| step-fix-01-bridge-and-thresholds.md | fix | 修 description/image bridge + buyer_lottery_registered truncate + ct6 threshold + section emission |
| step-fix-02-bid-count-semantic.md | fix | 修 bid_count 语义 — wtList pageSize=10000 + tr-1 header + 移除 .jp_detail_bjnum |
| step-03-audit-round-02-subset.md | audit-round | Round 2 subset (105 Round 1 FAIL IDs): PASS 105 / FAIL 0 |
| step-final-verify.md | verify | Final verify 全 542: PASS 542 / FAIL 0 |

## Audit 字段表（33 audit point）

完整字段表参 spec §4。摘要：

```
Frontmatter 字段 (9): title, source, subject_id, status, published, description, author, tags, created
价格字段 (5):       final_price, start_price, assess_price, cap_price, deposit
时间字段 (3):       bid_start, signup_end, end_time
统计字段 (3):       bid_count, followers, views
关联字段 (1):       image
Buyer 字段 (3):    buyer.lottery_code, buyer.lottery_count, buyer.lottery_registered
ct2 (1):           ct2 image count
Section 存在性 (8): 关键信息, 标的物介绍, 图片展示, 司法处置公告, 竞买须知, 竞价记录, 竞价结果, 联系方式
```

## 后端 XHR 接口（audit 重抓 + 提取）

```
POST /page/jpxkc/zc_prjs/prj_li
  body: id=<listId>&sortTag=0&keyWord=&czfy=&zt=&bzj=&qsj=&zgxj=&pageNo=<N>&pageSize=<size>
  returns: HTML 含 N 个 <li> markups (each = ListItem)
  用途: list-fetcher 拉所有 IDs + listItemHtml

POST /page/jpxkc/prj/ggnr
  body: BDID=<bdid>
  returns: 司法处置公告 HTML 片段
  用途: section_司法处置公告 audit ground truth

POST /page/jpxkc/prj/wtListPaging
  body: cpdm=<prjId>&zgxj=<zgxj>&type=all&pageNo=1&pageSize=10000
  returns: 委托竞价记录 HTML (1 thead tr + N data tr)
  用途: section_竞价记录 + bid_count audit ground truth

POST /page/jpxkc/prj/jjjgListPaging
  body: id=<prjId>&jjcc=<jjcc>&pageNo=1&pageSize=10
  returns: 竞价结果排名 HTML
  用途: section_竞价结果 audit ground truth
```

## 实际跑批数据 highlight

- 总 IDs: 542（理论 542 / 实际 542）
- Status 分布: cj (成交) 541 + ch (撤回) 1
- 总耗时: ~25 分钟（Final verify）/ 累计跑 ~75 分钟（Round 1 + Round 2 subset + Final verify）
- e2e 单张耗时: ~2-3s（chromium 复用）
- XHR refetch: 542 × 3 = 1626 次，0 失败（cbex 服务器稳定，无反爬阻挠）
- 自动修复 commits: 3 (`f881ecfc` / `0298b6b9` / `4873415c`)

## Phase A 改动具体（可作其他 site 类似改动参考）

### 1. CbexFrontmatterInput 加 end_time（src/utils/cbex-extractor.ts L298-340）

```typescript
export interface CbexFrontmatterInput {
  // ...
  signup_end: string;
  end_time?: string;  // ← 新增 optional
  bid_count: number;
  // ...
}

export function buildCbexFrontmatter(input: CbexFrontmatterInput): string {
  // ...
  lines.push(`signup_end: ${yamlEscape(input.signup_end)}`);
  if (input.end_time) lines.push(`end_time: ${yamlEscape(input.end_time)}`);  // ← 新增条件 push
  lines.push(`bid_count: ${input.bid_count}`);
  // ...
}
```

### 2. CbexStructuredContent 透出 prices/stats/bid_start/signup_end/end_time

```typescript
export interface CbexStructuredContent {
  // ... existing fields (title, content, etc.) ...

  // Proprietary fields (extractedContent dict for template engine)
  end_time: string;
  bid_start: string;
  signup_end: string;
  prices: CbexPrices;
  stats: CbexStats;
  subject_id: string;
  status: string;
}

// extractCbexStructuredContent return 加对应字段
return {
  // ... existing ...
  end_time: top.end_time,
  bid_start: top.bid_start,
  signup_end: top.signup_end,
  prices: top.prices,
  stats: top.stats,
  subject_id: top.subject_id,
  status: top.status,
};
```

### 3. content.ts e2e bridge L864-908 替换（替换原硬编码 fmExtra）

```typescript
if (source === 'cbex') {
  const r = result as any;
  const fullCbexYaml = buildCbexFrontmatter({
    title: r?.title || '',
    url: document.URL,
    subject_id: r?.subject_id || '',
    status: r?.status || '',
    final_price: r?.prices?.final_price,
    start_price: r?.prices?.start_price,
    assess_price: r?.prices?.assess_price,
    cap_price: r?.prices?.cap_price,
    deposit: r?.prices?.deposit,
    bid_start: r?.bid_start || r?.published || '',
    signup_end: r?.signup_end || '',
    end_time: r?.end_time,
    bid_count: r?.stats?.bid_count || 0,
    followers: r?.stats?.followers || 0,
    views: r?.stats?.views || 0,
    created: today,
  });
  // Strip outer --- and known-duplicated keys (title/url/source/created)
  const innerLines = fullCbexYaml
    .replace(/^---\n/, '')
    .replace(/\n---\n?$/, '')
    .split('\n')
    .filter((line) =>
      !line.startsWith('title:') && !line.startsWith('url:') &&
      !line.startsWith('source:') && !line.startsWith('created:'),
    );
  fmExtra.push(...innerLines);
}
```

### 4. e2e bridge buildVariables fix description/image 硬编码空

```typescript
// content.ts buildVariables call (e2e bridge)
const simulatedVars = sharedMod.buildVariables({
  title: result?.title || '',
  // ...
  description: (result as any)?.description || '',  // ← 之前硬编码 ''
  image: (result as any)?.image || '',              // ← 之前硬编码 ''
  // ...
});
```

## 经验教训（cbex 任务实测）

参 spec §10 边界场景 + 各 step-fix report。摘要：

1. **subagent 不继承 controller cwd**：dispatch prompt 强制 `cd <worktree>` first command。Task 1 implementer 错把 commit 写到 main 触发 cherry-pick + reset 修复。
2. **Quality reviewer 漏 regression**：Task 2 implementer 错把「add」做成「move」删了 Task 1 字段。Quality reviewer 合理化了删除。Controller 必须自己 spot-check diff。后续 fix subagent prompt 加「Don't undo previous tasks」+ 列已加字段。
3. **wtList API pagination 陷阱**：cbex backend 默认 pageSize=10。Round 1 错以为 wtList tr count == bid count；实际 522611 (265 bids) 只返回 11 行。修复加 `pageSize=10000`。
4. **`<tr>` header off-by-one**：wtList HTML 含 1 个 thead `<tr>`。tr count - 1 才是 data row count。
5. **撤回 status null vs 0**：null normalize 到 default 值（如 0）才能 PASS。
6. **threshold 校准 ≠ 降级**：ct6 textContent ≥ 50 → 20，因实测发现 50 太严（拍卖站点 ct6 联系方式经常 ≤ 50 字）。threshold 仍要求非平凡内容。
7. **语义校准 ≠ 降级**：`.jp_detail_bjnum span` 语义 = 最高限价报价人数 ≠ 总报价次数。移除作 pass criterion，保留 informational note。
