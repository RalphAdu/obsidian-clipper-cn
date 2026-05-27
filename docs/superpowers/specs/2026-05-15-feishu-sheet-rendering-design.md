# 飞书 docx 内嵌表格（SHEET block）渲染 设计文档

**日期**：2026-05-15
**目标**：cn 剪存飞书 docx 时，把内嵌 SHEET (block_type=30) 渲染为完整 markdown 表格（含粗体），不再输出 `[Embedded content: type 30]` 占位。

## 1. 问题

cn `feishu-extractor.ts:735` 把 SHEET 块归到 "Embedded content" 占位组：

```ts
case FEISHU_BLOCK_TYPE.IFRAME:
case FEISHU_BLOCK_TYPE.WIDGET:
case FEISHU_BLOCK_TYPE.SHEET:  // ← 30
case FEISHU_BLOCK_TYPE.MINDNOTE:
...
    return `<p>[Embedded content: type ${block.block_type}]</p>`;
```

用户场景：含 12 个 SHEET 的 docx (`https://duomiyang.feishu.cn/docx/U6xkd6jJOoBsKPxKSb2c684KnXg`) 剪存后所有表格全部丢失。

## 2. 数据流设计

复用 image/file 的 placeholder + resolve 模式：

```
extractor:
  case SHEET → <table data-feishu-sheet="{ss_token}_{sheet_id}"></table>
  
resolveFeishuSheets(html):
  扫描所有 <table data-feishu-sheet="..."> 占位
  Promise.all 并发 fetch（每个 sheet 一次 background message）
  组装 HTML 表格（含 <strong> for bold）
  替换占位

background:
  'fetchFeishuSheet' message:
    1. 拆 token → ss_token + sheet_id
    2. 并发 fetch:
       - GET /open-apis/sheets/v2/spreadsheets/{ss_token}/values_batch_get?ranges={sheet_id}
       - GET /open-apis/sheets/v2/spreadsheets/{ss_token}/style?ranges={sheet_id}!A1:Z{rows} (粗体)
    3. 返回 { values: string[][], boldMask: boolean[][] }
```

## 3. SHEET token 解析

飞书 docx 的 `block.sheet.token` 格式：`{spreadsheet_token}_{sheet_id}`，下划线分割。

- 例：`DTLmsQUbyh8AJ3tfXawcZ0sanah_uq6m2M`
- spreadsheet_token: `DTLmsQUbyh8AJ3tfXawcZ0sanah`
- sheet_id: `uq6m2M`

split：`const [ssToken, sheetId] = token.split('_');`（取最后一个下划线作分隔——飞书 token 含字母数字 + 下划线时可能误切，但经验上 ss_token 部分不含下划线）

## 4. HTML 表格输出

第一行作 header，其余作 body。Bold cell 包 `<strong>`：

```html
<table>
  <thead>
    <tr>
      <th>维度</th>
      <th>信息</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td><strong>核心身份</strong></td>
      <td>AI 创业者，编程深海圈创始人...</td>
    </tr>
    ...
  </tbody>
</table>
```

defuddle 转 markdown：

```markdown
| 维度 | 信息 |
| --- | --- |
| **核心身份** | AI 创业者，编程深海圈创始人... |
```

## 5. Bold 检测策略

调 `/open-apis/sheets/v2/spreadsheets/{ss_token}/style?ranges={sheet_id}!A1:Z{rows}` 拿 cell style 数组。

判断逻辑（参考 `feishu-to-markdown` skill）：
- `style.font.bold === true` 或 `style.font.fontWeight >= 600` → bold
- **特例**：r=0（header 行）不包 `<strong>`，header 在 markdown 表格中自带 bold 渲染

如 style API 失败 → 输出表格但无粗体（降级，不致命）。

## 6. 并发 + 错误处理

- `Promise.all` 并发 fetch 所有 SHEET（用户文档 12 个 → 并发 ~1-2 秒）
- 单个 sheet 失败：输出 `<p>📊 [Sheet 加载失败]</p>` 占位 + logger.warn
- 全局 failure：保留 `[Embedded content: type 30]` 占位（用户至少知道有内嵌表格）

## 7. 文件改动

**修改**：
- `src/utils/feishu-extractor.ts`：
  - `case SHEET` 渲染占位（去掉 SHEET 从 Embedded fallback 组）
  - 新增 `fetchFeishuSheetData(token: string)`：消息桥
  - 新增 `resolveFeishuSheets(html: string)`：批量并发解析
  - `extractFeishuStructuredContent` 调用链末尾追加 `resolveFeishuSheets`

- `src/background.ts`：
  - 新增 `fetchFeishuSheetData(ssToken, sheetId, range)` 函数
  - 新增 `'fetchFeishuSheet'` message handler
  - 加入 allowlist

**不修改**：manifest（无新 permission，host 已含 open.feishu.cn）

## 8. 测试

### 自动化（chrome MCP）
- 用 cn 已有 page-world bridge 触发 extraction
- 用户 wiki/docx 含表格 → 验证 markdown 中：
  - 含 `| 维度 | 信息 |` 表格头
  - 含 `| **核心身份** |` 粗体单元格
  - 不再出现 `[Embedded content: type 30]`

### 手测
- Obsidian 中打开 vault 测试 markdown，看表格渲染

## 9. 范围之外

- SHEET 单元格内的图片 / 富文本（链接等）—— 飞书 sheets API 仅返回纯文本 + 基础 style
- 跨多 sheet tab 的 spreadsheet（每个 SHEET block 只引用一个 sheet_id，不在 scope）
- 公式（v2 API 默认返回 ToString 即计算结果，而非公式表达式）—— OK
- Bitable（多维表格）—— 那是另一种 block 类型，不在本次

---

**预估实施**：1-2 小时（spec + plan + 写代码 + 自动化测试）
