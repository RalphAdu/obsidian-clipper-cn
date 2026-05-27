# scys 文章裁剪补全 `published` frontmatter 字段 设计文档

**日期**：2026-05-18
**目标**：scys.com `/articleDetail/xq_topic/{id}` 路径裁剪到 Obsidian 的笔记 frontmatter 缺 `published`。API 已返回 `topicDTO.gmtCreate`（unix seconds），但 extractor 没透传、`content.ts` 的合并表达式也没接住。本次顺便把 zsxq 现有手写日期格式化代码也对齐到共享的 `convertDate`，让 `published` 字段在所有 extractor 内走单一路径。

## 1. 问题定位

### 1.1 现象

用户裁剪 `https://scys.com/articleDetail/xq_topic/22255842525182811`，得到的 frontmatter 缺 `published:` 行的值。scys 网页本身在作者下方显示发布时间（如 `2026-05-14 10:00`），数据是有的，只是没走到产物。

### 1.2 根因（三层遗漏，缺一不可）

| 层 | 文件:行 | 现状 | 期望 |
|---|---|---|---|
| 接口 | `src/utils/scys-extractor.ts:501-506` | `ScysStructuredContent` 只有 `title/author/content/wordCount` | 加 `published: string` 必填字段 |
| 数据透传 | `src/utils/scys-extractor.ts:822-893` `extractScysArticleStandalone` | `detail.gmtCreate`（已 fetch，line 703）未出现在 return 中 | return 加 `published: convertDate(new Date(detail.gmtCreate * 1000))` |
| 合并 | `src/content.ts:376` | `published: bilibiliContent?.published \|\| zsxqContent?.published \|\| defuddled.published` | 加入 `scysContent?.published` |

fixture 数据已验证：`src/utils/fixtures/scys-article-55188248-detail.json` 含 `"gmtCreate":1762503084`。

### 1.3 对比 zsxq

zsxq 已实现 `published`（`src/utils/zsxq-extractor.ts:691`），格式 `YYYY-MM-DD`，本地时区。本次 scys 对齐同一形态：**`published: string` 必填字段**，路径无创建时间语义时填空字符串。

## 2. 设计

### 2.1 共享日期格式化：`convertDate`

`src/utils/date-utils.ts` 已存在 `convertDate(date: Date, format = 'YYYY-MM-DD'): string`，基于 dayjs，本地时区。本次设计的两个 extractor（scys、zsxq）都通过它格式化 `published`，不再各自手写 `getFullYear/padStart`。

### 2.2 ScysStructuredContent 接口扩展

`src/utils/scys-extractor.ts:501`：

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

必填（非 optional），与 `ZsxqStructuredContent.published` 接口形态一致。

### 2.3 extractor 三条路径的 return 改动

`src/utils/scys-extractor.ts`：

| 函数 | 行 | published 取值 |
|---|---|---|
| `extractScysCourseChapter` | ~609 | `published: ''` |
| `extractScysDocxStandalone` | ~609 | `published: ''` |
| `extractScysArticleStandalone` | ~887-892 | 见下方逻辑 |

article 路径逻辑（内联在该函数 return 处）：

```ts
const published = detail.gmtCreate
	? convertDate(new Date(detail.gmtCreate * 1000))
	: '';
```

边界：`gmtCreate === 0` 或 falsy → `''`。无需额外 `Number.isNaN` 检查——`detail.gmtCreate * 1000` 已是有限数，`new Date(finite)` 不会 NaN。

文件顶部 imports 加：

```ts
import { convertDate } from './date-utils';
```

### 2.4 zsxq 对齐：替换手写格式化

`src/utils/zsxq-extractor.ts:694-702`：

```ts
function buildZsxqPublished(topic: ZsxqTopic): string {
	if (!topic.create_time) return '';
	const d = new Date(topic.create_time);
	if (Number.isNaN(d.getTime())) return '';
	return convertDate(d);
}
```

保留前置的 `!topic.create_time` 空值检查和 `Number.isNaN(d.getTime())` 检查——`topic.create_time` 是 ISO 字符串，可能畸形（如 `'invalid'`），`new Date('invalid')` 给 Invalid Date，dayjs 会把它格式化成字符串 `'Invalid Date'`，不预防会污染 frontmatter。

文件顶部 imports 加 `import { convertDate } from './date-utils';`。

`parseChineseArticleDate`（zsxq-extractor.ts:674-681）**不动**——它处理的是中文文本 `"2026年05月01日 21:02"`，输入是字符串而非 Date 对象，跟 `convertDate` 不在同一职责。

### 2.5 `content.ts` 合并

`src/content.ts:376`：

```ts
published: bilibiliContent?.published || scysContent?.published || zsxqContent?.published || defuddled.published,
```

`scysContent` 放在 `zsxqContent` 之前——和同一函数 line 379 的 `site` 检测优先级（`bilibiliContent ? ... : feishuContent ? ... : scysContent ? ... : zsxqContent ? ... : defuddled`）保持顺序一致，便于后续读者一眼看出"scys 在 zsxq 前"。

### 2.6 fallback 路径（content.ts:681）

`src/content.ts:681` 已经写的是 `published: (result as any)?.published || ''`——它在 scys 主路径失败时走 background bridge 形成 simulated vars，本次接口变更后自动获益（`result` 即 `ScysStructuredContent`，新增字段直接被泛 any 读到）。**不改**。

## 3. 数据流（修复后）

```
scys API POST /shengcai-web/client/homePage/topicDetail
  → topicDTO.gmtCreate (unix seconds, e.g. 1762503084)
  → fetchScysArticleDetail 透传 ScysArticleDetail.gmtCreate
  → extractScysArticleStandalone: new Date(gmtCreate * 1000)
  → convertDate(d)  →  "YYYY-MM-DD"  （e.g. "2025-11-07" 本地时区）
  → ScysStructuredContent.published
  → ContentResponse.published（content.ts:376 merge）
  → Obsidian frontmatter `published:` 字段
```

## 4. 测试

### 4.1 scys 路径

`src/utils/scys-extractor.test.ts` 增加 article published 用例：

- 用现有 fixture `scys-article-55188248-detail.json`（`gmtCreate: 1762503084`）
- 断言 `result.published === convertDate(new Date(1762503084 * 1000))`
- **不**硬编码字符串（CI 时区可能不是 Asia/Shanghai；硬编码会让测试在 CI 上挂掉）
- 同一文件另加 course/docx 路径的断言：`result.published === ''`

### 4.2 zsxq 路径

`src/utils/zsxq-extractor.test.ts`：

- 现有的 `buildZsxqPublished` 行为测试不应破坏（行为等价：手写实现和 `convertDate` 对同一 Date 输入产生同一 YYYY-MM-DD 字符串）
- 若现有测试覆盖了 `topic.create_time === ''`、ISO 畸形字符串等边界，必须仍通过

### 4.3 date-utils

`src/utils/date-utils.ts` 已存在且无对应 `.test.ts` 文件。**不**新建——`convertDate` 是 dayjs 一行 wrapper，单独测它会变成测 dayjs 本身。它的行为已通过 scys/zsxq 的集成测试间接覆盖。

## 5. 不做什么（YAGNI）

- **不**支持 datetime（HH:mm）格式——已在 brainstorm 第一轮排除，frontmatter 用 `YYYY-MM-DD` 与 zsxq 对齐
- **不**给 course/docx 找发布时间——已在 brainstorm 第二轮排除（不确定 API 是否提供且无 publish-time 语义）
- **不**抽公共 `StructuredContent` 接口给 scys/zsxq/feishu/bilibili——各 extractor 的字段集已分叉（如 bilibili 有 `image`、scys 没有），强行抽公共接口会拖累后续演进
- **不**改 `parseChineseArticleDate`（zsxq 用于解析中文文本日期）——和 `convertDate` 是不同职责

## 6. 回归风险

- `ScysStructuredContent` 从 4 字段变 5 字段必填——所有 TypeScript 消费者会被编译器强制更新。`content.ts:365-381` 是唯一直接消费 `scysContent` 的地方，其余通过泛 `any` 读取（如 line 681）不受影响。
- zsxq 内部 `buildZsxqPublished` 实现替换——输出对同一输入应字节相等。若 CI 跑在非 Asia/Shanghai 时区，手写实现和 `convertDate` 都按本地时区计算，仍然等价（不会引入时区漂移）。
