# cbex/jpxkc Extractor Design

**Date**: 2026-05-29
**Status**: Draft → 阿杜 review
**URL pattern**: `https://jpxkc.cbex.com/jpxkc/prj/detail/<prj_id>.html`
**Example**: <https://jpxkc.cbex.com/jpxkc/prj/detail/522611.html>

---

## 1. 背景与目标

北京产权交易所（cbex.com）「京牌小客车司法处置」是北京法院公开拍卖被执行人名下小客车的平台。每个标的物（一辆车）对应一个详情页，包含：

- 标题、标的物编号、竞价状态、起始价/成交价/保证金等关键交易字段
- 7 个 tab：标的物介绍 / 图片展示 / 司法处置公告 / 竞买须知 / 联系方式 / 竞价记录 / 竞价结果
- 买受人摇号信息（竞价结束后）

默认 Defuddle fallback 只能抓正文段落，丢失全部结构化字段与多 tab 内容。本 spec 设计一个专项 extractor，将完整结构化数据落地到 Obsidian markdown。

## 2. 架构

| 项 | 决策 |
|---|---|
| 文件 | `src/utils/cbex-extractor.ts` + `cbex-extractor.test.ts` + `cbex-extractor.e2e.test.ts` |
| URL 匹配 | `^https?://jpxkc\.cbex\.com/jpxkc/prj/detail/\d+\.html$` |
| 入口 | `export async function extractCbexStructuredContent(doc: Document): Promise<CbexContent \| null>` |
| 主路径 wire | `content.ts` 加 `isCbexPrjDetailUrl` 分支，并入 `getPageContent()` 的 merge 链（参考 docsqq/xiaoyuzhou 现有 pattern） |
| Bridge wire | `content.ts:711` origin 白名单加 `cbex.com$`；同样 routing 分支（满足 [[feedback_e2e_bridge_path_double_wire]] 双路一致铁律） |
| 失败兜底 | extractor `throw` 由 content.ts 主 catch 收集 → `ContentResponse.extractorWarnings` → popup 顶部黄 banner（i18n `extractorFailedFallback`，参 [[project_extractor_warning_banner]]） |

## 3. 数据形态

### 3.1 Frontmatter（YAML）

```yaml
title: "京NC6575别克牌SGM6527AT蓝小型汽车"
url: "https://jpxkc.cbex.com/jpxkc/prj/detail/522611.html"
source: cbex
subject_id: "202512NC6575"
status: 竞价结束
final_price: 30000.00
start_price: 20000.00
assess_price: 20000.00
cap_price: 30000.00
deposit: 20000.00
bid_start: "2025-12-15 08:00"
signup_end: "2025-12-12 15:00"
bid_count: 265
followers: 411
views: 124477
created: 2026-05-29
```

字段语义与缺省规则：

- `final_price`：仅当 DOM 里有「本标的物成交价：」时输出；否则字段缺省
- `subject_id`：去前缀「标的物编号：」；非 ASCII 字符照保留
- `status`：直接取 `.state_mark`（竞价结束 / 报价中 / 报名中 / 等）
- 价格字段统一去 `¥` 和千分位 `,`，输出 number；DOM 没有则缺省
- `bid_start` / `signup_end`：拼装为 `YYYY-MM-DD HH:MM` 字符串（去秒），保 quote 防 YAML 误解析
- 买受人摇号信息不进 frontmatter（不索引），仅在正文表格

### 3.2 正文骨架

```markdown
# 京NC6575别克牌SGM6527AT蓝小型汽车

## 关键信息

| 项目 | 内容 |
|---|---|
| 标的物编号 | 202512NC6575 |
| 竞价状态 | 竞价结束 |
| 起始价 | ¥20,000.00 |
| 评估价 | ¥20,000.00 |
| 最高限价 | ¥30,000.00 |
| 成交价 | ¥30,000.00 |
| 保证金 | ¥20,000.00 |
| 竞价开始时间 | 2025-12-15 08:00 |
| 报名截止时间 | 2025-12-12 15:00 |
| 买受人摇号编码 | 6035100088419 |
| 买受人摇号次数 | 87 |
| 买受人摇号注册时间 | 2011-01-02 13:23 |
| 关注数 | 411 |
| 围观数 | 124477 |
| 报价次数 | 265 |

## 标的物介绍

（ct1 内容，车辆参数表 / 介绍正文）

## 图片展示

![](https://jpxkc.cbex.com/editorUpload/file/.../car1.jpg)
![](https://jpxkc.cbex.com/editorUpload/file/.../car2.jpg)

## 司法处置公告

（ct4 公告正文，markdown 化）

## 竞买须知

（ct5 须知条款，markdown 化）

## 竞价记录

| 序号 | 出价人 | 价格 | 时间 |
|---|---|---|---|

## 竞价结果

（ct8 内容）

## 联系方式

业务咨询：4006121717
保证金收退咨询：4006891566
```

### 3.3 字段缺省规则

| 状态 | 缺省字段 |
|---|---|
| 未开始 / 报名中 | `final_price`、买受人三字段（DOM 无） |
| 报价中 | `final_price`、买受人三字段（DOM 无） |
| 竞价结束（未成交） | `final_price`（可能为 0 或缺省）、买受人字段（视情况） |
| 竞价结束（成交） | 全字段齐 |

「关键信息」表格中缺省行直接不输出（不留空白行）。

## 4. DOM 抽取策略

### 4.1 顶部已渲染字段（无需 lazy load）

| 字段 | selector / 提取方式 |
|---|---|
| `title` | `.bd_detail_name` |
| `subject_id` | `.bd_detail_num` text，正则去前缀 |
| `status` | `.state_mark` |
| 结束/开始时间组 | `.bd_detail_state_over .time_num` 序列（年月日时分秒按位置拼） |
| `bid_count` | `.jp_detail_bjnum span` |
| `followers` / `views` | `.bd_detail_head_rt` 内含「人关注」/「次围观」的兄弟 `.num`（待 plan 阶段 grep 确认 selector） |
| 价格组 | `.bd_detail_money_box` 内 `<li>` 文本，按文字关键字（起始价/评估价/最高限价/保证金）路由 |
| `bid_start` | 全文 text node 扫描「竞价开始时间：(\d{4}\.\d{2}\.\d{2} \d{2}:\d{2})」 |
| `signup_end` | 全文 text node 扫描「报名及保证金报名费交纳截止时间：」后跟随的中文日期串 |
| 买受人三字段 | `.bd_detail_head_rt` 或 `.jmr_info` 中含「摇号申请编码：」「摇号次数：」「摇号注册时间：」的 text node |

所有 helper 严格 `(doc: ParentNode)` 签名，禁止 `(html: string)`（参 CLAUDE.md Helper API 原则）。

### 4.2 Lazy load tab 处理：方案 B 优先 → A fallback

页面 inline JS 暴露端点（待 recon 阶段实测确认对应关系）：

| 端点 | 推测 tab | 待确认项 |
|---|---|---|
| `/page/jpxkc/prj/wtListPaging` | ct1 标的物介绍 | 是否同含车辆参数 + 图片列表？ |
| `/page/jpxkc/prj/ggnr` | ct4 司法处置公告 | 入参形式 |
| `/page/jpxkc/prj/prjBidInfo` | ct7 竞价记录 | 分页处理 |
| `/page/jpxkc/prj/jjjgListPaging` | ct8 竞价结果 | 数据 shape |
| ct2 图片展示 | 若不在 ct1 endpoint 返回内则单独 recon | |

**recon task（Plan 第 1 步）**：

1. 浏览器手动 click 各 tab，记录 DevTools Network 实际 URL / method / payload / response
2. 测试是否需 cookie 或 CSRF token（参 [[project_docs_qq_endpoints]] —— cbex 可能类似但具体 cookie/header 未知）
3. 测试是否需登录态：若公开则 `fetch` + `credentials: 'include'` 即可
4. 落 recon 文档到 `docs/superpowers/specs/2026-05-29-cbex-recon.md`（含响应 shape sample）

**方案 B 实现**：

```ts
async function fetchCbexTab(prjId: string, endpoint: string): Promise<string> {
  const res = await fetch(`${endpoint}?prjId=${prjId}`, {
    credentials: 'include',
    headers: { 'X-Requested-With': 'XMLHttpRequest' },
  });
  if (!res.ok) throw new Error(`cbex tab fetch failed: ${endpoint} ${res.status}`);
  return res.text();
}
```

**单 tab 级别 fallback（B → A）**：

- 某 endpoint recon 失败（鉴权复杂 / CSRF / 响应不可解析）时，该 tab 退回方案 A：JS 主动点击 + poll 100ms 直到 innerText.length 增长稳定或 5s 超时
- 全 5 个 tab 全失败：extractor return null → ContentResponse.extractorWarnings 警告（cbex tabs 加载失败，仅保留顶部信息）

### 4.3 图片处理

- ct2 图片：DOM 中找 `<img>` 元素，提取 `src`，按文档顺序 `![](src)` 嵌入「图片展示」section
- 若图片走 lazy load 且端点返回的是 HTML 片段：以 `DOMParser` 解析后取 `<img src>`
- 不做 base64 嵌入（参 feishu-extractor 的图片处理，cbex 图片走 CDN，不需 base64）

### 4.4 已知风险

| 风险 | 缓解 |
|---|---|
| 仅在「竞价结束」状态实测 | recon 阶段找一个「竞价中」或「报名中」URL 同步实测，避免单一状态盲区 |
| Lazy load 异步 → bridge 路径同步 trigger 易漏 | bridge handler 与主路径共用 `extractCbexStructuredContent`，内部统一 `await` 所有 tab fetch |
| AJAX endpoint 鉴权未知 | recon 阶段必须显式列出每个 endpoint 的 cookie / CSRF 要求；不可隐式假设 |
| cbex 站点改版可能改 selector | unit test 覆盖 DOM fixture；e2e 跑真实页面校验 byte-equivalent |

## 5. 测试与 ship 硬化

### 5.1 Unit test (`cbex-extractor.test.ts`)

- DOM fixture：截取 522611.html 顶部主区（不含 lazy tab）+ 一份 mock 竞买中状态
- 断言：
  - 顶部所有字段（标题/编号/状态/价格组/买受人/关注围观报价）正确提取
  - 价格 number 化（去 `¥` 与 `,`）
  - 状态字段切换：竞价结束 vs 竞价中，frontmatter 字段缺省正确
- 模式参 `weixin-extractor.test.ts` / `scys-extractor.test.ts`

### 5.2 E2E test (`cbex-extractor.e2e.test.ts`)

- 用 `runRealClip(URL)` 跑真 chrome 扩展
- 校验 markdown byte-equivalent 期望文件（fixture）
- **bridge 白名单需先加 `cbex.com$`**
- 同时验证「竞价结束」+ 至少 1 个其他状态（recon 阶段找到的二号 URL）

### 5.3 Helper API 约束

- `extractCbexStructuredContent(doc: Document)`：严格 DOM 签名（参 CLAUDE.md Helper API 原则）
- AJAX fetch 走独立 `fetchCbexTabContent(prjId, endpoint)` helper，方便单测 mock

### 5.4 Audit

- `audit-extractor-ship` skill 跑视觉验收（sbs grid）
- 主 session 派 subagent，输出 REPORT.md paste 进 ship checklist T5-2

### 5.5 Ship checklist（缺一不可）

按 [[feedback_extractor_acceptance]] 铁律：

- **T5-1**：`npm test`（含本 extractor unit）全 PASS
- **T5-2**：`audit-extractor-ship` REPORT.md（≥10 项 checklist，diff ≤ 阈值）paste 验收
- **T5-3**：`npm run test:e2e -- cbex` PASS
- **T5-4**：Obsidian.app 真截图（粘贴 frontmatter + 「关键信息」表格 + 4 tab section 的实际渲染）

任一缺失 → 不报验收，禁止默默退回。

### 5.6 二号 URL 验证

recon 阶段必须额外找一个「竞价中」或「报名中」URL，跑同样 e2e，避免「竞价结束」单一状态盲区。Recon 文档列出至少 2 个测试 URL。

## 6. 落地顺序（粗略，详见 plan）

1. Recon：浏览器实测各 tab 的 XHR endpoint 形态 → 写 recon 文档
2. 加 `isCbexPrjDetailUrl` URL 检测 + extractor 骨架文件
3. 实现顶部已渲染字段提取 + unit test
4. 实现方案 B fetch（按 recon 结果实现，单 tab 失败 fallback 方案 A）
5. 实现「关键信息」表格 / 各 tab markdown 拼装
6. wire 进 content.ts 主路径 + bridge 路径（双 wire）
7. 警告 banner i18n key 与 fallback 兜底
8. unit test + e2e test 全跑
9. audit-extractor-ship 视觉验收
10. ship checklist 4 项全跑 → 报阿杜验收

## 7. 参考

- 既有 extractor pattern：`src/utils/xiaoyuzhou-extractor.ts`（最新，含 bridge wire）
- Helper 严格 DOM 签名：`src/utils/weixin-extractor.ts` 的 `extractPublishedFromDocument`
- AJAX 端点鉴权教训：[[project_docs_qq_endpoints]]
- Ship 验收铁律：[[feedback_extractor_acceptance]]
- Bridge 双 wire 铁律：[[feedback_e2e_bridge_path_double_wire]]
- 警告 banner pattern：[[project_extractor_warning_banner]]
