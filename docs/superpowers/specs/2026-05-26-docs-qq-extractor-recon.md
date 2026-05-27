# docs.qq.com Endpoint Reconnaissance (2026-05-27)

> 用 playwright 自动化 + 注入 macOS Chrome cookie 抓 `https://docs.qq.com/doc/<token>` 页面点击导出 Word 按钮触发的网络请求 + 下载文件。
> 抓包过程脚本 `scripts/docs-qq-recon.mjs` 仅 reconnaissance 一次性用，task 完成后删除。

## 关键 UI 入口（reconnaissance 用）

腾讯文档新版没有传统的"文件"菜单文字按钮，而是右上角一个 **24×24 图标按钮**：

- selector: `[aria-label="file"]` 或 `.menu-button-file`
- 位置: viewport (1920×1080) 下 x≈1636, y≈14

> 这个 selector 只为 reconnaissance 自动化用。**extractor 运行时不点 UI**，直接调下面 4 个 HTTP endpoint。

---

## 1. 文档元数据 endpoint

### Request

```
GET https://docs.qq.com/cgi-go/padinfo/getpadinfo?encodePadId=<token>&infoKeys=[1,2]&xsrf=<xsrf_token>
Headers:
  Referer: https://docs.qq.com/doc/<token>
```

**变量**：
- `<token>` — URL path 里的 doc token，例如 `DQmZvdEFOR0RFWU9t`
- `<xsrf_token>` — CSRF token，从 cookie 字段 `xsrf` 读取（baseline 抓包看到值 `2f43999878bb37d0`）

### Response (200 JSON)

```json
{
  "retcode": 0,
  "msg": "成功",
  "data": {
    "padInfo": {
      "localPadId": "BfotANGDEYOm",        // ← 内部 padId
      "domainId": "300000000",
      "globalPadId": "300000000$BfotANGDEYOm" // ← 用于 export_office 的 docId
    },
    "privilegeAttribute": {
      "can_export": 1,
      "can_export_online": 1,
      ...
    },
    "title": "望岳投资250618十小时全文"   // ← title 字段
  }
}
```

**关键字段**：
- `data.title` → 文档标题
- `data.padInfo.globalPadId` → 拿来拼 export_office 的 `docId` 字段
- `data.privilegeAttribute.can_export` → 检查是否有权限导出（1 = yes）

**author / 时间字段**：getpadinfo 不返回 author / createTime / modifyTime。MVP 阶段：
- `author` 留空（或从 cookie/页面 hint 拿，v2 优化）
- `createTime` / `modifyTime` 留空（或后期从 docx zip 里 `docProps/core.xml` 拿，v2 优化）

---

## 2. 导出任务发起 endpoint

### Request

```
POST https://docs.qq.com/v1/export/export_office
Headers:
  Referer: https://docs.qq.com/doc/<token>
  Accept: application/json, text/plain, */*
  Content-Type: application/x-www-form-urlencoded;charset=UTF-8
Body (URL-encoded form data):
  exportType=0
  switches={"embedFonts":false}
  exportSource=client
  docId=<globalPadId>                       ← 例如 300000000$BfotANGDEYOm
  objectMapping={"hinaMappings":[]}
```

**变量**：
- `<globalPadId>` — 从步骤 1 拿到（形如 `300000000$BfotANGDEYOm`）

**实测 raw body**：
```
exportType=0&switches=%7B%22embedFonts%22%3Afalse%7D&exportSource=client&docId=300000000%24BfotANGDEYOm&objectMapping=%7B%22hinaMappings%22%3A%5B%5D%7D
```

### Response (200 JSON)

```json
{
  "ret": 0,
  "operationId": "144115212181264209_5a7a263e-ba8d-9c6b-4bf9-19cded663c22"
}
```

**关键字段**：
- `ret = 0` 表示成功（非 0 throw `DocsQQExportFailedError`）
- `operationId` 形如 `<uid>_<uuid>` — 异步任务 ID，用于后续轮询

---

## 3. 任务状态轮询 endpoint

### Request

```
GET https://docs.qq.com/v1/export/query_progress?operationId=<operationId>
Headers:
  Referer: https://docs.qq.com/doc/<token>
  Accept: application/json, text/plain, */*
```

**变量**：
- `<operationId>` — 步骤 2 拿到的任务 ID

### Response (200 JSON)

**Processing 状态**：
```json
{
  "ret": 0,
  "status": "Processing",
  "progress": 50,
  "attachments": [],
  "flags": {}
}
```

**Done 状态**：
```json
{
  "ret": 0,
  "status": "Done",
  "progress": 100,
  "file_url": "https://docs-import-export-1251316161.cos.ap-guangzhou.myqcloud.com/export/docx/BfotANGDEYOm/version_17247_144115212181264209.json.docx?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=...&X-Amz-Signature=...",
  "file_name": "望岳投资250618十小时全文.docx",
  "file_size": 28167079,
  "attachments": [],
  "flags": {}
}
```

**Failed 状态** (推测，本次未抓到)：
```json
{
  "ret": 0,
  "status": "Failed",
  ...
}
```
> spec 实现里 `status === 'Failed'` 或 `status === 'failed'` 都视作失败，throw `DocsQQExportFailedError`。

**关键字段**：
- `status`: 状态机 `Processing` / `Done` / `Failed`
- `progress`: 0-100
- `file_url`: status=Done 时才有，是腾讯云 COS signed URL（30 分钟过期）
- `file_name`: 建议的下载文件名（含中文，可忽略）
- `file_size`: bytes

**实测耗时**：从 export_office POST 到首个 `status=Done` 轮询响应约 4-6 秒（27MB docx 文档），spec 用 30s timeout 足够。

---

## 4. docx 文件下载 endpoint

### Request

```
GET <file_url>
```

**URL 实例**：
```
https://docs-import-export-1251316161.cos.ap-guangzhou.myqcloud.com/export/docx/
BfotANGDEYOm/version_17247_144115212181264209.json.docx?
X-Amz-Algorithm=AWS4-HMAC-SHA256&
X-Amz-Credential=AKID<REDACTED>%2F20260527%2Fap-guangzhou%2Fs3%2Faws4_request&
X-Amz-Date=20260527T060249Z&
X-Amz-Expires=1800&    # 30 分钟过期
X-Amz-SignedHeaders=host&
response-content-disposition=attachment%3Bfilename%3D...&
response-content-type=&
X-Amz-Signature=...
```

**注意事项**：
- 是腾讯云对象存储 (COS) 的 AWS4-HMAC-SHA256 签名 URL
- **不需要发送 cookie**（fetch 用 `credentials: 'omit'`，避免预检失败）
- **不需要发送 Referer**（COS 域不检查）
- 30 分钟过期（X-Amz-Expires=1800）
- response 是 .docx 二进制 (ZIP packaged Word document)

### Response

- Content-Type: `application/vnd.openxmlformats-officedocument.wordprocessingml.document` 或 `application/octet-stream`
- Body: docx ArrayBuffer，约 27MB（实测）

---

## 完整调用流程

```ts
// 1. 拿元数据 + globalPadId
const meta = await fetch(`https://docs.qq.com/cgi-go/padinfo/getpadinfo?encodePadId=${token}&infoKeys=[1,2]&xsrf=${xsrf}`, {
  credentials: 'include',  // 带 cookie
  headers: { 'Referer': `https://docs.qq.com/doc/${token}` },
}).then(r => r.json());

const { title, padInfo: { globalPadId } } = meta.data;

// 2. 发起导出
const exportRes = await fetch('https://docs.qq.com/v1/export/export_office', {
  method: 'POST',
  credentials: 'include',
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
    'Referer': `https://docs.qq.com/doc/${token}`,
  },
  body: new URLSearchParams({
    exportType: '0',
    switches: '{"embedFonts":false}',
    exportSource: 'client',
    docId: globalPadId,
    objectMapping: '{"hinaMappings":[]}',
  }).toString(),
}).then(r => r.json());

if (exportRes.ret !== 0 || !exportRes.operationId) {
  throw new DocsQQExportFailedError(`export_office returned ret=${exportRes.ret}`);
}
const { operationId } = exportRes;

// 3. 轮询
let fileUrl = null;
for (let i = 0; i < 30; i++) {
  await sleep(1000);
  const res = await fetch(`https://docs.qq.com/v1/export/query_progress?operationId=${encodeURIComponent(operationId)}`, {
    credentials: 'include',
    headers: { 'Referer': `https://docs.qq.com/doc/${token}` },
  }).then(r => r.json());

  if (res.status === 'Done') {
    fileUrl = res.file_url;
    break;
  }
  if (res.status === 'Failed') {
    throw new DocsQQExportFailedError(`query_progress reported Failed`);
  }
}
if (!fileUrl) throw new DocsQQTransientError('export timeout 30s');

// 4. 下载 docx
const arrayBuffer = await fetch(fileUrl, {
  credentials: 'omit',  // COS 不需要 cookie
}).then(r => r.arrayBuffer());

// 5. mammoth 转 HTML
const mammoth = await import('mammoth');
const { value: html } = await mammoth.convertToHtml({ arrayBuffer }, {
  convertImage: mammoth.images.imgElement(img =>
    img.read('base64').then(data => ({ src: `data:${img.contentType};base64,${data}` }))
  ),
});

return { title, content: html };
```

---

## CSRF (xsrf) token 来源

从 cookie 字段读取：

```ts
function getXsrfFromCookies(): string {
  const m = document.cookie.match(/(?:^|;\s*)xsrf=([^;]+)/);
  if (!m) throw new DocsQQAuthError('cookie 缺 xsrf token');
  return m[1];
}
```

**实测**：腾讯文档登录后 cookie 含 `xsrf=<16 字符 hex>`，值跟当前 session 绑定，刷新页面也不变（baseline + export 段抓到的 xsrf 值都是 `2f43999878bb37d0`）。

**⚠️ 2026-05-27 实测修正**: 上面写 "cookie 字段 `xsrf`" 是 reconnaissance 阶段误读 — 实际**腾讯文档没有名为 `xsrf` 的 cookie 字段**。真正的 CSRF token 来源是 **cookie 字段 `TOK`**，前端 JS 读 TOK 后作为 `?xsrf=<value>` query param 拼装到 URL 上 (所以 URL 里看到的 `xsrf=2f43999878bb37d0` 是这么来的)。

正确实现 (见 src/utils/docs-qq-extractor.ts getXsrfFromCookies):

```ts
function getXsrfFromCookies(): string {
	// 真实来源是 TOK cookie，xsrf 是历史误命名 (保留 fallback)
	const tokMatch = document.cookie.match(/(?:^|;\s*)TOK=([^;]+)/);
	if (tokMatch) return tokMatch[1];
	const xsrfMatch = document.cookie.match(/(?:^|;\s*)xsrf=([^;]+)/);
	if (xsrfMatch) return xsrfMatch[1];
	throw new DocsQQAuthError('cookie 缺 TOK token，请先登录腾讯文档');
}
```

---

## Mammoth 转换验证 (spike)

用 reconnaissance 拿到的 27MB 真实 docx 跑 mammoth.convertToHtml：

| 指标 | 值 |
|------|---|
| 输入 docx 体积 | 26.9MB |
| 输出 HTML 体积 | 35.5MB |
| 转换耗时 | 1124ms |
| Mammoth messages | 0 (无 warning) |
| 段落 `<p>` 数 | 1587 |
| 标题 `<h1>` / `<h2>` / `<h3>` | 1 / 5 / 90 |
| 加粗 `<strong>` | 411 |
| 斜体 `<em>` | 337 |
| 图片 `<img>` (全 base64 内嵌) | 110 |
| 公式 `<math>` | 0 (该文档无公式) |

**结论**：mammoth.convertToHtml 对腾讯文档导出的 .docx 工作良好，无需特殊配置。

---

## 反向工程边界 + 风险

1. **接口路径稳定性**：`/v1/export/export_office` + `/v1/export/query_progress` 是腾讯文档 v1 API 路径，命名结构暗示版本化，相对稳定。但腾讯无对外文档承诺兼容性。
2. **CSRF token 来源**：当前从 cookie `xsrf` 字段读。若腾讯改成 page meta 或 header inject，需更新读取逻辑。
3. **会员限制**：getpadinfo response 的 `privilegeAttribute.can_export` 字段表征用户是否有导出权限。401/403 时 throw `DocsQQAuthError`，提示登录或换会员。
4. **COS signed URL 过期**：30 分钟有效，足够裁剪流程（轮询完到下载通常 < 1s）。无需特殊处理 expired URL。
5. **接口变更回归**：若 schema 变（如 `file_url` 改成 `download_url`），重跑 `scripts/docs-qq-recon.mjs`（恢复脚本到本仓库 git 历史）抓新 schema，对照本文档更新 extractor 字段读取。
