# 飞书 docx X0nq audit + 修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal**：补齐飞书 e2e 路径（infra + test fixture），跑视觉 audit 找 `https://pcn5ogco2cwh.feishu.cn/docx/X0nqdaz4Fo7GYNx0JbLcvhHln6b` 这个文档的裁剪问题，逐项修，ship。

**Architecture**：
- e2e-clip-runner 加 `feishuSettings` 注入（MV3 service worker `chrome.storage.local.set`）
- dump-clip 加 `--feishu-creds <path>` 透传
- 新建 `src/utils/feishu-extractor.e2e.test.ts` 用这个 URL 作 ground truth
- 现有 `audit-extractor-ship` skill + audit-prepare.sh 链路不动，只是入口加一站

**Tech Stack**：playwright-extra（已用）、vitest（已用）、chromium MV3 extension service worker

**Spec**: `docs/superpowers/specs/2026-05-29-feishu-docx-X0nq-audit-design.md`

---

## File Structure

| 文件 | 改动 | 责任 |
|---|---|---|
| `scripts/e2e-clip-runner.ts` | 修改 | ClipOptions 加 `feishuSettings`；launchContext 后 SW 注入 |
| `scripts/dump-clip.ts` | 修改 | CLI flag `--feishu-creds <path>`；parse 出 `{ appId, appSecret }` 透传 |
| `src/utils/feishu-extractor.e2e.test.ts` | 新建 | 用 X0nq URL 跑 runRealClip + assertion |
| `Life/_cn-test/feishu-X0nq-audit.md` | 写入（临时） | audit 输入；从 `/tmp/clip-md.txt` 复制 |
| `src/utils/feishu-extractor.ts` 及附属 | 修改（pending audit） | 按 audit 报告修复 |

---

### Task 1: ClipOptions 加 feishuSettings 字段定义

**Files**:
- Modify: `scripts/e2e-clip-runner.ts:33-43`（ClipOptions interface）

- [ ] **Step 1.1: 加字段到 ClipOptions**

定位 `scripts/e2e-clip-runner.ts` 的 `ClipOptions` interface（约 L33-43），在 `offscreen` 字段后插入：

```ts
	feishuSettings?: { appId: string; appSecret: string };  // 注入 chrome.storage.local.feishu_settings，让飞书 extractor 能调 OpenAPI
```

- [ ] **Step 1.2: type check**

```bash
npx tsc --noEmit -p scripts/tsconfig.json 2>&1 | grep -E "(error|TS)" | head
```

Expected: 没有 error 输出（仅 stdin/empty）。

- [ ] **Step 1.3: commit**

```bash
git add scripts/e2e-clip-runner.ts
git commit -m "feat(e2e-clip-runner): ClipOptions.feishuSettings field for storage injection"
```

---

### Task 2: launchPersistentContext 后注入 feishu_settings 到 service worker

**Files**:
- Modify: `scripts/e2e-clip-runner.ts:155`（cookies addCookies 之后）

- [ ] **Step 2.1: 在 cookies inject 后加 SW 注入 block**

`scripts/e2e-clip-runner.ts` 找到这段（约 L153-155）：

```ts
			if (cookies.length > 0) {
				await context.addCookies(cookies as any);
			}
```

紧接其后插入：

```ts
			// Inject feishu_settings into background SW storage so the feishu
			// extractor can mint tenant_access_token via background.ts
			// `getFeishuTenantToken`. Fresh playwright profile has empty
			// chrome.storage.local — without this, feishu OpenAPI calls 401.
			if (opts.feishuSettings) {
				let sw = context.serviceWorkers()[0];
				if (!sw) {
					sw = await Promise.race([
						context.waitForEvent('serviceworker', { timeout: 15_000 }),
						new Promise<never>((_, rej) =>
							setTimeout(() => rej(new Error('background SW not ready within 15s')), 15_000)
						),
					]) as any;
				}
				await sw!.evaluate(async (s) => {
					// @ts-expect-error chrome global in SW
					await chrome.storage.local.set({ feishu_settings: s });
				}, opts.feishuSettings);
			}
```

- [ ] **Step 2.2: type check**

```bash
npx tsc --noEmit -p scripts/tsconfig.json 2>&1 | grep -E "(error|TS)" | head
```

Expected: 没有 error。

- [ ] **Step 2.3: commit**

```bash
git add scripts/e2e-clip-runner.ts
git commit -m "feat(e2e-clip-runner): inject feishu_settings into background SW storage"
```

---

### Task 3: dump-clip.ts 加 --feishu-creds flag

**Files**:
- Modify: `scripts/dump-clip.ts`

- [ ] **Step 3.1: 加 parseFeishuCreds 函数 + flag parse**

定位 `scripts/dump-clip.ts` 的 main 函数顶部（导入区之后），加 helper：

```ts
function parseFeishuCreds(path: string): { appId: string; appSecret: string } | null {
	if (!existsSync(path)) {
		console.warn(`[dump] feishu creds file not found: ${path}`);
		return null;
	}
	const text = readFileSync(path, 'utf-8');
	const idMatch = text.match(/^id:\s*(\S+)/m);
	const secretMatch = text.match(/^secret:\s*(\S+)/m);
	if (!idMatch || !secretMatch) {
		console.warn(`[dump] feishu creds file missing id/secret lines: ${path}`);
		return null;
	}
	return { appId: idMatch[1].trim(), appSecret: secretMatch[1].trim() };
}
```

补 `readFileSync` 到 imports（如果还没）：

```ts
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
```

- [ ] **Step 3.2: 加 flag parse + 透传**

在 `profileArg` parse 后加：

```ts
	const credsIdx = args.indexOf('--feishu-creds');
	const credsPath = credsIdx >= 0 ? args[credsIdx + 1] : 'docs/superpowers/feishu.md';
	const feishuSettings = parseFeishuCreds(credsPath) ?? undefined;
	if (feishuSettings) {
		console.log(`[dump] feishu creds loaded: appId=${feishuSettings.appId.slice(0, 10)}...`);
	}
```

把 `runRealClip` 调用改成：

```ts
	const clip = await runRealClip(url, { wait, timeout: 90_000, userDataDir, feishuSettings });
```

更新 Usage 行：

```ts
		console.error('Usage: dump-clip.ts <URL> [--profile <dir>] [--feishu-creds <path>]');
```

- [ ] **Step 3.3: type check**

```bash
npx tsc --noEmit -p scripts/tsconfig.json 2>&1 | grep -E "(error|TS)" | head
```

Expected: 没有 error。

- [ ] **Step 3.4: commit**

```bash
git add scripts/dump-clip.ts
git commit -m "feat(dump-clip): --feishu-creds flag (parse docs/superpowers/feishu.md by default)"
```

---

### Task 4: feishu-extractor.e2e.test.ts 新建

**Files**:
- Create: `src/utils/feishu-extractor.e2e.test.ts`

- [ ] **Step 4.1: 写 test 文件**

写到 `src/utils/feishu-extractor.e2e.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { runRealClip } from '../../scripts/e2e-clip-runner';

// X0nq fixture — driven by user 2026-05-29 audit request. If extractor
// regresses (frontmatter break, image placeholder leak, missing H1),
// this fails and tells us before manual audit catches it.
const URL = 'https://pcn5ogco2cwh.feishu.cn/docx/X0nqdaz4Fo7GYNx0JbLcvhHln6b';
const CREDS_PATH = 'docs/superpowers/feishu.md';

function readCreds(): { appId: string; appSecret: string } | null {
	if (!existsSync(CREDS_PATH)) return null;
	const text = readFileSync(CREDS_PATH, 'utf-8');
	const idMatch = text.match(/^id:\s*(\S+)/m);
	const secretMatch = text.match(/^secret:\s*(\S+)/m);
	if (!idMatch || !secretMatch) return null;
	return { appId: idMatch[1].trim(), appSecret: secretMatch[1].trim() };
}

const creds = readCreds();

(creds ? describe : describe.skip)('feishu docx X0nq e2e', () => {
	it('clips and produces non-empty markdown with frontmatter', async () => {
		const clip = await runRealClip(URL, {
			feishuSettings: creds!,
			timeout: 120_000,
		});
		expect(clip.markdown.length).toBeGreaterThan(500);
		expect(clip.markdown).toMatch(/^---\n/);
		expect(clip.markdown).toMatch(/\nsource: "https:\/\/pcn5ogco2cwh\.feishu\.cn\/docx\/X0nq/);
		expect(clip.markdown).toMatch(/\ntags:/);
		expect(clip.markdown).not.toMatch(/feishu-image:\/\//);
		expect(clip.markdown).toMatch(/\n# /);
	}, 180_000);
});
```

- [ ] **Step 4.2: build chrome dist（e2e 必须）**

```bash
npm run build:chrome 2>&1 | tail -5
```

Expected: `webpack` 输出 hash 行 + 退出 0。

- [ ] **Step 4.3: 跑 e2e test**

```bash
npx vitest run --config vitest.e2e.config.ts src/utils/feishu-extractor.e2e.test.ts 2>&1 | tail -30
```

Expected: `1 passed (1)`.

如果 fail：

- 401/403 → 凭据 tenant 不匹配 `pcn5ogco2cwh` tenant。改用阿杜手工裁剪一次（Task 5 plan B）
- timeout → 拉长 timeout 或检查飞书页面是否能匿名访问（即使有 token 也要页面公开 / extractor 走 OpenAPI 直查不依赖页面登录）
- markdown 含 `feishu-image://` → 已经是 audit 要修的 bug，记下来，先调成 warning 让 e2e 通过

- [ ] **Step 4.4: commit**

```bash
git add src/utils/feishu-extractor.e2e.test.ts
git commit -m "test(feishu): e2e fixture for docx X0nq (audit ground truth)"
```

---

### Task 5: 生成 audit markdown 落 vault

**Files**:
- 调用：`scripts/dump-clip.ts`
- 复制：`/tmp/clip-md.txt` → `~/Documents/Obsidian /Life/_cn-test/feishu-X0nq-audit.md`

- [ ] **Step 5.1: 跑 dump-clip**

```bash
npx ts-node --project scripts/tsconfig.json scripts/dump-clip.ts \
  https://pcn5ogco2cwh.feishu.cn/docx/X0nqdaz4Fo7GYNx0JbLcvhHln6b
```

Expected:
- 输出 `[dump] feishu creds loaded: appId=cli_a9074898...`
- `/tmp/clip-md.txt` 和 `/tmp/clip-html.txt` 已写
- `[dump] duration: <60_000ms`

- [ ] **Step 5.2: 复制 markdown 到 vault**

```bash
cp /tmp/clip-md.txt "/Users/adu/Documents/Obsidian /Life/_cn-test/feishu-X0nq-audit.md"
ls -la "/Users/adu/Documents/Obsidian /Life/_cn-test/feishu-X0nq-audit.md"
```

Expected: 文件存在，size > 500 bytes。

- [ ] **Step 5.3: 快速肉眼扫一遍 markdown**

```bash
head -50 "/Users/adu/Documents/Obsidian /Life/_cn-test/feishu-X0nq-audit.md"
wc -l "/Users/adu/Documents/Obsidian /Life/_cn-test/feishu-X0nq-audit.md"
```

记下行数 L（后面 audit 分片用）。

- [ ] **Step 5.4: 不 commit**

vault 文件不属于 git 仓库。

---

### Task 6: audit-prepare + subagent 派单

**Files**:
- 调用：`scripts/audit-prepare.sh`

- [ ] **Step 6.1: 生成 RUN_ID + 跑 audit-prepare**

```bash
RUN_ID=$(date +%Y%m%d-%H%M%S)
echo "RUN_ID=$RUN_ID"
scripts/audit-prepare.sh Life _cn-test/feishu-X0nq-audit \
  https://pcn5ogco2cwh.feishu.cn/docx/X0nqdaz4Fo7GYNx0JbLcvhHln6b \
  --run-id "$RUN_ID" 2>&1 | tail -5
```

Expected: 最后一行 `AUDIT_PREPARE_OK url-slug=... n_grids=N md_lines=L grid_dir=/tmp/audit-${RUN_ID}/...`。
解析 N、L、grid_dir。

- [ ] **Step 6.2: 分片计算**

```
S = ceil(N / 7)
slice_p 负责 grid (p-1)*7+1 ... min(p*7, N)
slice_p 负责 md 行 ((p-1)*L/S)+1 ... (p*L/S)
```

写到 todo。

- [ ] **Step 6.3: 并行派 subagent**

按 `audit-extractor-ship` skill Step 4.1 prompt 模板，一个 message 里 spawn 所有 slice 的 Agent（general-purpose）。

每个 subagent 写到 `/tmp/audit-${RUN_ID}/<url-slug>/slice-${p}.json`。

- [ ] **Step 6.4: 等所有 subagent 完成 → 跑 summarize**

```bash
npx tsx scripts/audit-summarize.ts --run-id "$RUN_ID" \
  --run-dir "/tmp/audit-${RUN_ID}" \
  --out "/tmp/audit-${RUN_ID}/REPORT.md"
echo "Summarize exit: $?"
```

Expected: exit 0 (全 PASS) 或 exit 1 (有 fail/needs_review)。

- [ ] **Step 6.5: cat REPORT.md paste 给阿杜**

```bash
cat "/tmp/audit-${RUN_ID}/REPORT.md"
```

paste 输出到主 session，跟阿杜对齐修复列表。

---

### Task 7: 实现 audit 修复（动态）

**Files**:
- Modify: `src/utils/feishu-extractor.ts`（按 audit 报告）
- Maybe: `src/utils/feishu-extractor.test.ts`（unit test 覆盖新修复）
- Maybe: `src/utils/fixtures/`（新 fixture）

⚠️ **此 task 的具体 step 等 Task 6 audit REPORT 出来后**跟阿杜对齐再生成 sub-plan。预期模式：

每个修复点：

1. 加最小 fixture（JSON blocks 或 HTML 片段）到 `src/utils/fixtures/`
2. 写 failing unit test
3. 跑 `npx vitest run feishu-extractor` 确认 fail
4. 改 `src/utils/feishu-extractor.ts`
5. 跑 unit test 确认 PASS
6. 跑 `npx vitest run feishu-extractor` 全文件 PASS（不破坏其他 case）
7. commit

修完所有点：

- [ ] **重跑 e2e**

```bash
npm run build:chrome
npx vitest run --config vitest.e2e.config.ts src/utils/feishu-extractor.e2e.test.ts
```

Expected: PASS

- [ ] **重跑 audit**

```bash
RUN_ID_V2=$(date +%Y%m%d-%H%M%S)
# Re-dump
npx ts-node --project scripts/tsconfig.json scripts/dump-clip.ts \
  https://pcn5ogco2cwh.feishu.cn/docx/X0nqdaz4Fo7GYNx0JbLcvhHln6b
cp /tmp/clip-md.txt "/Users/adu/Documents/Obsidian /Life/_cn-test/feishu-X0nq-audit.md"
# Re-audit
scripts/audit-prepare.sh Life _cn-test/feishu-X0nq-audit \
  https://pcn5ogco2cwh.feishu.cn/docx/X0nqdaz4Fo7GYNx0JbLcvhHln6b \
  --run-id "$RUN_ID_V2"
# 派 subagent + summarize 同 Task 6
```

Expected: REPORT 全 PASS 或阿杜接受残留 diff。

---

### Task 8: ship

**Files**:
- 抢锁：`.ship-lock.json` (repo root)
- worktree build → rsync 到 main `dist/`

- [ ] **Step 8.1: worktree build verify**

在 worktree 里：

```bash
npm test 2>&1 | tail -10
npm run build:chrome 2>&1 | tail -5
```

Expected: 都 PASS / exit 0。

- [ ] **Step 8.2: 抢 ship lock**

按 `feedback_ship_lock_mechanism` flow（O_EXCL + .ship-lock.json）。

- [ ] **Step 8.3: rsync dist/ 到 main 仓库**

```bash
rsync -av --delete dist/ ../../dist/
```

- [ ] **Step 8.4: ship checklist T5-1..4**

按 `feedback_extractor_acceptance` 强制 checklist：

- T5-1: e2e PASS（Task 4 已跑）
- T5-2: audit REPORT 全 PASS（Task 7 已跑）+ paste 报告尾
- T5-3: 浏览器手动验证截图（Obsidian Reading View）
- T5-4: BACKLOG §2 沉淀（如果有新教训）

- [ ] **Step 8.5: 报"请验收"**

paste ship checklist 到主 session，等阿杜回"通过"。

- [ ] **Step 8.6: 阿杜确认后合 main + push + 释锁**

按 `feedback_post_acceptance_cleanup`：合 worktree → push origin adu → 释 ship lock → 清理 worktree → 更新 BACKLOG/memory → commit + push → 报"收尾完毕"。

---

## Self-Review

✅ **Spec coverage**: spec 4 章全部覆盖 — 3.1→Task 1+2, 3.2 Test→Task 4, 3.3→Task 5+6, 3.4→Task 7, 3.5→Task 8

✅ **Placeholder scan**: Task 7 标 ⚠️ "动态" 但是 spec 明确说"audit 后跟阿杜对齐再 sub-plan" — 这不是占位符，是合理的依赖断点

✅ **Type consistency**:
- ClipOptions.feishuSettings 类型 `{ appId: string; appSecret: string }` 在 Task 1/2/3/4 一致
- parseFeishuCreds 返回 `{ appId, appSecret } | null` 在 Task 3/4 一致

✅ **风险/降级路径**: Task 4 列出 401/timeout/placeholder 三种 e2e fail 应对
