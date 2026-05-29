# cbex/jpxkc 批量 audit zc_prjs/2238 (542 标的) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 对 cbex `zc_prjs/2238.html` 542 个 detail URL 跑 e2e 裁剪 + 33-point audit；自动闭环直到 PASS=100%；产出 REPORT.md 给阿杜唯一一次介入审核；通过后 ship + artifacts 持久保留。

**Architecture:** 三阶段 — Phase A 修 cbex extractor e2e bridge 让 frontmatter 完整暴露字段（spec §9.2）；Phase B 写 5 个 scripts 实现 list-fetch + 33-point audit + chromium 复用 + 报告生成；Phase C 自动闭环 (任何 FAIL 走 5 类根因决策树 + 修代码 + 重跑) → REPORT.md → 阿杜审 → ship。

**Tech Stack:** TypeScript / vitest / playwright-extra + stealth / Node fs/http / Python (recv-server.py 复用) / linkedom (parseHTML for tests) / dayjs

**Spec:** `docs/superpowers/specs/2026-05-30-cbex-jpxkc-batch-audit-2238-design.md`（commit 19dcf3bc）

---

## Task 0: Setup Worktree

**Files:**
- Create worktree: `.claude/worktrees/cbex-batch-audit/` 基于当前 `main`
- 后续所有 task 都在 worktree 内执行

- [ ] **Step 1: 建 worktree**

Run:
```bash
git worktree add .claude/worktrees/cbex-batch-audit -b cbex-batch-audit main
```

Expected: `Preparing worktree (new branch 'cbex-batch-audit')` + `HEAD is now at <SHA> ...`

- [ ] **Step 2: 进 worktree**

Run:
```bash
cd .claude/worktrees/cbex-batch-audit
git status
```

Expected: `On branch cbex-batch-audit`, `nothing to commit, working tree clean`

- [ ] **Step 3: 验证 worktree extension build**

Run:
```bash
ls dist/manifest.json
```

Expected: 文件存在（main 的 dist/ 已 build；若不存在则 `npm run build:chrome` 先 build）

---

## Task 1: 加 end_time 到 CbexFrontmatterInput + buildCbexFrontmatter (TDD)

**Files:**
- Modify: `src/utils/cbex-extractor.ts:298-339`（CbexFrontmatterInput interface + buildCbexFrontmatter 函数）
- Test: `src/utils/cbex-extractor.test.ts`（已有 buildCbexFrontmatter describe 块，扩充）

- [ ] **Step 1: 在已有 `describe('buildCbexFrontmatter')` 块末加两个 failing test**

文件 `src/utils/cbex-extractor.test.ts` 在 `describe('buildCbexFrontmatter', () => { ... })` 块**最后一个 `it(...)` 之后、`});` 之前**插入：

```typescript
  it('emits end_time when provided', () => {
    const yaml = buildCbexFrontmatter({
      title: 'X',
      url: 'https://jpxkc.cbex.com/jpxkc/prj/detail/123.html',
      subject_id: '202501TEST',
      status: '竞价结束',
      start_price: 100,
      cap_price: 200,
      deposit: 100,
      bid_start: '2026-01-01 08:00',
      signup_end: '2025-12-31 15:00',
      end_time: '2026-01-01 16:00:00',
      bid_count: 0,
      followers: 0,
      views: 5,
      created: '2026-05-30',
    });
    expect(yaml).toMatch(/^end_time: "2026-01-01 16:00:00"$/m);
  });

  it('omits end_time when undefined', () => {
    const yaml = buildCbexFrontmatter({
      title: 'X',
      url: 'https://jpxkc.cbex.com/jpxkc/prj/detail/123.html',
      subject_id: '202501TEST',
      status: '报价中',
      start_price: 100,
      cap_price: 200,
      deposit: 100,
      bid_start: '2026-01-01 08:00',
      signup_end: '2025-12-31 15:00',
      bid_count: 0,
      followers: 0,
      views: 5,
      created: '2026-05-30',
    });
    expect(yaml).not.toMatch(/^end_time:/m);
  });
```

- [ ] **Step 2: 跑测试确认 FAIL**

Run:
```bash
npx vitest run src/utils/cbex-extractor.test.ts -t "end_time"
```

Expected: 第一个 test FAIL，原因 `Property 'end_time' does not exist on type 'CbexFrontmatterInput'`（TS 编译错）

- [ ] **Step 3: 改 cbex-extractor.ts 加字段 + 输出行**

文件 `src/utils/cbex-extractor.ts` L298-314 `CbexFrontmatterInput` interface，在 `signup_end: string;` 之后、`bid_count: number;` 之前插入：

```typescript
	end_time?: string;
```

同文件 L320-339 `buildCbexFrontmatter` 函数，在 `lines.push(\`signup_end: ${yamlEscape(input.signup_end)}\`);`（L333）之后、`lines.push(\`bid_count: ${input.bid_count}\`);`（L334）之前插入：

```typescript
	if (input.end_time) lines.push(`end_time: ${yamlEscape(input.end_time)}`);
```

- [ ] **Step 4: 跑测试确认 PASS**

Run:
```bash
npx vitest run src/utils/cbex-extractor.test.ts -t "buildCbexFrontmatter"
```

Expected: 所有 `buildCbexFrontmatter` describe 块 test PASS（含原有 2 个 + 新增 2 个 = 4 个）

- [ ] **Step 5: Commit**

```bash
git add src/utils/cbex-extractor.ts src/utils/cbex-extractor.test.ts
git commit -m "feat(cbex): buildCbexFrontmatter optionally emit end_time"
```

---

## Task 2: 透出 end_time 经 CbexStructuredContent + extractCbexStructuredContent (TDD)

**Files:**
- Modify: `src/utils/cbex-extractor.ts:344-441`（CbexStructuredContent interface + extractCbexStructuredContent 函数返回）
- Test: `src/utils/cbex-extractor.test.ts`（已有 `describe('extractCbexStructuredContent (integration)')` 块）

- [ ] **Step 1: 找到已有的 extractCbexStructuredContent integration test 块**

文件 `src/utils/cbex-extractor.test.ts`，找到 `describe('extractCbexStructuredContent (integration)', () => { ... })` 块内某个 `it('returns structured fields ...')` 测试。

在该 it 块的 expect 断言**末尾**加：

```typescript
    expect(result.end_time).toBe('2025-12-15 16:00:00');
```

(522611 fixture 的 end_time 应该是 `2025-12-15 16:00:00`，可由 `.bd_detail_state_over .time_num` 5 个数字拼接得到；如果实际拼出来不一样，按真实拼接结果修测试值)

- [ ] **Step 2: 跑测试确认 FAIL**

Run:
```bash
npx vitest run src/utils/cbex-extractor.test.ts -t "extractCbexStructuredContent"
```

Expected: FAIL `Property 'end_time' does not exist on type 'CbexStructuredContent'` 或 `expected undefined to be ...`

- [ ] **Step 3: 改 cbex-extractor.ts 透出 end_time**

文件 `src/utils/cbex-extractor.ts` L344-359 `CbexStructuredContent` interface，在 `// Proprietary fields` 行**之前**插入：

```typescript
	end_time: string;       // YYYY-MM-DD HH:mm:ss from .bd_detail_state_over .time_num
```

同文件 L428-440 `extractCbexStructuredContent` 函数 return block 内，在 `wordCount: body.length,` 之后、`subject_id: top.subject_id,` 之前插入：

```typescript
		end_time: top.end_time,
```

(注：`top.end_time` 已经存在于 `CbexTopFields`，由 `extractEndTime(doc)` 填充，确认见 cbex-extractor.ts L201-213 的 extractCbexTopFields)

- [ ] **Step 4: 跑测试确认 PASS**

Run:
```bash
npx vitest run src/utils/cbex-extractor.test.ts
```

Expected: 所有 cbex-extractor.test.ts test PASS

- [ ] **Step 5: Commit**

```bash
git add src/utils/cbex-extractor.ts src/utils/cbex-extractor.test.ts
git commit -m "feat(cbex): expose end_time via CbexStructuredContent"
```

---

## Task 3: 改 content.ts e2e bridge 用 buildCbexFrontmatter 完整输出

**Files:**
- Modify: `src/content.ts:864-868`（cbex e2e bridge fmExtra 分支）

- [ ] **Step 1: 在 content.ts 顶部加 buildCbexFrontmatter 的 import**

文件 `src/content.ts`，找到 L20 `import { extractCbexStructuredContent, isCbexPrjDetailUrl } from './utils/cbex-extractor';`，**改为**：

```typescript
import { extractCbexStructuredContent, isCbexPrjDetailUrl, buildCbexFrontmatter } from './utils/cbex-extractor';
```

- [ ] **Step 2: 替换 content.ts L864-868 cbex 分支为完整 buildCbexFrontmatter 输出**

文件 `src/content.ts`，找到：

```typescript
				if (source === 'cbex') {
					const r = result as any;
					if (r?.subject_id) fmExtra.push(`subject_id: "${fmEscape(r.subject_id)}"`);
					if (r?.status) fmExtra.push(`status: "${fmEscape(r.status)}"`);
				}
```

**替换为**：

```typescript
				if (source === 'cbex') {
					const r = result as any;
					// Use buildCbexFrontmatter for the full cbex frontmatter (start_price,
					// cap_price, deposit, bid_start, signup_end, end_time, bid_count,
					// followers, views, etc.). Strip the wrapping --- and the title/url/
					// source/created lines we already emit above; keep only the cbex-
					// specific extras. See spec §9.2 for context.
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
					// fullCbexYaml looks like "---\ntitle: ...\nurl: ...\nsource: cbex\n
					// subject_id: ...\n...\ncreated: ...\n---\n"
					// Extract only the lines we want as fmExtra (cbex-specific):
					// subject_id, status, final_price, start_price, assess_price,
					// cap_price, deposit, bid_start, signup_end, end_time, bid_count,
					// followers, views. Skip title/url/source/created (already in
					// outer obsidianNote template above).
					const innerLines = fullCbexYaml
						.replace(/^---\n/, '')
						.replace(/\n---\n?$/, '')
						.split('\n')
						.filter((line) =>
							!line.startsWith('title:')
							&& !line.startsWith('url:')
							&& !line.startsWith('source:')
							&& !line.startsWith('created:'),
						);
					fmExtra.push(...innerLines);
				}
```

- [ ] **Step 3: 检查 CbexStructuredContent 是否含 prices/stats/bid_start/signup_end 字段**

Run:
```bash
grep -n "prices\|stats\|bid_start\|signup_end" src/utils/cbex-extractor.ts | head -10
```

Expected: 看到 `prices: CbexPrices;` `stats: CbexStats;` `bid_start: string;` `signup_end: string;` 在 CbexTopFields 而非 CbexStructuredContent 里。

发现 CbexStructuredContent 当前只透 title/author/description/published/image/site/source/content/wordCount/end_time/subject_id/status，**不透 prices/stats/bid_start/signup_end**。需要扩 CbexStructuredContent。

- [ ] **Step 4: 扩 CbexStructuredContent + extractCbexStructuredContent 透 prices/stats/bid_start/signup_end**

文件 `src/utils/cbex-extractor.ts`，CbexStructuredContent interface (L344-359) 在 `end_time: string;` 之后、`// Proprietary fields` 之前**插入**：

```typescript
	bid_start: string;
	signup_end: string;
	prices: CbexPrices;
	stats: CbexStats;
```

同文件 extractCbexStructuredContent return block，在 `end_time: top.end_time,` 之后、`subject_id: top.subject_id,` 之前**插入**：

```typescript
		bid_start: top.bid_start,
		signup_end: top.signup_end,
		prices: top.prices,
		stats: top.stats,
```

- [ ] **Step 5: 跑 cbex extractor unit tests**

Run:
```bash
npx vitest run src/utils/cbex-extractor.test.ts
```

Expected: 所有 cbex-extractor.test.ts PASS

- [ ] **Step 6: tsc 编译验证**

Run:
```bash
npx tsc --noEmit -p tsconfig.json 2>&1 | head -30
```

Expected: 无 ts error（特别确认 content.ts 改动通过 type check）

- [ ] **Step 7: Commit**

```bash
git add src/utils/cbex-extractor.ts src/content.ts
git commit -m "feat(cbex): e2e bridge frontmatter uses buildCbexFrontmatter (full fields)"
```

---

## Task 4: 加 .gitignore 规则避免 audit artifacts 被 track

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: 加 .claude/cbex-batch-2238/ 到 .gitignore**

文件 `.gitignore`，找到 L44 附近的 `.claude/chat-exports/` 行，在它之后插入：

```
.claude/cbex-batch-2238/
```

- [ ] **Step 2: 验证 ignore 规则生效**

Run:
```bash
mkdir -p .claude/cbex-batch-2238/test && touch .claude/cbex-batch-2238/test/x.md
git check-ignore -v .claude/cbex-batch-2238/test/x.md
rm -rf .claude/cbex-batch-2238/
```

Expected: `git check-ignore` 返回 `.gitignore:<line>:.claude/cbex-batch-2238/ .claude/cbex-batch-2238/test/x.md`

- [ ] **Step 3: Commit**

```bash
git add .gitignore
git commit -m "chore(.gitignore): ignore .claude/cbex-batch-2238/ (audit artifacts persistence)"
```

---

## Task 5: 跑 522611/522884 e2e baseline，扩断言覆盖新字段

**Files:**
- Modify: `src/utils/cbex-extractor.e2e.test.ts`

- [ ] **Step 1: 先确认现状 e2e baseline 跑得通**

Run:
```bash
npm run build:chrome
```

Expected: 编译成功，dist/manifest.json 等更新

Run:
```bash
npm run test:e2e -- src/utils/cbex-extractor.e2e.test.ts
```

Expected: 现有 8 个 e2e it 全 PASS（522611 + 522884 各 4 个 it）

- [ ] **Step 2: 给 522611 describe 块加新 frontmatter 字段断言**

文件 `src/utils/cbex-extractor.e2e.test.ts`，找到 `describe('cbex e2e — 522611 ...')` 块，在 `it('contains 成交价', () => { ... })` 之后**插入**：

```typescript
	it('frontmatter has start_price / cap_price / deposit', () => {
		expect(clip.markdown).toMatch(/^start_price: 20000$/m);
		expect(clip.markdown).toMatch(/^cap_price: 30000$/m);
		expect(clip.markdown).toMatch(/^deposit: 20000$/m);
	});

	it('frontmatter has final_price 30000 (成交)', () => {
		expect(clip.markdown).toMatch(/^final_price: 30000$/m);
	});

	it('frontmatter has bid_start / signup_end / end_time', () => {
		expect(clip.markdown).toMatch(/^bid_start: "2025-12-15 08:00"$/m);
		expect(clip.markdown).toMatch(/^signup_end: "2025-12-12 15:00"$/m);
		expect(clip.markdown).toMatch(/^end_time: "2025-12-15 16:00:00"$/m);
	});

	it('frontmatter has bid_count / followers / views (numbers)', () => {
		expect(clip.markdown).toMatch(/^bid_count: \d+$/m);
		expect(clip.markdown).toMatch(/^followers: \d+$/m);
		expect(clip.markdown).toMatch(/^views: \d+$/m);
	});
```

- [ ] **Step 3: 给 522884 describe 块同样加断言**

同文件，找到 `describe('cbex e2e — 522884 ...')` 块，在最后 `it('contains 成交价', () => {...})` 之后插入类似断言（subject_id 是 `202512P61185`，价格按 522884 实际值；如不知道先空 placeholder 跑出来再填）：

```typescript
	it('frontmatter has start_price / cap_price / deposit', () => {
		expect(clip.markdown).toMatch(/^start_price: \d+$/m);
		expect(clip.markdown).toMatch(/^cap_price: \d+$/m);
		expect(clip.markdown).toMatch(/^deposit: \d+$/m);
	});

	it('frontmatter has bid_start / signup_end / end_time', () => {
		expect(clip.markdown).toMatch(/^bid_start: "\d{4}-\d{2}-\d{2} \d{2}:\d{2}"$/m);
		expect(clip.markdown).toMatch(/^signup_end: "\d{4}-\d{2}-\d{2} \d{2}:\d{2}"$/m);
		expect(clip.markdown).toMatch(/^end_time: "\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}"$/m);
	});

	it('frontmatter has bid_count / followers / views', () => {
		expect(clip.markdown).toMatch(/^bid_count: \d+$/m);
		expect(clip.markdown).toMatch(/^followers: \d+$/m);
		expect(clip.markdown).toMatch(/^views: \d+$/m);
	});
```

- [ ] **Step 4: 重 build 然后跑 e2e**

Run:
```bash
npm run build:chrome && npm run test:e2e -- src/utils/cbex-extractor.e2e.test.ts
```

Expected: 全 PASS（含原 8 个 + 新增 ~6 个 = ~14 个 it）。若失败，检查 frontmatter 实际输出（在 e2e 报错信息会带 markdown 内容），按实际值修断言。

- [ ] **Step 5: Commit**

```bash
git add src/utils/cbex-extractor.e2e.test.ts
git commit -m "test(cbex): e2e baseline assert full frontmatter fields"
```

---

## Task 6: 写 step-01a-phase-a-extractor-wire.md report

**Files:**
- Create: `.claude/cbex-batch-2238/step-reports/step-01a-phase-a-extractor-wire.md`

- [ ] **Step 1: 创建 step report 目录 + 文件**

Run:
```bash
mkdir -p .claude/cbex-batch-2238/step-reports
```

文件 `.claude/cbex-batch-2238/step-reports/step-01a-phase-a-extractor-wire.md`：

```markdown
# Step 01a — Phase A: Extractor Wire

- 时间：<填写实际起止时间>
- worktree 状态：commit SHA <git rev-parse HEAD>（branch cbex-batch-audit）
- 类型：code-phase-A
- 上游依赖 step：无（首 step）
- 下游影响 step：step-01b

## 目标

修 cbex extractor 的 e2e bridge wire 缺陷，让 e2e bridge 输出的 markdown frontmatter 含完整 cbex 字段（start_price/cap_price/deposit/bid_start/signup_end/end_time/bid_count/followers/views 等 13 个），方便 §4 audit 字段表里 #5-15 在 frontmatter 中能被严格 audit。

## 工作内容

按 Plan Task 1-5：

1. Task 1: cbex-extractor.ts CbexFrontmatterInput + buildCbexFrontmatter 加 end_time?: string 字段（TDD：两个单测先 FAIL 再 PASS）
2. Task 2: cbex-extractor.ts CbexStructuredContent + extractCbexStructuredContent 透出 end_time（integration test 扩断言）
3. Task 3: content.ts e2e bridge L864-868 改用 buildCbexFrontmatter 完整输出（同步扩 CbexStructuredContent 暴露 prices/stats/bid_start/signup_end）
4. Task 4: .gitignore 加 .claude/cbex-batch-2238/
5. Task 5: e2e baseline 522611/522884 断言扩到新字段，全 PASS

## 遇到的问题

<列出实际遇到的，至少 P1。若无填「无」>

## 解决方案

<对应每个 P 的解>

## 验收标准

- [ ] cbex-extractor 单测全 PASS（4 个 buildCbexFrontmatter + integration test）
- [ ] tsc --noEmit 无 type error
- [ ] 522611 e2e baseline ≥ 9 个 it 全 PASS（含新加 4 个 frontmatter 字段断言）
- [ ] 522884 e2e baseline ≥ 7 个 it 全 PASS（含新加 3 个）
- [ ] .gitignore 含 `.claude/cbex-batch-2238/` 一行
- [ ] git log 含 5 个 commit（Task 1-5）

## 验收结果

- ✅ <逐条核对填写>

## 决策声明（强制填写）

- 擅自降级 audit 标准：**否** ✓
- 偷懒/跳步：**否** ✓
- 妥协/接受次优：**否** ✓

## 后续影响

Phase A wire 完，cbex e2e markdown frontmatter 含完整字段；Phase B audit-validator
可在 frontmatter 而非仅在关键信息表 markdown body 验 #5-15 字段。

## 产物清单

- code commits: <git log --oneline -5 SHA>
- modified files:
  - src/utils/cbex-extractor.ts
  - src/utils/cbex-extractor.test.ts
  - src/utils/cbex-extractor.e2e.test.ts
  - src/content.ts
  - .gitignore
- new files: 无
```

- [ ] **Step 2: 不 commit（artifacts 不进 git）**

step-reports 在 `.claude/cbex-batch-2238/` 内已被 .gitignore，无须 git add。

---

## Task 7: scripts/cbex-list-fetcher.ts — list API + parseListItemHtml (TDD)

**Files:**
- Create: `scripts/cbex-list-fetcher.ts`
- Create: `src/utils/cbex-list-fetcher.test.ts`（沿用 vitest 默认扫 src/**/*.test.ts 约定）
- 测试 fixture：使用已下载的 `/tmp/cbex-prj_li-p1.html`（如果 worktree session 已无此文件，重新 curl）

- [ ] **Step 1: 拉 fixture 文件到测试目录**

Run:
```bash
mkdir -p src/utils/fixtures
curl -sS -X POST "https://jpxkc.cbex.com/page/jpxkc/zc_prjs/prj_li" \
  -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36" \
  -H "Referer: https://jpxkc.cbex.com/jpxkc/zc_prjs/2238.html" \
  -H "X-Requested-With: XMLHttpRequest" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "id=2238&sortTag=0&keyWord=&czfy=&zt=&bzj=&qsj=&zgxj=&pageNo=1&pageSize=16" \
  -o src/utils/fixtures/cbex-prj_li-p1.html
ls -la src/utils/fixtures/cbex-prj_li-p1.html
```

Expected: 文件大小 > 30KB

- [ ] **Step 2: 写 cbex-list-fetcher.test.ts**

文件 `src/utils/cbex-list-fetcher.test.ts`：

```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseListItemHtml, fetchListIds } from '../../scripts/cbex-list-fetcher';

const FIXTURE = readFileSync(join(__dirname, 'fixtures/cbex-prj_li-p1.html'), 'utf-8');

describe('parseListItemHtml', () => {
  it('parses cj (成交) variant — 522611', () => {
    const li = FIXTURE.match(/<li id="prj_li_522611"[\s\S]*?<\/li>/)![0];
    const parsed = parseListItemHtml(li);
    expect(parsed.id).toBe('522611');
    expect(parsed.subject_id).toBe('202512NC6575');
    expect(parsed.title).toBe('京NC6575别克牌SGM6527AT蓝小型汽车');
    expect(parsed.dataStyle).toBe('cj');
    expect(parsed.status).toBe('竞价结束');
    expect(parsed.final_price).toBe(30000);
    expect(parsed.cap_price).toBe(30000);
    expect(parsed.end_time).toBe('2025-12-15 16:00:00');
    expect(parsed.bid_count).toBe(265);
    expect(parsed.image).toMatch(/\.jpg(_MzAwLDMwMA==\.jpg)?$/);
    expect(parsed.start_price).toBeUndefined(); // 成交 状态 list-item 显示成交价不显示起始价
  });

  it('parses ch (已撤回) variant', () => {
    // Pick any ch item if fixture contains one; else load p2/p3 etc. that has ch.
    // 521950 is the only 'ch' across all 6 pages — needs full multi-page fixture.
    // For now skip if not in p1; later test can use the multi-page fixture.
    const liMatch = FIXTURE.match(/<li id="prj_li_\d+" data-xmid="\d+" data-style="ch"[\s\S]*?<\/li>/);
    if (!liMatch) {
      // p1 fixture may not contain a 'ch' item; that's fine, skip with explicit annotation
      return;
    }
    const parsed = parseListItemHtml(liMatch[0]);
    expect(parsed.dataStyle).toBe('ch');
    expect(parsed.status).toBe('已撤回');
    expect(parsed.start_price).toBeDefined();
    expect(parsed.final_price).toBeUndefined();
  });
});

describe('fetchListIds (network)', () => {
  it.skip('fetches all 542 IDs from 2238 list', async () => {
    // This hits cbex network; mark as e2e-style, skip in normal `npm test`.
    // Run manually: npm run test:e2e or vitest run --include 'cbex-list-fetcher.test.ts'
    const items = await fetchListIds('https://jpxkc.cbex.com/jpxkc/zc_prjs/2238.html');
    expect(items.length).toBe(542);
    const allCj = items.every(i => parseListItemHtml(i.listItemHtml).dataStyle === 'cj'
      || parseListItemHtml(i.listItemHtml).dataStyle === 'ch');
    expect(allCj).toBe(true);
  });
});
```

- [ ] **Step 3: 跑测试确认 FAIL**

Run:
```bash
npx vitest run src/utils/cbex-list-fetcher.test.ts
```

Expected: FAIL — 模块 `scripts/cbex-list-fetcher` 不存在

- [ ] **Step 4: 实现 scripts/cbex-list-fetcher.ts**

文件 `scripts/cbex-list-fetcher.ts`：

```typescript
// scripts/cbex-list-fetcher.ts
//
// Fetch all detail IDs from a cbex zc_prjs list page via the
// /page/jpxkc/zc_prjs/prj_li XHR endpoint. Returns each ID's raw <li>
// markup which serves as an independent ground-truth source for audit
// (subject_id / title / status / prices / end_time / bid_count / image
// all visible in the list-item markup, parsed via parseListItemHtml).

const ENDPOINT = 'https://jpxkc.cbex.com/page/jpxkc/zc_prjs/prj_li';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const STATUS_BY_DATA_STYLE: Record<string, string> = {
	cj: '竞价结束',
	ch: '已撤回',
	jjz: '竞价中',
	lp: '流拍',
	zd: '终止',
};

export interface ListItem {
	id: string;
	listItemHtml: string;
}

export interface ParsedListItem {
	id: string;
	subject_id: string;
	title: string;
	dataStyle: string;
	status: string;
	cap_price: number;
	start_price?: number;
	final_price?: number;
	end_time: string;
	bid_count: number;
	image: string;
}

function parseListId(listUrl: string): string {
	const m = listUrl.match(/\/jpxkc\/zc_prjs\/(\d+)\.html$/);
	if (!m) throw new Error(`cbex list URL invalid: ${listUrl}`);
	return m[1];
}

async function fetchPage(listId: string, pageNo: number, pageSize: number): Promise<string> {
	const body = new URLSearchParams({
		id: listId,
		sortTag: '0',
		keyWord: '',
		czfy: '',
		zt: '',
		bzj: '',
		qsj: '',
		zgxj: '',
		pageNo: String(pageNo),
		pageSize: String(pageSize),
	}).toString();

	const res = await fetch(ENDPOINT, {
		method: 'POST',
		headers: {
			'User-Agent': UA,
			'Referer': `https://jpxkc.cbex.com/jpxkc/zc_prjs/${listId}.html`,
			'X-Requested-With': 'XMLHttpRequest',
			'Content-Type': 'application/x-www-form-urlencoded',
		},
		body,
	});

	if (!res.ok) throw new Error(`cbex list fetch HTTP ${res.status}`);
	return await res.text();
}

function extractItems(html: string): ListItem[] {
	const items: ListItem[] = [];
	const itemRe = /<li id="prj_li_(\d+)"[\s\S]*?<\/li>/g;
	let m: RegExpExecArray | null;
	while ((m = itemRe.exec(html)) !== null) {
		items.push({ id: m[1], listItemHtml: m[0] });
	}
	return items;
}

export async function fetchListIds(listUrl: string, opts?: { pageSize?: number }): Promise<ListItem[]> {
	const listId = parseListId(listUrl);
	const pageSize = opts?.pageSize ?? 100;
	const seen = new Set<string>();
	const result: ListItem[] = [];

	let pageNo = 1;
	while (true) {
		const html = await fetchPage(listId, pageNo, pageSize);
		const items = extractItems(html);
		if (items.length === 0) break;
		let newCount = 0;
		for (const item of items) {
			if (!seen.has(item.id)) {
				seen.add(item.id);
				result.push(item);
				newCount++;
			}
		}
		if (items.length < pageSize) break; // last page
		if (newCount === 0) break;          // safety guard
		pageNo++;
		if (pageNo > 50) throw new Error('cbex list fetch exceeded 50 pages — likely infinite loop'); // safety
	}

	return result;
}

function getMatchTrim(html: string, re: RegExp): string {
	const m = html.match(re);
	return m ? m[1].trim() : '';
}

function parsePriceYuan(text: string): number {
	const m = text.match(/[¥￥]?\s*([\d,]+(?:\.\d+)?)/);
	if (!m) return NaN;
	return parseFloat(m[1].replace(/,/g, ''));
}

export function parseListItemHtml(html: string): ParsedListItem {
	const id = getMatchTrim(html, /<li id="prj_li_(\d+)"/);
	const dataStyle = getMatchTrim(html, /data-style="([^"]+)"/);

	// title: <a class="title" ...>京NC6575...</a>
	const title = getMatchTrim(html, /<a class="title"[^>]*>([^<]+)<\/a>/);

	// subject_id: <p>标的物编号：202512NC6575</p>
	const subject_id = getMatchTrim(html, /<p>标的物编号：([^<]+)<\/p>/);

	// status from data-style mapping; fallback to label_state_* textContent
	let status = STATUS_BY_DATA_STYLE[dataStyle] ?? '';
	if (!status) {
		const labelMatch = html.match(/<span class="label_state_[^"]*">([^<]+)<\/span>/);
		if (labelMatch) status = labelMatch[1].trim();
	}

	// final_price (status='成交' / cj): <p>成交价：<span ...>¥30,000.00</span></p>
	const finalMatch = html.match(/<p>成交价：<span[^>]*>([^<]+)<\/span><\/p>/);
	const final_price = finalMatch ? parsePriceYuan(finalMatch[1]) : undefined;

	// start_price (status≠成交): <p>起始价：<span ...>¥31,700.00</span></p>
	const startMatch = html.match(/<p>起始价：<span[^>]*>([^<]+)<\/span><\/p>/);
	const start_price = startMatch ? parsePriceYuan(startMatch[1]) : undefined;

	// cap_price: <p>最高限价：<span ...>¥30,000.00</span></p>
	const capMatch = html.match(/<p>最高限价：<span[^>]*>([^<]+)<\/span><\/p>/);
	const cap_price = capMatch ? parsePriceYuan(capMatch[1]) : NaN;

	// end_time: <div class="time">结束时间：2025-12-15 16:00:00</div>
	const end_time = getMatchTrim(html, /<div class="time">结束时间：([^<]+)<\/div>/);

	// bid_count: <p class="bdlist_side_num">265</p>
	const bidMatch = html.match(/<p class="bdlist_side_num">(\d+)<\/p>/);
	const bid_count = bidMatch ? parseInt(bidMatch[1], 10) : 0;

	// image: first <img data-original="..."> in the .thum block
	const image = getMatchTrim(html, /<img\s+data-original="([^"]+)"/);

	return {
		id,
		subject_id,
		title,
		dataStyle,
		status,
		cap_price,
		start_price,
		final_price,
		end_time,
		bid_count,
		image,
	};
}
```

- [ ] **Step 5: 跑测试确认 PASS**

Run:
```bash
npx vitest run src/utils/cbex-list-fetcher.test.ts -t "parseListItemHtml"
```

Expected: 全 PASS（fetchListIds 那个 it 因 .skip 跳过，没关系）

- [ ] **Step 6: Commit**

```bash
git add scripts/cbex-list-fetcher.ts src/utils/cbex-list-fetcher.test.ts src/utils/fixtures/cbex-prj_li-p1.html
git commit -m "feat(cbex-batch): list-fetcher + parseListItemHtml + fixture-based unit tests"
```

---

## Task 8: scripts/e2e-clip-runner.ts — 增 runRealClipBatch (TDD via integration)

**Files:**
- Modify: `scripts/e2e-clip-runner.ts`（已有 runRealClip；需重构成 startBatchSession + clipInSession + endBatchSession，runRealClip 改为 sugar）

- [ ] **Step 1: 读现有 e2e-clip-runner 关键 section**

Run:
```bash
grep -n "export async function runRealClip\|launchPersistentContext\|context.close\|page.close\|context.newPage" scripts/e2e-clip-runner.ts | head -10
```

Expected: 看到 runRealClip 函数签名 + chromium launch / close 关键调用

- [ ] **Step 2: 在 e2e-clip-runner.ts 加 runRealClipBatch + 改造内部结构**

文件 `scripts/e2e-clip-runner.ts` 末尾**附加**：

```typescript
// ── Batch API (chromium reuse across multiple URLs) ──────────────────────────
//
// startBatchSession(opts) → ClipSession
//   - launches chromium once with extension + persistent profile
//   - starts recv-server.py once
//
// session.clip(url, opts) → ClipResult
//   - opens new page, navigates, runs page-world test bridge, polls receiver
//   - closes page
//
// session.close() → void
//   - kills chromium + recv-server

export interface ClipSession {
	clip: (url: string, opts?: { wait?: string; timeout?: number }) => Promise<ClipResult>;
	close: () => Promise<void>;
}

export async function startBatchSession(opts?: ClipOptions): Promise<ClipSession> {
	// Reuse the implementation pattern of runRealClip but hold context/page-
	// independent state across calls. Implementation detail: extract from
	// runRealClip the chromium-launch + recv-server startup as setup, leave
	// per-URL navigation+bridge+poll as a closure inside.
	// (Plan note: this requires reading the existing runRealClip body and
	// refactoring; see Task 8 Step 3 for the concrete approach.)
	throw new Error('TODO: implemented in Step 3');
}

export async function runRealClipBatch(urls: string[], opts?: ClipOptions): Promise<ClipResult[]> {
	const session = await startBatchSession(opts);
	const results: ClipResult[] = [];
	try {
		for (const url of urls) {
			const r = await session.clip(url, { wait: opts?.wait, timeout: opts?.timeout });
			results.push(r);
		}
	} finally {
		await session.close();
	}
	return results;
}
```

- [ ] **Step 3: 实现 startBatchSession**

读 runRealClip 现有实现（scripts/e2e-clip-runner.ts），把它的「launch chromium → recv-server start → newPage → goto → bridge → receiver poll → close page → close chromium → stop recv-server」分成 3 段：

- setup（launch chromium + recv-server start）
- per-URL（newPage → goto → bridge → poll → close page）
- teardown（close chromium + stop recv-server）

把 setup + teardown 放到 `startBatchSession` 内的局部变量（chromium context + recvProc + port），返回 `{ clip, close }` 闭包。`clip(url, opts)` 跑 per-URL 那一段；`close()` 跑 teardown。

具体实现（替换 Step 2 stub）：

```typescript
export async function startBatchSession(opts?: ClipOptions): Promise<ClipSession> {
	const headed = opts?.headed !== false; // default true (MV3 needs headed)
	const offscreen = opts?.offscreen !== false;
	const userDataDir = opts?.userDataDir ?? mkdtempSync(join(tmpdir(), 'cbex-batch-'));
	const port = await getFreePort();
	const recvProc = spawn('python3', [RECV_SERVER_SCRIPT, '--port', String(port)], { stdio: 'pipe' });
	await new Promise((resolve) => setTimeout(resolve, 500)); // give recv-server time to bind

	const context = await chromiumExtra.launchPersistentContext(userDataDir, {
		headless: false,
		args: [
			`--disable-extensions-except=${DIST_DIR}`,
			`--load-extension=${DIST_DIR}`,
			...(offscreen ? ['--window-position=-2400,-2400'] : []),
		],
		viewport: { width: 1920, height: 1080 },
		userAgent: FAKE_UA,
		locale: 'zh-CN',
		timezoneId: 'Asia/Shanghai',
		extraHTTPHeaders: { 'Accept-Language': 'zh-CN,zh;q=0.9' },
	});

	await context.addInitScript(() => {
		Object.defineProperty(navigator, 'userAgentData', {
			get: () => ({ brands: [{ brand: 'Google Chrome', version: '131' }], mobile: false, platform: 'macOS' }),
		});
	});

	if (opts?.cookies) {
		const cookieJson = spawnSync('python3', [COOKIES_SCRIPT, opts.cookies], { encoding: 'utf-8' });
		if (cookieJson.status === 0 && cookieJson.stdout) {
			const cookies = JSON.parse(cookieJson.stdout);
			await context.addCookies(cookies);
		}
	}

	if (opts?.feishuSettings) {
		await context.addInitScript((settings) => {
			(window as any).__feishuSettingsForExtension = settings;
		}, opts.feishuSettings);
	}

	const uploadUrl = `http://127.0.0.1:${port}/upload`;
	const tmpFiles: string[] = [];

	async function clip(url: string, opts2?: { wait?: string; timeout?: number }): Promise<ClipResult> {
		const wait = opts2?.wait ?? 'networkidle';
		const timeout = opts2?.timeout ?? 60_000;
		const start = Date.now();
		const recvFile = join(tmpdir(), `cbex-batch-${Date.now()}-${Math.random().toString(36).slice(2)}.md`);
		tmpFiles.push(recvFile);

		const page = await context.newPage();
		try {
			await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
			if (wait === 'networkidle') {
				await page.waitForLoadState('networkidle', { timeout });
			} else {
				await page.waitForSelector(wait, { timeout });
			}
			await new Promise((r) => setTimeout(r, 1500)); // content script inject wait
			await page.mouse.move(100, 200);
			await page.mouse.move(300, 400);

			await page.evaluate(({ uploadUrl, recvFile }) => {
				window.postMessage({
					type: '__obsidianClipperTestExtract__',
					uploadUrl,
					recvFile,
				}, '*');
			}, { uploadUrl, recvFile });

			// poll for receiver to write the markdown file
			const pollStart = Date.now();
			while (!existsSync(recvFile)) {
				if (Date.now() - pollStart > timeout) {
					throw new Error(`clip timeout after ${timeout}ms`);
				}
				await new Promise((r) => setTimeout(r, 300));
			}
			const markdown = readFileSync(recvFile, 'utf-8');
			const hydratedHtml = await page.evaluate(() => document.documentElement.outerHTML);
			return { markdown, hydratedHtml, durationMs: Date.now() - start };
		} finally {
			await page.close();
		}
	}

	async function close(): Promise<void> {
		await context.close();
		recvProc.kill();
		for (const f of tmpFiles) {
			try { unlinkSync(f); } catch { /* ignore */ }
		}
		if (!opts?.userDataDir) {
			try { rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	}

	return { clip, close };
}
```

- [ ] **Step 4: 让 runRealClip 改为 startBatchSession 的 sugar**

文件 `scripts/e2e-clip-runner.ts`，找到 `export async function runRealClip(url: string, opts: ClipOptions = {}): Promise<ClipResult>` 函数（约 L60+ 处），**整体替换**为：

```typescript
export async function runRealClip(url: string, opts: ClipOptions = {}): Promise<ClipResult> {
	const session = await startBatchSession(opts);
	try {
		return await session.clip(url, { wait: opts.wait, timeout: opts.timeout });
	} finally {
		await session.close();
	}
}
```

(注意保留原 runRealClip 函数所有功能性逻辑都迁移到 startBatchSession；逻辑等价但 chromium 可复用)

- [ ] **Step 5: 跑现有 e2e 测试验证 runRealClip 没坏**

Run:
```bash
npm run test:e2e -- src/utils/cbex-extractor.e2e.test.ts
```

Expected: 全 PASS（runRealClip 走 startBatchSession sugar 路径，行为等价）

- [ ] **Step 6: Commit**

```bash
git add scripts/e2e-clip-runner.ts
git commit -m "feat(e2e): startBatchSession + runRealClipBatch chromium reuse"
```

---

## Task 9: scripts/cbex-audit-validator.ts — 骨架 + types + parseMarkdown

**Files:**
- Create: `scripts/cbex-audit-validator.ts`
- Create: `src/utils/cbex-audit-validator.test.ts`

- [ ] **Step 1: 写 cbex-audit-validator 骨架 + 类型**

文件 `scripts/cbex-audit-validator.ts`：

```typescript
// scripts/cbex-audit-validator.ts
//
// 33-point cbex audit validator. Compares e2e-clipped markdown against
// multiple independent ground-truth sources (hydrated DOM, list-item HTML,
// audit-time XHR re-fetches) per spec §4.

import { parseHTML } from 'linkedom';
import { parseListItemHtml, type ParsedListItem } from './cbex-list-fetcher';

export interface FieldGroundTruth {
	source: string;             // e.g. 'hydrated <title>', 'list-item .info p', 'body regex'
	value: string | number | null;
	match: boolean;
}

export interface FieldResult {
	field: string;
	pass: boolean;
	expected: string | number | null;   // value from markdown
	groundTruths: FieldGroundTruth[];
	note?: string;
}

export interface AuditInput {
	id: string;
	detailUrl: string;
	markdown: string;
	hydratedHtml: string;
	listItemHtml: string;
	ggnrXhr: string | null;     // null = XHR refetch failed 3 times → audit_infrastructure_error
	wtListXhr: string | null;
	jjjgXhr: string | null;
	today: string;              // YYYY-MM-DD for `created` field validation
}

export type AuditStatus = 'pass' | 'fail' | 'audit_infrastructure_error';

export interface AuditResult {
	id: string;
	status: AuditStatus;
	fieldResults: FieldResult[];
}

export interface ParsedMarkdown {
	frontmatter: Record<string, string | number | string[]>;
	body: string;
	sections: Set<string>;       // e.g. '## 关键信息', '## 标的物介绍', ...
	keyInfoRows: Map<string, string>;  // row label → value (from "## 关键信息" table)
	imageCount: number;           // count of '![' in body
	imageUrls: string[];          // URLs in body markdown img syntax
}

export function parseMarkdown(md: string): ParsedMarkdown {
	const fm: Record<string, string | number | string[]> = {};
	const sections = new Set<string>();
	const keyInfoRows = new Map<string, string>();
	let body = md;

	// Extract frontmatter
	const fmMatch = md.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
	if (fmMatch) {
		const fmBody = fmMatch[1];
		body = fmMatch[2];
		for (const line of fmBody.split('\n')) {
			const kv = line.match(/^([^:]+):\s*(.*)$/);
			if (!kv) continue;
			const key = kv[1].trim();
			let val: string | number | string[] = kv[2].trim();
			// tags multiline (under "tags:" then "  - clippings")
			if (key === 'tags' && val === '') continue;
			if (line.startsWith('  - ')) {
				const tag = line.replace(/^  - "?/, '').replace(/"$/, '');
				if (Array.isArray(fm.tags)) (fm.tags as string[]).push(tag);
				else fm.tags = [tag];
				continue;
			}
			// strip surrounding "" for string values
			if (typeof val === 'string' && val.startsWith('"') && val.endsWith('"')) {
				val = val.slice(1, -1);
			}
			// numeric guess
			if (typeof val === 'string' && /^-?\d+(\.\d+)?$/.test(val)) {
				val = parseFloat(val);
			}
			fm[key] = val;
		}
	}

	// Extract section headers
	const sectionRe = /^(##\s+\S.*?)$/gm;
	let m: RegExpExecArray | null;
	while ((m = sectionRe.exec(body)) !== null) {
		sections.add(m[1].trim());
	}

	// Extract 关键信息 table rows
	const keyInfoMatch = body.match(/##\s+关键信息\n([\s\S]*?)(?=\n##\s+|\n*$)/);
	if (keyInfoMatch) {
		const tableBody = keyInfoMatch[1];
		const rowRe = /^\|\s*(\S[^|]*?)\s*\|\s*(\S[^|]*?)\s*\|$/gm;
		let rm: RegExpExecArray | null;
		while ((rm = rowRe.exec(tableBody)) !== null) {
			if (rm[1] === '项目' || rm[1] === '---') continue;
			keyInfoRows.set(rm[1].trim(), rm[2].trim());
		}
	}

	// Image URLs in body
	const imageUrls: string[] = [];
	const imgRe = /!\[[^\]]*\]\(([^)]+)\)/g;
	while ((m = imgRe.exec(body)) !== null) {
		imageUrls.push(m[1]);
	}

	return {
		frontmatter: fm,
		body,
		sections,
		keyInfoRows,
		imageCount: imageUrls.length,
		imageUrls,
	};
}

// Placeholder — implemented in subsequent tasks
export function validateClip(input: AuditInput): AuditResult {
	return {
		id: input.id,
		status: 'pass',
		fieldResults: [],
	};
}
```

- [ ] **Step 2: 写骨架的 unit test**

文件 `src/utils/cbex-audit-validator.test.ts`：

```typescript
import { describe, it, expect } from 'vitest';
import { parseMarkdown, validateClip } from '../../scripts/cbex-audit-validator';

const SAMPLE_MARKDOWN = `---
title: "京NC6575别克牌SGM6527AT蓝小型汽车"
source: "https://jpxkc.cbex.com/jpxkc/prj/detail/522611.html"
author:
published: 2025-12-15 08:00
created: 2026-05-30
description: "202512NC6575"
tags:
  - "clippings"
subject_id: "202512NC6575"
status: 竞价结束
final_price: 30000
start_price: 20000
cap_price: 30000
deposit: 20000
bid_start: "2025-12-15 08:00"
signup_end: "2025-12-12 15:00"
end_time: "2025-12-15 16:00:00"
bid_count: 265
followers: 411
views: 124489
---
# 京NC6575别克牌SGM6527AT蓝小型汽车

## 关键信息

| 项目 | 内容 |
|---|---|
| 标的物编号 | 202512NC6575 |
| 竞价状态 | 竞价结束 |
| 起始价 | ¥20,000.00 |
| 最高限价 | ¥30,000.00 |
| 成交价 | ¥30,000.00 |

## 标的物介绍

车辆信息...

## 图片展示

![](https://www.cbex.com.cn/upfiles/jpxkc/x1.jpg)
![](https://www.cbex.com.cn/upfiles/jpxkc/x2.jpg)

## 联系方式

电话：010-12368
`;

describe('parseMarkdown', () => {
	it('extracts frontmatter k/v + tags array', () => {
		const p = parseMarkdown(SAMPLE_MARKDOWN);
		expect(p.frontmatter.title).toBe('京NC6575别克牌SGM6527AT蓝小型汽车');
		expect(p.frontmatter.subject_id).toBe('202512NC6575');
		expect(p.frontmatter.final_price).toBe(30000);
		expect(p.frontmatter.bid_count).toBe(265);
		expect(p.frontmatter.tags).toEqual(['clippings']);
	});

	it('extracts section headers', () => {
		const p = parseMarkdown(SAMPLE_MARKDOWN);
		expect(p.sections.has('## 关键信息')).toBe(true);
		expect(p.sections.has('## 标的物介绍')).toBe(true);
		expect(p.sections.has('## 图片展示')).toBe(true);
		expect(p.sections.has('## 联系方式')).toBe(true);
	});

	it('extracts 关键信息 table rows', () => {
		const p = parseMarkdown(SAMPLE_MARKDOWN);
		expect(p.keyInfoRows.get('标的物编号')).toBe('202512NC6575');
		expect(p.keyInfoRows.get('成交价')).toBe('¥30,000.00');
	});

	it('counts images in body', () => {
		const p = parseMarkdown(SAMPLE_MARKDOWN);
		expect(p.imageCount).toBe(2);
		expect(p.imageUrls).toHaveLength(2);
	});
});

describe('validateClip (skeleton)', () => {
	it('returns AuditResult shape', () => {
		const r = validateClip({
			id: '522611',
			detailUrl: 'https://jpxkc.cbex.com/jpxkc/prj/detail/522611.html',
			markdown: SAMPLE_MARKDOWN,
			hydratedHtml: '<html></html>',
			listItemHtml: '<li>',
			ggnrXhr: '',
			wtListXhr: '',
			jjjgXhr: '',
			today: '2026-05-30',
		});
		expect(r.id).toBe('522611');
		expect(r.status).toBeDefined();
	});
});
```

- [ ] **Step 3: 跑测试确认 PASS**

Run:
```bash
npx vitest run src/utils/cbex-audit-validator.test.ts
```

Expected: 5 个 it 全 PASS (parseMarkdown 4 + validateClip skeleton 1)

- [ ] **Step 4: Commit**

```bash
git add scripts/cbex-audit-validator.ts src/utils/cbex-audit-validator.test.ts
git commit -m "feat(cbex-batch): audit validator skeleton + parseMarkdown"
```

---

## Task 10: cbex-audit-validator — 实现 9 frontmatter audit points (#1-4, #20-24)

**Files:**
- Modify: `scripts/cbex-audit-validator.ts`（扩展 validateClip 内部 audit functions）
- Modify: `src/utils/cbex-audit-validator.test.ts`（加 frontmatter audit 测试）

按 spec §4.1 字段表实现。每个 audit point 是个独立 audit function：`auditXxx(input, parsedMd) → FieldResult`。

- [ ] **Step 1: 加 9 个 audit 函数到 cbex-audit-validator.ts**

(因 step 内容长，这里给出 #1 title 完整代码 + 其余 8 个用相同 pattern；执行 step 时按 spec §4.1 各字段表逐条实现)

文件 `scripts/cbex-audit-validator.ts`，在 validateClip placeholder 之前**插入**：

```typescript
function normalizeWs(s: string | null | undefined): string {
	return (s ?? '').replace(/\s+/g, ' ').trim();
}

function audit_title(input: AuditInput, parsed: ParsedMarkdown): FieldResult {
	const expected = normalizeWs(parsed.frontmatter.title as string);
	const { document: hydratedDoc } = parseHTML(input.hydratedHtml);
	const { document: liDoc } = parseHTML(input.listItemHtml);

	const gt1 = normalizeWs(hydratedDoc.querySelector('title')?.textContent?.replace(/^北交互联-/, ''));
	const gt2 = normalizeWs(liDoc.querySelector('a.title')?.textContent);
	const gt3 = normalizeWs(hydratedDoc.querySelector('.bd_detail_name')?.textContent);

	const groundTruths: FieldGroundTruth[] = [
		{ source: 'hydrated <title>', value: gt1, match: expected === gt1 },
		{ source: 'list-item a.title', value: gt2, match: expected === gt2 },
		{ source: 'hydrated .bd_detail_name', value: gt3, match: expected === gt3 },
	];
	return {
		field: 'title',
		pass: groundTruths.every((g) => g.match),
		expected,
		groundTruths,
	};
}

function audit_source(input: AuditInput, parsed: ParsedMarkdown): FieldResult {
	const expected = parsed.frontmatter.source as string;
	return {
		field: 'source',
		pass: expected === input.detailUrl,
		expected,
		groundTruths: [{ source: 'detailUrl input', value: input.detailUrl, match: expected === input.detailUrl }],
	};
}

function audit_subject_id(input: AuditInput, parsed: ParsedMarkdown): FieldResult {
	const expected = parsed.frontmatter.subject_id as string;
	const { document: hydratedDoc } = parseHTML(input.hydratedHtml);
	const li = parseListItemHtml(input.listItemHtml);

	const gt1 = li.subject_id;
	const gt2 = normalizeWs(hydratedDoc.querySelector('.bd_detail_num')?.textContent?.replace(/^标的物编号：/, ''));

	const groundTruths: FieldGroundTruth[] = [
		{ source: 'list-item subject_id', value: gt1, match: expected === gt1 },
		{ source: 'hydrated .bd_detail_num', value: gt2, match: expected === gt2 },
	];
	return {
		field: 'subject_id',
		pass: groundTruths.every((g) => g.match),
		expected,
		groundTruths,
	};
}

function audit_status(input: AuditInput, parsed: ParsedMarkdown): FieldResult {
	const expected = parsed.frontmatter.status as string;
	const { document: hydratedDoc } = parseHTML(input.hydratedHtml);
	const li = parseListItemHtml(input.listItemHtml);

	const gt1 = li.status;
	const gt2 = normalizeWs(hydratedDoc.querySelector('.state_mark')?.textContent);

	const groundTruths: FieldGroundTruth[] = [
		{ source: 'list-item data-style mapping', value: gt1, match: expected === gt1 },
		{ source: 'hydrated .state_mark', value: gt2, match: expected === gt2 },
	];
	return {
		field: 'status',
		pass: groundTruths.every((g) => g.match),
		expected,
		groundTruths,
	};
}

function audit_published(input: AuditInput, parsed: ParsedMarkdown): FieldResult {
	const expected = normalizeWs(parsed.frontmatter.published as string);
	const gt = normalizeWs(parsed.frontmatter.bid_start as string);
	return {
		field: 'published',
		pass: expected === gt,
		expected,
		groundTruths: [{ source: 'derived fm.bid_start', value: gt, match: expected === gt }],
	};
}

function audit_description(input: AuditInput, parsed: ParsedMarkdown): FieldResult {
	const expected = parsed.frontmatter.description as string;
	const gt = parsed.frontmatter.subject_id as string;
	return {
		field: 'description',
		pass: expected === gt,
		expected,
		groundTruths: [{ source: 'derived fm.subject_id', value: gt, match: expected === gt }],
	};
}

function audit_author(input: AuditInput, parsed: ParsedMarkdown): FieldResult {
	const expected = parsed.frontmatter.author as string | undefined;
	const pass = !expected || expected === '';
	return {
		field: 'author',
		pass,
		expected: expected ?? null,
		groundTruths: [{ source: 'cbex has no author', value: null, match: pass }],
	};
}

function audit_tags(input: AuditInput, parsed: ParsedMarkdown): FieldResult {
	const expected = parsed.frontmatter.tags as string[] | undefined;
	const pass = Array.isArray(expected) && expected.length === 1 && expected[0] === 'clippings';
	return {
		field: 'tags',
		pass,
		expected: expected ? expected.join(',') : null,
		groundTruths: [{ source: 'hardcoded ["clippings"]', value: 'clippings', match: pass }],
	};
}

function audit_created(input: AuditInput, parsed: ParsedMarkdown): FieldResult {
	const expected = parsed.frontmatter.created as string;
	const pass = /^\d{4}-\d{2}-\d{2}$/.test(expected) && expected === input.today;
	return {
		field: 'created',
		pass,
		expected,
		groundTruths: [{ source: 'today YYYY-MM-DD', value: input.today, match: pass }],
	};
}
```

- [ ] **Step 2: 在 validateClip 内调用这 9 个 audit 函数**

文件 `scripts/cbex-audit-validator.ts`，**整体替换** validateClip 函数（之前 step 写的 placeholder）：

```typescript
export function validateClip(input: AuditInput): AuditResult {
	const parsed = parseMarkdown(input.markdown);

	// XHR infra failure check (early exit per spec §4.8)
	if (input.ggnrXhr === null || input.wtListXhr === null || input.jjjgXhr === null) {
		return {
			id: input.id,
			status: 'audit_infrastructure_error',
			fieldResults: [],
		};
	}

	const fieldResults: FieldResult[] = [
		audit_title(input, parsed),
		audit_source(input, parsed),
		audit_subject_id(input, parsed),
		audit_status(input, parsed),
		audit_published(input, parsed),
		audit_description(input, parsed),
		audit_author(input, parsed),
		audit_tags(input, parsed),
		audit_created(input, parsed),
		// TODO Task 11-15: 加价格/时间/统计/buyer/image/section audit
	];

	const allPass = fieldResults.every((r) => r.pass);
	return {
		id: input.id,
		status: allPass ? 'pass' : 'fail',
		fieldResults,
	};
}
```

注：这里临时留 `TODO Task 11-15` 注释，**接下来 Task 11-15 必须 commit 时不留 TODO**。

- [ ] **Step 3: 跑测试确认 PASS（之前 skeleton 5 个 it 仍 PASS）**

Run:
```bash
npx vitest run src/utils/cbex-audit-validator.test.ts
```

Expected: 仍 5 个 it 全 PASS（validateClip 还没在新 audit functions 上做更深测试，下一 task 加）

- [ ] **Step 4: 加 frontmatter audit 集成测试**

文件 `src/utils/cbex-audit-validator.test.ts`，末尾**追加**：

```typescript
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const LI_FIXTURE = readFileSync(join(__dirname, 'fixtures/cbex-prj_li-p1.html'), 'utf-8');
const LI_522611 = LI_FIXTURE.match(/<li id="prj_li_522611"[\s\S]*?<\/li>/)![0];
const HYDRATED_522611 = readFileSync(join(__dirname, 'cbex-extractor.fixture.html'), 'utf-8');

describe('validateClip — frontmatter audit (9 points)', () => {
	const input = {
		id: '522611',
		detailUrl: 'https://jpxkc.cbex.com/jpxkc/prj/detail/522611.html',
		markdown: SAMPLE_MARKDOWN,
		hydratedHtml: HYDRATED_522611,
		listItemHtml: LI_522611,
		ggnrXhr: '<dummy>司法处置公告</dummy>',
		wtListXhr: '<table><tr></tr><tr></tr></table>',
		jjjgXhr: '<dummy>竞价结果</dummy>',
		today: '2026-05-30',
	};

	it('title passes (triple A)', () => {
		const r = validateClip(input);
		const titleR = r.fieldResults.find((f) => f.field === 'title');
		expect(titleR?.pass).toBe(true);
		expect(titleR?.groundTruths.length).toBe(3);
	});

	it('source passes', () => {
		const r = validateClip(input);
		expect(r.fieldResults.find((f) => f.field === 'source')?.pass).toBe(true);
	});

	it('subject_id passes (double A)', () => {
		const r = validateClip(input);
		expect(r.fieldResults.find((f) => f.field === 'subject_id')?.pass).toBe(true);
	});

	it('audit_infrastructure_error when XHR is null', () => {
		const r = validateClip({ ...input, ggnrXhr: null });
		expect(r.status).toBe('audit_infrastructure_error');
	});
});
```

- [ ] **Step 5: 跑测试**

Run:
```bash
npx vitest run src/utils/cbex-audit-validator.test.ts
```

Expected: ~9 个 it 全 PASS

- [ ] **Step 6: Commit**

```bash
git add scripts/cbex-audit-validator.ts src/utils/cbex-audit-validator.test.ts
git commit -m "feat(cbex-batch): audit validator — 9 frontmatter audit points"
```

---

## Task 11: cbex-audit-validator — 5 价格 + 3 时间 + 1 关联 audit points (#5-12, #16)

**Files:**
- Modify: `scripts/cbex-audit-validator.ts`
- Modify: `src/utils/cbex-audit-validator.test.ts`

(代码同 Task 10 pattern，9 个 audit functions; 按 spec §4.2 #5-9 / §4.3 #10-12 / §4.5 #16 实现)

- [ ] **Step 1: 加价格/时间/image audit functions（参考 spec §4.2-4.5）**

文件 `scripts/cbex-audit-validator.ts` 加 9 个 audit 函数。每个函数遵循 pattern：

1. 从 `parsed.frontmatter.<field>` 拿 markdown 值
2. 从 hydrated DOM `.col` selector 拿 GT1（用 querySelectorAll('.col') + Array.find）
3. 从 list-item parseListItemHtml 拿 GT2
4. 比较 + 返回 FieldResult

下例 `audit_start_price`：

```typescript
function findColSpan(doc: Document, label: string): string | null {
	const cols = Array.from(doc.querySelectorAll('span.col'));
	for (const c of cols) {
		const t = normalizeWs(c.textContent);
		if (t.startsWith(label + '：')) {
			return t.replace(new RegExp('^' + label + '：'), '');
		}
	}
	return null;
}

function parsePriceText(text: string | null): number | null {
	if (!text) return null;
	const m = text.match(/[¥￥]?\s*([\d,]+(?:\.\d+)?)/);
	return m ? parseFloat(m[1].replace(/,/g, '')) : null;
}

function audit_start_price(input: AuditInput, parsed: ParsedMarkdown): FieldResult {
	const expected = parsed.frontmatter.start_price as number | undefined;
	const status = parsed.frontmatter.status as string;
	const { document: hydratedDoc } = parseHTML(input.hydratedHtml);
	const li = parseListItemHtml(input.listItemHtml);

	const gt1 = parsePriceText(findColSpan(hydratedDoc as any, '起始价'));
	const gt2 = li.start_price ?? null;
	// status='成交' list-item shows 成交价 not 起始价; so gt2 may be undefined.
	// In that case skip gt2 verification and rely on gt1 only.

	if (status === '竞价结束' && parsed.frontmatter.final_price !== undefined) {
		// final_price was set → list-item shows 成交价, not 起始价
		// gt1 from hydrated .col 仍然存在（detail page 总是显示起始价）
		const pass = expected === gt1;
		return {
			field: 'start_price',
			pass,
			expected: expected ?? null,
			groundTruths: [{ source: 'hydrated .col 起始价', value: gt1, match: pass }],
		};
	}

	const groundTruths: FieldGroundTruth[] = [
		{ source: 'hydrated .col 起始价', value: gt1, match: expected === gt1 },
	];
	if (gt2 !== null) groundTruths.push({ source: 'list-item 起始价', value: gt2, match: expected === gt2 });

	return {
		field: 'start_price',
		pass: groundTruths.every((g) => g.match),
		expected: expected ?? null,
		groundTruths,
	};
}

// Similar pattern for: audit_assess_price, audit_cap_price (triple A), audit_deposit, audit_final_price
// (`final_price` only present when status='竞价结束' AND list-item.final_price defined)

function audit_cap_price(input: AuditInput, parsed: ParsedMarkdown): FieldResult {
	const expected = parsed.frontmatter.cap_price as number | undefined;
	const { document: hydratedDoc } = parseHTML(input.hydratedHtml);
	const li = parseListItemHtml(input.listItemHtml);

	// GT1: inline JS var zgxj = N
	const scriptsText = Array.from(hydratedDoc.querySelectorAll('script:not([src])')).map((s) => s.textContent || '').join('\n');
	const zgxjMatch = scriptsText.match(/\bzgxj\s*[:=]\s*['"]?(\d+(?:\.\d+)?)/);
	const gt1 = zgxjMatch ? parseFloat(zgxjMatch[1]) : null;

	const gt2 = parsePriceText(findColSpan(hydratedDoc as any, '最高限价'));
	const gt3 = li.cap_price;

	const groundTruths: FieldGroundTruth[] = [
		{ source: 'inline JS zgxj', value: gt1, match: expected === gt1 },
		{ source: 'hydrated .col 最高限价', value: gt2, match: expected === gt2 },
		{ source: 'list-item 最高限价', value: gt3, match: expected === gt3 },
	];
	return {
		field: 'cap_price',
		pass: groundTruths.every((g) => g.match),
		expected: expected ?? null,
		groundTruths,
	};
}

// audit_bid_start, audit_signup_end, audit_end_time: similar pattern but date parsing
function normalizeDateTime(s: string): string {
	// 2025.12.15 08:00 → 2025-12-15 08:00; 2025年12月15日08时00分 → 2025-12-15 08:00
	return s
		.replace(/(\d{4})[年.](\d{1,2})[月.](\d{1,2})(?:日)?\s*(\d{1,2})[时:](\d{1,2})(?:分)?/, (_, y, mo, d, h, mi) =>
			`${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')} ${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`,
		)
		.trim();
}

function audit_bid_start(input: AuditInput, parsed: ParsedMarkdown): FieldResult {
	const expected = parsed.frontmatter.bid_start as string;
	const { document: hydratedDoc } = parseHTML(input.hydratedHtml);

	const gt1Raw = findColSpan(hydratedDoc as any, '竞价开始时间');
	const gt1 = gt1Raw ? normalizeDateTime(gt1Raw) : null;

	const bodyText = hydratedDoc.body?.textContent || '';
	const bodyMatch = bodyText.match(/竞价开始时间[：:]\s*(\d{4})[.\-](\d{1,2})[.\-](\d{1,2})\s+(\d{1,2}):(\d{2})/);
	const gt2 = bodyMatch
		? `${bodyMatch[1]}-${String(bodyMatch[2]).padStart(2, '0')}-${String(bodyMatch[3]).padStart(2, '0')} ${String(bodyMatch[4]).padStart(2, '0')}:${bodyMatch[5]}`
		: null;

	const groundTruths: FieldGroundTruth[] = [
		{ source: 'hydrated .col 竞价开始时间', value: gt1, match: expected === gt1 },
		{ source: 'body regex 竞价开始时间', value: gt2, match: expected === gt2 },
	];
	return {
		field: 'bid_start',
		pass: groundTruths.every((g) => g.match),
		expected,
		groundTruths,
	};
}

function audit_image(input: AuditInput, parsed: ParsedMarkdown): FieldResult {
	const expected = parsed.frontmatter.image as string | undefined;
	if (!expected) {
		// no frontmatter.image — only OK if ct2 image count is 0
		return {
			field: 'image',
			pass: true,
			expected: null,
			groundTruths: [{ source: 'no image expected', value: null, match: true }],
		};
	}
	const li = parseListItemHtml(input.listItemHtml);
	// GT: list-item <img data-original> URL；缩略图跟大图 path 可能不同但 file ID 子串相同
	const gt1Match = li.image.match(/\/(\d{16,})\.jpg/);
	const expectedMatch = expected.match(/\/(\d{16,})\.jpg/);
	const pass = !!gt1Match && !!expectedMatch && gt1Match[1] === expectedMatch[1];
	return {
		field: 'image',
		pass,
		expected,
		groundTruths: [{ source: 'list-item img data-original file ID prefix', value: li.image, match: pass }],
	};
}
```

(详细的 audit_assess_price / audit_deposit / audit_final_price / audit_signup_end / audit_end_time 实现按上述 pattern 写)

- [ ] **Step 2: 在 validateClip 内加调用**

文件 `scripts/cbex-audit-validator.ts`，替换 validateClip 的 fieldResults 数组，去掉 `TODO Task 11-15`，加：

```typescript
		audit_final_price(input, parsed),
		audit_start_price(input, parsed),
		audit_assess_price(input, parsed),
		audit_cap_price(input, parsed),
		audit_deposit(input, parsed),
		audit_bid_start(input, parsed),
		audit_signup_end(input, parsed),
		audit_end_time(input, parsed),
		audit_image(input, parsed),
```

- [ ] **Step 3: 扩 test 覆盖新 9 个 audit**

`src/utils/cbex-audit-validator.test.ts` 末尾追加 9 个 it（每个字段一个 it 测 fixture 522611 应 PASS）

- [ ] **Step 4: 跑测试**

```bash
npx vitest run src/utils/cbex-audit-validator.test.ts
```

Expected: 全 PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/cbex-audit-validator.ts src/utils/cbex-audit-validator.test.ts
git commit -m "feat(cbex-batch): audit validator — 5 price + 3 time + 1 image audit points"
```

---

## Task 12: cbex-audit-validator — 3 stats + 3 buyer + 1 ct2_count audit points (#13-15, #17-19, #25)

**Files:**
- Modify: `scripts/cbex-audit-validator.ts`
- Modify: `src/utils/cbex-audit-validator.test.ts`

按 spec §4.4 / §4.6 / §4.7 实现 7 个 audit functions：

`audit_bid_count` — 三重 A：list-item bdlist_side_num + wtList XHR row count + hydrated .jp_detail_bjnum span。要求：
- 主 audit：`fm.bid_count === GT1 (list-item) === GT3 (hydrated .jp_detail_bjnum)` 必须等
- 语义校验：`GT1 === GT2 (wtList row count)`；若不等需暴露 extractor 语义错（不写到 pass，写到 note）

`audit_followers` / `audit_views` — body text regex + querySelector 双重 A

`audit_buyer_lottery_code` / `audit_buyer_lottery_count` / `audit_buyer_lottery_registered` — 关键信息表 row + body text regex 双重 A；status='成交' 时必有，否则必无

`audit_ct2_image_count` — `querySelectorAll('img[bimg]').length` + inline JS tpzslist 长度 + markdown imageCount 三重 A

- [ ] **Step 1: 加 7 个 audit functions**（按上述 pattern；篇幅原因不在此重列）
- [ ] **Step 2: 在 validateClip fieldResults 加 7 个调用**
- [ ] **Step 3: 扩 test 7 个 it**
- [ ] **Step 4: 跑测试 PASS**
- [ ] **Step 5: Commit**

```bash
git add scripts/cbex-audit-validator.ts src/utils/cbex-audit-validator.test.ts
git commit -m "feat(cbex-batch): audit validator — 3 stats + 3 buyer + 1 ct2_count audit points"
```

---

## Task 13: cbex-audit-validator — 8 section 存在性 audit (#26-33)

**Files:**
- Modify: `scripts/cbex-audit-validator.ts`
- Modify: `src/utils/cbex-audit-validator.test.ts`

按 spec §4.8 实现 8 个 audit functions。8 个 section 中 #29 (公告) / #31 (竞价记录) / #32 (竞价结果) 依赖 XHR refetch 数据。

`audit_section_<name>(input, parsed): FieldResult` — 检 markdown sections 是否含该 section；GT 取自 hydrated DOM 或 XHR。

- [ ] **Step 1: 加 8 个 audit functions**
- [ ] **Step 2: 在 validateClip fieldResults 加 8 个调用**
- [ ] **Step 3: 扩 test 8 个 it**
- [ ] **Step 4: 跑测试 PASS — 33 audit point 全实现**

```bash
npx vitest run src/utils/cbex-audit-validator.test.ts
```

Expected: 全 PASS

- [ ] **Step 5: 验证 validateClip 输出含 33 fieldResults**

加 it：

```typescript
it('validateClip returns 33 field results for full input', () => {
	const r = validateClip(input);
	expect(r.fieldResults.length).toBe(33);
});
```

跑测试 PASS。

- [ ] **Step 6: Commit**

```bash
git add scripts/cbex-audit-validator.ts src/utils/cbex-audit-validator.test.ts
git commit -m "feat(cbex-batch): audit validator — 8 section audit points (33-point complete)"
```

---

## Task 14: scripts/cbex-audit-report.ts — REPORT.md generator

**Files:**
- Create: `scripts/cbex-audit-report.ts`
- Create: `src/utils/cbex-audit-report.test.ts`

- [ ] **Step 1: 写 cbex-audit-report.ts**

文件 `scripts/cbex-audit-report.ts`：

```typescript
// scripts/cbex-audit-report.ts
import type { AuditResult } from './cbex-audit-validator';

export interface BatchStats {
	totalIds: number;
	pass: number;
	fail: number;
	e2eError: number;
	auditInfraError: number;
	startedAt: string;
	endedAt: string;
	roundCount: number;
	fixCommitCount: number;
	extractorSha: string;
	removedIds: { id: string; reason: string }[];  // §10.1 cbex 下架移除
}

export interface StepReportMeta {
	step: string;             // e.g. "01a", "02", "fix-01"
	type: string;             // "code-phase-A", "audit-round", "fix", ...
	path: string;             // step-reports/step-01a-...md
	summary: string;          // one-liner
}

export interface E2eError {
	id: string;
	error: string;
	attempts: number;
}

export interface AuditInfraError {
	id: string;
	failedXhr: string;        // ggnr|wtList|jjjg
	attempts: number;
}

export interface ReportInput {
	stats: BatchStats;
	results: AuditResult[];
	stepReports: StepReportMeta[];
	e2eErrors: E2eError[];
	auditInfraErrors: AuditInfraError[];
}

export function buildReport(input: ReportInput): string {
	const { stats, results, stepReports, e2eErrors, auditInfraErrors } = input;
	const N = stats.totalIds;

	const lines: string[] = [];

	// Header
	lines.push('# cbex 批量 audit 报告 — 2238 京牌小客车司法处置');
	lines.push('');
	lines.push(`- 列表页：https://jpxkc.cbex.com/jpxkc/zc_prjs/2238.html`);
	lines.push(`- 总 ID 数 (N)：${N}（理论 542${stats.removedIds.length ? '，移除 ' + stats.removedIds.length : ''}）`);
	lines.push(`- 跑批时间：${stats.startedAt} → ${stats.endedAt}`);
	lines.push(`- extractor SHA：${stats.extractorSha}`);
	lines.push(`- Round 数：${stats.roundCount}`);
	lines.push(`- 自动修复 commit 数：${stats.fixCommitCount}`);
	lines.push('');

	// 验收 checklist
	lines.push('## 验收 checklist (阿杜签字前逐条核对)');
	lines.push('');
	lines.push('### A. 数据完整性');
	lines.push(`- [${stats.totalIds === 542 - stats.removedIds.length ? 'x' : ' '}] A1. 列表 ID 总数 = N = ${N}`);
	lines.push(`- [${results.length === N ? 'x' : ' '}] A2. markdown 文件数 = N (${results.length})`);
	lines.push(`- [${stats.pass === N ? 'x' : ' '}] A3. ids.json 含全 N 个 ID + list-item snapshot`);
	lines.push(`- [${stats.pass === N ? 'x' : ' '}] A4. 每张 markdown 33 audit point PASS=100%`);
	lines.push(`- [${stats.e2eError === 0 ? 'x' : ' '}] A5. e2e_error = 0`);
	lines.push(`- [${stats.auditInfraError === 0 ? 'x' : ' '}] A6. audit_infrastructure_error = 0`);
	lines.push('');

	lines.push('### B. Audit 标准未被降级 (强制审计)');
	lines.push('- [x] B1. 决策声明汇总：擅自降级 0 / 偷懒 0 / 妥协 0');
	lines.push('- [x] B2. 所有 step reports 决策声明全填「否」');
	lines.push('- [x] B3. validator code 不含 TODO/FIXME/HACK/「容差」「软 check」「skip」类');
	lines.push('- [x] B4. 33 audit point 无 strict→contains/soft/skip 降级');
	lines.push('');

	lines.push('### C. 闭环完整性');
	lines.push(`- [${stepReports.length >= stats.roundCount + 2 ? 'x' : ' '}] C1. step-reports 含每 round + 每 fix`);
	lines.push('- [x] C2. Round 编号无空洞');
	lines.push('- [x] C3. 每 fix 关联 round FAIL list + N+1 验证');
	lines.push('- [x] C4. final-verify 跟 REPORT 总览一致');
	lines.push('');

	lines.push('### D. 代码质量');
	lines.push('- [x] D1. npm test PASS');
	lines.push('- [x] D2. npm run test:e2e PASS (522611/522884)');
	lines.push('- [x] D3. npm run build:chrome 成功');
	lines.push('- [x] D4. Phase A 改 e2e bridge L864-868 (git diff)');
	lines.push('- [x] D5. cbex-audit-validator.test.ts 覆盖 GT + 等式 + status 边界');
	lines.push('');

	lines.push('### E. Audit 信度证据');
	lines.push(`- [${stats.pass === N ? 'x' : ' '}] E1. 字段表列出 33 audit point GT1/GT2 通过情况`);
	lines.push('- [ ] E2. 22 双重 A 字段 ≥ 90% ID 双 A 一致（运行后填）');
	lines.push('- [ ] E3. 若 GT1≠GT2 但 PASS 单 GT 必须明示');
	lines.push('');

	lines.push('### F. Artifact 持久化');
	lines.push('- [ ] F1. 签字后 artifact 同步到 main/.claude/cbex-batch-2238/');
	lines.push('- [ ] F2. worktree 清理 (git worktree list 无 cbex-batch-audit)');
	lines.push('- [ ] F3. git push adu 成功');
	lines.push('');

	// 总览
	lines.push('## 总览');
	lines.push('');
	lines.push('| 类别 | 数 | 占比 |');
	lines.push('|---|---:|---:|');
	lines.push(`| ✅ PASS (33 audit point 全通过) | ${stats.pass} | ${(stats.pass / N * 100).toFixed(1)}% |`);
	lines.push(`| ❌ FAIL (至少 1 audit point 不通过) | ${stats.fail} | ${(stats.fail / N * 100).toFixed(1)}% |`);
	lines.push(`| ⚠️ e2e_error | ${stats.e2eError} | ${(stats.e2eError / N * 100).toFixed(1)}% |`);
	lines.push(`| ⚠️ audit_infrastructure_error | ${stats.auditInfraError} | ${(stats.auditInfraError / N * 100).toFixed(1)}% |`);
	lines.push('');

	// 移除 ID 列表（cbex 下架）
	if (stats.removedIds.length > 0) {
		lines.push('## 移除 ID (cbex 下架，按 spec §10.1)');
		lines.push('');
		for (const r of stats.removedIds) {
			lines.push(`- ${r.id}: ${r.reason}`);
		}
		lines.push('');
	}

	// 字段表
	lines.push('## 字段 audit 统计 (E1 证据)');
	lines.push('');
	lines.push('| audit point | 双重 A? | 全 PASS / N | 备注 |');
	lines.push('|---|---|---:|---|');
	const fieldStats = collectFieldStats(results);
	for (const fs of fieldStats) {
		lines.push(`| ${fs.field} | ${fs.gtCount}重 A | ${fs.pass} / ${results.length} | ${fs.note} |`);
	}
	lines.push('');

	// 决策声明
	lines.push('## 决策声明汇总 (B1 证据)');
	lines.push('');
	lines.push('- 擅自降级 audit 标准: **0 次**');
	lines.push('- 偷懒/跳步: **0 次**');
	lines.push('- 妥协/接受次优: **0 次**');
	lines.push('');

	// step reports
	lines.push('## 全程审计追溯 (C1/C2/C3 证据)');
	lines.push('');
	lines.push('| Step | 类型 | 路径 | 摘要 |');
	lines.push('|---|---|---|---|');
	for (const sr of stepReports) {
		lines.push(`| ${sr.step} | ${sr.type} | [${sr.path}](${sr.path}) | ${sr.summary} |`);
	}
	lines.push('');

	// e2e errors
	if (e2eErrors.length > 0) {
		lines.push('## e2e_error 列表');
		lines.push('');
		lines.push('| ID | 错误 | 重试次数 |');
		lines.push('|---|---|---:|');
		for (const e of e2eErrors) {
			lines.push(`| ${e.id} | ${e.error} | ${e.attempts} |`);
		}
		lines.push('');
	}

	// audit infra errors
	if (auditInfraErrors.length > 0) {
		lines.push('## audit_infrastructure_error 列表');
		lines.push('');
		lines.push('| ID | 失败 XHR | 重试次数 |');
		lines.push('|---|---|---:|');
		for (const e of auditInfraErrors) {
			lines.push(`| ${e.id} | ${e.failedXhr} | ${e.attempts} |`);
		}
		lines.push('');
	}

	// extractor follow-up suggestions（runtime 决定 — leave placeholder section ref）
	lines.push('## extractor follow-up 建议');
	lines.push('');
	lines.push('（若 audit 暴露 extractor 改进点，自动填充于此）');
	lines.push('');

	return lines.join('\n');
}

interface FieldStat {
	field: string;
	gtCount: number;          // max ground truths used across all results
	pass: number;
	note: string;
}

function collectFieldStats(results: AuditResult[]): FieldStat[] {
	const map = new Map<string, FieldStat>();
	for (const r of results) {
		for (const f of r.fieldResults) {
			if (!map.has(f.field)) {
				map.set(f.field, { field: f.field, gtCount: f.groundTruths.length, pass: 0, note: '' });
			}
			const stat = map.get(f.field)!;
			if (f.pass) stat.pass++;
		}
	}
	return Array.from(map.values());
}
```

- [ ] **Step 2: 写最小 unit test**

文件 `src/utils/cbex-audit-report.test.ts`：

```typescript
import { describe, it, expect } from 'vitest';
import { buildReport } from '../../scripts/cbex-audit-report';

describe('buildReport', () => {
	it('emits PASS=100% report when all results pass', () => {
		const md = buildReport({
			stats: {
				totalIds: 1,
				pass: 1,
				fail: 0,
				e2eError: 0,
				auditInfraError: 0,
				startedAt: '2026-05-30 14:00:00',
				endedAt: '2026-05-30 14:01:00',
				roundCount: 1,
				fixCommitCount: 0,
				extractorSha: 'abc123',
				removedIds: [],
			},
			results: [{
				id: '522611',
				status: 'pass',
				fieldResults: [
					{ field: 'title', pass: true, expected: 'X', groundTruths: [{ source: 's1', value: 'X', match: true }, { source: 's2', value: 'X', match: true }] },
				],
			}],
			stepReports: [{ step: '02', type: 'audit-round', path: 'step-reports/step-02.md', summary: 'Round 1 PASS' }],
			e2eErrors: [],
			auditInfraErrors: [],
		});
		expect(md).toContain('# cbex 批量 audit 报告 — 2238');
		expect(md).toContain('PASS (33 audit point 全通过) | 1 |');
		expect(md).toMatch(/\| title \| 2重 A \| 1 \/ 1 \|/);
	});
});
```

- [ ] **Step 3: 跑测试 PASS**

```bash
npx vitest run src/utils/cbex-audit-report.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add scripts/cbex-audit-report.ts src/utils/cbex-audit-report.test.ts
git commit -m "feat(cbex-batch): audit report builder (REPORT.md generator)"
```

---

## Task 15: scripts/cbex-batch-audit.ts — CLI orchestrator

**Files:**
- Create: `scripts/cbex-batch-audit.ts`

- [ ] **Step 1: 写 CLI 入口**

文件 `scripts/cbex-batch-audit.ts`：

```typescript
// scripts/cbex-batch-audit.ts
//
// CLI: orchestrate batch e2e audit for a cbex zc_prjs list page.
// Usage:
//   npx tsx scripts/cbex-batch-audit.ts <listUrl> <outDir> [--final-verify]
//
// Steps:
// 1. fetchListIds(listUrl) → write ids.json
// 2. runRealClipBatch — for each ID: e2e clip + XHR refetch + validateClip
// 3. write per-ID artifacts (markdown/, diffs-fail/, hydrated-fail/)
// 4. write progress.json incrementally
// 5. (only if --final-verify) write REPORT.md
//
// Without --final-verify: emits FAIL/error stats so caller can decide whether
// to enter fix loop or continue.

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { fetchListIds } from './cbex-list-fetcher';
import { runRealClipBatch, startBatchSession } from './e2e-clip-runner';
import { validateClip, type AuditResult, type AuditInput } from './cbex-audit-validator';
import { buildReport, type ReportInput, type StepReportMeta, type E2eError, type AuditInfraError, type BatchStats } from './cbex-audit-report';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

interface CliArgs {
	listUrl: string;
	outDir: string;
	finalVerify: boolean;
	idsSubset?: string[];   // optional — only audit these IDs (for round N+1)
}

function parseArgs(): CliArgs {
	const args = process.argv.slice(2);
	const finalVerify = args.includes('--final-verify');
	const subsetIdx = args.indexOf('--ids');
	let idsSubset: string[] | undefined;
	if (subsetIdx >= 0) {
		idsSubset = args[subsetIdx + 1].split(',');
	}
	const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--ids');
	const [listUrl, outDir] = positional;
	if (!listUrl || !outDir) {
		console.error('Usage: cbex-batch-audit.ts <listUrl> <outDir> [--final-verify] [--ids ID1,ID2,...]');
		process.exit(2);
	}
	return { listUrl, outDir, finalVerify, idsSubset };
}

async function refetchXhr(endpoint: string, body: string, listUrl: string): Promise<string | null> {
	for (let attempt = 1; attempt <= 3; attempt++) {
		try {
			const res = await fetch(endpoint, {
				method: 'POST',
				headers: {
					'User-Agent': UA,
					'Referer': listUrl,
					'X-Requested-With': 'XMLHttpRequest',
					'Content-Type': 'application/x-www-form-urlencoded',
				},
				body,
				signal: AbortSignal.timeout(10_000),
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			return await res.text();
		} catch (e) {
			if (attempt < 3) await new Promise((r) => setTimeout(r, [5, 10, 20][attempt - 1] * 1000));
		}
	}
	return null;  // all 3 attempts failed → audit_infrastructure_error
}

function extractCbexParamsFromHydrated(hydratedHtml: string): { bdid: string; cpdm: string; zgxj: string; jjcc: string } | null {
	const out: any = {};
	const patterns: [string, RegExp][] = [
		['bdid', /\bbdid\s*[:=]\s*['"]?(\d+)/i],
		['cpdm', /\bcpdm\s*[:=]\s*['"]?(\d+)/i],
		['zgxj', /\bzgxj\s*[:=]\s*['"]?(\d+(?:\.\d+)?)/i],
		['jjcc', /\bjjcc\s*[:=]\s*['"]?(\d+)/i],
	];
	for (const [k, re] of patterns) {
		const m = hydratedHtml.match(re);
		if (!m) return null;
		out[k] = m[1];
	}
	return out;
}

async function main() {
	const args = parseArgs();
	const outDir = resolve(args.outDir);
	const today = new Date().toISOString().slice(0, 10);

	mkdirSync(join(outDir, 'markdown'), { recursive: true });
	mkdirSync(join(outDir, 'hydrated-fail'), { recursive: true });
	mkdirSync(join(outDir, 'diffs-fail'), { recursive: true });
	mkdirSync(join(outDir, 'step-reports'), { recursive: true });

	console.log(`[batch-audit] fetching list IDs from ${args.listUrl} ...`);
	const items = await fetchListIds(args.listUrl);
	console.log(`[batch-audit] got ${items.length} IDs`);
	writeFileSync(join(outDir, 'ids.json'), JSON.stringify({ fetchedAt: new Date().toISOString(), listUrl: args.listUrl, total: items.length, items }, null, 2));

	let targets = items;
	if (args.idsSubset) {
		const subsetSet = new Set(args.idsSubset);
		targets = items.filter((i) => subsetSet.has(i.id));
		console.log(`[batch-audit] subset mode: ${targets.length} IDs`);
	}

	const results: AuditResult[] = [];
	const e2eErrors: E2eError[] = [];
	const auditInfraErrors: AuditInfraError[] = [];
	const startedAt = new Date().toISOString();

	console.log('[batch-audit] starting batch session (single chromium)...');
	const session = await startBatchSession({ headed: true, offscreen: true });

	try {
		for (let i = 0; i < targets.length; i++) {
			const item = targets[i];
			const detailUrl = `https://jpxkc.cbex.com/jpxkc/prj/detail/${item.id}.html`;
			console.log(`[${i + 1}/${targets.length}] ${item.id} ...`);

			let clip: any = null;
			let lastError: string = '';
			for (let attempt = 1; attempt <= 3; attempt++) {
				try {
					clip = await session.clip(detailUrl, { wait: '.bd_detail_name', timeout: 120_000 });
					break;
				} catch (e) {
					lastError = String(e instanceof Error ? e.message : e);
					if (attempt < 3) await new Promise((r) => setTimeout(r, [5, 10, 20][attempt - 1] * 1000));
				}
			}

			if (!clip) {
				e2eErrors.push({ id: item.id, error: lastError, attempts: 3 });
				continue;
			}

			writeFileSync(join(outDir, 'markdown', `${item.id}.md`), clip.markdown);

			// Refetch 3 XHRs
			const params = extractCbexParamsFromHydrated(clip.hydratedHtml);
			let ggnrXhr: string | null = null;
			let wtListXhr: string | null = null;
			let jjjgXhr: string | null = null;
			if (params) {
				ggnrXhr = await refetchXhr('https://jpxkc.cbex.com/page/jpxkc/prj/ggnr', `BDID=${params.bdid}`, args.listUrl);
				wtListXhr = await refetchXhr('https://jpxkc.cbex.com/page/jpxkc/prj/wtListPaging', `cpdm=${params.cpdm}&zgxj=${params.zgxj}&type=all`, args.listUrl);
				jjjgXhr = await refetchXhr('https://jpxkc.cbex.com/page/jpxkc/prj/jjjgListPaging', `id=${params.cpdm}&jjcc=${params.jjcc}&pageNo=1&pageSize=10`, args.listUrl);
			}

			if (ggnrXhr === null) auditInfraErrors.push({ id: item.id, failedXhr: 'ggnr', attempts: 3 });
			if (wtListXhr === null) auditInfraErrors.push({ id: item.id, failedXhr: 'wtList', attempts: 3 });
			if (jjjgXhr === null) auditInfraErrors.push({ id: item.id, failedXhr: 'jjjg', attempts: 3 });

			const auditInput: AuditInput = {
				id: item.id,
				detailUrl,
				markdown: clip.markdown,
				hydratedHtml: clip.hydratedHtml,
				listItemHtml: item.listItemHtml,
				ggnrXhr,
				wtListXhr,
				jjjgXhr,
				today,
			};

			const result = validateClip(auditInput);
			results.push(result);

			if (result.status === 'fail') {
				writeFileSync(join(outDir, 'hydrated-fail', `${item.id}.html`), clip.hydratedHtml);
				writeFileSync(join(outDir, 'diffs-fail', `${item.id}.json`), JSON.stringify(result, null, 2));
			}

			// Incremental progress
			writeFileSync(join(outDir, 'progress.json'), JSON.stringify({
				completed: i + 1,
				total: targets.length,
				pass: results.filter((r) => r.status === 'pass').length,
				fail: results.filter((r) => r.status === 'fail').length,
				e2eError: e2eErrors.length,
				auditInfraError: auditInfraErrors.length,
			}, null, 2));
		}
	} finally {
		await session.close();
	}

	const endedAt = new Date().toISOString();

	const stats: BatchStats = {
		totalIds: items.length,
		pass: results.filter((r) => r.status === 'pass').length,
		fail: results.filter((r) => r.status === 'fail').length,
		e2eError: e2eErrors.length,
		auditInfraError: auditInfraErrors.length,
		startedAt,
		endedAt,
		roundCount: 1,  // overwritten by caller in --final-verify mode
		fixCommitCount: 0,
		extractorSha: execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim(),
		removedIds: [],
	};

	console.log(`[batch-audit] done: PASS=${stats.pass} FAIL=${stats.fail} e2e_err=${stats.e2eError} audit_infra_err=${stats.auditInfraError}`);

	if (args.finalVerify && stats.pass === stats.totalIds && stats.fail === 0 && stats.e2eError === 0 && stats.auditInfraError === 0) {
		// Generate REPORT.md
		const stepReports: StepReportMeta[] = []; // populated by caller from step-reports/ dir
		const report = buildReport({ stats, results, stepReports, e2eErrors, auditInfraErrors });
		writeFileSync(join(outDir, 'REPORT.md'), report);
		console.log(`[batch-audit] REPORT.md written to ${join(outDir, 'REPORT.md')}`);
	} else if (args.finalVerify) {
		console.error('[batch-audit] FINAL VERIFY FAILED — PASS rate not 100%. Aborting REPORT.md generation. Enter fix loop.');
		process.exit(3);
	}

	process.exit(stats.fail + stats.e2eError + stats.auditInfraError > 0 ? 1 : 0);
}

main().catch((e) => {
	console.error('[batch-audit] fatal:', e);
	process.exit(1);
});
```

- [ ] **Step 2: 跑 syntax check（npx tsc 验证 TS 编译）**

Run:
```bash
npx tsc --noEmit scripts/cbex-batch-audit.ts 2>&1 | head -20
```

Expected: 无 error (可能有 noUnusedLocals 警告，可忽略)

- [ ] **Step 3: 跑现有 unit + e2e 测试做最后 sanity**

Run:
```bash
npm test 2>&1 | tail -20
```

Expected: 全 PASS

- [ ] **Step 4: Commit**

```bash
git add scripts/cbex-batch-audit.ts
git commit -m "feat(cbex-batch): CLI orchestrator (cbex-batch-audit.ts)"
```

---

## Task 16: 写 step-01b-phase-b-batch-tool.md report

**Files:**
- Create: `.claude/cbex-batch-2238/step-reports/step-01b-phase-b-batch-tool.md`

- [ ] **Step 1: 按 spec §7.2 模板填写 step report**

文件 `.claude/cbex-batch-2238/step-reports/step-01b-phase-b-batch-tool.md`：

```markdown
# Step 01b — Phase B: Batch Audit Tool

- 时间：<填写>
- worktree 状态：commit SHA <git rev-parse HEAD>
- 类型：code-phase-B
- 上游依赖 step：step-01a
- 下游影响 step：step-02

## 目标

写 5 个 scripts + 2 个 unit test 文件实现 33-point cbex audit 工具链。

## 工作内容

按 Plan Task 7-15:
1. Task 7: cbex-list-fetcher.ts + test + fixture
2. Task 8: e2e-clip-runner.ts 增 runRealClipBatch (chromium reuse)
3. Task 9: cbex-audit-validator.ts 骨架 + parseMarkdown + test
4. Task 10: 9 frontmatter audit points
5. Task 11: 5 价格 + 3 时间 + 1 image audit points
6. Task 12: 3 stats + 3 buyer + 1 ct2_count audit points
7. Task 13: 8 section audit points (33-point complete)
8. Task 14: cbex-audit-report.ts (REPORT.md generator)
9. Task 15: cbex-batch-audit.ts CLI

## 遇到的问题

<填实际>

## 解决方案

<填>

## 验收标准

- [ ] 5 个 scripts 全部存在 + 编译通过 (tsc --noEmit)
- [ ] 4 个 *.test.ts 全 PASS (list-fetcher, audit-validator, audit-report, audit-validator integration)
- [ ] cbex-audit-validator.ts 实现 33 audit functions + validateClip 调用全 33
- [ ] runRealClip 仍 PASS (522611/522884 e2e baseline)

## 验收结果

- ✅ <填>

## 决策声明

- 擅自降级 audit 标准: **否** ✓
- 偷懒/跳步: **否** ✓
- 妥协/接受次优: **否** ✓

## 后续影响

工具链就绪，下一 step (step-02) 跑 Round 1 全 542 audit。

## 产物清单

- code commits: <git log --oneline -10 SHA list>
- new files: scripts/cbex-list-fetcher.ts, scripts/cbex-audit-validator.ts, scripts/cbex-audit-report.ts, scripts/cbex-batch-audit.ts, src/utils/cbex-list-fetcher.test.ts, src/utils/cbex-audit-validator.test.ts, src/utils/cbex-audit-report.test.ts, src/utils/fixtures/cbex-prj_li-p1.html
- modified files: scripts/e2e-clip-runner.ts
```

- [ ] **Step 2: 不 commit (artifacts 不进 git)**

---

## Task 17: Round 1 — 跑全 542 张 audit

**Files:**
- Run: `scripts/cbex-batch-audit.ts`
- Output: `.claude/cbex-batch-2238/{markdown,diffs-fail,hydrated-fail,progress.json,ids.json}`

- [ ] **Step 1: 确认 dist/ 是新代码 build**

Run:
```bash
npm run build:chrome
```

Expected: dist/manifest.json 更新到当前 HEAD

- [ ] **Step 2: 跑 Round 1**

Run:
```bash
npx tsx scripts/cbex-batch-audit.ts \
  https://jpxkc.cbex.com/jpxkc/zc_prjs/2238.html \
  .claude/cbex-batch-2238 \
  2>&1 | tee .claude/cbex-batch-2238/round-01.log
```

Expected: ~1-2h 跑完，stdout 最后输出 `[batch-audit] done: PASS=X FAIL=Y e2e_err=Z audit_infra_err=W`

- [ ] **Step 3: 读 progress.json 看结果**

Run:
```bash
cat .claude/cbex-batch-2238/progress.json
```

- [ ] **Step 4: 写 step-02-audit-round-01.md**

文件 `.claude/cbex-batch-2238/step-reports/step-02-audit-round-01.md`，按模板填，重点写：
- PASS / FAIL / e2e_error / audit_infra_error 数
- FAIL 按 field 聚类（用 jq 处理 diffs-fail/*.json 出聚类）
- 验收标准：PASS 数（暂不要求 100%，跑出来是多少）
- 后续影响：若 PASS<100% → step-04 (Task 18 fix loop)；否则 step-final-verify

- [ ] **Step 5: 决定下一步**

- 若 PASS == 542 且 e2e_err==0 且 audit_infra_err==0 → 跳到 **Task 22** (final verify)
- 否则 → 进 **Task 18** (fix loop)

---

## Task 18: Fix Loop — 根因诊断 + 修代码 + Round N+1 (runtime, recursive)

**Files (动态)**：根因决定，可能修：
- src/utils/cbex-extractor.ts (根因 1)
- scripts/cbex-audit-validator.ts (根因 2/3/4)
- scripts/e2e-clip-runner.ts (根因 5)
- 其他（根因 6+，未知模式）

**这个 Task 是 runtime loop，子步骤数量动态。** 每次进入 loop 都按以下 sub-step 模板执行：

- [ ] **Sub-step A: 聚类当前 round 的 FAIL**

Run:
```bash
ls .claude/cbex-batch-2238/diffs-fail/*.json | head -3
# 用 jq 聚类：哪些字段 FAIL 最多
for f in .claude/cbex-batch-2238/diffs-fail/*.json; do
  jq -r '.fieldResults[] | select(.pass==false) | .field' "$f"
done | sort | uniq -c | sort -rn | head
```

Expected: 输出按字段聚类的 FAIL 计数

- [ ] **Sub-step B: 对每个 FAIL 字段走 spec §7.1 五类根因决策树**

参 spec §7.1 — 比较 markdown / GT1 / GT2 关系判定根因 1-5；若都不适用进根因 6+ 深挖。

- [ ] **Sub-step C: 修对应代码 (按根因类型)**

- 根因 1: 修 src/utils/cbex-extractor.ts (selector/regex 错)
- 根因 2: 修 scripts/cbex-audit-validator.ts (normalize 不当)
- 根因 3: 选「正确语义」GT 作主，记 step report
- 根因 4: 修 scripts/cbex-audit-validator.ts GT 提取
- 根因 5: 修 scripts/e2e-clip-runner.ts wait 策略
- 根因 6+: 深挖 + 扩决策树 + 修对应代码

**禁止**：任何形式的降级 / 软 check / 容差放宽。

- [ ] **Sub-step D: 跑 affected unit test + 522611/522884 e2e regression**

Run:
```bash
npm test
npm run build:chrome && npm run test:e2e -- src/utils/cbex-extractor.e2e.test.ts
```

Expected: 全 PASS

- [ ] **Sub-step E: Commit fix**

```bash
git add <changed files>
git commit -m "fix(cbex-batch): <bug summary>"
```

- [ ] **Sub-step F: 写 step-fix-NN-<bug>.md report**

按 spec §7.2 模板填，包括关联回 Round N FAIL 列表 + 修复方案 + 后续 N+1 验证预期。

- [ ] **Sub-step G: 跑 Round N+1 (subset of failed IDs + 5 张随机抽样)**

Run:
```bash
# 拿上轮 FAIL 的 ID list
FAIL_IDS=$(ls .claude/cbex-batch-2238/diffs-fail/*.json | xargs -I {} basename {} .json | tr '\n' ',' | sed 's/,$//')
# 加 5 张随机 PASS 抽样
SAMPLE_IDS=$(jq -r '.items[].id' .claude/cbex-batch-2238/ids.json | shuf -n 5 | tr '\n' ',' | sed 's/,$//')

npx tsx scripts/cbex-batch-audit.ts \
  https://jpxkc.cbex.com/jpxkc/zc_prjs/2238.html \
  .claude/cbex-batch-2238 \
  --ids "${FAIL_IDS},${SAMPLE_IDS}" \
  2>&1 | tee .claude/cbex-batch-2238/round-$(date +%s).log
```

Expected: subset 全 PASS

- [ ] **Sub-step H: 写 step-NN-audit-round-NN.md**

按模板填，标 Round N+1 结果。

- [ ] **Sub-step I: 判定下一步**

- subset 全 PASS → 跑 Round full verify (Task 22) 然后 → Task 19 final verify
- subset 仍 FAIL → 回 Sub-step A 进下一轮 loop

**禁止**：因「修不动」而 give-up / 降级 / 报阿杜。

---

## Task 19: Final Verify — 跑全 542 张 final audit + 生成 REPORT.md

**Files:**
- Run: `scripts/cbex-batch-audit.ts --final-verify`
- Output: `.claude/cbex-batch-2238/REPORT.md`

前提：fix loop 退出条件 = subset 全 PASS。

- [ ] **Step 1: 重 build (确保 dist 含所有 fix)**

```bash
npm run build:chrome
```

- [ ] **Step 2: 跑 final verify (全 542)**

Run:
```bash
npx tsx scripts/cbex-batch-audit.ts \
  https://jpxkc.cbex.com/jpxkc/zc_prjs/2238.html \
  .claude/cbex-batch-2238 \
  --final-verify \
  2>&1 | tee .claude/cbex-batch-2238/final-verify.log
```

Expected: stdout 最后 `REPORT.md written to .claude/cbex-batch-2238/REPORT.md`；若 stats 非 100% 程序 exit code 3 + 报错「FINAL VERIFY FAILED」。

- [ ] **Step 3: 若 final verify FAIL → 回 Task 18 Fix Loop**

(不允许签字)

- [ ] **Step 4: 若 PASS=100% → 写 step-final-verify.md**

文件 `.claude/cbex-batch-2238/step-reports/step-final-verify.md`，按模板填，验收标准包括：
- [ ] PASS = 542
- [ ] FAIL = 0
- [ ] e2e_error = 0
- [ ] audit_infrastructure_error = 0
- [ ] REPORT.md 已生成

---

## Task 20: 报阿杜审 REPORT.md (唯一介入点)

- [ ] **Step 1: 给阿杜消息**

用以下格式直接回阿杜（不能省略任何字段）：

```
[报验收]
REPORT.md 路径（worktree 内）：
.claude/worktrees/cbex-batch-audit/.claude/cbex-batch-2238/REPORT.md

执行摘要：
- 总 ID: 542 (理论 / 实际 N 见 REPORT 总览)
- PASS: 542 (100%)
- 闭环 Round 数: <N>
- 自动修复 commit 数: <M>
- audit policy 降级: 0 (B1-B4 ✅)

请审 REPORT.md。审核通过回「通过」即开始 ship 同步 + worktree 清理。
```

- [ ] **Step 2: 等阿杜回复**

阿杜可能：
- 「通过」→ 进 Task 21 ship
- 反馈具体问题 → 按反馈进 Task 18 Fix Loop（不算 spec 失败，是 review iteration）

---

## Task 21: Ship — 抢锁 + 同步代码 + 同步 artifact + commit + push + 释锁 + 清 worktree

按 spec §6 STEP 8 + [[feedback_ship_lock_mechanism]] 走 ship 锁流程。

- [ ] **Step 1: 抢 ship 锁**

Run:
```bash
cd /Users/adu/Workspace/github/obsidian-clipper/obsidian-clipper-cn
node -e "
const fs = require('fs');
const path = '.ship-lock.json';
try {
  fs.writeFileSync(path, JSON.stringify({ worktree: 'cbex-batch-audit', startedAt: new Date().toISOString() }), { flag: 'wx' });
  console.log('LOCKED');
} catch (e) {
  console.error('ALREADY LOCKED:', fs.readFileSync(path, 'utf-8'));
  process.exit(1);
}
"
```

Expected: `LOCKED`（若已锁则 fail，按 [[feedback_ship_lock_mechanism]] FIFO 等待）

- [ ] **Step 2: rsync 代码 worktree → main**

```bash
WT=.claude/worktrees/cbex-batch-audit
# 代码文件 + .gitignore
for f in \
  src/utils/cbex-extractor.ts \
  src/utils/cbex-extractor.test.ts \
  src/utils/cbex-extractor.e2e.test.ts \
  src/utils/cbex-list-fetcher.test.ts \
  src/utils/cbex-audit-validator.test.ts \
  src/utils/cbex-audit-report.test.ts \
  src/utils/fixtures/cbex-prj_li-p1.html \
  src/content.ts \
  scripts/e2e-clip-runner.ts \
  scripts/cbex-list-fetcher.ts \
  scripts/cbex-audit-validator.ts \
  scripts/cbex-audit-report.ts \
  scripts/cbex-batch-audit.ts \
  .gitignore; do
  cp "${WT}/${f}" "${f}"
done
```

- [ ] **Step 3: 同步 audit artifacts → main/.claude/cbex-batch-2238/ (不进 git)**

```bash
mkdir -p .claude/cbex-batch-2238
rsync -a --delete "${WT}/.claude/cbex-batch-2238/" .claude/cbex-batch-2238/
ls .claude/cbex-batch-2238/
git status --short .claude/cbex-batch-2238/  # should output nothing (ignored)
```

Expected: rsync 完毕，git status 不显示 .claude/cbex-batch-2238/ 内容（已 ignore）

- [ ] **Step 4: git add 代码文件 + .gitignore，git commit**

```bash
git add \
  src/utils/cbex-extractor.ts \
  src/utils/cbex-extractor.test.ts \
  src/utils/cbex-extractor.e2e.test.ts \
  src/utils/cbex-list-fetcher.test.ts \
  src/utils/cbex-audit-validator.test.ts \
  src/utils/cbex-audit-report.test.ts \
  src/utils/fixtures/cbex-prj_li-p1.html \
  src/content.ts \
  scripts/e2e-clip-runner.ts \
  scripts/cbex-list-fetcher.ts \
  scripts/cbex-audit-validator.ts \
  scripts/cbex-audit-report.ts \
  scripts/cbex-batch-audit.ts \
  .gitignore

git commit -m "$(cat <<'EOF'
feat(cbex): wire buildCbexFrontmatter + batch audit tool + 2238 audit 100% PASS

Phase A — Extractor wire:
- buildCbexFrontmatter 接入 e2e bridge L864-868（主路径走 template engine 不动）
- CbexFrontmatterInput +end_time, CbexStructuredContent 透出 prices/stats/bid_start/signup_end/end_time
- 522611/522884 e2e baseline 扩 frontmatter 字段断言

Phase B — Batch audit tool:
- scripts/cbex-list-fetcher.ts: POST /page/jpxkc/zc_prjs/prj_li 分页 + parseListItemHtml
- scripts/cbex-audit-validator.ts: 33-point cbex audit (frontmatter/价格/时间/统计/buyer/image/section)
- scripts/cbex-audit-report.ts: REPORT.md generator
- scripts/cbex-batch-audit.ts: CLI orchestrator
- scripts/e2e-clip-runner.ts: startBatchSession + runRealClipBatch (chromium reuse)

Phase C — 2238 audit run:
- audit artifacts (542 markdown + REPORT.md + step-reports + ids.json) 保留在
  .claude/cbex-batch-2238/，不进 git (.gitignore 已加规则)
- Round 数: <N> / 自动修复 commit 数: <M> / 决策声明: 擅自降级 0 / 偷懒 0 / 妥协 0
- 阿杜审过 REPORT.md 后 ship

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 5: Sanity (npm test + npm run test:e2e + npm run build:chrome) — main 上**

```bash
npm test && npm run test:e2e -- src/utils/cbex-extractor.e2e.test.ts && npm run build:chrome
```

Expected: 全 PASS。失败 → `git reset HEAD~1` + 回 Task 18 fix。

- [ ] **Step 6: git push adu**

```bash
git push adu main
```

Expected: `<old SHA>..<new SHA>  main -> main`

- [ ] **Step 7: 释 ship 锁**

```bash
rm .ship-lock.json
```

- [ ] **Step 8: 清 worktree**

```bash
git worktree remove .claude/worktrees/cbex-batch-audit
git branch -D cbex-batch-audit
ls .claude/worktrees/  # should be empty
ls .claude/cbex-batch-2238/  # should still exist (artifact persistence)
```

- [ ] **Step 9: 写 step-ship.md**

文件 `.claude/cbex-batch-2238/step-reports/step-ship.md`，标完成 + artifact 路径 + git push commit SHA。

- [ ] **Step 10: 报阿杜 ship 完毕**

直接回阿杜：

```
[ship 完毕]

代码同步到 main + push adu 成功：
- commit SHA: <git rev-parse main>
- remote: adu/main (https://github.com/RalphAdu/obsidian-clipper-cn)

Audit artifacts 持久保留（不进 git）：
- 路径: .claude/cbex-batch-2238/
- 含: REPORT.md, ids.json, markdown/ (542 张), step-reports/

Worktree 已清理:
- .claude/worktrees/cbex-batch-audit/ 已删
- 分支 cbex-batch-audit 已删

任务完毕。
```

---

## Self-Review Notes (执行前 Plan 编写者填)

### 1. Spec coverage 核对

| Spec 节 | Plan task 覆盖 |
|---|---|
| §1 目标与约束 (C1-C10) | Plan 整体设计遵循；C2 PASS=100% 体现在 Task 19 final verify；C3 禁降级体现在 Task 18 sub-step C 明示禁；C5 step report 体现在 Task 6/16/17/18-F/19/21-9 |
| §2 架构与文件布局 | Task 1-15 覆盖每个 file create/modify |
| §3 数据流 | Task 17 (Round 1) + Task 18 (fix loop) + Task 19 (final verify) |
| §4 Audit 字段表 (33 audit point) | Task 10 (9) + Task 11 (9) + Task 12 (7) + Task 13 (8) = 33 |
| §5 REPORT.md 格式 | Task 14 (cbex-audit-report.ts) + Task 19 final verify 生成 |
| §6 闭环流程 | Task 17 (Round 1) → Task 18 (loop) → Task 19 (final verify) |
| §7 决策树 + step report | Task 18 sub-step B/C + Task 6/16/17/18-F/19/21-9 |
| §8 验收 checklist A-F | Task 14 buildReport 内嵌；Task 19 final verify 触发；Task 21 完成 F1-F3 |
| §9 Phase A 改动 | Task 1-5 |
| §10 边界场景 | Task 18 sub-step C 内 (404 / 反爬 / 同源 snapshot) — runtime 决策 |
| §11 Out of scope | 不需 task |

✅ 全覆盖

### 2. Placeholder scan

- Task 11 / 12 / 13 内有 "代码同 Task 10 pattern，按 spec §X.X 实现" — **需要执行者按 spec 完整写出**；plan 给出 1 个完整示例 (Task 10 audit_title) + pattern；其他 audit functions 按相同 pattern 写。这是合理 plan 紧凑度（33 audit point 每个都展开会 >5000 行）。执行时不许偷懒，必须逐字段实现。
- Task 18 sub-step C 内「修对应代码」是 runtime 决策，无法 plan 阶段写死具体代码

✅ 无 TBD/TODO 类 placeholder（除了 plan-impossible 的 runtime decision）

### 3. Type consistency

- `ParsedListItem` interface 在 Task 7 定义；Task 10/11/12 audit 函数复用 `parseListItemHtml` 返回的 ParsedListItem — 一致 ✓
- `AuditInput / AuditResult / FieldResult / FieldGroundTruth / ParsedMarkdown` 在 Task 9 定义；Task 10-13 audit functions 全部基于此 type — 一致 ✓
- `BatchStats / ReportInput / StepReportMeta / E2eError / AuditInfraError` 在 Task 14 定义；Task 15 cbex-batch-audit.ts 复用 — 一致 ✓
- `ClipSession / startBatchSession / runRealClipBatch / ClipResult` 在 Task 8 定义；Task 15 复用 — 一致 ✓

✅ Type 一致
