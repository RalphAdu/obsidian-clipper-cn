# Spec: Feishu list — empty TEXT spacer terminates the list

Date: 2026-05-18
Scope: `src/utils/feishu-extractor.ts`（仅 `collectListGroup`）
Repro: <https://my.feishu.cn/wiki/Td9nwP2ExiBCgCkzcM1c9gwYnmd>

## 问题

飞书原文的"自我介绍"段落，BULLET 列表

- 功能不完善：…
- 平台限制：…
- 频繁的 BUG 与修改：…

下方紧跟一段普通正文（"这些问题需要不停的跟对方沟通，…"等 15+ 段）。在飞书 web 端这些段落与上方"初次使用时…"对齐，是 PAGE 直接子段落；裁剪到 Obsidian 后却以**列表项缩进**呈现。

## 根因

`collectListGroup`（`feishu-extractor.ts:897`）的 follower 机制：BULLET/ORDERED/TODO 后续任何不在 `LIST_BOUNDARIES`、也不是 bold-only "section header" 的 block，都被 append 到**最后一个** `<li>` 的尾部。

对照 Feishu OpenAPI 拉下来的 block 序列：

```
BULLET 频繁的BUG与修改：…
TEXT  (空)                   ← 飞书侧"空行 spacer"
TEXT  这些问题需要不停的…
TEXT  而且优化软件…
TEXT  最终我下定决心自学编程，
TEXT  用自己的能力解决问题…
TEXT  (空)
TEXT  后来随着越来越多项目…
… (持续 15+ 段)
```

空 TEXT 和后续所有非空 TEXT 全部被 `pendingFollowers` 吸收，最终 flush 进第 3 个 `<li>` → Obsidian 渲染为列表项缩进。

## 不能回归的现有行为

| 测试 | 序列 | 当前行为（必须保留）|
|---|---|---|
| L97-108 | `ORDERED → 非空 TEXT → H2` | 非空 TEXT flush 进最后 `<li>` |
| L216-226 | `ORDERED → 非空 TEXT → ORDERED → 非空 TEXT → ORDERED` | 单个 `<ol>`，每个 TEXT 是上一项的解释（对应正文"软件的适用场景"段的"内容创作者/电商从业者/数据分析师/团队协作"模式）|
| L228-237 | `BULLET → empty TEXT → BULLET` | 单个 `<ul>`，spacer 被吸收 |

## 设计

### 行为合约

`collectListGroup` 主循环新增一条规则：

> **"empty TEXT spacer" 的下一个非空 block 决定列表是否关闭：**
>
> - 下一个仍是 **同 kind 列表项** → spacer 当作 follower 吸收（保留 L228 行为）
> - 否则 → **关闭列表**，索引回退到 spacer 位置，由上层 `renderChildren` 按段落渲染（空 TEXT 在 `renderBlock` 中因 `inner.trim() === ''` 被渲染为空字符串，无害）

"empty TEXT spacer" 定义：`block.block_type === FEISHU_BLOCK_TYPE.TEXT` 且所有 `text_run` 拼接后 `trim().length === 0`（涵盖纯空与仅 bold 空 run 两种）。

### 行为表

| 序列 | 原行为 | 新行为 |
|---|---|---|
| BULLET → empty TEXT → BULLET | 列表合并 | 不变 |
| ORDERED → 非空 TEXT → ORDERED | 列表合并，TEXT 吸收 | 不变 |
| ORDERED → 非空 TEXT → H2 | TEXT flush 进最后 `<li>` | 不变 |
| **BULLET×3 → empty TEXT → 非空 TEXT × N**（case A，本次 bug）| 全 flush 进最后 `<li>`，缩进 | **列表关闭，N 段独立 `<p>`** |
| BULLET → empty TEXT → ORDERED | （未明确）| 上方 `<ul>` 关闭，下方 `<ol>` 独立 |
| BULLET → empty TEXT → EOF | （未明确）| `</ul>` 正常关闭，spacer 渲染为空 |
| BULLET → empty TEXT × 2 → 非空 TEXT | 全 flush 进 `<li>` | 列表关闭，连续 spacer 跳过，非空 TEXT 独立 |

### 伪码

```
while i < childIds.length:
  b = blockMap[childIds[i]]
  if !b: i++; continue

  if b.block_type === kind:
      flush pendingFollowers to last entry; new entry; i++; continue

  if isListKind(b.block_type) || LIST_BOUNDARIES.has(b.block_type):
      break

  if isSectionHeaderText(b):
      break

  if isEmptyTextSpacer(b):
      j = i + 1
      while j < childIds.length and isEmptyTextSpacer(blockMap[childIds[j]]):
          j++
      next = j < childIds.length ? blockMap[childIds[j]] : undefined
      if next && next.block_type === kind:
          pendingFollowers.push(b); i++; continue   # 保留 spacer 吸收
      else:
          break                                      # i 不前进，spacer 留给上层
  
  pendingFollowers.push(b); i++
```

### 新增 helper

```ts
function isEmptyTextSpacer(block: FeishuBlock | undefined): boolean {
  if (!block || block.block_type !== FEISHU_BLOCK_TYPE.TEXT) return false;
  const text = (block.text?.elements || [])
    .map((e) => e.text_run?.content || '')
    .join('');
  return text.trim().length === 0;
}
```

## 测试

新增 vitest case 在 `feishu-extractor.test.ts` 的 "section header boundary" describe 之后（或新建 `"list spacer boundary"` describe）：

1. `BULLET → empty TEXT → 非空 TEXT × 3 → H2` → assert：`<ul>` 仅含原 1 个 `<li>`；3 段独立 `<p>`；`<h2>` 紧随其后。
2. `BULLET → empty TEXT × 2 → 非空 TEXT` → 同上（连续 spacer lookahead）。
3. `BULLET → empty TEXT → EOF` → assert：`</ul>` 关闭；无残留空 `<p>`。
4. `BULLET → empty TEXT → ORDERED` → assert：`<ul>` 关闭；下一个 `<ol>` 独立。

**回归红线**：保留 L97 / L216 / L228 三个测试 100% 通过。

可选 audit fixture：把本次拉的 `/tmp/feishu-Td9n-blocks.json`（276 blocks，wiki `Td9nwP2ExiBCgCkzcM1c9gwYnmd`）以 `existsSync` 方式作为 audit test（仿 `feishu-extractor.audit.test.ts`），sentinel 断言两条：

- "BULLET 列表的 `<li>` 数量 = 3"（不再吞段落）
- "段落'这些问题需要不停的跟对方沟通'独立成 `<p>` 且不在任何 `<li>` 内部"

fixture 文件不入仓。

## 验证与收尾

1. `npx vitest run src/utils/feishu-extractor.test.ts` 全绿
2. `npm test` 全套全绿
3. `npm run build:chrome` → `dist/`，按惯例 hot reload 生效
4. 在飞书原文 `Td9nwP2ExiBCgCkzcM1c9gwYnmd` 上手动 clip → Obsidian 中比对截图 1：红框段落与"初次使用时…"左对齐，无列表缩进
5. 清理 `/tmp/feishu-Td9n-blocks.json`（沉淀 audit fixture 则保留但不入仓）

## 不在范围内

- IMAGE / FILE / IFRAME 等其他 follower 类型的吸收语义（保持现状）
- 飞书 web 嵌套 list（`block.children` 上的子列表）的行为（已由 `renderBlockChildren` 处理，与本次无关）
- LIST_BOUNDARIES 集合本身的增减
