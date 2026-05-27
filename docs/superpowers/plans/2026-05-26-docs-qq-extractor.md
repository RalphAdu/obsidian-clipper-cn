# docs.qq.com Extractor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让浏览器扩展在 `https://docs.qq.com/doc/<token>` 页面触发裁剪时，绕过 Defuddle 通用通路，走腾讯文档"导出 .docx"异步接口取得高保真内容，转为 markdown 写入 Obsidian。

**Architecture:** content.ts 页面 runtime 调腾讯文档导出 endpoint（自动带 cookie/CSRF/Referer）→ 拉 .docx ArrayBuffer → 动态 import mammoth.js 转 HTML（图片 base64 内嵌；公式 OMML→MathML→LaTeX 后处理）→ 返回 HTML 给主流程 turndown pipeline → 写 Obsidian。错误一律 throw，由 content.ts catch 进 `extractorWarnings[]` 显示 banner。

**Tech Stack:** TypeScript + Webpack splitChunks 动态分包 + mammoth.js（docx→HTML）+ mathml-to-latex（MathML→LaTeX）+ Vitest 单测 + Playwright E2E + `audit-extractor-ship` 视觉验收

**Spec reference:** `docs/superpowers/specs/2026-05-26-docs-qq-extractor-design.md`

---

## File Structure

| 路径 | 操作 | 职责 |
|------|------|------|
| `src/utils/docs-qq-extractor.ts` | 新建 | 主 extractor 文件（URL routing + endpoint 调用 + mammoth + 公式后处理 + 编排） |
| `src/utils/docs-qq-extractor.test.ts` | 新建 | Vitest 单测，mock fetch + mock `import('mammoth')` |
| `src/utils/docs-qq-extractor.e2e.test.ts` | 新建 | Playwright E2E 真 docs.qq.com URL |
| `src/content.ts` | 修改 | 加 isDocsQQUrl 路由 + catch + extractorWarnings.push |
| `webpack.config.js` | 修改 | `optimization.splitChunks.cacheGroups.mammoth` 分包配置 |
| `package.json` | 修改 | 加 `mammoth` + `mathml-to-latex` dependencies |
| `docs/superpowers/specs/2026-05-26-docs-qq-extractor-recon.md` | 新建 | Reconnaissance 产物：4 个 endpoint 的实测路径 / payload / response schema |
| `docs/superpowers/BACKLOG.md` | 修改 | §6.xx 新增 docs.qq extractor 落地记录 |

---

## Task 1: Endpoint Reconnaissance

**Files:**
- Create: `docs/superpowers/specs/2026-05-26-docs-qq-extractor-recon.md`
- Touch: `scripts/read-chrome-cookies.py`（已存在，仅 reference）

**目标**：用 playwright + 已登录 chrome 实测腾讯文档"导出为 Word"按钮触发的全部网络请求，落 recon.md，作为后续所有 fetch task 的 endpoint 真值来源。

- [ ] **Step 1: 准备 fixture URL**

阿杜提供 1 个测试用 docs.qq.com URL（最好是自己的文档，含表格/图片/公式效果最好）。临时记到 `RECON_URL` 变量。本 plan 默认用阿杜原始 URL `https://docs.qq.com/doc/DQmZvdEFOR0RFWU9t`，但 reconnaissance 阶段建议用自有文档以便调"导出"权限。

- [ ] **Step 2: 起 playwright + 已登录 chrome**

```bash
# 在仓库根目录
uv run python -c "
from pycookiecheat import chrome_cookies
cookies = chrome_cookies('https://docs.qq.com')
print(f'读到 {len(cookies)} 个 cookie，包括: {list(cookies.keys())[:5]}')
"
# 期望: 输出 >0 个 cookie key，包含 uid_key / fingerprint / TOK 等腾讯认证字段
```

- [ ] **Step 3: 写 reconnaissance 脚本（playwright）**

新建临时脚本 `scripts/docs-qq-recon.mjs`（task 完成后删除，仅本 task 用）：

```js
import { chromium } from 'playwright';
import { execSync } from 'child_process';

const RECON_URL = process.env.RECON_URL || 'https://docs.qq.com/doc/DQmZvdEFOR0RFWU9t';

// 用 pycookiecheat 读 cookie，注入到 playwright context
const cookieJson = execSync(`uv run python -c "
import json
from pycookiecheat import chrome_cookies
cookies = chrome_cookies('https://docs.qq.com')
print(json.dumps([{'name': k, 'value': v, 'domain': '.docs.qq.com', 'path': '/'} for k, v in cookies.items()]))
"`).toString();
const cookies = JSON.parse(cookieJson);

const browser = await chromium.launch({ headless: false });
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  viewport: { width: 1920, height: 1080 },
  locale: 'zh-CN',
  timezoneId: 'Asia/Shanghai',
});
await ctx.addCookies(cookies);

const page = await ctx.newPage();

// 抓所有 fetch / xhr 请求
const requests = [];
page.on('request', req => {
  if (req.resourceType() === 'fetch' || req.resourceType() === 'xhr') {
    requests.push({
      url: req.url(),
      method: req.method(),
      headers: req.headers(),
      postData: req.postData(),
    });
  }
});
page.on('response', async res => {
  const req = requests.find(r => r.url === res.url() && !r.responseStatus);
  if (req) {
    req.responseStatus = res.status();
    req.responseHeaders = res.headers();
    try {
      req.responseBody = await res.text();
    } catch {}
  }
});

await page.goto(RECON_URL, { waitUntil: 'networkidle' });
console.log('页面加载完成，请手工点 [文件 → 导出为 → Word]，完成后按回车继续...');
await new Promise(r => process.stdin.once('data', r));

// 等额外 2s 抓导出回调请求
await page.waitForTimeout(2000);

// 输出抓到的所有相关请求到 stdout (按 URL host 过滤腾讯域)
const tencentReqs = requests.filter(r => /docs\.qq\.com|qq\.com/.test(r.url));
console.log(`\n\n=== 抓到 ${tencentReqs.length} 个腾讯域请求 ===\n`);
for (const r of tencentReqs) {
  console.log('---');
  console.log(`${r.method} ${r.url}`);
  console.log(`Status: ${r.responseStatus}`);
  console.log(`Request headers: ${JSON.stringify(r.headers, null, 2)}`);
  if (r.postData) console.log(`Request body: ${r.postData}`);
  if (r.responseBody && r.responseBody.length < 5000) {
    console.log(`Response body: ${r.responseBody}`);
  } else if (r.responseBody) {
    console.log(`Response body (truncated 2KB): ${r.responseBody.slice(0, 2000)}...`);
  }
}

await browser.close();
```

- [ ] **Step 4: 跑 reconnaissance**

```bash
RECON_URL='<阿杜提供的 URL>' node scripts/docs-qq-recon.mjs
```

页面打开后手工点 "文件 → 导出为 → Word"，完成下载后按回车。stdout 全部 dump 到 `/tmp/docs-qq-recon-raw.log`：

```bash
RECON_URL='<URL>' node scripts/docs-qq-recon.mjs 2>&1 | tee /tmp/docs-qq-recon-raw.log
```

- [ ] **Step 5: 把抓到的请求整理到 recon.md**

新建 `docs/superpowers/specs/2026-05-26-docs-qq-extractor-recon.md`，按以下模板整理：

```markdown
# docs.qq.com Endpoint Reconnaissance (2026-05-26)

> 用 playwright 抓 `https://docs.qq.com/doc/<token>` 页面点"导出为 Word"触发的网络请求。
> 用户登录态由 pycookiecheat 注入。
> 抓包脚本 `scripts/docs-qq-recon.mjs` 已删除（仅本次用）。

## 1. 元数据 endpoint（页面加载时拿）

**URL**: `<填入实测 URL>`
**Method**: GET
**Query**:
- `<param>`: `<含义>`
**Required headers**:
- `Cookie`: 用户登录态（fetch 自动带）
- `Referer`: `https://docs.qq.com/doc/<token>`
- `X-Token`: `<如有 CSRF，填实际值来源——通常来自 cookie 某字段或页面 meta>`

**Response schema** (实际 JSON 字段裁剪保留关键项):
\`\`\`json
{
  "title": "<doc title>",
  "creator": { "name": "...", "uid": "..." },
  "create_time": <unix timestamp>,
  "modify_time": <unix timestamp>,
  "word_count": <int>
}
\`\`\`

## 2. 导出任务发起 endpoint

**URL**: `<填入实测 URL>`
**Method**: POST
**Body** (form-data or JSON):
\`\`\`
docId=<token>&format=docx&...
\`\`\`
**Response schema**:
\`\`\`json
{
  "operation_id": "<async task id>",
  "status": "pending"
}
\`\`\`

## 3. 导出任务状态轮询 endpoint

**URL**: `<填入实测 URL>`
**Method**: GET
**Query**: `operation_id=<id>`
**Response schema**:
\`\`\`json
{
  "status": "pending" | "processing" | "done" | "failed",
  "progress": <0-100>,
  "download_url": "<最终 docx 下载 URL，status=done 时才有>"
}
\`\`\`

## 4. docx 文件下载 endpoint

**URL**: 由步骤 3 的 `download_url` 字段提供（可能跨域到 CDN）
**Method**: GET
**Response**: ArrayBuffer（.docx zip 包）
**注意事项**: 是否需要额外 header（Authorization？Referer？）
```

- [ ] **Step 6: 删除临时脚本，commit recon.md**

```bash
rm scripts/docs-qq-recon.mjs
git add -f docs/superpowers/specs/2026-05-26-docs-qq-extractor-recon.md
git commit -m "$(cat <<'EOF'
docs(recon): docs.qq.com endpoint reconnaissance

抓到 4 个 endpoint（元数据 / 导出发起 / 任务轮询 / 文件下载）的 URL / method /
headers / payload / response schema。后续 plan 各 fetch task 直接引用 recon.md。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: 安装依赖 + Webpack splitChunks 配置

**Files:**
- Modify: `package.json`（dependencies）
- Modify: `webpack.config.js`（optimization.splitChunks）

- [ ] **Step 1: 安装 npm 依赖**

```bash
npm i --save mammoth@^1.9.0 mathml-to-latex@^1.4.0
```

预期输出: `added 2 packages, audited ...`. package.json `dependencies` 节多 2 行。

- [ ] **Step 2: 验证 npm install 成功**

```bash
node -e "console.log(require('mammoth').convertToHtml)"
# Expected: [Function: convertToHtml]
node -e "console.log(require('mathml-to-latex'))"
# Expected: [Function: ...] 或 { default: [Function] }
```

如果失败，重新 `npm i`。

- [ ] **Step 3: 改 webpack.config.js 加 splitChunks 配置**

在 `webpack.config.js` 的 `mainConfig.optimization` 节点内已有 `minimize / minimizer` 字段。在它**同级**追加：

```js
optimization: {
  minimize: true,
  minimizer: [
    new TerserPlugin({ /* 现有保持不变 */ }),
  ],
  // ⬇️ 新增：mammoth + jszip + mathml-to-latex 单独分包，仅 docs.qq.com 触发时加载
  splitChunks: {
    cacheGroups: {
      mammoth: {
        test: /[\\/]node_modules[\\/](mammoth|jszip|mathml-to-latex|underscore)[\\/]/,
        name: 'mammoth-vendor',
        chunks: 'async',  // 只对 dynamic import 出来的代码分包
        priority: 10,
        enforce: true,
      },
    },
  },
},
```

> 说明 `underscore` 也加进 test：mammoth 依赖 underscore，否则 underscore 会跟主 bundle 重复打包。

- [ ] **Step 4: 验证 build 成功 + chunk 文件出现**

```bash
npm run build:chrome
```

期望 `dist/` 下出现 `mammoth-vendor.<hash>.js`（约 200-280KB），且 `dist/content.js` 体积**没有**显著增长（不应超过原 size + 5KB）。

```bash
ls -lh dist/mammoth-vendor.*.js
ls -lh dist/content.js
```

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json webpack.config.js
git commit -m "$(cat <<'EOF'
build: 加 mammoth + mathml-to-latex 依赖 + webpack 动态分包

docs.qq.com extractor 需要 docx → HTML 转换（mammoth）和公式 MathML → LaTeX 后处理
（mathml-to-latex）。两个依赖加起来 ~280KB（含 jszip 子依赖），全量打入 content.js
会拖慢所有页面。

splitChunks 把 mammoth + jszip + mathml-to-latex + underscore 分到 mammoth-vendor
chunk，仅 docs.qq.com URL 触发 `await import('mammoth')` 才加载。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: parseDocsQQUrl + 单测

**Files:**
- Create: `src/utils/docs-qq-extractor.ts`
- Create: `src/utils/docs-qq-extractor.test.ts`

- [ ] **Step 1: 写失败的单测**

新建 `src/utils/docs-qq-extractor.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { parseDocsQQUrl, isDocsQQDocUrl } from './docs-qq-extractor';

describe('parseDocsQQUrl', () => {
  it('parses doc URL with bare token', () => {
    expect(parseDocsQQUrl('https://docs.qq.com/doc/DQmZvdEFOR0RFWU9t')).toEqual({
      type: 'doc', token: 'DQmZvdEFOR0RFWU9t',
    });
  });

  it('strips hash anchor', () => {
    expect(parseDocsQQUrl('https://docs.qq.com/doc/DQmZvdEFOR0RFWU9t#?foo=bar')).toEqual({
      type: 'doc', token: 'DQmZvdEFOR0RFWU9t',
    });
  });

  it('strips query string', () => {
    expect(parseDocsQQUrl('https://docs.qq.com/doc/DQmZvdEFOR0RFWU9t?p=123')).toEqual({
      type: 'doc', token: 'DQmZvdEFOR0RFWU9t',
    });
  });

  it('returns null for /sheet/ URL (v2)', () => {
    expect(parseDocsQQUrl('https://docs.qq.com/sheet/DQmZvdEFOR0RFWU9t')).toBeNull();
  });

  it('returns null for /slide/ URL (v2)', () => {
    expect(parseDocsQQUrl('https://docs.qq.com/slide/DQmZvdEFOR0RFWU9t')).toBeNull();
  });

  it('returns null for non-docs.qq URL', () => {
    expect(parseDocsQQUrl('https://example.com/doc/abc')).toBeNull();
  });

  it('returns null for http (not https)', () => {
    expect(parseDocsQQUrl('http://docs.qq.com/doc/abc')).toBeNull();
  });
});

describe('isDocsQQDocUrl', () => {
  it('returns true for doc URL', () => {
    expect(isDocsQQDocUrl('https://docs.qq.com/doc/DQmZvdEFOR0RFWU9t')).toBe(true);
  });
  it('returns false for non-doc URL', () => {
    expect(isDocsQQDocUrl('https://docs.qq.com/sheet/abc')).toBe(false);
    expect(isDocsQQDocUrl('https://example.com/doc/abc')).toBe(false);
  });
});
```

- [ ] **Step 2: 跑单测验证失败**

```bash
npx vitest run src/utils/docs-qq-extractor.test.ts
```

期望: FAIL with "Failed to resolve import './docs-qq-extractor'" 或类似。

- [ ] **Step 3: 写最小实现**

新建 `src/utils/docs-qq-extractor.ts`：

```ts
export interface DocsQQParsedUrl {
  type: 'doc';
  token: string;
}

export function parseDocsQQUrl(url: string): DocsQQParsedUrl | null {
  const match = url.match(/^https:\/\/docs\.qq\.com\/doc\/([A-Za-z0-9]+)/);
  if (!match) return null;
  return { type: 'doc', token: match[1] };
}

export function isDocsQQDocUrl(url: string): boolean {
  return parseDocsQQUrl(url) !== null;
}
```

- [ ] **Step 4: 跑单测验证通过**

```bash
npx vitest run src/utils/docs-qq-extractor.test.ts
```

期望: 8 个 test 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/utils/docs-qq-extractor.ts src/utils/docs-qq-extractor.test.ts
git commit -m "$(cat <<'EOF'
feat(docs-qq): add parseDocsQQUrl + isDocsQQDocUrl + 单测

URL routing: 仅 /doc/<token>（MVP），其它类型如 /sheet/ /slide/ 返回 null（v2）。
hash 和 query string 都被忽略。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: TypeScript Interfaces + Error 类

**Files:**
- Modify: `src/utils/docs-qq-extractor.ts`
- Modify: `src/utils/docs-qq-extractor.test.ts`

- [ ] **Step 1: 写 Error 类失败的单测**

在 `src/utils/docs-qq-extractor.test.ts` 末尾加：

```ts
import {
  DocsQQAuthError,
  DocsQQNotFoundError,
  DocsQQTransientError,
  DocsQQExportFailedError,
  DocsQQConvertError,
} from './docs-qq-extractor';

describe('Error classes', () => {
  it('DocsQQAuthError instanceof Error and carries message', () => {
    const e = new DocsQQAuthError('未登录');
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toBe('未登录');
    expect(e.name).toBe('DocsQQAuthError');
  });

  it('all error subclasses have distinct names', () => {
    const errors = [
      new DocsQQAuthError('a'),
      new DocsQQNotFoundError('b'),
      new DocsQQTransientError('c'),
      new DocsQQExportFailedError('d'),
      new DocsQQConvertError('e'),
    ];
    const names = errors.map(e => e.name);
    expect(new Set(names).size).toBe(5);
  });
});
```

- [ ] **Step 2: 跑单测验证失败**

```bash
npx vitest run src/utils/docs-qq-extractor.test.ts
```

期望: 新增 2 个 test FAIL（"DocsQQAuthError" 等未定义）。

- [ ] **Step 3: 写实现**

在 `src/utils/docs-qq-extractor.ts` 末尾追加：

```ts
// ============================================
// TypeScript Interfaces
// ============================================

export interface DocsQQMetadata {
  title: string;
  author: string;
  createTime: string;  // YYYY-MM-DD
  modifyTime: string;  // YYYY-MM-DD
  wordCount: number;
}

export interface DocsQQStructuredContent {
  title: string;
  author: string;
  content: string;        // HTML (待主流程 turndown)
  published: string;      // YYYY-MM-DD, from modifyTime
  wordCount: number;
}

export interface DocsQQExtractOpts {
  token: string;
  url: string;
  doc: Document;
}

// ============================================
// Error 子类
// ============================================

export class DocsQQAuthError extends Error {
  constructor(message: string) { super(message); this.name = 'DocsQQAuthError'; }
}
export class DocsQQNotFoundError extends Error {
  constructor(message: string) { super(message); this.name = 'DocsQQNotFoundError'; }
}
export class DocsQQTransientError extends Error {
  constructor(message: string) { super(message); this.name = 'DocsQQTransientError'; }
}
export class DocsQQExportFailedError extends Error {
  constructor(message: string) { super(message); this.name = 'DocsQQExportFailedError'; }
}
export class DocsQQConvertError extends Error {
  constructor(message: string) { super(message); this.name = 'DocsQQConvertError'; }
}
```

- [ ] **Step 4: 跑单测验证通过**

```bash
npx vitest run src/utils/docs-qq-extractor.test.ts
```

期望: 所有 test PASS（含之前的 + 新增 2 个）。

- [ ] **Step 5: Commit**

```bash
git add src/utils/docs-qq-extractor.ts src/utils/docs-qq-extractor.test.ts
git commit -m "$(cat <<'EOF'
feat(docs-qq): add types + Error subclasses

新增 DocsQQMetadata / DocsQQStructuredContent / DocsQQExtractOpts 类型。
5 个 Error 子类用于错误分类（Auth/NotFound/Transient/ExportFailed/Convert）—
content.ts catch 时按子类决定 warning banner 文案。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: fetchDocMetadata + 单测

**Files:**
- Modify: `src/utils/docs-qq-extractor.ts`
- Modify: `src/utils/docs-qq-extractor.test.ts`
- Reference: `docs/superpowers/specs/2026-05-26-docs-qq-extractor-recon.md` §1（元数据 endpoint）

- [ ] **Step 1: 从 recon.md §1 拿到元数据 endpoint 的真实 URL/method/headers/response schema**

打开 `docs/superpowers/specs/2026-05-26-docs-qq-extractor-recon.md` §1，把 URL 模板、必需 headers、response JSON 字段路径整理出来。

- [ ] **Step 2: 写失败的单测**

在 `docs-qq-extractor.test.ts` 末尾加（**replace `<META_URL>` / `<RESPONSE_JSON_FIELDS>` 为 recon.md 实测值**）：

```ts
import { fetchDocMetadata } from './docs-qq-extractor';

describe('fetchDocMetadata', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns parsed metadata on 200', async () => {
    const mockResponse = {
      // ← 这里照搬 recon.md §1 的 response schema 真实字段
      title: 'My Doc',
      creator: { name: 'Alice' },
      create_time: 1716700000,
      modify_time: 1716800000,
      word_count: 1234,
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify(mockResponse), { status: 200 })
    );

    const meta = await fetchDocMetadata('DQmZvdEFOR0RFWU9t');
    expect(meta.title).toBe('My Doc');
    expect(meta.author).toBe('Alice');
    expect(meta.createTime).toBe('2024-05-26');  // unix → YYYY-MM-DD
    expect(meta.modifyTime).toBe('2024-05-27');
    expect(meta.wordCount).toBe(1234);
  });

  it('throws DocsQQAuthError on 401', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('', { status: 401 }));
    await expect(fetchDocMetadata('DQmZvdEFOR0RFWU9t')).rejects.toBeInstanceOf(DocsQQAuthError);
  });

  it('throws DocsQQAuthError on 403', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('', { status: 403 }));
    await expect(fetchDocMetadata('DQmZvdEFOR0RFWU9t')).rejects.toBeInstanceOf(DocsQQAuthError);
  });

  it('throws DocsQQNotFoundError on 404', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('', { status: 404 }));
    await expect(fetchDocMetadata('DQmZvdEFOR0RFWU9t')).rejects.toBeInstanceOf(DocsQQNotFoundError);
  });

  it('throws DocsQQTransientError on 5xx', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('', { status: 500 }));
    await expect(fetchDocMetadata('DQmZvdEFOR0RFWU9t')).rejects.toBeInstanceOf(DocsQQTransientError);
  });
});
```

`vi.restoreAllMocks` 需 `import { vi } from 'vitest'`。

- [ ] **Step 3: 跑单测验证失败**

```bash
npx vitest run src/utils/docs-qq-extractor.test.ts
```

期望: 新 test FAIL with "fetchDocMetadata is not defined"。

- [ ] **Step 4: 写实现**

在 `src/utils/docs-qq-extractor.ts` 追加（**replace `<META_URL_TEMPLATE>` / `<REQUIRED_HEADERS>` 为 recon.md §1 实测值**）：

```ts
const META_ENDPOINT_URL = '<META_URL_TEMPLATE>';  // 例: 'https://docs.qq.com/cgi-bin/.../info?docId={token}'
const FETCH_TIMEOUT_MS = 10_000;

function unixToYmd(unix: number): string {
  const d = new Date(unix * 1000);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (e) {
    if ((e as Error).name === 'AbortError') {
      throw new DocsQQTransientError(`fetch timeout: ${url}`);
    }
    throw new DocsQQTransientError(`fetch failed: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

function throwForStatus(status: number, context: string): void {
  if (status === 401 || status === 403) {
    throw new DocsQQAuthError(`${context}: 未登录或无权限 (HTTP ${status})`);
  }
  if (status === 404) {
    throw new DocsQQNotFoundError(`${context}: 文档不存在 (HTTP ${status})`);
  }
  if (status >= 500) {
    throw new DocsQQTransientError(`${context}: 腾讯服务暂时不可用 (HTTP ${status})`);
  }
  if (status >= 400) {
    throw new DocsQQTransientError(`${context}: HTTP ${status}`);
  }
}

export async function fetchDocMetadata(token: string): Promise<DocsQQMetadata> {
  const url = META_ENDPOINT_URL.replace('{token}', token);
  const response = await fetchWithTimeout(url, {
    method: 'GET',
    headers: {
      // ← 从 recon.md §1 抄真实 headers (Referer, X-Token 等)
      'Referer': `https://docs.qq.com/doc/${token}`,
    },
    credentials: 'include',  // 自动带 cookie
  });

  throwForStatus(response.status, 'fetchDocMetadata');

  const data = await response.json();

  // ↓ 字段路径从 recon.md §1 实测值抄
  return {
    title: data.title || '',
    author: data.creator?.name || '',
    createTime: unixToYmd(data.create_time),
    modifyTime: unixToYmd(data.modify_time),
    wordCount: data.word_count || 0,
  };
}
```

- [ ] **Step 5: 跑单测验证通过 + commit**

```bash
npx vitest run src/utils/docs-qq-extractor.test.ts
git add src/utils/docs-qq-extractor.ts src/utils/docs-qq-extractor.test.ts
git commit -m "$(cat <<'EOF'
feat(docs-qq): fetchDocMetadata + 单测

调元数据 endpoint 拿 title/author/createTime/modifyTime/wordCount。
错误分类: 401/403→Auth, 404→NotFound, 5xx→Transient, timeout→Transient。
endpoint URL/headers 从 recon.md §1 抄。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: requestExportTask + 单测

**Files:**
- Modify: `src/utils/docs-qq-extractor.ts`
- Modify: `src/utils/docs-qq-extractor.test.ts`
- Reference: `recon.md` §2

- [ ] **Step 1: 写失败的单测**

```ts
import { requestExportTask } from './docs-qq-extractor';

describe('requestExportTask', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('returns operationId on 200', async () => {
    // ← 字段名 operation_id 从 recon.md §2 抄实测值
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ operation_id: 'task-xyz-123' }), { status: 200 })
    );
    const id = await requestExportTask('DQmZvdEFOR0RFWU9t', 'docx');
    expect(id).toBe('task-xyz-123');
  });

  it('throws DocsQQAuthError on 401', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('', { status: 401 }));
    await expect(requestExportTask('DQmZvdEFOR0RFWU9t', 'docx')).rejects.toBeInstanceOf(DocsQQAuthError);
  });

  it('throws DocsQQExportFailedError if response has no operation_id', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({}), { status: 200 })
    );
    await expect(requestExportTask('DQmZvdEFOR0RFWU9t', 'docx')).rejects.toBeInstanceOf(DocsQQExportFailedError);
  });
});
```

- [ ] **Step 2: 跑单测验证失败**

```bash
npx vitest run src/utils/docs-qq-extractor.test.ts -t 'requestExportTask'
```

期望: 3 test FAIL with "requestExportTask is not defined"。

- [ ] **Step 3: 写实现**

```ts
const EXPORT_REQUEST_URL = '<EXPORT_REQUEST_URL>';  // 从 recon.md §2

export async function requestExportTask(
  token: string,
  format: 'docx' = 'docx'
): Promise<string> {
  const response = await fetchWithTimeout(EXPORT_REQUEST_URL, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',  // 或 form-urlencoded（看 recon.md §2）
      'Referer': `https://docs.qq.com/doc/${token}`,
    },
    body: JSON.stringify({
      // ← 字段名从 recon.md §2 抄
      docId: token,
      format,
    }),
  });

  throwForStatus(response.status, 'requestExportTask');

  const data = await response.json();
  // ↓ 字段名从 recon.md §2 抄
  const operationId = data.operation_id;
  if (!operationId) {
    throw new DocsQQExportFailedError(
      `requestExportTask: 响应没有 operation_id 字段，body=${JSON.stringify(data).slice(0, 200)}`
    );
  }
  return operationId;
}
```

- [ ] **Step 4: 跑单测验证通过 + commit**

```bash
npx vitest run src/utils/docs-qq-extractor.test.ts
git add src/utils/docs-qq-extractor.ts src/utils/docs-qq-extractor.test.ts
git commit -m "feat(docs-qq): requestExportTask + 单测

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 7: pollExportStatus + 单测

**Files:**
- Modify: `src/utils/docs-qq-extractor.ts`
- Modify: `src/utils/docs-qq-extractor.test.ts`
- Reference: `recon.md` §3

- [ ] **Step 1: 写失败的单测**

```ts
import { pollExportStatus } from './docs-qq-extractor';

describe('pollExportStatus', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('returns downloadUrl when status=done on first poll', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({
        status: 'done',
        progress: 100,
        download_url: 'https://docs.qq.com/cdn/file.docx',
      }), { status: 200 })
    );
    const url = await pollExportStatus('task-xyz-123', { timeoutMs: 1000, intervalMs: 100 });
    expect(url).toBe('https://docs.qq.com/cdn/file.docx');
  });

  it('polls multiple times until done', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    spy.mockResolvedValueOnce(new Response(JSON.stringify({ status: 'pending', progress: 0 }), { status: 200 }));
    spy.mockResolvedValueOnce(new Response(JSON.stringify({ status: 'processing', progress: 50 }), { status: 200 }));
    spy.mockResolvedValueOnce(new Response(JSON.stringify({
      status: 'done', progress: 100, download_url: 'https://example.com/x.docx',
    }), { status: 200 }));

    const url = await pollExportStatus('task-xyz', { timeoutMs: 5000, intervalMs: 50 });
    expect(url).toBe('https://example.com/x.docx');
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('throws DocsQQExportFailedError when status=failed', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ status: 'failed' }), { status: 200 })
    );
    await expect(
      pollExportStatus('task-xyz', { timeoutMs: 1000, intervalMs: 50 })
    ).rejects.toBeInstanceOf(DocsQQExportFailedError);
  });

  it('throws DocsQQTransientError on timeout', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ status: 'pending', progress: 0 }), { status: 200 })
    );
    await expect(
      pollExportStatus('task-xyz', { timeoutMs: 200, intervalMs: 50 })
    ).rejects.toBeInstanceOf(DocsQQTransientError);
  });
});
```

- [ ] **Step 2: 跑测验证失败**

```bash
npx vitest run src/utils/docs-qq-extractor.test.ts -t 'pollExportStatus'
```

- [ ] **Step 3: 写实现**

```ts
const EXPORT_STATUS_URL = '<EXPORT_STATUS_URL>';  // 从 recon.md §3

export async function pollExportStatus(
  operationId: string,
  opts: { timeoutMs: number; intervalMs: number }
): Promise<string> {
  const deadline = Date.now() + opts.timeoutMs;

  while (Date.now() < deadline) {
    const url = EXPORT_STATUS_URL.replace('{operationId}', operationId);
    const response = await fetchWithTimeout(url, {
      method: 'GET',
      credentials: 'include',
    });

    throwForStatus(response.status, 'pollExportStatus');

    const data = await response.json();
    // ↓ 字段名从 recon.md §3 抄
    const status: string = data.status;

    if (status === 'done') {
      const downloadUrl = data.download_url;
      if (!downloadUrl) {
        throw new DocsQQExportFailedError('pollExportStatus: status=done 但缺 download_url');
      }
      return downloadUrl;
    }
    if (status === 'failed') {
      throw new DocsQQExportFailedError(`pollExportStatus: 任务失败，response=${JSON.stringify(data).slice(0, 200)}`);
    }

    // pending / processing: 等待下次轮询
    await new Promise(resolve => setTimeout(resolve, opts.intervalMs));
  }

  throw new DocsQQTransientError(`pollExportStatus: 超过 ${opts.timeoutMs}ms 未完成`);
}
```

- [ ] **Step 4: 跑测验证通过**

```bash
npx vitest run src/utils/docs-qq-extractor.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/utils/docs-qq-extractor.ts src/utils/docs-qq-extractor.test.ts
git commit -m "feat(docs-qq): pollExportStatus + 单测

每 intervalMs poll 一次，status=done 返回 download_url，
status=failed throw ExportFailedError，超过 timeoutMs throw TransientError。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 8: fetchDocxFile + 单测

**Files:**
- Modify: `src/utils/docs-qq-extractor.ts`
- Modify: `src/utils/docs-qq-extractor.test.ts`

- [ ] **Step 1: 写失败的单测**

```ts
import { fetchDocxFile } from './docs-qq-extractor';

describe('fetchDocxFile', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('returns ArrayBuffer on 200', async () => {
    const fakeBuffer = new TextEncoder().encode('PK\x03\x04...').buffer;
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(fakeBuffer, { status: 200 })
    );
    const buf = await fetchDocxFile('https://example.com/file.docx');
    expect(buf).toBeInstanceOf(ArrayBuffer);
    expect(buf.byteLength).toBeGreaterThan(0);
  });

  it('throws DocsQQTransientError on 404 (CDN gone)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('', { status: 404 }));
    await expect(fetchDocxFile('https://example.com/x.docx')).rejects.toBeInstanceOf(DocsQQTransientError);
  });

  it('throws DocsQQTransientError if Content-Length > 50MB', async () => {
    const resp = new Response(new ArrayBuffer(0), {
      status: 200,
      headers: { 'Content-Length': String(51 * 1024 * 1024) },
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(resp);
    await expect(fetchDocxFile('https://example.com/big.docx')).rejects.toBeInstanceOf(DocsQQTransientError);
  });
});
```

- [ ] **Step 2: 跑测验证失败**

```bash
npx vitest run src/utils/docs-qq-extractor.test.ts -t 'fetchDocxFile'
```

- [ ] **Step 3: 写实现**

```ts
const DOWNLOAD_SIZE_LIMIT = 50 * 1024 * 1024;  // 50MB

export async function fetchDocxFile(downloadUrl: string): Promise<ArrayBuffer> {
  const response = await fetchWithTimeout(downloadUrl, {
    method: 'GET',
    credentials: 'include',
  });

  // 注意 CDN 失效用 404 表达，这里跟主域 404 语义不同 → 视为 Transient
  if (response.status === 404) {
    throw new DocsQQTransientError(`fetchDocxFile: CDN 文件已失效 (HTTP 404)`);
  }
  throwForStatus(response.status, 'fetchDocxFile');

  const contentLength = response.headers.get('Content-Length');
  if (contentLength && Number(contentLength) > DOWNLOAD_SIZE_LIMIT) {
    throw new DocsQQTransientError(
      `fetchDocxFile: 文件过大 ${contentLength} bytes > ${DOWNLOAD_SIZE_LIMIT}`
    );
  }

  return await response.arrayBuffer();
}
```

- [ ] **Step 4: 跑测验证通过 + commit**

```bash
npx vitest run src/utils/docs-qq-extractor.test.ts
git add src/utils/docs-qq-extractor.ts src/utils/docs-qq-extractor.test.ts
git commit -m "feat(docs-qq): fetchDocxFile + 单测

下载 .docx 文件 ArrayBuffer，Content-Length 上限 50MB（防 OOM）。
CDN 404 视为 Transient（跟主域 404 不同语义）。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 9: convertDocxToHtml (mammoth) + 单测

**Files:**
- Modify: `src/utils/docs-qq-extractor.ts`
- Modify: `src/utils/docs-qq-extractor.test.ts`

- [ ] **Step 1: 写失败的单测**

```ts
import { convertDocxToHtml } from './docs-qq-extractor';

describe('convertDocxToHtml', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('returns HTML string from valid docx ArrayBuffer (mocked mammoth)', async () => {
    // mock dynamic import('mammoth')
    vi.doMock('mammoth', () => ({
      default: {
        convertToHtml: vi.fn().mockResolvedValue({
          value: '<p>Hello</p>',
          messages: [],
        }),
        images: {
          imgElement: (_handler: unknown) => 'IMG_HANDLER_TOKEN',
        },
      },
    }));

    const buf = new ArrayBuffer(8);
    const html = await convertDocxToHtml(buf);
    expect(html).toContain('<p>Hello</p>');
  });

  it('throws DocsQQConvertError when mammoth throws', async () => {
    vi.doMock('mammoth', () => ({
      default: {
        convertToHtml: vi.fn().mockRejectedValue(new Error('corrupt docx')),
        images: { imgElement: (_h: unknown) => 'X' },
      },
    }));

    await expect(convertDocxToHtml(new ArrayBuffer(8))).rejects.toBeInstanceOf(DocsQQConvertError);
  });
});
```

- [ ] **Step 2: 跑测验证失败**

```bash
npx vitest run src/utils/docs-qq-extractor.test.ts -t 'convertDocxToHtml'
```

- [ ] **Step 3: 写实现**

```ts
export async function convertDocxToHtml(arrayBuffer: ArrayBuffer): Promise<string> {
  let mammoth;
  try {
    const module = await import('mammoth');
    mammoth = module.default || module;
  } catch (e) {
    throw new DocsQQConvertError(`无法加载 mammoth 模块: ${(e as Error).message}`);
  }

  try {
    const { value } = await mammoth.convertToHtml(
      { arrayBuffer },
      {
        convertImage: mammoth.images.imgElement((image: { contentType: string; read: (encoding: string) => Promise<string> }) =>
          image.read('base64').then((data: string) => ({
            src: `data:${image.contentType};base64,${data}`,
          }))
        ),
      }
    );
    return value;
  } catch (e) {
    throw new DocsQQConvertError(`mammoth 转换失败: ${(e as Error).message}`);
  }
}
```

- [ ] **Step 4: 跑测验证通过 + commit**

```bash
npx vitest run src/utils/docs-qq-extractor.test.ts
git add src/utils/docs-qq-extractor.ts src/utils/docs-qq-extractor.test.ts
git commit -m "feat(docs-qq): convertDocxToHtml + mammoth 动态 import

await import('mammoth') 触发 webpack 分包加载 mammoth-vendor chunk。
图片自动 base64 内嵌到 HTML data: URL。失败 throw DocsQQConvertError。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 10: postProcessHtml (MathML → LaTeX) + 单测

**Files:**
- Modify: `src/utils/docs-qq-extractor.ts`
- Modify: `src/utils/docs-qq-extractor.test.ts`

- [ ] **Step 1: 写失败的单测**

```ts
import { postProcessHtml } from './docs-qq-extractor';

describe('postProcessHtml', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('converts inline MathML to $...$', async () => {
    vi.doMock('mathml-to-latex', () => ({
      default: (_xml: string) => 'x^2',
    }));
    const html = '<p>Equation: <math><mi>x</mi></math></p>';
    const result = await postProcessHtml(html);
    expect(result).toContain('$x^2$');
  });

  it('converts block MathML to $$...$$', async () => {
    vi.doMock('mathml-to-latex', () => ({
      default: (_xml: string) => 'a + b = c',
    }));
    const html = '<p><math display="block"><mi>a</mi></math></p>';
    const result = await postProcessHtml(html);
    expect(result).toContain('$$a + b = c$$');
  });

  it('removes empty <p>', async () => {
    const html = '<p>foo</p><p></p><p>bar</p>';
    const result = await postProcessHtml(html);
    expect(result).not.toMatch(/<p><\/p>/);
    expect(result).toContain('<p>foo</p>');
    expect(result).toContain('<p>bar</p>');
  });

  it('collapses consecutive <br>', async () => {
    const html = '<p>x<br><br><br>y</p>';
    const result = await postProcessHtml(html);
    expect((result.match(/<br>/g) || []).length).toBeLessThanOrEqual(1);
  });

  it('keeps MathML untouched if mathml-to-latex throws', async () => {
    vi.doMock('mathml-to-latex', () => ({
      default: (_xml: string) => { throw new Error('cant parse'); },
    }));
    const html = '<p><math><mi>x</mi></math></p>';
    const result = await postProcessHtml(html);
    // 不转 LaTeX，保留原 MathML
    expect(result).toContain('<math');
  });
});
```

- [ ] **Step 2: 跑测验证失败**

```bash
npx vitest run src/utils/docs-qq-extractor.test.ts -t 'postProcessHtml'
```

- [ ] **Step 3: 写实现**

```ts
export async function postProcessHtml(rawHtml: string): Promise<string> {
  const parser = new DOMParser();
  const doc = parser.parseFromString(rawHtml, 'text/html');

  // 1. MathML → LaTeX
  if (doc.querySelector('math')) {
    let mathmlToLatex: ((xml: string) => string) | null = null;
    try {
      const mod = await import('mathml-to-latex');
      mathmlToLatex = (mod.default || mod) as (xml: string) => string;
    } catch {
      // 模块加载失败，跳过公式转换
    }

    if (mathmlToLatex) {
      for (const math of Array.from(doc.querySelectorAll('math'))) {
        try {
          const latex = mathmlToLatex(math.outerHTML);
          const isBlock = math.getAttribute('display') === 'block';
          const wrapped = isBlock ? `$$${latex}$$` : `$${latex}$`;
          math.replaceWith(doc.createTextNode(wrapped));
        } catch {
          // 单条转换失败保留 MathML 原标签
        }
      }
    }
  }

  // 2. 清理空段落
  for (const p of Array.from(doc.querySelectorAll('p'))) {
    if (!p.textContent?.trim() && !p.querySelector('img,video,br')) {
      p.remove();
    }
  }

  // 3. 折叠连续 <br>（保留 1 个）
  for (const br of Array.from(doc.querySelectorAll('br'))) {
    let next = br.nextSibling;
    while (next && next.nodeName === 'BR') {
      const toRemove = next;
      next = next.nextSibling;
      toRemove.parentNode?.removeChild(toRemove);
    }
  }

  return doc.body.innerHTML;
}
```

- [ ] **Step 4: 跑测验证通过 + commit**

```bash
npx vitest run src/utils/docs-qq-extractor.test.ts
git add src/utils/docs-qq-extractor.ts src/utils/docs-qq-extractor.test.ts
git commit -m "feat(docs-qq): postProcessHtml (MathML→LaTeX + 清理)

MathML inline → \$...\$，block → \$\$...\$\$。
转换失败保留原 MathML，不阻塞裁剪。
空 <p> 和连续 <br> 清理。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 11: extractDocsQQContent 主入口编排 + 单测

**Files:**
- Modify: `src/utils/docs-qq-extractor.ts`
- Modify: `src/utils/docs-qq-extractor.test.ts`

- [ ] **Step 1: 写失败的单测**

```ts
import { extractDocsQQContent } from './docs-qq-extractor';

describe('extractDocsQQContent (orchestration)', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('runs full pipeline: meta → export → poll → download → mammoth → postProcess', async () => {
    // 4 个 fetch mock 按顺序
    const spy = vi.spyOn(globalThis, 'fetch');
    spy.mockResolvedValueOnce(new Response(JSON.stringify({  // meta
      title: 'My Doc', creator: { name: 'Alice' },
      create_time: 1716700000, modify_time: 1716800000, word_count: 100,
    }), { status: 200 }));
    spy.mockResolvedValueOnce(new Response(JSON.stringify({  // export request
      operation_id: 'op-1',
    }), { status: 200 }));
    spy.mockResolvedValueOnce(new Response(JSON.stringify({  // poll
      status: 'done', download_url: 'https://cdn/x.docx',
    }), { status: 200 }));
    spy.mockResolvedValueOnce(new Response(new ArrayBuffer(64), { status: 200 }));  // download

    vi.doMock('mammoth', () => ({
      default: {
        convertToHtml: vi.fn().mockResolvedValue({ value: '<p>Body</p>', messages: [] }),
        images: { imgElement: (_h: unknown) => 'X' },
      },
    }));

    const result = await extractDocsQQContent({
      token: 'DQmZvdEFOR0RFWU9t',
      url: 'https://docs.qq.com/doc/DQmZvdEFOR0RFWU9t',
      doc: document,
    });

    expect(result.title).toBe('My Doc');
    expect(result.author).toBe('Alice');
    expect(result.published).toBe('2024-05-27');
    expect(result.content).toContain('<p>Body</p>');
    expect(result.wordCount).toBe(100);
  });

  it('propagates DocsQQAuthError from fetchDocMetadata', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('', { status: 401 }));
    await expect(extractDocsQQContent({
      token: 'X', url: 'https://docs.qq.com/doc/X', doc: document,
    })).rejects.toBeInstanceOf(DocsQQAuthError);
  });
});
```

- [ ] **Step 2: 跑测验证失败**

```bash
npx vitest run src/utils/docs-qq-extractor.test.ts -t 'extractDocsQQContent'
```

- [ ] **Step 3: 写实现**

```ts
function estimateWordCount(html: string): number {
  // 简单估算：剥 HTML 标签后字符数（中文按字符算）
  const text = html.replace(/<[^>]*>/g, '');
  const cjk = (text.match(/[一-鿿]/g) || []).length;
  const words = (text.match(/[a-zA-Z0-9]+/g) || []).length;
  return cjk + words;
}

export async function extractDocsQQContent(
  opts: DocsQQExtractOpts
): Promise<DocsQQStructuredContent> {
  const { token } = opts;

  const meta = await fetchDocMetadata(token);
  const operationId = await requestExportTask(token, 'docx');
  const downloadUrl = await pollExportStatus(operationId, {
    timeoutMs: 30_000,
    intervalMs: 1_000,
  });
  const arrayBuffer = await fetchDocxFile(downloadUrl);
  const rawHtml = await convertDocxToHtml(arrayBuffer);
  const html = await postProcessHtml(rawHtml);

  return {
    title: meta.title,
    author: meta.author,
    published: meta.modifyTime,
    content: html,
    wordCount: meta.wordCount || estimateWordCount(html),
  };
}
```

- [ ] **Step 4: 跑测验证通过 + commit**

```bash
npx vitest run src/utils/docs-qq-extractor.test.ts
git add src/utils/docs-qq-extractor.ts src/utils/docs-qq-extractor.test.ts
git commit -m "feat(docs-qq): extractDocsQQContent 主入口编排 + 单测

meta → export → poll → download → mammoth → postProcess 全链路串起来。
任一步抛错向上传播（fail-loud，由 content.ts catch）。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 12: content.ts 集成 isDocsQQUrl branch

**Files:**
- Modify: `src/content.ts`（在 zsxq 后追加 isDocsQQ）

- [ ] **Step 1: 改 content.ts 加 import**

`src/content.ts` 第 14-17 行附近现有 imports，在 zsxq import 后追加（**line ~18**）：

```ts
import { extractDocsQQContent, isDocsQQDocUrl, parseDocsQQUrl } from './utils/docs-qq-extractor';
```

- [ ] **Step 2: 在 zsxqContent 后追加 docsQQContent 调用**

`src/content.ts` 第 296-302 行（zsxqContent 块）**后面**插入：

```ts
const docsQQContent = isDocsQQDocUrl(document.URL)
  ? await (async () => {
      const parsed = parseDocsQQUrl(document.URL);
      if (!parsed) return null;
      return extractDocsQQContent({
        token: parsed.token,
        url: document.URL,
        doc: document,
      });
    })().catch((error) => {
      const msg = error instanceof Error ? error.message : String(error);
      contentLogger.warn('Failed to extract docs.qq structured content', { error: msg });
      extractorWarnings.push(`docs.qq: ${msg}`);
      return null;
    })
  : null;
```

- [ ] **Step 3: 把 docsQQContent 字段映射到 extractedContent**

在 `if (feishuContent?.commentsMarkdown)` 块后（**line ~327** 附近）追加（紧邻 feishuContent 处理逻辑，保持对称结构）：

```ts
if (docsQQContent) {
  // docsQQContent.content / title / author 走 ContentResponse cascade，
  // 跟 scysContent 同样不需要写入 extractedContent dict（避免覆盖 turndown 后产物）。
  // 见 line ~328 注释解释。
}
```

并在 `author:` cascade 行（约 line 394）追加 `docsQQContent?.author`：

```ts
author: bilibiliContent?.author || feishuContent?.author || scysContent?.author || zsxqContent?.author || docsQQContent?.author || defuddled.author,
```

同时找到 ContentResponse 构造的其它字段（title / content / wordCount / published），按相同 pattern 把 `docsQQContent?.<field>` 接到 cascade 链上。完整 cascade 链格式：

```ts
title: bilibiliContent?.title || feishuContent?.title || scysContent?.title || zsxqContent?.title || docsQQContent?.title || defuddled.title,
content: bilibiliContent?.content || feishuContent?.content || scysContent?.content || zsxqContent?.content || docsQQContent?.content || defuddled.content,
wordCount: docsQQContent?.wordCount || scysContent?.wordCount || zsxqContent?.wordCount || defuddled.wordCount,
published: feishuContent?.published || scysContent?.published || zsxqContent?.published || docsQQContent?.published || defuddled.published,
```

> 注：scys 等 extractor 在 content-extractor.ts:160 通过 createMarkdownContent 跑过 turndown，docsQQ 同样走这条路径——因为 docsQQContent.content 是 HTML 而非已 markdown 化（跟 feishu/scys/zsxq 一致），不需要单独绕过 turndown。

- [ ] **Step 4: 跑 vitest 验证已有测试不破坏**

```bash
npm test
```

期望: 全 PASS（含本 plan task 3-11 的单测）。

- [ ] **Step 5: 验证 TypeScript 编译过**

```bash
npx tsc --noEmit
```

期望: 无 error。

- [ ] **Step 6: Commit**

```bash
git add src/content.ts
git commit -m "$(cat <<'EOF'
feat(docs-qq): 集成 docs-qq-extractor 到 content.ts URL 路由

在 zsxq 之后加 docsQQContent 调用，catch 失败收进 extractorWarnings 显示 banner。
ContentResponse cascade 链加 docsQQContent?.<field> 优先级（在 zsxq 后、defuddled 前）。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: 构建验证 + 扩展 hot reload + 手工真 URL 验收

**Files:**
- 无新建 / 修改文件，仅验证

- [ ] **Step 1: build chrome**

```bash
npm run build:chrome
```

期望:
- 成功，无 webpack error / warning
- `dist/content.js` 体积没有 +250KB（说明分包正确）
- `dist/mammoth-vendor.<hash>.js` 出现且 ~200-280KB

```bash
ls -lh dist/content.js dist/mammoth-vendor.*.js
```

- [ ] **Step 2: 扩展 hot reload**

chrome://extensions → 找到 Obsidian Web Clipper → 点 reload。或直接退浏览器重启。

- [ ] **Step 3: 手工真 URL 验收**

阿杜手动操作：
1. 用 macOS Chrome 打开阿杜原始 URL `https://docs.qq.com/doc/DQmZvdEFOR0RFWU9t`（已登录）
2. 点扩展图标触发裁剪
3. 等几秒（导出任务异步，可能要 5-15s）
4. 看 Obsidian.app 中产物：
   - frontmatter 含 title / author / published / source
   - 正文段落 / 标题 / 列表 / 表格 / 图片 / 链接渲染正确
   - 公式（如有）显示 `$...$` / `$$...$$`
   - 没有 raw HTML 漏到 markdown

- [ ] **Step 4: 验收失败 → 录 console log 排查 → 修复 → 回到 Step 1**

如果裁剪失败、warning banner 出现，按 `feedback_extractor_acceptance.md` 4 问 root cause + 字段收紧。

- [ ] **Step 5: 验收通过后无 commit（仅手工验证，没改代码）**

如有代码改动（修 bug），单独 commit。

---

## Task 14: E2E 测试框架 + 第 1 个 fixture

**Files:**
- Create: `src/utils/docs-qq-extractor.e2e.test.ts`

- [ ] **Step 1: 看现有 E2E 模式（参考既有）**

读 `src/utils/scys-extractor.e2e.test.ts` 和 `src/utils/weixin-extractor.e2e.test.ts` 找 `runRealClip` 调用模式：

```bash
grep -n "runRealClip\|describe.e2e" src/utils/scys-extractor.e2e.test.ts
```

- [ ] **Step 2: 写 E2E 测试**

新建 `src/utils/docs-qq-extractor.e2e.test.ts`（参考 scys 同名 e2e 文件结构）：

```ts
import { describe, it, expect } from 'vitest';
import { runRealClip } from '../test-utils/run-real-clip';  // 路径以 scys 同款为准

const FIXTURES = [
  {
    name: '阿杜原始 URL',
    url: 'https://docs.qq.com/doc/DQmZvdEFOR0RFWU9t',
    expectTitle: /.+/,
    expectHasFrontmatter: true,
  },
  // 后续 Task 15 加更多 fixture
];

describe('docs-qq-extractor e2e', () => {
  for (const fix of FIXTURES) {
    it(`extracts ${fix.name}: ${fix.url}`, async () => {
      const result = await runRealClip(fix.url);

      expect(result.markdown).toBeTruthy();
      expect(result.markdown.length).toBeGreaterThan(100);
      if (fix.expectHasFrontmatter) {
        expect(result.markdown).toMatch(/^---\n[\s\S]+?\n---/);
      }
      expect(result.markdown).toMatch(/title:\s+/);
    }, 60_000);  // 单 case timeout 60s（含 chrome 启动 + 异步导出）
  }
});
```

- [ ] **Step 3: 跑 e2e**

```bash
npm run test:e2e -- src/utils/docs-qq-extractor.e2e.test.ts
```

期望: 1 个 case PASS。

如失败：
- 看 playwright 是否能登录态进 docs.qq.com（cookie 读取问题）→ 检查 `scripts/read-chrome-cookies.py` 是否支持 docs.qq.com 域
- 看是否被反爬识别（403 / 验证码弹窗）→ 加 stealth plugin、调 UA / viewport

- [ ] **Step 4: Commit**

```bash
git add src/utils/docs-qq-extractor.e2e.test.ts
git commit -m "$(cat <<'EOF'
test(docs-qq): e2e fixture (1 URL)

第一个 fixture：阿杜原始 URL。验证 markdown 长度 + frontmatter 出现。
扩展 fixture 集见 plan task 15。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 15: 多 fixture E2E + audit-extractor-ship 视觉验收

**Files:**
- Modify: `src/utils/docs-qq-extractor.e2e.test.ts`

- [ ] **Step 1: 阿杜提供 2-4 个补充 fixture URL**

要求覆盖：
- 含表格（验证表格 turndown 正确）
- 含图片（验证 base64 内嵌）
- 含公式（验证 LaTeX 转换）
- 含嵌入子文档 / 长文档（可选）

如果阿杜来不及收集，先用第 1 个 fixture，跳过此 task，标记为 follow-up。

- [ ] **Step 2: 扩展 FIXTURES 数组**

```ts
const FIXTURES = [
  { name: '阿杜原始 URL', url: '...', /* 同前 */ },
  { name: '含表格', url: '<阿杜提供>', expectMarkdownContains: /\|.*\|/ },
  { name: '含图片', url: '<阿杜提供>', expectMarkdownContains: /!\[\]\(data:image/ },
  { name: '含公式', url: '<阿杜提供>', expectMarkdownContains: /\$.+?\$/ },
];
```

- [ ] **Step 3: 跑全部 e2e**

```bash
npm run test:e2e -- src/utils/docs-qq-extractor.e2e.test.ts
```

期望: 所有 case PASS。

- [ ] **Step 4: 跑 audit-extractor-ship 视觉验收**

按 `audit-extractor-ship` SKILL：

```bash
# 1. 准备每个 fixture URL → 产物 markdown 路径
# 2. 调 SKILL（主 session 派 N 个 subagent，每 subagent 处理 ~5 个 grid 截图）
# 3. 收 REPORT.md
```

具体调用看 `reference_audit_extractor_ship.md`。

- [ ] **Step 5: 收 audit 报告，10 项 checklist 全过 PASS**

如有 diff[]，按 priority 修复。

- [ ] **Step 6: Commit**

```bash
git add src/utils/docs-qq-extractor.e2e.test.ts
git commit -m "$(cat <<'EOF'
test(docs-qq): e2e 多 fixture + audit-extractor-ship 视觉验收

新增 3-4 个 fixture（表格 / 图片 / 公式 / 长文档）。
audit 报告 docs/superpowers/test-reports/2026-05-26-docs-qq-audit/REPORT.md
（仅本地，已 gitignore）。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 16: Ship Gate T5-1..4 (验证 + ship)

**Files:**
- 验证用，无新文件

- [ ] **Step 1: T5-1 — `npm test` PASS**

```bash
npm test
```

期望: 所有 vitest 单测 PASS（exclude e2e）。

- [ ] **Step 2: T5-2 — `npm run test:e2e` PASS + audit PASS**

```bash
npm run test:e2e
```

期望: 所有 e2e（含 docs-qq + 既有 scys/feishu/weixin/zsxq）PASS。
audit-extractor-ship 报告 10 项 checklist 全 PASS。

- [ ] **Step 3: T5-3 — `npm run build:chrome` + 手工真 URL 验收**

```bash
npm run build:chrome
```

期望: build 成功，dist/content.js 没 +250KB，dist/mammoth-vendor.*.js 出现。

扩展 hot reload，手工裁剪 1 个 URL（最好不是 e2e fixture，避免 cherry-picking）。Obsidian.app 看产物，确认：
- frontmatter 完整
- 正文渲染正确
- 没 warning banner（happy path）

- [ ] **Step 4: T5-4 — 文档更新（下个 Task）**

跳到 Task 17。

---

## Task 17: BACKLOG + memory 更新 + ship 上 main

**Files:**
- Modify: `docs/superpowers/BACKLOG.md`
- Create: `/Users/adu/.claude/projects/-Users-adu-Workspace-github-obsidian-clipper-obsidian-clipper-cn/memory/project_docs_qq_endpoints.md`
- Modify: `/Users/adu/.claude/projects/-Users-adu-Workspace-github-obsidian-clipper-obsidian-clipper-cn/memory/MEMORY.md`

- [ ] **Step 1: 写新 memory 文件**

`memory/project_docs_qq_endpoints.md`:

```markdown
---
name: docs.qq.com 4 个 endpoint 实测路径 + payload schema
description: 2026-05-26 reconnaissance 拿到的腾讯文档元数据 / 导出发起 / 任务轮询 / 文件下载 endpoint
metadata:
  type: project
---

完整实测路径 / payload 见 [docs/superpowers/specs/2026-05-26-docs-qq-extractor-recon.md](../specs/2026-05-26-docs-qq-extractor-recon.md)。

**关键点**：
- 4 个 endpoint 都需 cookie + Referer + 可能 X-Token CSRF header
- 导出是异步任务（请求 → 轮询 → 下载），实测耗时 5-15s
- 文件下载用独立 CDN 域，CDN 404 是 transient（不是文档不存在）
- 接口可能变 — 若 schema 不匹配，重跑 reconnaissance 脚本（已删除，从 plan task 1 复制）
```

- [ ] **Step 2: 更新 MEMORY.md 索引**

在 `## Project（当前状态）` 节下，按字母 / 主题序追加：

```markdown
- [docs.qq.com 4 个 endpoint 实测](project_docs_qq_endpoints.md) — 元数据 / 导出发起 / 任务轮询 / 文件下载；接口可能变重跑 recon
```

- [ ] **Step 3: BACKLOG.md 更新 §6.xx**

在 `docs/superpowers/BACKLOG.md` 找到 `## 6. 已落地经验` 节，追加：

```markdown
### 6.26 docs.qq.com extractor 落地 (2026-05-26)

**问题**：腾讯文档 `https://docs.qq.com/doc/<token>` 走 Defuddle 默认通路产物极差
（SPA + contenteditable 渲染，跟早期飞书同类）。

**方案**：cookie 路径 + 导出 .docx 接口 + mammoth.js 转 HTML + 现有 turndown
pipeline。content.ts runtime 调（自动带 cookie/CSRF/Referer），错误一律 throw 由
content.ts catch 进 extractorWarnings 显示 banner。

**关键决策**：
- URL 范围仅 /doc/<token>（MVP），sheet/slide/etc. 留 v2
- 导出 .docx 而非 .md：腾讯生成 markdown 是会员功能且格式不可控
- mammoth + mathml-to-latex 动态 import + webpack splitChunks 分到
  mammoth-vendor chunk（其他页面零开销）
- 公式 MathML → LaTeX 在 HTML 阶段做，turndown 不动公式

**ship gate**：
- T5-1: vitest 100% PASS
- T5-2: e2e <N 个 fixture> PASS + audit-extractor-ship 10 项 checklist 全 PASS
- T5-3: build + hot reload + 手工裁 1 个真 URL 写入 Obsidian.app 通过
- T5-4: 本节 + memory project_docs_qq_endpoints.md 更新

**风险**：
- 腾讯反爬变动 → endpoint 不变情况下重 reconnaissance
- bundle size +280KB（在 mammoth-vendor chunk，不影响其它页面）

**相关文件**：
- spec: `docs/superpowers/specs/2026-05-26-docs-qq-extractor-design.md`
- plan: `docs/superpowers/plans/2026-05-26-docs-qq-extractor.md`
- recon: `docs/superpowers/specs/2026-05-26-docs-qq-extractor-recon.md`
- code: `src/utils/docs-qq-extractor.ts`
- test: `src/utils/docs-qq-extractor.test.ts` + `*.e2e.test.ts`
```

- [ ] **Step 4: Commit 文档 + ship**

```bash
git add -f docs/superpowers/BACKLOG.md docs/superpowers/plans/2026-05-26-docs-qq-extractor.md
git commit -m "$(cat <<'EOF'
docs(BACKLOG): §6.26 docs.qq.com extractor 落地经验

新增 docs.qq /doc/ 类型专项 extractor 的落地总结：cookie + 导出 .docx +
mammoth + 公式后处理。webpack splitChunks 分包避免影响其它页面。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 5: 抢 ship 锁 + 合 main + push（按 feedback_ship_lock_mechanism）**

如 plan 是在 worktree 里执行，按 [[feedback_ship_lock_mechanism]] FIFO 抢锁 + rsync dist/ → main + push → 释锁。

如不是 worktree（直接 main 上跑），跳过锁机制：

```bash
git push origin main
```

- [ ] **Step 6: 报阿杜验收**

```
✅ docs.qq.com extractor 已 ship 到 main (commit <hash>)

✓ T5-1: vitest 100% PASS
✓ T5-2: e2e N/N PASS + audit-extractor-ship 10/10 checklist PASS
✓ T5-3: build + hot reload + 手工真 URL 写入 Obsidian.app 验收通过
✓ T5-4: BACKLOG §6.26 + memory project_docs_qq_endpoints 更新

请验收，回 "通过" 我做收尾（worktree 清理 / 经验沉淀）。
```

---

## Self-Review（plan 完成后自查）

### Spec coverage check

| Spec 要求 | Plan task |
|----------|----------|
| §3 数据流 / 设计原则 | Task 5-12 落实 |
| §4 文件结构 | Task 3-15 |
| §5.1 URL routing | Task 3 |
| §5.2 endpoint reconnaissance | Task 1 |
| §6.1 happy path 编排 | Task 11 |
| §6.2 错误分类 5 类 | Task 4 + 5-8 |
| §6.3 防御性约束（timeout / size / retry） | Task 5 (fetchWithTimeout) + 8 (DOWNLOAD_SIZE_LIMIT) |
| §7 公式 MathML → LaTeX | Task 10 |
| §8 frontmatter 元数据 | Task 11 (ContentResponse cascade via Task 12) |
| §9 Webpack 分包 | Task 2 |
| §10.1 unit test | Task 3-11（每 task 5-step TDD） |
| §10.2 e2e test | Task 14-15 |
| §10.3 ship-gate T5-1..4 | Task 16-17 |
| §11 风险 | covered by error handling + recon docs |
| §12 实施顺序 | Task 1-17 顺序对齐 |

### Placeholder scan

- ✅ `<META_URL_TEMPLATE>` / `<EXPORT_REQUEST_URL>` 等 endpoint 占位符 — 这些指向 recon.md 真实值，task 5-8 step 1 都要求"从 recon.md 抄"。这不是 plan-failure placeholder，是延迟绑定。
- ✅ `<阿杜提供>` fixture URL — task 15 step 1 显式要求阿杜提供，并标 fallback（如来不及给就用 task 14 第 1 个）
- ✅ 无 TBD / TODO / "fill in details"

### Type / 函数签名一致性

- ✅ `extractDocsQQContent(opts: DocsQQExtractOpts): Promise<DocsQQStructuredContent>` 跨 task 4 / 11 / 12 一致
- ✅ `fetchDocMetadata(token: string): Promise<DocsQQMetadata>` 跨 task 5 / 11 一致
- ✅ `pollExportStatus(operationId, opts)` 跨 task 7 / 11 一致
- ✅ `convertDocxToHtml(arrayBuffer: ArrayBuffer): Promise<string>` 跨 task 9 / 11 一致
- ✅ `postProcessHtml(rawHtml: string): Promise<string>` 跨 task 10 / 11 一致
- ✅ Error 子类（5 类）跨 task 4 / 5-8 一致

### Scope check

- ✅ 单 spec / 单 plan 可执行，17 个 task 自包含
- ✅ task 1 reconnaissance 是 explicitly self-contained，产 recon.md
- ✅ 不依赖其他未交付组件

Self-review 通过。
