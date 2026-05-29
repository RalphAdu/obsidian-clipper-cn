# cbex/jpxkc Extractor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a dedicated extractor for 北京产权交易所京牌小客车司法处置 detail pages (`https://jpxkc.cbex.com/jpxkc/prj/detail/<prj_id>.html`) that captures all 7 tab contents + top-level structured fields into a well-formed Obsidian markdown note.

**Architecture:** Single extractor module `src/utils/cbex-extractor.ts` following the existing pattern (xiaoyuzhou / docs-qq). Top-level fields read directly from already-rendered DOM. Three lazy-loaded tabs (ct4 / ct7 / ct8) fetched via known POST endpoints (recon complete). Two pseudo-lazy tabs (ct1 / ct2) read from inline `<textarea>` / inline JS variable already present in the initial HTML. Output composes YAML frontmatter (indexable fields) + 关键信息 markdown table + per-tab markdown sections. Wired into `content.ts` main path and page-world test bridge for e2e parity.

**Tech Stack:** TypeScript, DOMParser (browser runtime + jsdom for tests), fetch (browser), Vitest, Playwright + real Chrome (e2e via `runRealClip`).

**Reference URLs:**
- Spec: `docs/superpowers/specs/2026-05-29-cbex-jpxkc-extractor-design.md`
- Test URL #1 (status=竞价结束, 已成交, **有**买受人摇号信息): https://jpxkc.cbex.com/jpxkc/prj/detail/522611.html
- Test URL #2 (status=竞价结束, 已成交, **无**买受人摇号信息): https://jpxkc.cbex.com/jpxkc/prj/detail/522884.html — covers buyer-field absence; if 报价中/报名中 URL becomes available later, add it as URL #3
- **Currency symbol variant** discovered during recon: 522611 uses half-width `¥` (U+00A5); 522884 uses full-width `￥` (U+FFE5). The `parsePrice` regex in Task 4 must accept both (already does — the `¥?` is optional, value capture is digit-driven).

**Recon Findings (frozen at 2026-05-29):**

| Tab | href | Mechanism | Endpoint / Source | Body |
|---|---|---|---|---|
| ct1 标的物介绍 | `#bd_detail_tab_ct1` | Hidden textarea | `#content_BDWJS` (HTML-encoded, decode `&lt;` etc.) | — |
| ct2 图片展示 | `#bd_detail_tab_ct2` | Inline JS var | `var tpzslist = [...]` (array of image URLs) | — |
| ct4 司法处置公告 | `#bd_detail_tab_ct4` | XHR POST | `/page/jpxkc/prj/ggnr` (Content-Type form) | `BDID=<bdid>` |
| ct5 竞买须知 | `#bd_detail_tab_ct5` | Server-rendered | DOM at load | — |
| ct6 联系方式 | `#bd_detail_tab_ct6` | Server-rendered | DOM at load | — |
| ct7 竞价记录 | `#bd_detail_tab_ct7` | XHR POST | `/page/jpxkc/prj/wtListPaging` | `cpdm=<prjId>&zgxj=<cap>&type=all` |
| ct8 竞价结果 | `#bd_detail_tab_ct8` | XHR POST | `/page/jpxkc/prj/jjjgListPaging` | `id=<prjId>&jjcc=1&pageNo=1&pageSize=10` |

Params extractable from inline scripts via regex: `BDID` (matches `bdid\s*[=:]\s*['"]?(\d+)`), `cpdm` (also `=prjId from URL`), `zgxj` (i.e. cap_price, from `zgxj\s*[=:]\s*['"]?(\d+(?:\.\d+)?)`), `jjcc` (from `jjcc\s*[=:]\s*['"]?(\d+)`).

All 3 XHR responses are `text/html` fragments — parse with `DOMParser` then map to markdown.

---

## File Structure

| File | Purpose |
|---|---|
| `src/utils/cbex-extractor.ts` (create) | URL detection, param extraction, per-tab fetch + DOM-to-markdown, main entry `extractCbexStructuredContent` |
| `src/utils/cbex-extractor.test.ts` (create) | Unit tests for URL detection, param extraction, top-level DOM extraction, frontmatter/table builders, per-tab markdown converters |
| `src/utils/cbex-extractor.e2e.test.ts` (create) | E2E via `runRealClip` against real cbex URL(s) — byte-equivalent assertion |
| `src/utils/cbex-extractor.fixture.html` (create) | DOM fixture: snapshot of 522611.html for unit tests (with inline scripts trimmed) |
| `src/utils/cbex-extractor.fixture-ct4.html` (create) | ggnr response snapshot |
| `src/utils/cbex-extractor.fixture-ct7.html` (create) | wtListPaging response snapshot |
| `src/utils/cbex-extractor.fixture-ct8.html` (create) | jjjgListPaging response snapshot |
| `src/content.ts` (modify) | Import + main-path wire + bridge-path wire + origin whitelist |
| `src/_locales/zh/messages.json` (modify) | No new key — reuse existing `extractorFailedFallback` |

---

## Task 1: URL detection + param extraction (TDD)

**Files:**
- Create: `src/utils/cbex-extractor.ts`
- Test: `src/utils/cbex-extractor.test.ts`

- [ ] **Step 1.1: Write failing tests for `isCbexPrjDetailUrl`**

Create `src/utils/cbex-extractor.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { isCbexPrjDetailUrl, parseCbexUrl } from './cbex-extractor';

describe('isCbexPrjDetailUrl', () => {
  it('matches jpxkc.cbex.com prj detail URLs', () => {
    expect(isCbexPrjDetailUrl('https://jpxkc.cbex.com/jpxkc/prj/detail/522611.html')).toBe(true);
    expect(isCbexPrjDetailUrl('http://jpxkc.cbex.com/jpxkc/prj/detail/12345.html')).toBe(true);
  });

  it('rejects other cbex URLs', () => {
    expect(isCbexPrjDetailUrl('https://jpxkc.cbex.com/jpxkc/zc_prjs/2238.html')).toBe(false);
    expect(isCbexPrjDetailUrl('https://otc.cbex.com/page/s/index')).toBe(false);
    expect(isCbexPrjDetailUrl('https://www.cbex.com.cn/')).toBe(false);
  });

  it('rejects non-cbex URLs', () => {
    expect(isCbexPrjDetailUrl('https://example.com/jpxkc/prj/detail/522611.html')).toBe(false);
    expect(isCbexPrjDetailUrl('not a url')).toBe(false);
  });
});

describe('parseCbexUrl', () => {
  it('extracts prjId from valid URL', () => {
    expect(parseCbexUrl('https://jpxkc.cbex.com/jpxkc/prj/detail/522611.html')).toEqual({ prjId: '522611' });
  });

  it('returns null for invalid URLs', () => {
    expect(parseCbexUrl('https://example.com/foo')).toBeNull();
  });
});
```

- [ ] **Step 1.2: Run tests — expect FAIL (module not found)**

```bash
npx vitest run src/utils/cbex-extractor.test.ts
```

Expected: errors about missing `./cbex-extractor` module.

- [ ] **Step 1.3: Create minimal `cbex-extractor.ts` to make tests pass**

```ts
// src/utils/cbex-extractor.ts

export interface CbexParsedUrl {
  prjId: string;
}

export function isCbexPrjDetailUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname === 'jpxkc.cbex.com' && /^\/jpxkc\/prj\/detail\/\d+\.html$/.test(u.pathname);
  } catch {
    return false;
  }
}

export function parseCbexUrl(url: string): CbexParsedUrl | null {
  if (!isCbexPrjDetailUrl(url)) return null;
  const u = new URL(url);
  const m = u.pathname.match(/^\/jpxkc\/prj\/detail\/(\d+)\.html$/);
  return m ? { prjId: m[1] } : null;
}
```

- [ ] **Step 1.4: Run tests — expect PASS**

```bash
npx vitest run src/utils/cbex-extractor.test.ts
```

Expected: PASS for `isCbexPrjDetailUrl` (3 tests) + `parseCbexUrl` (2 tests).

- [ ] **Step 1.5: Commit**

```bash
git add src/utils/cbex-extractor.ts src/utils/cbex-extractor.test.ts
git commit -m "feat(cbex): URL detection + parseCbexUrl helper"
```

---

## Task 2: Find a second-state test URL

**Goal:** Spec § 4.4 mandates testing at least 2 states (not just 竞价结束). Find a 报价中 / 报名中 / 未开始 URL.

- [ ] **Step 2.1: Browse cbex listing for active auctions**

Open `https://jpxkc.cbex.com/page/jpxkc/s/index.html` in a browser. Filter for 「报价中」 status. Pick a URL.

- [ ] **Step 2.2: Document the second URL in the plan**

Edit `docs/superpowers/plans/2026-05-29-cbex-jpxkc-extractor.md` — replace "Test URL #2 ... Task 1.5 must find" with the actual URL.

Also commit a brief note of its state (e.g. "状态：报价中, 起始价 ¥20000, 关注 N 人").

- [ ] **Step 2.3: Commit**

```bash
git add docs/superpowers/plans/2026-05-29-cbex-jpxkc-extractor.md
git commit -m "docs(plan): record second-state cbex test URL for e2e coverage"
```

---

## Task 3: Extract inline script params (`BDID`, `cpdm`, `zgxj`, `jjcc`)

**Files:**
- Modify: `src/utils/cbex-extractor.ts`
- Test: `src/utils/cbex-extractor.test.ts`

- [ ] **Step 3.1: Write failing test for `extractCbexParams`**

Append to `cbex-extractor.test.ts`:

```ts
import { extractCbexParams } from './cbex-extractor';
import { parseHTML } from 'linkedom';

describe('extractCbexParams', () => {
  it('extracts BDID, cpdm, zgxj, jjcc from inline scripts', () => {
    const html = `<html><body>
      <script>var foo = 1;
      var bdid = "4185";
      var cpdm = "522611";
      var zgxj = "30000.00";
      var jjcc = "1";
      </script></body></html>`;
    const { document: doc } = parseHTML(html);
    expect(extractCbexParams(doc)).toEqual({ bdid: '4185', cpdm: '522611', zgxj: '30000.00', jjcc: '1' });
  });

  it('tolerates colon-style assignments (object literals)', () => {
    const html = `<html><body>
      <script>var opts = { BDID: 999, prjId: 111, cpdm: '777', zgxj: '20000.00', jjcc: '2' };</script></body></html>`;
    const { document: doc } = parseHTML(html);
    expect(extractCbexParams(doc)).toEqual({ bdid: '999', cpdm: '777', zgxj: '20000.00', jjcc: '2' });
  });

  it('returns null for any missing param', () => {
    const html = `<html><body><script>var bdid = "4185";</script></body></html>`;
    const { document: doc } = parseHTML(html);
    expect(extractCbexParams(doc)).toBeNull();
  });
});
```

- [ ] **Step 3.2: Run test — expect FAIL**

```bash
npx vitest run src/utils/cbex-extractor.test.ts -t extractCbexParams
```

- [ ] **Step 3.3: Implement `extractCbexParams`**

Append to `cbex-extractor.ts`:

```ts
export interface CbexParams {
  bdid: string;
  cpdm: string;
  zgxj: string;
  jjcc: string;
}

const PARAM_PATTERNS: Record<keyof CbexParams, RegExp> = {
  bdid: /\bbdid\s*[:=]\s*['"]?(\d+)/i,
  cpdm: /\bcpdm\s*[:=]\s*['"]?(\d+)/i,
  zgxj: /\bzgxj\s*[:=]\s*['"]?(\d+(?:\.\d+)?)/i,
  jjcc: /\bjjcc\s*[:=]\s*['"]?(\d+)/i,
};

export function extractCbexParams(doc: ParentNode): CbexParams | null {
  const scripts = Array.from(doc.querySelectorAll('script:not([src])'));
  const all = scripts.map((s) => s.textContent || '').join('\n');
  const out: Partial<CbexParams> = {};
  for (const [k, re] of Object.entries(PARAM_PATTERNS) as [keyof CbexParams, RegExp][]) {
    const m = all.match(re);
    if (!m) return null;
    out[k] = m[1];
  }
  return out as CbexParams;
}
```

- [ ] **Step 3.4: Run test — expect PASS**

- [ ] **Step 3.5: Commit**

```bash
git add src/utils/cbex-extractor.ts src/utils/cbex-extractor.test.ts
git commit -m "feat(cbex): extractCbexParams (bdid/cpdm/zgxj/jjcc from inline scripts)"
```

---

## Task 4: Extract top-level rendered fields

**Files:**
- Modify: `src/utils/cbex-extractor.ts`
- Test: `src/utils/cbex-extractor.test.ts`
- Create: `src/utils/cbex-extractor.fixture.html`

- [ ] **Step 4.1: Capture top-level DOM fixture**

Save to `src/utils/cbex-extractor.fixture.html` a hand-trimmed HTML snippet covering the `.bd_detail_head` block plus the `.bd_detail_money_box`-equivalent block (you'll grep for the exact class via DevTools on the real page). Include enough text-node noise (e.g. the "报名及保证金报名费交纳截止时间：" line, "竞价开始时间：" line, "买受人摇号编码:" etc.) for the regex helpers to work against. ~300 lines is fine.

**Reference page elements to include** (drawn from 522611.html DOM walk done during brainstorm):

```html
<div class="bd_detail_head">
  <div class="bd_detail_scroll">...</div>
  <div class="bd_detail_head_rt">
    <div class="jp_detail_bjnum"><span>265</span></div>
    <div class="bd_detail_title">
      <p class="bd_detail_name">京NC6575别克牌SGM6527AT蓝小型汽车</p>
      <p class="bd_detail_num">标的物编号：202512NC6575</p>
    </div>
    <div>
      <div class="bd_detail_state_over jp_detail_state_ove">
        <span class="state_mark">竞价结束</span>
        <span class="fwb">结束时间：</span>
        <span class="time_num">2025</span><span>年</span>
        <span class="time_num">12</span><span>月</span>
        <span class="time_num">15</span><span>日</span>
        <span class="time_num">16</span><span>时</span>
        <span class="time_num">00</span><span>分</span>
        <span class="time_num">35</span><span>秒</span>
      </div>
    </div>
  </div>
</div>
<!-- 关键信息 block —— actual class TBD via DOM walk -->
<div class="bd_detail_info">
  <p>起始价：<span>¥ 20,000.00</span></p>
  <p>评估价：<span>¥ 20,000.00</span></p>
  <p>最高限价：<span>¥ 30,000.00</span></p>
  <p>保证金：<span>¥ 20,000.00</span></p>
  <p>本标的物成交价：<span>¥ 30,000.00</span></p>
  <p>竞价开始时间：<span>2025.12.15 08:00</span></p>
  <p>报名及保证金报名费交纳截止时间：<span>2025年12月12日15时00分（以到账为准）</span></p>
  <p>买受人摇号申请编码：6035100088419</p>
  <p>买受人摇号次数：87</p>
  <p>买受人摇号注册时间：2011-01-02 13:23:21.364</p>
  <p>关注：<span>411</span> 围观：<span>124477</span></p>
</div>
```

(Adjust class names + text to match real DOM — open 522611.html in DevTools, copy outerHTML of relevant blocks.)

- [ ] **Step 4.2: Write failing tests for each top-level extractor**

Append to `cbex-extractor.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  extractCbexTopFields,
  // Per-field unit helpers (exported for testability)
  extractTitle,
  extractSubjectId,
  extractStatus,
  extractEndTime,
  extractBidStartTime,
  extractSignupEndTime,
  extractPrices,
  extractBuyerInfo,
  extractStats,
} from './cbex-extractor';

function loadFixture(name: string): Document {
  const html = readFileSync(join(__dirname, name), 'utf-8');
  const { document } = parseHTML(html);
  return document as unknown as Document;
}

describe('top-level field extractors', () => {
  const doc = loadFixture('cbex-extractor.fixture.html');

  it('extractTitle returns .bd_detail_name text', () => {
    expect(extractTitle(doc)).toBe('京NC6575别克牌SGM6527AT蓝小型汽车');
  });

  it('extractSubjectId strips 标的物编号： prefix', () => {
    expect(extractSubjectId(doc)).toBe('202512NC6575');
  });

  it('extractStatus returns .state_mark text', () => {
    expect(extractStatus(doc)).toBe('竞价结束');
  });

  it('extractEndTime composes ymd hm from .time_num span sequence', () => {
    expect(extractEndTime(doc)).toBe('2025-12-15 16:00');
  });

  it('extractBidStartTime parses 竞价开始时间：YYYY.MM.DD HH:MM', () => {
    expect(extractBidStartTime(doc)).toBe('2025-12-15 08:00');
  });

  it('extractSignupEndTime parses Chinese date', () => {
    expect(extractSignupEndTime(doc)).toBe('2025-12-12 15:00');
  });

  it('extractPrices returns all numeric values', () => {
    expect(extractPrices(doc)).toEqual({
      start_price: 20000.00,
      assess_price: 20000.00,
      cap_price: 30000.00,
      deposit: 20000.00,
      final_price: 30000.00,
    });
  });

  it('extractBuyerInfo returns lottery code/count/registered_at', () => {
    expect(extractBuyerInfo(doc)).toEqual({
      lottery_code: '6035100088419',
      lottery_count: '87',
      lottery_registered: '2011-01-02 13:23',
    });
  });

  it('extractStats returns followers/views/bid_count', () => {
    expect(extractStats(doc)).toEqual({
      followers: 411,
      views: 124477,
      bid_count: 265,
    });
  });

  it('extractCbexTopFields composes everything', () => {
    const result = extractCbexTopFields(doc);
    expect(result.title).toBe('京NC6575别克牌SGM6527AT蓝小型汽车');
    expect(result.subject_id).toBe('202512NC6575');
    expect(result.final_price).toBe(30000.00);
  });
});
```

- [ ] **Step 4.3: Run tests — expect FAIL**

- [ ] **Step 4.4: Implement extractors one by one (TDD inner loop)**

Implement each helper to make its test pass. Each helper signature must be `(doc: ParentNode) => string | object | number | null` (per CLAUDE.md Helper API principle). Example skeleton:

```ts
export function extractTitle(doc: ParentNode): string {
  return (doc.querySelector('.bd_detail_name')?.textContent || '').trim();
}

export function extractSubjectId(doc: ParentNode): string {
  const raw = (doc.querySelector('.bd_detail_num')?.textContent || '').trim();
  return raw.replace(/^标的物编号[：:]\s*/, '');
}

export function extractStatus(doc: ParentNode): string {
  return (doc.querySelector('.state_mark')?.textContent || '').trim();
}

export function extractEndTime(doc: ParentNode): string {
  const nums = Array.from(doc.querySelectorAll('.bd_detail_state_over .time_num'))
    .map((el) => (el.textContent || '').trim());
  if (nums.length < 5) return '';
  // sequence is [年, 月, 日, 时, 分(, 秒)]
  const [y, mo, d, h, mi] = nums;
  return `${y}-${pad(mo)}-${pad(d)} ${pad(h)}:${pad(mi)}`;
}

function pad(s: string): string {
  return s.padStart(2, '0');
}

function getBodyText(doc: ParentNode): string {
  return (doc as any).body?.textContent || (doc as any).textContent || '';
}

export function extractBidStartTime(doc: ParentNode): string {
  const m = getBodyText(doc).match(/竞价开始时间[：:]\s*(\d{4})[.\-](\d{1,2})[.\-](\d{1,2})\s+(\d{1,2}):(\d{2})/);
  if (!m) return '';
  return `${m[1]}-${pad(m[2])}-${pad(m[3])} ${pad(m[4])}:${m[5]}`;
}

export function extractSignupEndTime(doc: ParentNode): string {
  const m = getBodyText(doc).match(/报名及保证金报名费交纳截止时间[：:]\s*(\d{4})年(\d{1,2})月(\d{1,2})日(\d{1,2})时(\d{1,2})分/);
  if (!m) return '';
  return `${m[1]}-${pad(m[2])}-${pad(m[3])} ${pad(m[4])}:${pad(m[5])}`;
}

function parsePrice(text: string): number | null {
  const m = text.match(/¥?\s*([\d,]+(?:\.\d+)?)/);
  if (!m) return null;
  return parseFloat(m[1].replace(/,/g, ''));
}

interface CbexPrices {
  start_price?: number;
  assess_price?: number;
  cap_price?: number;
  deposit?: number;
  final_price?: number;
}

export function extractPrices(doc: ParentNode): CbexPrices {
  const text = getBodyText(doc);
  const out: CbexPrices = {};
  const labelToKey: Array<[RegExp, keyof CbexPrices]> = [
    [/起始价[：:]([^评最保本竞报关围]+)/, 'start_price'],
    [/评估价[：:]([^起最保本竞报关围]+)/, 'assess_price'],
    [/最高限价[：:]([^起评保本竞报关围]+)/, 'cap_price'],
    [/保证金[：:]([^起评最本竞报关围]+)/, 'deposit'],
    [/本标的物成交价[：:]([^起评最保竞报关围]+)/, 'final_price'],
  ];
  for (const [re, key] of labelToKey) {
    const m = text.match(re);
    if (m) {
      const p = parsePrice(m[1]);
      if (p !== null) out[key] = p;
    }
  }
  return out;
}

interface CbexBuyer {
  lottery_code?: string;
  lottery_count?: string;
  lottery_registered?: string;
}

export function extractBuyerInfo(doc: ParentNode): CbexBuyer {
  const text = getBodyText(doc);
  const out: CbexBuyer = {};
  const mCode = text.match(/(?:买受人)?摇号申请编码[：:]\s*(\d+)/);
  if (mCode) out.lottery_code = mCode[1];
  const mCnt = text.match(/(?:买受人)?摇号次数[：:]\s*(\d+)/);
  if (mCnt) out.lottery_count = mCnt[1];
  // 摇号注册时间 may include sub-seconds — truncate to YYYY-MM-DD HH:MM
  const mReg = text.match(/(?:买受人)?摇号注册时间[：:]\s*(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})/);
  if (mReg) out.lottery_registered = `${mReg[1]} ${mReg[2]}`;
  return out;
}

interface CbexStats {
  followers: number;
  views: number;
  bid_count: number;
}

export function extractStats(doc: ParentNode): CbexStats {
  const bidCount = parseInt(
    (doc.querySelector('.jp_detail_bjnum span')?.textContent || '0').trim(),
    10,
  ) || 0;
  const text = getBodyText(doc);
  const fol = text.match(/关注[：:]?\s*(\d+)/);
  const view = text.match(/围观[：:]?\s*(\d+)/);
  return {
    followers: fol ? parseInt(fol[1], 10) : 0,
    views: view ? parseInt(view[1], 10) : 0,
    bid_count: bidCount,
  };
}

export interface CbexTopFields {
  title: string;
  subject_id: string;
  status: string;
  end_time: string;
  bid_start: string;
  signup_end: string;
  prices: CbexPrices;
  buyer: CbexBuyer;
  stats: CbexStats;
}

export function extractCbexTopFields(doc: ParentNode): CbexTopFields {
  return {
    title: extractTitle(doc),
    subject_id: extractSubjectId(doc),
    status: extractStatus(doc),
    end_time: extractEndTime(doc),
    bid_start: extractBidStartTime(doc),
    signup_end: extractSignupEndTime(doc),
    prices: extractPrices(doc),
    buyer: extractBuyerInfo(doc),
    stats: extractStats(doc),
  };
}
```

If a unit test fails, **first refine the fixture HTML** to match the real DOM (open DevTools on 522611.html, find the exact class names, copy outerHTML, prune to fixture). Then re-run tests.

- [ ] **Step 4.5: Run tests — expect PASS**

```bash
npx vitest run src/utils/cbex-extractor.test.ts
```

- [ ] **Step 4.6: Commit**

```bash
git add src/utils/cbex-extractor.ts src/utils/cbex-extractor.test.ts src/utils/cbex-extractor.fixture.html
git commit -m "feat(cbex): top-level field extractors + DOM fixture"
```

---

## Task 5: Decode `#content_BDWJS` (ct1 标的物介绍)

**Files:**
- Modify: `src/utils/cbex-extractor.ts`
- Test: `src/utils/cbex-extractor.test.ts`

- [ ] **Step 5.1: Write failing test**

```ts
import { extractBdwjsHtml } from './cbex-extractor';

describe('extractBdwjsHtml', () => {
  it('decodes HTML-encoded content of #content_BDWJS textarea', () => {
    const html = `<html><body><textarea id="content_BDWJS">&lt;p&gt;hello&lt;/p&gt;&lt;img src="/foo.jpg"&gt;</textarea></body></html>`;
    const { document: doc } = parseHTML(html);
    expect(extractBdwjsHtml(doc)).toBe('<p>hello</p><img src="/foo.jpg">');
  });

  it('returns empty string if textarea missing', () => {
    const { document: doc } = parseHTML('<html></html>');
    expect(extractBdwjsHtml(doc)).toBe('');
  });
});
```

- [ ] **Step 5.2: Run — expect FAIL**

- [ ] **Step 5.3: Implement**

Append to `cbex-extractor.ts`:

```ts
export function extractBdwjsHtml(doc: ParentNode): string {
  const ta = doc.querySelector('#content_BDWJS') as HTMLTextAreaElement | null;
  if (!ta) return '';
  // textarea.value is the raw HTML-encoded string. textContent yields the
  // decoded text (entities normalized). We want the inner HTML to feed
  // into createMarkdownContent — so prefer textContent.
  return (ta.value ?? ta.textContent ?? '').trim();
}
```

- [ ] **Step 5.4: Run — expect PASS**

- [ ] **Step 5.5: Commit**

```bash
git commit -am "feat(cbex): extractBdwjsHtml (ct1 标的物介绍 textarea decode)"
```

---

## Task 6: Decode `tpzslist` inline JS variable (ct2 图片展示)

**Files:**
- Modify: `src/utils/cbex-extractor.ts`
- Test: `src/utils/cbex-extractor.test.ts`

- [ ] **Step 6.1: Write failing test**

```ts
import { extractTpzslist } from './cbex-extractor';

describe('extractTpzslist', () => {
  it('parses tpzslist JSON array', () => {
    const html = `<html><body><script>
      var oldtpzs = "/foo.jpg";
      var tpzslist = ["/editorUpload/file/2025/11/aaa.jpg","/editorUpload/file/2025/11/bbb.jpg"];
      </script></body></html>`;
    const { document: doc } = parseHTML(html);
    expect(extractTpzslist(doc)).toEqual([
      '/editorUpload/file/2025/11/aaa.jpg',
      '/editorUpload/file/2025/11/bbb.jpg',
    ]);
  });

  it('returns empty array if not found', () => {
    const { document: doc } = parseHTML('<html></html>');
    expect(extractTpzslist(doc)).toEqual([]);
  });
});
```

- [ ] **Step 6.2: Run — expect FAIL**

- [ ] **Step 6.3: Implement**

```ts
export function extractTpzslist(doc: ParentNode): string[] {
  const scripts = Array.from(doc.querySelectorAll('script:not([src])'));
  const all = scripts.map((s) => s.textContent || '').join('\n');
  // Match `var tpzslist = [...]` — JSON array of string URLs. Stop at first `];`
  const m = all.match(/\btpzslist\s*=\s*(\[[^\]]*\])/);
  if (!m) return [];
  try {
    const parsed = JSON.parse(m[1]);
    return Array.isArray(parsed) ? parsed.filter((u): u is string => typeof u === 'string') : [];
  } catch {
    return [];
  }
}
```

- [ ] **Step 6.4: Run — expect PASS**

- [ ] **Step 6.5: Commit**

```bash
git commit -am "feat(cbex): extractTpzslist (ct2 image array from inline JS)"
```

---

## Task 7: AJAX tab fetcher + ct4/ct7/ct8 fixtures

**Files:**
- Modify: `src/utils/cbex-extractor.ts`
- Test: `src/utils/cbex-extractor.test.ts`
- Create: `src/utils/cbex-extractor.fixture-ct4.html` (ggnr response sample)
- Create: `src/utils/cbex-extractor.fixture-ct7.html` (wtListPaging response sample)
- Create: `src/utils/cbex-extractor.fixture-ct8.html` (jjjgListPaging response sample)

- [ ] **Step 7.1: Capture XHR response fixtures from real page**

Open 522611.html in browser DevTools → Network tab. Click each of ct4, ct7, ct8 tabs. For each captured POST response, right-click → "Save as..." or copy response body. Save to `src/utils/cbex-extractor.fixture-ct{4,7,8}.html`. Trim PII (real lottery codes are public on this page — keep as-is — but if the response includes session tokens, redact).

- [ ] **Step 7.2: Write failing test for `fetchCbexTabContent`**

```ts
import { fetchCbexTabContent } from './cbex-extractor';

describe('fetchCbexTabContent', () => {
  it('POSTs form body with X-Requested-With header', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response('<table>x</table>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      });
    });
    const text = await fetchCbexTabContent(
      '/page/jpxkc/prj/ggnr',
      'BDID=4185',
      fakeFetch as unknown as typeof fetch,
    );
    expect(text).toBe('<table>x</table>');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/page/jpxkc/prj/ggnr');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.body).toBe('BDID=4185');
    expect((calls[0].init.headers as Record<string, string>)['X-Requested-With']).toBe('XMLHttpRequest');
    expect((calls[0].init.headers as Record<string, string>)['Content-Type']).toBe('application/x-www-form-urlencoded; charset=UTF-8');
    expect(calls[0].init.credentials).toBe('include');
  });

  it('throws on non-2xx', async () => {
    const fakeFetch = vi.fn(async () => new Response('nope', { status: 401 }));
    await expect(
      fetchCbexTabContent('/page/jpxkc/prj/ggnr', 'BDID=4185', fakeFetch as unknown as typeof fetch),
    ).rejects.toThrow(/401/);
  });
});
```

Add `import { vi } from 'vitest';` at the top if not already imported.

- [ ] **Step 7.3: Run — expect FAIL**

- [ ] **Step 7.4: Implement**

```ts
export async function fetchCbexTabContent(
  endpoint: string,
  body: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const res = await fetchImpl(endpoint, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
    },
    body,
  });
  if (!res.ok) {
    throw new Error(`cbex tab fetch failed: ${endpoint} status=${res.status}`);
  }
  return await res.text();
}
```

- [ ] **Step 7.5: Run — expect PASS**

- [ ] **Step 7.6: Commit**

```bash
git add src/utils/cbex-extractor.ts src/utils/cbex-extractor.test.ts src/utils/cbex-extractor.fixture-ct4.html src/utils/cbex-extractor.fixture-ct7.html src/utils/cbex-extractor.fixture-ct8.html
git commit -m "feat(cbex): fetchCbexTabContent + ct4/ct7/ct8 fixtures"
```

---

## Task 8: HTML-fragment → markdown converters for ct4 / ct7 / ct8

**Files:**
- Modify: `src/utils/cbex-extractor.ts`
- Test: `src/utils/cbex-extractor.test.ts`

The HTML fragments from ggnr / wtListPaging / jjjgListPaging are: ggnr = styled paragraphs (Times New Roman, etc.) → convert to plain markdown via Defuddle's `createMarkdownContent` (proven on other extractors). wtListPaging + jjjgListPaging = HTML `<table>` → use the same `createMarkdownContent` which produces GFM tables.

- [ ] **Step 8.1: Write tests for each converter**

```ts
import { ct4FragmentToMarkdown, ct7FragmentToMarkdown, ct8FragmentToMarkdown } from './cbex-extractor';

describe('ct4 fragment to markdown', () => {
  it('strips Times New Roman styling and returns plain paragraphs', async () => {
    const fragment = `<p style="font-family: 'Times New Roman'; font-size: 14px;">第一段</p><p>第二段</p>`;
    const md = await ct4FragmentToMarkdown(fragment, 'https://jpxkc.cbex.com/');
    expect(md).toContain('第一段');
    expect(md).toContain('第二段');
    expect(md).not.toContain('Times New Roman');
  });
});

describe('ct7 fragment to markdown', () => {
  it('converts bid-record table to GFM table', async () => {
    const fragment = `<table class="bd_detail_record">
      <tr><th>序号</th><th>名称</th><th>出价人</th><th>价格</th><th>时间</th></tr>
      <tr><td>265</td><td>京NC6575...</td><td>640610036...</td><td>30000.00</td><td>2025-12-15 16:00</td></tr>
    </table>`;
    const md = await ct7FragmentToMarkdown(fragment, 'https://jpxkc.cbex.com/');
    expect(md).toContain('| 序号 |');
    expect(md).toContain('30000.00');
  });
});

describe('ct8 fragment to markdown', () => {
  it('converts result table to GFM table', async () => {
    const fragment = `<table class="table_default">
      <tr><th>委托方</th><th>受让方</th><th>联系电话</th></tr>
      <tr><td>北京一中院</td><td>(脱敏)</td><td>(脱敏)</td></tr>
    </table>`;
    const md = await ct8FragmentToMarkdown(fragment, 'https://jpxkc.cbex.com/');
    expect(md).toContain('委托方');
    expect(md).toContain('受让方');
  });
});
```

- [ ] **Step 8.2: Run — expect FAIL**

- [ ] **Step 8.3: Implement (delegate to defuddle's createMarkdownContent)**

```ts
import { createMarkdownContent } from 'defuddle/full';

export async function ct4FragmentToMarkdown(fragment: string, baseUrl: string): Promise<string> {
  return createMarkdownContent(fragment, baseUrl).trim();
}

export async function ct7FragmentToMarkdown(fragment: string, baseUrl: string): Promise<string> {
  return createMarkdownContent(fragment, baseUrl).trim();
}

export async function ct8FragmentToMarkdown(fragment: string, baseUrl: string): Promise<string> {
  return createMarkdownContent(fragment, baseUrl).trim();
}
```

If `createMarkdownContent` is sync (per `defuddle/full`), drop the `async`/`await` and adjust test expectations.

- [ ] **Step 8.4: Run — expect PASS**

- [ ] **Step 8.5: Commit**

```bash
git commit -am "feat(cbex): ct4/ct7/ct8 fragment-to-markdown converters"
```

---

## Task 9: Frontmatter YAML builder

**Files:**
- Modify: `src/utils/cbex-extractor.ts`
- Test: `src/utils/cbex-extractor.test.ts`

Spec §3.1 frontmatter shape: only emit fields when present (no nulls). Use double-quoted strings for IDs / dates / titles to be YAML-safe.

- [ ] **Step 9.1: Write failing tests**

```ts
import { buildCbexFrontmatter } from './cbex-extractor';

describe('buildCbexFrontmatter', () => {
  it('emits all fields when complete (竞价结束成交)', () => {
    const yaml = buildCbexFrontmatter({
      title: '京NC6575别克牌SGM6527AT蓝小型汽车',
      url: 'https://jpxkc.cbex.com/jpxkc/prj/detail/522611.html',
      subject_id: '202512NC6575',
      status: '竞价结束',
      final_price: 30000,
      start_price: 20000,
      assess_price: 20000,
      cap_price: 30000,
      deposit: 20000,
      bid_start: '2025-12-15 08:00',
      signup_end: '2025-12-12 15:00',
      bid_count: 265,
      followers: 411,
      views: 124477,
      created: '2026-05-29',
    });
    expect(yaml).toContain('source: cbex');
    expect(yaml).toContain('subject_id: "202512NC6575"');
    expect(yaml).toContain('final_price: 30000');
    expect(yaml).toContain('status: 竞价结束');
    expect(yaml.startsWith('---\n')).toBe(true);
    expect(yaml.endsWith('---\n')).toBe(true);
  });

  it('omits absent optional fields (报价中, no final_price/buyer)', () => {
    const yaml = buildCbexFrontmatter({
      title: 'X', url: 'https://jpxkc.cbex.com/jpxkc/prj/detail/123.html',
      subject_id: '202501TEST', status: '报价中',
      start_price: 100, cap_price: 200, deposit: 100,
      bid_start: '2026-01-01 08:00', signup_end: '2025-12-31 15:00',
      bid_count: 0, followers: 0, views: 5, created: '2026-05-29',
    });
    expect(yaml).not.toContain('final_price');
    expect(yaml).not.toContain('assess_price');
  });
});
```

- [ ] **Step 9.2: Run — expect FAIL**

- [ ] **Step 9.3: Implement**

```ts
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
  bid_count: number;
  followers: number;
  views: number;
  created: string;
}

function yamlEscape(s: string): string {
  // Always double-quote, escape inner double quotes
  return `"${s.replace(/"/g, '\\"')}"`;
}

export function buildCbexFrontmatter(input: CbexFrontmatterInput): string {
  const lines: string[] = ['---'];
  lines.push(`title: ${yamlEscape(input.title)}`);
  lines.push(`url: ${yamlEscape(input.url)}`);
  lines.push(`source: cbex`);
  lines.push(`subject_id: ${yamlEscape(input.subject_id)}`);
  lines.push(`status: ${input.status}`);
  if (input.final_price !== undefined) lines.push(`final_price: ${input.final_price}`);
  if (input.start_price !== undefined) lines.push(`start_price: ${input.start_price}`);
  if (input.assess_price !== undefined) lines.push(`assess_price: ${input.assess_price}`);
  if (input.cap_price !== undefined) lines.push(`cap_price: ${input.cap_price}`);
  if (input.deposit !== undefined) lines.push(`deposit: ${input.deposit}`);
  lines.push(`bid_start: ${yamlEscape(input.bid_start)}`);
  lines.push(`signup_end: ${yamlEscape(input.signup_end)}`);
  lines.push(`bid_count: ${input.bid_count}`);
  lines.push(`followers: ${input.followers}`);
  lines.push(`views: ${input.views}`);
  lines.push(`created: ${input.created}`);
  lines.push('---');
  return lines.join('\n') + '\n';
}
```

- [ ] **Step 9.4: Run — expect PASS**

- [ ] **Step 9.5: Commit**

```bash
git commit -am "feat(cbex): buildCbexFrontmatter (YAML, omit absent optionals)"
```

---

## Task 10: 关键信息 markdown table builder

**Files:**
- Modify: `src/utils/cbex-extractor.ts`
- Test: `src/utils/cbex-extractor.test.ts`

- [ ] **Step 10.1: Write failing test**

```ts
import { buildKeyInfoTable } from './cbex-extractor';

describe('buildKeyInfoTable', () => {
  it('renders all rows when full state', () => {
    const md = buildKeyInfoTable({
      subject_id: '202512NC6575',
      status: '竞价结束',
      start_price: 20000,
      assess_price: 20000,
      cap_price: 30000,
      final_price: 30000,
      deposit: 20000,
      bid_start: '2025-12-15 08:00',
      signup_end: '2025-12-12 15:00',
      buyer: { lottery_code: '6035100088419', lottery_count: '87', lottery_registered: '2011-01-02 13:23' },
      stats: { followers: 411, views: 124477, bid_count: 265 },
    });
    expect(md).toContain('| 项目 | 内容 |');
    expect(md).toContain('| 标的物编号 | 202512NC6575 |');
    expect(md).toContain('| 起始价 | ¥20,000.00 |');
    expect(md).toContain('| 成交价 | ¥30,000.00 |');
    expect(md).toContain('| 买受人摇号编码 | 6035100088419 |');
    expect(md).toContain('| 关注数 | 411 |');
    expect(md).toContain('| 围观数 | 124477 |');
    expect(md).toContain('| 报价次数 | 265 |');
  });

  it('omits absent rows (报价中, no buyer)', () => {
    const md = buildKeyInfoTable({
      subject_id: '202501X', status: '报价中',
      start_price: 100, cap_price: 200, deposit: 100,
      bid_start: '2026-01-01 08:00', signup_end: '2025-12-31 15:00',
      buyer: {}, stats: { followers: 0, views: 0, bid_count: 0 },
    });
    expect(md).not.toContain('成交价');
    expect(md).not.toContain('买受人');
    expect(md).not.toContain('评估价');
  });
});
```

- [ ] **Step 10.2: Run — expect FAIL**

- [ ] **Step 10.3: Implement**

```ts
export interface KeyInfoInput {
  subject_id: string;
  status: string;
  start_price?: number;
  assess_price?: number;
  cap_price?: number;
  final_price?: number;
  deposit?: number;
  bid_start: string;
  signup_end: string;
  buyer: CbexBuyer;
  stats: CbexStats;
}

function formatYuan(n: number): string {
  return `¥${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function buildKeyInfoTable(i: KeyInfoInput): string {
  const rows: Array<[string, string]> = [
    ['标的物编号', i.subject_id],
    ['竞价状态', i.status],
  ];
  if (i.start_price !== undefined) rows.push(['起始价', formatYuan(i.start_price)]);
  if (i.assess_price !== undefined) rows.push(['评估价', formatYuan(i.assess_price)]);
  if (i.cap_price !== undefined) rows.push(['最高限价', formatYuan(i.cap_price)]);
  if (i.final_price !== undefined) rows.push(['成交价', formatYuan(i.final_price)]);
  if (i.deposit !== undefined) rows.push(['保证金', formatYuan(i.deposit)]);
  rows.push(['竞价开始时间', i.bid_start]);
  rows.push(['报名截止时间', i.signup_end]);
  if (i.buyer.lottery_code) rows.push(['买受人摇号编码', i.buyer.lottery_code]);
  if (i.buyer.lottery_count) rows.push(['买受人摇号次数', i.buyer.lottery_count]);
  if (i.buyer.lottery_registered) rows.push(['买受人摇号注册时间', i.buyer.lottery_registered]);
  rows.push(['关注数', String(i.stats.followers)]);
  rows.push(['围观数', String(i.stats.views)]);
  rows.push(['报价次数', String(i.stats.bid_count)]);
  const lines = ['| 项目 | 内容 |', '|---|---|'];
  for (const [k, v] of rows) lines.push(`| ${k} | ${v} |`);
  return lines.join('\n');
}
```

- [ ] **Step 10.4: Run — expect PASS**

- [ ] **Step 10.5: Commit**

```bash
git commit -am "feat(cbex): buildKeyInfoTable (omit absent rows)"
```

---

## Task 11: Main entry `extractCbexStructuredContent`

**Files:**
- Modify: `src/utils/cbex-extractor.ts`
- Test: `src/utils/cbex-extractor.test.ts`

- [ ] **Step 11.1: Define interface + write failing integration test**

```ts
import { extractCbexStructuredContent } from './cbex-extractor';

describe('extractCbexStructuredContent (integration)', () => {
  it('returns structured fields + assembled markdown', async () => {
    const fixture = readFileSync(join(__dirname, 'cbex-extractor.fixture.html'), 'utf-8');
    const { document: doc } = parseHTML(fixture);
    // Mock fetch to return ct4/7/8 fixtures
    const ct4 = readFileSync(join(__dirname, 'cbex-extractor.fixture-ct4.html'), 'utf-8');
    const ct7 = readFileSync(join(__dirname, 'cbex-extractor.fixture-ct7.html'), 'utf-8');
    const ct8 = readFileSync(join(__dirname, 'cbex-extractor.fixture-ct8.html'), 'utf-8');
    const fakeFetch: typeof fetch = vi.fn(async (url: string | URL | Request) => {
      const path = String(url);
      const body = path.includes('ggnr') ? ct4 : path.includes('wtListPaging') ? ct7 : ct8;
      return new Response(body, { status: 200, headers: { 'Content-Type': 'text/html' } });
    }) as any;
    const result = await extractCbexStructuredContent(
      doc as unknown as Document,
      'https://jpxkc.cbex.com/jpxkc/prj/detail/522611.html',
      fakeFetch,
    );
    expect(result).not.toBeNull();
    expect(result!.title).toBe('京NC6575别克牌SGM6527AT蓝小型汽车');
    expect(result!.content).toContain('## 关键信息');
    expect(result!.content).toContain('## 标的物介绍');
    expect(result!.content).toContain('## 图片展示');
    expect(result!.content).toContain('## 司法处置公告');
    expect(result!.content).toContain('## 竞买须知');
    expect(result!.content).toContain('## 竞价记录');
    expect(result!.content).toContain('## 竞价结果');
    expect(result!.content).toContain('## 联系方式');
  });

  it('throws if not a cbex URL', async () => {
    const { document: doc } = parseHTML('<html></html>');
    await expect(
      extractCbexStructuredContent(doc as unknown as Document, 'https://example.com/foo'),
    ).rejects.toThrow();
  });

  it('throws if params cannot be extracted', async () => {
    const { document: doc } = parseHTML('<html><body>no scripts</body></html>');
    await expect(
      extractCbexStructuredContent(
        doc as unknown as Document,
        'https://jpxkc.cbex.com/jpxkc/prj/detail/522611.html',
      ),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 11.2: Run — expect FAIL**

- [ ] **Step 11.3: Implement main entry**

```ts
export interface CbexStructuredContent {
  title: string;
  author: string;
  description: string;
  published: string;
  image: string;
  site: string;
  source: string;
  content: string;
  wordCount: number;

  // 专有字段
  subject_id: string;
  status: string;
}

function fmtDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

export async function extractCbexStructuredContent(
  doc: Document,
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CbexStructuredContent> {
  if (!isCbexPrjDetailUrl(url)) {
    throw new Error(`cbex: not a cbex prj detail URL: ${url}`);
  }
  const parsed = parseCbexUrl(url)!;
  const params = extractCbexParams(doc);
  if (!params) {
    throw new Error('cbex: required params (bdid/cpdm/zgxj/jjcc) not found in inline scripts');
  }

  const top = extractCbexTopFields(doc);

  // Fire 3 XHR endpoints in parallel; tolerate per-endpoint failure (graceful section omission).
  const safeFetch = async (endpoint: string, body: string): Promise<string> => {
    try {
      return await fetchCbexTabContent(endpoint, body, fetchImpl);
    } catch {
      return '';
    }
  };

  const [ggnrRaw, wtListRaw, jjjgRaw] = await Promise.all([
    safeFetch('/page/jpxkc/prj/ggnr', `BDID=${params.bdid}`),
    safeFetch(
      '/page/jpxkc/prj/wtListPaging',
      `cpdm=${parsed.prjId}&zgxj=${params.zgxj}&type=all`,
    ),
    safeFetch(
      '/page/jpxkc/prj/jjjgListPaging',
      `id=${parsed.prjId}&jjcc=${params.jjcc}&pageNo=1&pageSize=10`,
    ),
  ]);

  const baseUrl = new URL(url).origin;
  const ct1Html = extractBdwjsHtml(doc);
  const ct5Html = (doc.querySelector('#bd_detail_tab_ct5')?.innerHTML || '').trim();
  const ct6Html = (doc.querySelector('#bd_detail_tab_ct6')?.innerHTML || '').trim();
  const ct2Imgs = extractTpzslist(doc).map((u) =>
    u.startsWith('http') ? u : `${baseUrl}${u.startsWith('/') ? '' : '/'}${u}`,
  );

  const ct1Md = ct1Html ? createMarkdownContent(ct1Html, baseUrl).trim() : '';
  const ct4Md = ggnrRaw ? await ct4FragmentToMarkdown(ggnrRaw, baseUrl) : '';
  const ct5Md = ct5Html ? createMarkdownContent(ct5Html, baseUrl).trim() : '';
  const ct6Md = ct6Html ? createMarkdownContent(ct6Html, baseUrl).trim() : '';
  const ct7Md = wtListRaw ? await ct7FragmentToMarkdown(wtListRaw, baseUrl) : '';
  const ct8Md = jjjgRaw ? await ct8FragmentToMarkdown(jjjgRaw, baseUrl) : '';
  const ct2Md = ct2Imgs.map((u) => `![](${u})`).join('\n');

  const keyInfoMd = buildKeyInfoTable({
    subject_id: top.subject_id,
    status: top.status,
    start_price: top.prices.start_price,
    assess_price: top.prices.assess_price,
    cap_price: top.prices.cap_price,
    final_price: top.prices.final_price,
    deposit: top.prices.deposit,
    bid_start: top.bid_start,
    signup_end: top.signup_end,
    buyer: top.buyer,
    stats: top.stats,
  });

  const sections: string[] = [
    `# ${top.title}`,
    '',
    '## 关键信息',
    '',
    keyInfoMd,
  ];
  if (ct1Md) sections.push('', '## 标的物介绍', '', ct1Md);
  if (ct2Md) sections.push('', '## 图片展示', '', ct2Md);
  if (ct4Md) sections.push('', '## 司法处置公告', '', ct4Md);
  if (ct5Md) sections.push('', '## 竞买须知', '', ct5Md);
  if (ct7Md) sections.push('', '## 竞价记录', '', ct7Md);
  if (ct8Md) sections.push('', '## 竞价结果', '', ct8Md);
  if (ct6Md) sections.push('', '## 联系方式', '', ct6Md);
  const body = sections.join('\n');

  const frontmatter = buildCbexFrontmatter({
    title: top.title,
    url,
    subject_id: top.subject_id,
    status: top.status,
    start_price: top.prices.start_price,
    assess_price: top.prices.assess_price,
    cap_price: top.prices.cap_price,
    deposit: top.prices.deposit,
    final_price: top.prices.final_price,
    bid_start: top.bid_start,
    signup_end: top.signup_end,
    bid_count: top.stats.bid_count,
    followers: top.stats.followers,
    views: top.stats.views,
    created: fmtDate(new Date()),
  });

  // content returned to the framework should NOT include the frontmatter (the
  // template engine builds that from the variables). content == body markdown.
  // The buildCbexFrontmatter step is kept so the extractor can also emit a
  // standalone fully-formed note if the consumer wants it later; currently
  // it's covered by the unit test only.
  void frontmatter;

  return {
    title: top.title,
    author: '',
    description: top.subject_id,
    published: top.bid_start,
    image: ct2Imgs[0] || '',
    site: 'cbex',
    source: url,
    content: body,
    wordCount: body.length,
    subject_id: top.subject_id,
    status: top.status,
  };
}
```

- [ ] **Step 11.4: Run — expect PASS**

```bash
npx vitest run src/utils/cbex-extractor.test.ts
```

- [ ] **Step 11.5: Commit**

```bash
git commit -am "feat(cbex): extractCbexStructuredContent main entry"
```

---

## Task 12: Wire into `content.ts` main path

**Files:**
- Modify: `src/content.ts`

- [ ] **Step 12.1: Add import + extractor invocation**

Open `src/content.ts`. Following the xiaoyuzhou pattern:

Around the existing extractor imports (line ~15-19), add:

```ts
import { extractCbexStructuredContent, isCbexPrjDetailUrl } from './utils/cbex-extractor';
```

In `getPageContent()` handler, after the `xiaoyuzhouContent = ...` block (~line 327-334), insert:

```ts
const cbexContent = isCbexPrjDetailUrl(document.URL)
  ? await extractCbexStructuredContent(document, document.URL).catch((error) => {
    const msg = error instanceof Error ? error.message : String(error);
    contentLogger.warn('Failed to extract cbex structured content', { error: msg });
    extractorWarnings.push(`cbex: ${msg}`);
    return null;
  })
  : null;
```

In the `ContentResponse` assembly (~line 442-462), add `cbexContent?.*` into the cascade for: `content`, `title`, `published`, `image`, `site`, `wordCount`.

Example diff (apply to the relevant lines):

```ts
content: bilibiliContent?.structuredHtml || xiaoyuzhouContent?.content || cbexContent?.content || feishuContent?.content || /* ... */,
title: bilibiliContent?.title || xiaoyuzhouContent?.title || cbexContent?.title || feishuContent?.title || /* ... */,
site: bilibiliContent ? 'Bilibili' : xiaoyuzhouContent ? '小宇宙' : cbexContent ? 'cbex' : feishuContent ? 'Feishu' : /* ... */,
published: bilibiliContent?.published || xiaoyuzhouContent?.published || cbexContent?.published || feishuContent?.published || /* ... */,
image: bilibiliContent?.image || xiaoyuzhouContent?.image || /* ... */,
wordCount: docsQQContent?.wordCount || bilibiliContent?.wordCount || xiaoyuzhouContent?.wordCount || cbexContent?.wordCount || /* ... */,
```

Also surface cbex-specific fields to `extractedContent` (template-engine bindings):

After the xiaoyuzhou block (~line 359-365), add:

```ts
if (cbexContent) {
  extractedContent.subject_id = cbexContent.subject_id;
  extractedContent.status = cbexContent.status;
}
```

- [ ] **Step 12.2: Build chrome (no test yet, just verify it compiles)**

```bash
npm run build:chrome 2>&1 | tail -20
```

Expected: no TypeScript errors.

- [ ] **Step 12.3: Commit**

```bash
git add src/content.ts
git commit -m "feat(cbex): wire extractor into content.ts main path"
```

---

## Task 13: Wire into `content.ts` bridge path (origin whitelist + routing)

**Files:**
- Modify: `src/content.ts`

The bridge is the e2e harness's entry. Without bridge wire, `runRealClip` won't trigger cbex extraction → e2e test will fail silently. [[feedback_e2e_bridge_path_double_wire]] mandates double-wire.

- [ ] **Step 13.1: Add `cbex.com` to origin whitelist**

Find `src/content.ts:711`:

```ts
if (!/feishu\.cn$|larksuite\.com$|^scys\.com$|wx\.zsxq\.com$|^articles\.zsxq\.com$|^mp\.weixin\.qq\.com$|^docs\.qq\.com$|xiaoyuzhoufm\.com$/.test(origin)) return;
```

Add `|^jpxkc\.cbex\.com$` to the alternation:

```ts
if (!/feishu\.cn$|larksuite\.com$|^scys\.com$|wx\.zsxq\.com$|^articles\.zsxq\.com$|^mp\.weixin\.qq\.com$|^docs\.qq\.com$|xiaoyuzhoufm\.com$|^jpxkc\.cbex\.com$/.test(origin)) return;
```

- [ ] **Step 13.2: Add routing branch**

After the `xiaoyuzhou` branch in the routing chain (around line 739-741), insert:

```ts
} else if (isCbexPrjDetailUrl(document.URL)) {
  result = await extractCbexStructuredContent(document, document.URL) as any;
  source = 'cbex' as any;
```

Update the `source` literal type if it's a TypeScript discriminated union — add `'cbex'` to the union:

```ts
let source: 'scys' | 'feishu' | 'zsxq' | 'wechat' | 'docsqq' | 'xiaoyuzhou' | 'cbex' | null = null;
```

- [ ] **Step 13.3: Update `site` mapping for bridge → buildVariables call**

Find the `site:` line in `simulatedVars = sharedMod.buildVariables({...})` (~line 815):

```ts
site: source === 'scys' ? 'Scys' : source === 'feishu' ? 'Feishu' : source === 'zsxq' ? 'ZSXQ' : source === 'docsqq' ? 'DocsQQ' : source === 'xiaoyuzhou' ? '小宇宙' : '',
```

Add cbex branch:

```ts
site: source === 'scys' ? 'Scys' : source === 'feishu' ? 'Feishu' : source === 'zsxq' ? 'ZSXQ' : source === 'docsqq' ? 'DocsQQ' : source === 'xiaoyuzhou' ? '小宇宙' : source === 'cbex' ? 'cbex' : '',
```

- [ ] **Step 13.4: Build chrome to verify**

```bash
npm run build:chrome 2>&1 | tail -20
```

- [ ] **Step 13.5: Commit**

```bash
git add src/content.ts
git commit -m "feat(cbex): bridge path + origin whitelist (e2e parity)"
```

---

## Task 14: E2E test (`runRealClip` against real cbex page)

**Files:**
- Create: `src/utils/cbex-extractor.e2e.test.ts`

- [ ] **Step 14.1: Write e2e test (URL #1, 竞价结束)**

```ts
import { describe, it, expect } from 'vitest';
import { runRealClip } from '../../scripts/e2e-clip-runner';

describe('cbex extractor e2e (real chrome)', () => {
  it('clips a 竞价结束 page byte-equivalent to expected markdown', async () => {
    const clip = await runRealClip(
      'https://jpxkc.cbex.com/jpxkc/prj/detail/522611.html',
      { wait: '.bd_detail_name', timeout: 120_000 },
    );
    expect(clip.markdown.length).toBeGreaterThan(500);
    expect(clip.markdown).toContain('京NC6575别克牌SGM6527AT蓝小型汽车');
    expect(clip.markdown).toContain('subject_id: "202512NC6575"');
    expect(clip.markdown).toContain('## 关键信息');
    expect(clip.markdown).toContain('## 标的物介绍');
    expect(clip.markdown).toContain('## 图片展示');
    expect(clip.markdown).toContain('## 司法处置公告');
    expect(clip.markdown).toContain('## 竞买须知');
    expect(clip.markdown).toContain('## 竞价记录');
    expect(clip.markdown).toContain('## 竞价结果');
    expect(clip.markdown).toContain('成交价');
  }, 180_000);

  it('clips a 竞价结束 page without buyer info (522884)', async () => {
    const clip = await runRealClip(
      'https://jpxkc.cbex.com/jpxkc/prj/detail/522884.html',
      { wait: '.bd_detail_name', timeout: 120_000 },
    );
    expect(clip.markdown).toContain('京P61185北京现代牌BH6430AY黑色小型汽车');
    expect(clip.markdown).toContain('subject_id: "202512P61185"');
    expect(clip.markdown).toContain('## 关键信息');
    // 成交价 present (this URL also sold), 但 buyer 字段缺省
    expect(clip.markdown).toContain('成交价');
    expect(clip.markdown).not.toContain('买受人摇号编码');
    expect(clip.markdown).not.toContain('买受人摇号次数');
    expect(clip.markdown).not.toContain('买受人摇号注册时间');
  }, 180_000);
});
```

- [ ] **Step 14.2: Update worktree dist (e2e loads from `dist/`)**

```bash
npm run build:chrome 2>&1 | tail -5
```

- [ ] **Step 14.3: Run e2e**

```bash
npx vitest run --config vitest.e2e.config.ts src/utils/cbex-extractor.e2e.test.ts 2>&1 | tail -30
```

Expected: PASS. If fails, look at the receiver output — common causes:
- Bridge whitelist didn't take effect → rebuild dist
- A param regex didn't match the actual inline JS → adjust regex
- A fetch endpoint returned 401/403 (cookie required) → check whether browser was logged in; if so the e2e should still inherit cookies because `launchPersistentContext` uses an isolated profile — sign in once via `userDataDir` then re-run

- [ ] **Step 14.4: Commit**

```bash
git add src/utils/cbex-extractor.e2e.test.ts
git commit -m "test(cbex): e2e via real chrome extension"
```

---

## Task 15: Visual audit via `audit-extractor-ship`

**Files:**
- (No new files; audit produces ephemeral reports under `docs/superpowers/specs/.../audit/`)

Per [[feedback_visual_audit_subagent_pattern]], the main session must dispatch subagents — never read 10+ grid screenshots directly.

- [ ] **Step 15.1: Prepare audit run**

```bash
bash scripts/audit-prepare.sh \
  --url https://jpxkc.cbex.com/jpxkc/prj/detail/522611.html \
  --extractor cbex \
  --name 522611 \
  2>&1 | tail -10
```

Note the printed `RUN_ID`.

- [ ] **Step 15.2: Dispatch subagents per the audit-extractor-ship skill**

Invoke the `audit-extractor-ship` skill. Follow its instructions (it will guide subagent dispatch + collect JSON results into the final REPORT.md). Main session never reads the grids directly.

- [ ] **Step 15.3: Resolve any audit `diffs[]` items**

For each diff with severity ≥ medium, fix the extractor + rerun. Continue until REPORT shows ≤2 low-severity items or all-clean.

- [ ] **Step 15.4: Commit audit results**

```bash
git add docs/superpowers/specs/2026-05-29-cbex-jpxkc-extractor-audit/  # ignored except for REPORT.md
git commit -m "test(cbex): visual audit REPORT (522611, full-content sbs)"
```

---

## Task 16: Ship checklist

Per [[feedback_extractor_acceptance]], all four gates must pass before reporting verification.

- [ ] **T5-1: `npm test`**

```bash
npm test 2>&1 | tail -15
```

Expected: cbex unit tests PASS. Pre-existing template-integration failures may remain (note them in the ship message but do NOT block).

- [ ] **T5-2: `audit-extractor-ship` REPORT.md ≤ threshold**

Paste the contents of `docs/superpowers/specs/.../audit/REPORT.md` into the ship message.

- [ ] **T5-3: `npm run test:e2e -- cbex`**

```bash
npx vitest run --config vitest.e2e.config.ts src/utils/cbex-extractor.e2e.test.ts 2>&1 | tail -15
```

Expected: 2 PASS (URL #1 + URL #2, assuming Task 2 found a URL #2). If Task 2 hasn't found one, the second test is auto-skipped — note this in the ship message.

- [ ] **T5-4: Obsidian.app real-screenshot acceptance**

1. Open `dist/` extension in Chrome
2. Navigate to `https://jpxkc.cbex.com/jpxkc/prj/detail/522611.html`
3. Click the obsidian-clipper popup → save to a test vault
4. Open the resulting .md in Obsidian Desktop
5. Take screenshots of: (a) frontmatter rendering in Properties view, (b) 关键信息 table, (c) each of the 4 tab sections (标的物介绍, 图片展示 with images loaded, 司法处置公告, 竞买须知, 竞价记录, 竞价结果, 联系方式)
6. Paste screenshots in the ship message

- [ ] **Ship message format**

Use the standard template (paste in chat):

```
请验收

T5-1 unit tests: ✅ (cbex extractor: N PASS / 0 FAIL)
T5-2 audit REPORT: <paste REPORT.md contents>
T5-3 e2e tests: ✅ (URL #1 PASS; URL #2 <PASS / skipped>)
T5-4 Obsidian screenshots: <attach>

Pre-existing baseline failures (NOT introduced by this work):
- template-integration.test.ts: 3 failures (fixture drift from earlier extractor changes)
```

---

## Self-Review

Run through this checklist after the plan is complete:

**Spec coverage (against `2026-05-29-cbex-jpxkc-extractor-design.md`):**

| Spec section | Task |
|---|---|
| §2 architecture (extractor file, URL match, entry, wire) | Task 1, 11, 12, 13 |
| §3.1 frontmatter | Task 9 |
| §3.2 正文骨架 (关键信息 table + per-tab sections) | Task 10, 11 |
| §3.3 字段缺省规则 | Task 9 (frontmatter), Task 10 (table) |
| §4.1 顶部已渲染字段 selectors | Task 4 |
| §4.2 Lazy load 方案 B (3 XHR endpoints) | Task 7, 11 |
| §4.3 图片 ct2 | Task 6, 11 |
| §4.4 已知风险: 二号 URL 验证 | Task 2 |
| §5.1 unit tests | Tasks 1, 3, 4, 5, 6, 7, 8, 9, 10, 11 |
| §5.2 e2e tests | Task 14 |
| §5.3 Helper API (DOM signature) | Tasks 4, 5, 6 (all `doc: ParentNode`) |
| §5.4 audit-extractor-ship | Task 15 |
| §5.5 ship checklist 4 gates | Task 16 |
| §5.6 二号 URL 验证 | Task 2 + Task 14 second test |
| Warning banner fallback | Task 12 (.catch + extractorWarnings) |
| Bridge double-wire | Task 13 |

All sections mapped. No gaps.

**Placeholder scan:** None found beyond the `__FILL_IN_FROM_TASK_2__` sentinel in Task 14, which Task 2 explicitly resolves.

**Type consistency:**
- `CbexParams.bdid` (lowercase) used consistently across Tasks 3, 11.
- `CbexStructuredContent.title` matches `extractCbexTopFields().title`.
- `parseCbexUrl()!.prjId` used in Task 11 ✓.
- `cbex` site literal used uniformly in `content.ts` wire (Tasks 12 + 13).

Plan complete.
