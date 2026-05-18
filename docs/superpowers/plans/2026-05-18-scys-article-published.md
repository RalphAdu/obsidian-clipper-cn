# scys 文章裁剪补全 `published` frontmatter 字段 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** scys `/articleDetail/xq_topic/{id}` 裁剪笔记的 frontmatter 补上 `published` 字段（YYYY-MM-DD 本地时区）；顺便把 zsxq 内手写日期格式化对齐到共享的 `convertDate`。

**Architecture:** API → `gmtCreate` (unix sec) → `new Date(× 1000)` → `convertDate(d)` → `published` 字段 → `content.ts` 合并入 `ContentResponse` → Obsidian frontmatter。两个 extractor (scys/zsxq) 都通过同一个 `convertDate(date, 'YYYY-MM-DD')` 完成日期格式化。

**Tech Stack:** TypeScript, vitest, webextension-polyfill, dayjs (已存在 `src/utils/date-utils.ts`)。

**Spec:** `docs/superpowers/specs/2026-05-18-scys-article-published-design.md`

---

## File Structure

| 文件 | 职责 | 改动类型 |
|---|---|---|
| `src/utils/scys-extractor.ts` | scys 内容提取 | (a) 接口加 `published: string`；(b) article 路径填 `gmtCreate` 格式化值；(c) course/docx 路径填 `''`；(d) import `convertDate` |
| `src/utils/scys-extractor.test.ts` | scys 提取测试 | (a) article published 断言；(b) course/docx published 断言；(c) import `convertDate` |
| `src/utils/zsxq-extractor.ts` | zsxq 内容提取 | `buildZsxqPublished` 内部 5 行手写 → 1 行 `convertDate`；import `convertDate` |
| `src/content.ts` | 内容脚本入口 | line 376 的 `published` 合并表达式加入 `scysContent?.published`（位置在 `zsxqContent?.published` 之前） |

---

## Task 1: scys 三条路径补全 published 字段（TDD）

**Files:**
- Modify: `src/utils/scys-extractor.ts:501-506`（接口）、`546-609`（course/docx return）、`822-893`（article return）、文件顶部（import）
- Test: `src/utils/scys-extractor.test.ts:1379-1404`（修改现有 article 测试加 published 断言）、新增 course/docx published 断言

### Step 1.1: 修改测试，在 article 主成功测试里加 published 断言（先失败）

`src/utils/scys-extractor.test.ts` 文件顶部已有 import 块，在合适位置加 `convertDate` 引用：

- [ ] **Step 1.1.1: 在 `src/utils/scys-extractor.test.ts` 顶部 import 区加 `convertDate`**

找到现有的 `import { extractScysStructuredContent, preprocessScysEntityHtml } from './scys-extractor';`（line 740 附近），在它**下面**加一行：

```ts
import { convertDate } from './date-utils';
```

- [ ] **Step 1.1.2: 在 `scys-extractor.test.ts:1399-1404` 的 article 主测试 `r` 断言块末尾追加 published 断言**

定位到 `it('returns content+title+author when topicDetail succeeds (comments optional)', ...)`（line 1379），找到其中的 `const r = await extractScysStructuredContent(doc);`（line 1399）下面的断言块。这个测试的 mock 数据里 `gmtCreate: 1762503084` 已经存在（line 1389）。

在已有 `expect(r?.content).not.toContain('💬 评论');`（line 1403）下面追加：

```ts
		expect(r?.published).toBe(convertDate(new Date(1762503084 * 1000)));
```

**为什么不硬编码 `'2025-11-07'`？** CI 时区不可控；用 `convertDate(new Date(...))` 计算期望值，跟实现走同一时区路径，避免 CI 时区抖动导致测试假性失败。

- [ ] **Step 1.1.3: 在 article 主测试同一个 `describe` 块里新增 course/docx published 断言**

scys 现有测试结构里 course/docx 测试在 `describe('extractScysStructuredContent (orchestration)', ...)`（line 742）。但用 fixture 真实数据测会触发整个 chapter fetch 链，太重。

简化做法：在 `describe('extractScysStructuredContent — article route', ...)`（line 1369）的 `it('returns null when topicDetail fails', ...)` 之后，新增一个**专门测 published 空值边界**的用例：

```ts
	it('returns published="" when gmtCreate is 0/missing', async () => {
		global.fetch = vi.fn().mockImplementation((url: any) => {
			if (String(url).includes('topicDetail')) {
				return Promise.resolve({ ok: true, json: () => Promise.resolve({
					success: true, data: {
						topicDTO: {
							entityId: '2', entityType: 'xq_topic', showTitle: 'No Date',
							docBlocks: [
								{ block_id: 'b1', block_type: 2, text: { elements: [{ text_run: { content: 'x' } }] } } as any,
							],
							gmtCreate: 0, commentsCount: 0, likeCount: 0, readingCount: 0,
						},
						topicUserDTO: { name: 'T' },
					},
				}) } as any);
			}
			return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: { total: 0, items: [] } }) } as any);
		});
		const doc = { URL: 'https://scys.com/articleDetail/xq_topic/2' } as Document;
		const r = await extractScysStructuredContent(doc);
		expect(r?.published).toBe('');
	});
```

**为什么不专门测 course/docx 路径？** 这两条路径的 `published: ''` 是硬编码空字符串，无业务逻辑可测；类型系统保证字段存在（必填 string）即可，单元测试反而是空操作。spec §4.1 提到的"course/docx 路径的断言：`result.published === ''`"在此处用 article 路径的 `gmtCreate: 0` 边界统一覆盖（同样走 `convertDate` 入口的 falsy 短路）。

- [ ] **Step 1.1.4: 运行测试，确认失败**

```bash
npx vitest run src/utils/scys-extractor.test.ts -t "returns content\+title\+author when topicDetail succeeds"
```

期望失败：`expect(r?.published).toBe(...)` —— `r?.published` 是 `undefined`，因为接口尚未声明该字段。

### Step 1.2: 在 scys-extractor.ts 实现 published 字段

- [ ] **Step 1.2.1: 在 `src/utils/scys-extractor.ts` 顶部 import 区加 `convertDate`**

文件顶部已有若干 `import` 行，在与其他工具 import 一致的位置（例如紧邻其他 `./xxx-utils` 引用）追加：

```ts
import { convertDate } from './date-utils';
```

- [ ] **Step 1.2.2: 扩展 `ScysStructuredContent` 接口（line 501）**

将：

```ts
export interface ScysStructuredContent {
	title: string;
	author: string;
	content: string;
	wordCount: number;
}
```

替换为：

```ts
export interface ScysStructuredContent {
	title: string;
	author: string;
	content: string;
	wordCount: number;
	/** Article publish date as YYYY-MM-DD (from topicDTO.gmtCreate unix seconds).
	 *  Empty string for course/docx paths (no publish-time semantics). */
	published: string;
}
```

- [ ] **Step 1.2.3: `extractScysCourseChapter` 返回 published**

定位到 `extractScysCourseChapter`（line 546-579 附近）的 return 语句，加入 `published: ''`。例如末尾的 return 形如：

```ts
	return { title: chapter.title, author: '', content: html, wordCount };
```

改为：

```ts
	return { title: chapter.title, author: '', content: html, wordCount, published: '' };
```

如果 `extractScysCourseChapter` 内部有多个 return，每个都需加 `published: ''`。

- [ ] **Step 1.2.4: `extractScysDocxStandalone` 返回 published**

定位到 line 609 附近的 return：

```ts
	return { title, author: '', content: html, wordCount };
```

改为：

```ts
	return { title, author: '', content: html, wordCount, published: '' };
```

如果该函数内部有多个 return，每个都需加 `published: ''`。

- [ ] **Step 1.2.5: `extractScysArticleStandalone` 返回 published（line 887-892 附近）**

定位到 article 路径末尾的 return：

```ts
	return {
		title: detail.showTitle,
		author: detail.authorName,
		content: html,
		wordCount,
	};
```

替换为：

```ts
	const published = detail.gmtCreate
		? convertDate(new Date(detail.gmtCreate * 1000))
		: '';

	return {
		title: detail.showTitle,
		author: detail.authorName,
		content: html,
		wordCount,
		published,
	};
```

**边界**：`detail.gmtCreate` 在 `fetchScysArticleDetail` 中已 `?? 0`（line 703），falsy 时为 0；`0` 触发短路返回 `''`。

- [ ] **Step 1.2.6: 运行测试，确认通过**

```bash
npx vitest run src/utils/scys-extractor.test.ts
```

期望：

- `returns content+title+author when topicDetail succeeds (comments optional)` 通过（含新的 `published` 断言）
- `returns published="" when gmtCreate is 0/missing` 通过
- 其余 scys 测试全部通过（接口扩展不应影响已有测试，因为已有断言不读 `published`）

- [ ] **Step 1.2.7: 跑 TypeScript 编译，确认无未覆盖的 return**

```bash
npx tsc --noEmit
```

期望：无报错。若有 `TS2322: Property 'published' is missing in type '{...}' but required` 类报错，说明某个 return 漏加 `published`，按报错路径补齐。

- [ ] **Step 1.2.8: 提交**

```bash
git add src/utils/scys-extractor.ts src/utils/scys-extractor.test.ts
git commit -m "$(cat <<'EOF'
feat(scys): article 路径补全 published frontmatter 字段

ScysStructuredContent 加 published: string 必填字段；article 路径用
convertDate(new Date(gmtCreate * 1000)) 格式化为 YYYY-MM-DD（本地时
区）；course/docx 路径填空字符串（无创建时间语义）。

修复 scys.com /articleDetail/xq_topic/{id} 裁剪笔记 frontmatter
published 字段为空的问题。API 早已返回 gmtCreate（unix seconds），
extractor 没透传。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: zsxq `buildZsxqPublished` 改用 `convertDate`

**Files:**
- Modify: `src/utils/zsxq-extractor.ts:694-702`、文件顶部（import）

**说明**：这是行为等价的 refactor。`buildZsxqPublished` 当前手写的 `getFullYear/padStart` 与 `convertDate`（dayjs `YYYY-MM-DD`）在所有时区下都给同一结果（两者都基于本地 Date 字段）。zsxq 现有测试不直接断言 `published` 字段值（grep 验证），所以本任务不"先红再绿"，而是 refactor + 跑全套确认不破坏。

- [ ] **Step 2.1: 在 `src/utils/zsxq-extractor.ts` 顶部 import 区加 `convertDate`**

文件顶部已有若干 import，追加：

```ts
import { convertDate } from './date-utils';
```

- [ ] **Step 2.2: 替换 `buildZsxqPublished` 内部实现（line 694-702）**

将：

```ts
function buildZsxqPublished(topic: ZsxqTopic): string {
	if (!topic.create_time) return '';
	const d = new Date(topic.create_time);
	if (Number.isNaN(d.getTime())) return '';
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, '0');
	const day = String(d.getDate()).padStart(2, '0');
	return `${y}-${m}-${day}`;
}
```

替换为：

```ts
function buildZsxqPublished(topic: ZsxqTopic): string {
	if (!topic.create_time) return '';
	const d = new Date(topic.create_time);
	if (Number.isNaN(d.getTime())) return '';
	return convertDate(d);
}
```

**保留前置检查**：`!topic.create_time` 防空字符串；`Number.isNaN(d.getTime())` 防畸形 ISO 字符串导致 dayjs 输出 `'Invalid Date'` 字符串。

- [ ] **Step 2.3: 跑 zsxq 测试，确认不破坏**

```bash
npx vitest run src/utils/zsxq-extractor.test.ts
```

期望：所有测试通过（zsxq 测试现状未断言 `published` 具体值，但有多个 `create_time` 输入；只要 `buildZsxqPublished` 不抛错、不返 `undefined`，外层组装的 `ZsxqStructuredContent` 对象通过类型即可）。

- [ ] **Step 2.4: 跑 TypeScript 编译**

```bash
npx tsc --noEmit
```

期望：无报错。

- [ ] **Step 2.5: 提交**

```bash
git add src/utils/zsxq-extractor.ts
git commit -m "$(cat <<'EOF'
refactor(zsxq): buildZsxqPublished 改用共享的 convertDate

5 行手写 getFullYear/padStart → 1 行 convertDate。行为等价：两者
都基于本地 Date 字段、输出 YYYY-MM-DD。让 scys 与 zsxq 走同一日
期格式化路径，未来再加新平台时复用。

保留前置 !create_time / NaN 检查——防畸形 ISO 字符串导致 dayjs
输出 'Invalid Date' 字符串污染 frontmatter。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `content.ts:376` 合并加 `scysContent?.published`

**Files:**
- Modify: `src/content.ts:376`

- [ ] **Step 3.1: 修改 `src/content.ts:376` 的 published 合并表达式**

定位到：

```ts
					published: bilibiliContent?.published || zsxqContent?.published || defuddled.published,
```

替换为：

```ts
					published: bilibiliContent?.published || scysContent?.published || zsxqContent?.published || defuddled.published,
```

**顺序理由**：和同一函数 line 379 的 `site` 检测顺序（`bilibiliContent ? ... : feishuContent ? ... : scysContent ? ... : zsxqContent ? ...`）保持一致——scys 在 zsxq 之前。

- [ ] **Step 3.2: TypeScript 编译**

```bash
npx tsc --noEmit
```

期望：无报错（`scysContent` 在 line 278 已声明为可能为 `null` 的 `ScysStructuredContent`，`?.published` 安全访问后接 `||` 回退正常）。

- [ ] **Step 3.3: 跑全套测试**

```bash
npm test
```

期望：所有测试通过。

- [ ] **Step 3.4: 提交**

```bash
git add src/content.ts
git commit -m "$(cat <<'EOF'
fix(content): published 合并表达式加入 scysContent

content.ts:376 此前漏接 scys。位置放在 zsxqContent 之前，与同函数
line 379 site 检测优先级（bilibili → feishu → scys → zsxq → defuddle）
保持一致。

修复 scys article 裁剪笔记 frontmatter published 字段为空的最后
一环——前两环（接口字段、article 路径填值）在前序 commits。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: 端到端手动验证

**Files:** 无源码改动；浏览器手动验证。

- [ ] **Step 4.1: Chrome 开发构建**

```bash
npm run dev:chrome
```

watch 模式启动；让它跑着。

- [ ] **Step 4.2: 在 Chrome `chrome://extensions/` 重新加载本扩展**

如果未加载，点 "Load unpacked" 选 `dist/` 目录；已加载则点该扩展卡片的"刷新"按钮。

- [ ] **Step 4.3: 打开 spec 中提到的 scys 文章 URL**

```
https://scys.com/articleDetail/xq_topic/22255842525182811
```

- [ ] **Step 4.4: 触发裁剪**

按 toolbar 中扩展图标或快捷键打开 clipper，确认侧边栏弹出且能解析。

- [ ] **Step 4.5: 检查 frontmatter**

侧边栏底部的 frontmatter 预览（或裁剪保存到 Obsidian 的 `.md` 文件）应包含：

```yaml
published: 2026-05-14
```

（具体日期取决于这篇文章的 `gmtCreate`；只要不再是空、且形态为 `YYYY-MM-DD` 即通过）

- [ ] **Step 4.6: 回归——zsxq 文章未坏**

打开一篇 zsxq topic（任意已收藏的 `https://wx.zsxq.com/group/.../topic/...`），触发裁剪，确认 frontmatter `published:` 字段值仍为 YYYY-MM-DD（不是 `'Invalid Date'`、不是空）。

- [ ] **Step 4.7: 关闭 dev watch**

```bash
# Ctrl-C 关掉 npm run dev:chrome
```

---

## Done Criteria

全部 Task 完成后：

1. `npm test` 全绿
2. `npx tsc --noEmit` 无报错
3. 真实 Chrome 扩展裁剪 scys article URL，frontmatter `published` 含 YYYY-MM-DD 日期
4. 真实 Chrome 扩展裁剪 zsxq topic URL，frontmatter `published` 仍正常（回归保护）
5. git log 显示 3 个聚焦 commits（Task 1/2/3），无 dead code、无 TODO

---

## Self-Review 笔记

- **Spec 覆盖**：
  - spec §2.1（共享工具）→ Task 1.2.1 + Task 2.1 import；调用点 Task 1.2.5、Task 2.2
  - spec §2.2（接口扩展）→ Task 1.2.2
  - spec §2.3（三条路径）→ Task 1.2.3 / 1.2.4 / 1.2.5
  - spec §2.4（zsxq 对齐）→ Task 2
  - spec §2.5（content.ts merge）→ Task 3
  - spec §2.6（fallback 路径不动）→ 计划不涉及，符合
  - spec §4.1（scys 测试）→ Task 1.1.2、1.1.3
  - spec §4.2（zsxq 测试不破坏）→ Task 2.3
  - spec §4.3（不新建 date-utils 测试）→ 计划不涉及，符合
- **Placeholder 扫描**：无 TBD/TODO；所有步骤含 exact 代码或 exact 命令
- **类型一致性**：`convertDate` 签名 `(date: Date, format?: string) => string`，全计划调用形如 `convertDate(d)` 走默认 `'YYYY-MM-DD'`；`ScysStructuredContent.published: string` 全计划保持必填
