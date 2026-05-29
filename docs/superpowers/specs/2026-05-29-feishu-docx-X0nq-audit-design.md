# 飞书 docx X0nq 裁剪 audit + 修复 设计

**日期**：2026-05-29
**主分支基线**：`113dbff`
**触发**：阿杜 `https://pcn5ogco2cwh.feishu.cn/docx/X0nqdaz4Fo7GYNx0JbLcvhHln6b "看下这个页面的裁剪效果，优化到符合预期"`

## 1. 目标

1. 把这个 docx 的当前飞书 extractor 输出跟浏览器原页做视觉 audit，列出所有不符合预期的差异
2. 跟阿杜对齐修复列表，逐项修复
3. ship 到 main + dist/

## 2. 前置障碍

`audit-extractor-ship` skill 要求 markdown 文件已存在于 vault。当前两个 gap：

- **gap A**：飞书 e2e bridge 已 wire 进 `src/content.ts` (L725-727)，但 `scripts/e2e-clip-runner.ts` 的 launchPersistentContext 是 fresh profile，无 `feishu_settings`（appId/appSecret），background 拿不到 tenant token → 401 → bridge fail
- **gap B**：没有 `src/utils/feishu-extractor.e2e.test.ts`（scys / weixin / xiaoyuzhou / docs-qq 都有，飞书空缺）

## 3. 解决方案

### 3.1 e2e infra 飞书化

`scripts/e2e-clip-runner.ts` 的 `ClipOptions` 加：

```ts
feishuSettings?: { appId: string; appSecret: string };
```

`launchPersistentContext` 后：

```ts
if (opts.feishuSettings) {
  const sw = await Promise.race([
    context.waitForEvent('serviceworker', { timeout: 10_000 }),
    new Promise<ServiceWorker>((_, rej) =>
      setTimeout(() => rej(new Error('background SW not ready within 10s')), 10_000)),
  ]);
  await sw.evaluate(async (s) => {
    await chrome.storage.local.set({ feishu_settings: s });
  }, opts.feishuSettings);
}
```

`scripts/dump-clip.ts` 加 `--feishu-creds <path>` flag：

- 默认 `docs/superpowers/feishu.md`
- 文件格式（现有 `docs/superpowers/feishu.md`）：

  ```
  id: cli_a9074898cdf8dcba

  secret: 0QROagPABopp5iiWLIxBxdMDBJ0DyWtX
  ```

- 解析：grep `id:` / `secret:` 两行，trim value
- 缺文件 → warning 不报错（保留非飞书路径不破坏）

### 3.2 feishu-extractor.e2e.test.ts 新建

文件：`src/utils/feishu-extractor.e2e.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { runRealClip } from '../../scripts/e2e-clip-runner';

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

风格仿 `src/utils/scys-extractor.e2e.test.ts` / `src/utils/weixin-extractor.e2e.test.ts`。

### 3.3 markdown 落 vault → audit

- e2e test 通过后手动复制 `/tmp/clip-md.txt` 到 `Life/_cn-test/feishu-X0nq-audit.md`（用 `scripts/dump-clip.ts` 跑一次，dump-clip 已经写 `/tmp/clip-md.txt`）
- 跑 `scripts/audit-prepare.sh Life _cn-test/feishu-X0nq-audit URL --run-id $RUN_ID`
- 派 subagent 分片对比（每 ≤7 grid），用 `audit-extractor-ship` skill 自带的 10 项 checklist
- 输出 REPORT.md

### 3.4 跟阿杜对齐修复列表

- paste REPORT.md → 阿杜决定哪些 diff 要修
- 每个修复点：
  - 必要时加 fixture 到 `src/utils/fixtures/` + unit test
  - 改 `src/utils/feishu-extractor.ts`
  - `npx vitest run feishu-extractor`
  - 重跑 audit verify PASS

### 3.5 ship

按 ship 锁机制：worktree build → 抢 `.ship-lock.json` → rsync `dist/` 到 main → 报验收 → 阿杜回"通过"才合 main + push + 释锁。

## 4. 风险点

- **飞书 OpenAPI 凭据 (`cli_a9074898cdf8dcba`) tenant 不一定能访问 `pcn5ogco2cwh.feishu.cn` 这个 tenant 的文档**：跨 tenant 调用会被飞书拒绝（403/404）。若 e2e fail，退化为阿杜手工裁剪一次（最小子集），后续 audit 路径不变
- **MV3 service worker 不一定立即触发 `serviceworker` event**：装好 `--load-extension` 后 chrome 启动可能有 1-2s 延迟。`waitForEvent` 加 10s timeout 保护
- **e2e 跑这一个 URL 大约 60-120s（含浏览器启动）**：纳入 `npm run test:e2e` 后总耗时会增加，但仍在阿杜可接受范围（参 [[feedback_extractor_acceptance]] dev/ship 分轨）

## 5. 范围排除

- 不重写 feishu extractor 架构（仅按 audit 报告修单点 bug）
- 不改飞书凭据管理机制（仍走 `docs/superpowers/feishu.md` git-ignored 文件）
- 不加 multi-tenant 凭据支持（一个 tenant 一份凭据，本仓库当前模式）

## 6. 验收

- e2e: `npx vitest run --config vitest.e2e.config.ts src/utils/feishu-extractor.e2e.test.ts` PASS
- audit: `/tmp/audit-$RUN_ID/REPORT.md` 全 PASS（或阿杜明确接受残留 diff）
- 浏览器手动验证：4 层对齐（Obsidian Reading View vs 浏览器原页 vs e2e markdown vs vitest test）
