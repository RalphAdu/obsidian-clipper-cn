# Feishu List Spacer Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `collectListGroup` 在飞书 BULLET/ORDERED/TODO 列表后遇到「空 TEXT spacer + 非同 kind 内容」时关闭列表，修复 wiki `Td9nwP2ExiBCgCkzcM1c9gwYnmd` 把 15+ 段普通段落塞进最后一个 `<li>` 的缩进 bug。

**Architecture:** 在 `src/utils/feishu-extractor.ts` 的 `collectListGroup` 主循环新增一条规则：遇到 empty TEXT spacer 时 lookahead 到下一个非空 block —— 若是同 kind 则照旧吸收 spacer 继续列表，否则关闭列表并把索引留在 spacer 位置让上层 `renderChildren` 按段落渲染。新增 helper `isEmptyTextSpacer`。原有 4 个相关测试（L97 / L216 / L228 / 既有 audit）保持 100% 通过。

**Tech Stack:** TypeScript / Vitest / 飞书 Open API（已有 dump 在 `/tmp/feishu-Td9n-blocks.json`）

**Spec:** `docs/superpowers/specs/2026-05-18-feishu-list-spacer-boundary-design.md`

---

## File Structure

| 路径 | 操作 | 责任 |
|---|---|---|
| `src/utils/feishu-extractor.ts` | Modify | 新增 `isEmptyTextSpacer` helper；在 `collectListGroup` 循环里加 spacer lookahead 分支 |
| `src/utils/feishu-extractor.test.ts` | Modify | 在 "section header boundary" describe 后新增 "list spacer boundary" describe，含 4 个测试 |

不新建文件。所有改动都在两个既有文件内。

---

## Task 1：写 case A 失败测试（核心 bug）

**Files:**
- Modify: `src/utils/feishu-extractor.test.ts`（在 line 238 `});` 后追加）

- [ ] **Step 1.1: 在 `feishu-extractor.test.ts` 末尾、`extractFeishuStructuredContent — comments wiring` 这个 describe 之前，追加新的 describe**

打开 `src/utils/feishu-extractor.test.ts`，定位到 line 238（"section header boundary" describe 的关闭 `});`）和 line 240 `describe('extractFeishuStructuredContent — comments wiring', ...)`，在两者之间插入：

```ts
describe('convertBlocksToHtml — list spacer boundary', () => {
	it('BULLET → empty TEXT → non-empty TEXT × 3 → H2: list closes, paragraphs are siblings', () => {
		const blocks: FeishuBlock[] = [
			{ block_id: 'p', block_type: 1, page: { elements: [] }, children: ['u1', 'sp', 't1', 't2', 't3', 'h'] },
			{ block_id: 'u1', block_type: 12, parent_id: 'p', bullet: { elements: [{ text_run: { content: 'frequent BUG fixes' } }] } } as any,
			{ block_id: 'sp', block_type: 2, parent_id: 'p', text: { elements: [{ text_run: { content: '' } }] } } as any,
			{ block_id: 't1', block_type: 2, parent_id: 'p', text: { elements: [{ text_run: { content: 'These issues require constant back-and-forth,' } }] } } as any,
			{ block_id: 't2', block_type: 2, parent_id: 'p', text: { elements: [{ text_run: { content: 'and optimizing is a bottomless pit.' } }] } } as any,
			{ block_id: 't3', block_type: 2, parent_id: 'p', text: { elements: [{ text_run: { content: 'I finally decided to learn coding myself.' } }] } } as any,
			{ block_id: 'h', block_type: 4, parent_id: 'p', heading2: { elements: [{ text_run: { content: 'Next section' } }] } } as any,
		];
		const html = convertBlocksToHtml(blocks);
		// list must contain exactly the one <li> we declared
		expect(html.match(/<li>/g)?.length).toBe(1);
		expect(html).toContain('<li>frequent BUG fixes</li>');
		// the three plain TEXTs render as standalone <p> outside any <li>
		expect(html).toContain('<p>These issues require constant back-and-forth,</p>');
		expect(html).toContain('<p>and optimizing is a bottomless pit.</p>');
		expect(html).toContain('<p>I finally decided to learn coding myself.</p>');
		expect(html).not.toMatch(/<li>[^<]*<p>These issues/);
		expect(html).toContain('<h2>Next section</h2>');
	});
});
```

- [ ] **Step 1.2: 运行新测试，确认它失败**

Run:
```bash
cd /Users/adu/Workspace/github/obsidian-clipper/obsidian-clipper-cn
npx vitest run src/utils/feishu-extractor.test.ts -t 'list spacer boundary'
```

Expected: FAIL — `html.match(/<li>/g)?.length` 预期 1 实际仍是 1（li 没多），但 `<p>These issues…</p>` **被嵌在 `<li>` 内**，因此 `expect(html).not.toMatch(/<li>[^<]*<p>These issues/)` 这条 assertion 会失败（注意正则里 `[^<]*` 允许 `<li>frequent BUG fixes` 这种文字 + `<p>` 紧跟）。如果实际是 `<li>frequent BUG fixes<p>...</p>...</li>` 这种结构，正则会匹配到，断言失败。

实际更可能直接看到 `expect(html).toMatch /<li>[^<]*<p>These issues/`（或 toContain）失败提示。看到红就 OK，进 Step 2。

- [ ] **Step 1.3: 不要 commit**（测试要和实现一起 commit，TDD 红绿循环）

---

## Task 2：实现 `isEmptyTextSpacer` helper + 在 `collectListGroup` 加 spacer lookahead 分支

**Files:**
- Modify: `src/utils/feishu-extractor.ts:830-840`（helper 放在 `isSectionHeaderText` 上方）
- Modify: `src/utils/feishu-extractor.ts:909-936`（`collectListGroup` 主循环新增分支）

- [ ] **Step 2.1: 在 `isSectionHeaderText` 函数（line 839）正上方添加 `isEmptyTextSpacer` helper**

打开 `src/utils/feishu-extractor.ts`，找到 line 832-839（`isSectionHeaderText` 的 JSDoc + 函数定义）。在 line 832 的 JSDoc 注释 `/**` 上方插入：

```ts
/**
 * Returns true if `block` is a TEXT block whose text content (joined across
 * all text_run elements) is empty after trim. Spacer = feishu's "blank line"
 * convention between paragraphs/sections.
 */
function isEmptyTextSpacer(block: FeishuBlock | undefined): boolean {
	if (!block || block.block_type !== FEISHU_BLOCK_TYPE.TEXT) return false;
	const text = (block.text?.elements || [])
		.map((e) => e.text_run?.content || '')
		.join('');
	return text.trim().length === 0;
}

```

注意末尾留一个空行，与下方 `isSectionHeaderText` 的 JSDoc 隔开。

- [ ] **Step 2.2: 在 `collectListGroup` 里 `isSectionHeaderText` break 之后新增 spacer lookahead 分支**

找到 line 927-932（在 `collectListGroup` 函数内）：

```ts
		// A bold-only TEXT block is the feishu convention for a section header
		// (e.g., "家长的痛点：" above a bullet list). Close the current list so
		// the header renders as its own <p><strong>…</strong></p> paragraph.
		if (isSectionHeaderText(b)) {
			break;
		}

		pendingFollowers.push(b);
		i++;
```

把它替换为：

```ts
		// A bold-only TEXT block is the feishu convention for a section header
		// (e.g., "家长的痛点：" above a bullet list). Close the current list so
		// the header renders as its own <p><strong>…</strong></p> paragraph.
		if (isSectionHeaderText(b)) {
			break;
		}

		// An empty TEXT spacer (feishu's blank-line convention) signals
		// end-of-list when the next non-empty block is NOT the same list kind.
		// If the next non-empty block IS the same kind, keep absorbing the
		// spacer as a follower so list items separated by a blank line stay
		// in one <ul>/<ol>.
		if (isEmptyTextSpacer(b)) {
			let j = i + 1;
			while (j < childIds.length && isEmptyTextSpacer(blockMap.get(childIds[j]))) {
				j++;
			}
			const next = j < childIds.length ? blockMap.get(childIds[j]) : undefined;
			if (next && next.block_type === kind) {
				pendingFollowers.push(b);
				i++;
				continue;
			}
			// Close the list; leave `i` pointing AT the spacer so the upper
			// `renderChildren` loop processes spacer + following blocks as
			// page-level siblings (empty TEXT renders as '' in renderBlock).
			break;
		}

		pendingFollowers.push(b);
		i++;
```

- [ ] **Step 2.3: 运行 case A 测试，确认通过**

Run:
```bash
cd /Users/adu/Workspace/github/obsidian-clipper/obsidian-clipper-cn
npx vitest run src/utils/feishu-extractor.test.ts -t 'list spacer boundary'
```

Expected: PASS（1 passed）

- [ ] **Step 2.4: 跑整个 feishu-extractor.test.ts 套件，确认无回归**

Run:
```bash
npx vitest run src/utils/feishu-extractor.test.ts
```

Expected: 全部 passed。特别确认下面三个原有测试仍然绿：
- `flushes trailing followers (TEXT after the last OL) into the last <li>`（L97）
- `a non-bold TEXT block between OL lists still gets absorbed (no regression)`（L216）
- `a spacer-style empty bold TEXT is not a boundary (gets absorbed silently)`（L228）

如果有任何红，**回到 Step 2.1/2.2 检查改动**，不要硬改测试。

- [ ] **Step 2.5: commit（test + impl 一起）**

```bash
git add src/utils/feishu-extractor.ts src/utils/feishu-extractor.test.ts
git commit -m "$(cat <<'EOF'
fix(feishu): empty TEXT spacer terminates list group

Previously collectListGroup absorbed any non-LIST_BOUNDARY block after a
BULLET/ORDERED/TODO into the last <li> as a follower. This nested 15+
trailing paragraphs of wiki Td9nwP2ExiBCgCkzcM1c9gwYnmd inside the third
<li>, rendering with list indentation in Obsidian.

Now an empty TEXT spacer (feishu's blank-line convention) triggers list
close when its next non-empty sibling is NOT the same list kind.
Consecutive spacers are skipped via lookahead. Same-kind followups still
absorb the spacer (preserves L228 behavior). Non-spacer plain TEXT
followers are still absorbed (preserves L97, L216 — covers the
"ORDERED + explanation paragraph" idiom).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3：补三个边界测试，验证 lookahead 与 EOF 等场景

**Files:**
- Modify: `src/utils/feishu-extractor.test.ts`（在 Task 1 写的 `convertBlocksToHtml — list spacer boundary` describe 内追加 3 个 `it`）

- [ ] **Step 3.1: 在 `'list spacer boundary'` describe 内、Task 1 的 `it` 之后追加三个 `it`**

```ts
	it('BULLET → empty TEXT × 2 → non-empty TEXT: consecutive spacers do not block lookahead', () => {
		const blocks: FeishuBlock[] = [
			{ block_id: 'p', block_type: 1, page: { elements: [] }, children: ['u1', 'sp1', 'sp2', 't1'] },
			{ block_id: 'u1', block_type: 12, parent_id: 'p', bullet: { elements: [{ text_run: { content: 'item' } }] } } as any,
			{ block_id: 'sp1', block_type: 2, parent_id: 'p', text: { elements: [{ text_run: { content: '' } }] } } as any,
			{ block_id: 'sp2', block_type: 2, parent_id: 'p', text: { elements: [{ text_run: { content: '  ' } }] } } as any,
			{ block_id: 't1', block_type: 2, parent_id: 'p', text: { elements: [{ text_run: { content: 'standalone paragraph' } }] } } as any,
		];
		const html = convertBlocksToHtml(blocks);
		expect(html.match(/<li>/g)?.length).toBe(1);
		expect(html).toContain('<li>item</li>');
		expect(html).toContain('<p>standalone paragraph</p>');
		expect(html).not.toMatch(/<li>[^<]*<p>standalone/);
	});

	it('BULLET → empty TEXT → EOF: list closes cleanly, no orphan empty <p>', () => {
		const blocks: FeishuBlock[] = [
			{ block_id: 'p', block_type: 1, page: { elements: [] }, children: ['u1', 'sp'] },
			{ block_id: 'u1', block_type: 12, parent_id: 'p', bullet: { elements: [{ text_run: { content: 'only item' } }] } } as any,
			{ block_id: 'sp', block_type: 2, parent_id: 'p', text: { elements: [{ text_run: { content: '' } }] } } as any,
		];
		const html = convertBlocksToHtml(blocks);
		expect(html).toContain('<ul><li>only item</li></ul>');
		// empty TEXT renders to '' in renderBlock; no <p></p> should appear
		expect(html).not.toContain('<p></p>');
	});

	it('BULLET → empty TEXT → ORDERED: <ul> closes, <ol> stands alone', () => {
		const blocks: FeishuBlock[] = [
			{ block_id: 'p', block_type: 1, page: { elements: [] }, children: ['u1', 'sp', 'o1'] },
			{ block_id: 'u1', block_type: 12, parent_id: 'p', bullet: { elements: [{ text_run: { content: 'bullet item' } }] } } as any,
			{ block_id: 'sp', block_type: 2, parent_id: 'p', text: { elements: [{ text_run: { content: '' } }] } } as any,
			{ block_id: 'o1', block_type: 13, parent_id: 'p', ordered: { elements: [{ text_run: { content: 'ordered item' } }] } } as any,
		];
		const html = convertBlocksToHtml(blocks);
		expect(html).toContain('<ul><li>bullet item</li></ul>');
		expect(html).toContain('<ol><li>ordered item</li></ol>');
		expect(html).not.toMatch(/<li>[^<]*ordered item/);
	});
```

- [ ] **Step 3.2: 跑新测试，全绿**

Run:
```bash
npx vitest run src/utils/feishu-extractor.test.ts -t 'list spacer boundary'
```

Expected: 4 passed（Task 1 的 1 个 + Task 3 的 3 个）。

如果 EOF 测试看到 `</ul>` 顺序不对，或者多了空 `<p>`，那说明 Step 2.2 的 `break` 分支没把 spacer 留在原位 —— 检查 `i` 是否被无意推进。

- [ ] **Step 3.3: 跑全套测试**

Run:
```bash
npm test
```

Expected: 整库全绿。

- [ ] **Step 3.4: commit**

```bash
git add src/utils/feishu-extractor.test.ts
git commit -m "$(cat <<'EOF'
test(feishu): cover spacer boundary edge cases (consecutive, EOF, cross-kind)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4：构建 + 在浏览器中视觉对照验证

**Files:** 无源码改动；触发构建。

- [ ] **Step 4.1: 构建 Chrome 扩展（dev mode 自动 watch；这次直接走 prod 一次性 build 以便 rsync）**

Run:
```bash
cd /Users/adu/Workspace/github/obsidian-clipper/obsidian-clipper-cn
npm run build:chrome
```

Expected: 看到 `webpack ... compiled successfully`，`dist/` 被更新。

- [ ] **Step 4.2: rsync 到 main 装载目录（按既定 dev cycle 工作流）**

阿杜的 Chrome 已经在 hot reload `dist/`。如果当前仓库的 `dist/` 已经是 Chrome 装载目录，跳过 rsync。否则确认 `dist/` 路径与 Chrome "Load unpacked extension" 加载路径一致 —— 多数情况无需 rsync，扩展会 5s 内自动 hot reload。

- [ ] **Step 4.3: 在浏览器中打开飞书原文并裁剪**

1. 在 Chrome 中打开 <https://my.feishu.cn/wiki/Td9nwP2ExiBCgCkzcM1c9gwYnmd>
2. 等待页面加载完成
3. 点击 Obsidian Web Clipper 扩展图标 → 选择"飞书"模板 → 保存到 Obsidian
4. 在 Obsidian 中打开刚保存的笔记

- [ ] **Step 4.4: 视觉对比（验收 bar：与飞书 web 端视觉一致）**

在 Obsidian 中定位"功能不完善 / 平台限制 / 频繁的BUG与修改"这三个 bullet 项。

**通过标准（与截图 1 飞书 web 端一致）：**

- 三个 bullet 后紧跟的 `这些问题需要不停的跟对方沟通，` 等段落，**左对齐于 `初次使用时…` 段落**，没有任何缩进
- bullet 列表的 `<ul>` 仅包含 3 个 `<li>`，不嵌套 16+ 个 `<p>` 在最后一个 `<li>` 里
- 章节末尾的 `软件的适用场景` 段（4 个 ORDERED + 4 段解释）保持单个 `<ol>`，每段解释紧贴对应序号（这是 case B，必须无回归）

**不通过则 STOP，回到 Task 2 检查实现。**

- [ ] **Step 4.5: build artifact 不入仓**

`dist/` 在 `.gitignore` 中。`git status` 应该看不到 `dist/` 相关变化。无需 commit。

---

## Task 5：收尾

**Files:** 无源码改动；清理临时文件 + 更新 BACKLOG（如有需要）。

- [ ] **Step 5.1: 清理临时 dump**

Run:
```bash
rm -f /tmp/feishu-Td9n-blocks.json
```

（如果阿杜决定沉淀为 audit fixture：保留该文件 + 仿 `feishu-extractor.audit.test.ts` 模式新增一个 audit test 文件。本计划不包含此步，默认清理。）

- [ ] **Step 5.2: 确认 git 工作区干净**

Run:
```bash
git status
```

Expected: `nothing to commit, working tree clean`。

- [ ] **Step 5.3: 查看本次工作的 commit 列表**

Run:
```bash
git log --oneline -5
```

Expected: 看到三个新 commit（自上而下）：
- `test(feishu): cover spacer boundary edge cases ...`
- `fix(feishu): empty TEXT spacer terminates list group`
- `docs(feishu): spec — empty TEXT spacer terminates list group`

---

## Self-Review checklist

- ✓ Spec § 行为合约 → Task 2 Step 2.2 完整实现
- ✓ Spec § 行为表 6 行 → Task 1（case A）+ Task 3（spacer × 2 / EOF / 跨 kind）+ 现有 L97/L216/L228（不改）
- ✓ Spec § 测试矩阵 → Task 1 + Task 3 一一对应
- ✓ Spec § 验证清单 → Task 4
- ✓ 无 TBD / TODO / "implement later"
- ✓ 类型/函数名一致（`isEmptyTextSpacer` / `collectListGroup` / `pendingFollowers` 全文一致）
- ✓ 每个 step 给出完整可执行代码或命令 + 预期输出
- ✓ TDD 红 → 绿 → 提交节奏（Task 1 红，Task 2 绿+提交）

---

## 不在范围内（重申）

- 不改 IMAGE / FILE / IFRAME 等其他 follower 类型的吸收语义
- 不改 LIST_BOUNDARIES 集合本身
- 不新增 audit fixture（默认清理 /tmp dump）
- 不动 scys / bilibili / 上游模块
