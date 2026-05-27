# F5：飞书文档附件（FILE block）下载 设计文档

**日期**：2026-05-14
**目标**：在剪存飞书文档时下载附件（PDF / Office / 通用 file block）作为 base64 data URL 嵌入 Markdown，与现有图片处理体验对齐；超大文件留飞书原链接 fallback。

## 1. 问题陈述

cn 当前飞书 file block 处理（`src/utils/feishu-extractor.ts:676-682`）：

```ts
case FEISHU_BLOCK_TYPE.FILE: {
    const file = block.file;
    if (file?.name) {
        return `<p>[File: ${escapeHtml(file.name)}]</p>`;
    }
    return '';
}
```

只输出占位文字，**从未下载附件**。用户 Phase 10 手测发现：含 PDF 附件的飞书文档剪存后 PDF 内容完全缺失。

## 2. 设计概览

**复制图片处理路径**（架构对称，零风险新机制）：

```
渲染阶段（content side）:
  feishu-extractor: block.file → <a href="feishu-file://TOKEN" data-filename="x.pdf" data-size="...">x.pdf</a>
  resolveFeishuFiles(html) → 把 placeholder href 转 data:URL（或 fallback）
  fetchFeishuFileDataUrl(token) → 发消息给 background

后台阶段（service worker）:
  onMessage 'fetchFeishuFile' → fetchFeishuFileAsBase64(token)
  → HEAD 请求看 Content-Length
  → 如 >10MB 返回 { tooLarge: true, size }
  → 否则 GET https://open.feishu.cn/open-apis/drive/v1/medias/{token}/download
  → tenant token 鉴权
  → 转 base64 data URL（保留响应的 Content-Type）
```

## 3. 详细设计点

### 3.1 Placeholder URL schema
- `feishu-file://TOKEN` —— 与图片 `feishu-image://TOKEN` 对称

### 3.2 HTML 渲染（feishu-extractor）
```html
<a href="feishu-file://TOKEN" data-filename="x.pdf" data-size="3145728">x.pdf</a>
```
- `data-filename`：用于 fallback 显示
- `data-size`：来自飞书 API block.file.size 字段（如有）；用于客户端预判，避免无谓 HEAD 请求

resolve 后：
```html
<a href="data:application/pdf;base64,...">x.pdf</a>
```

defuddle 转 markdown：`[x.pdf](data:application/pdf;base64,...)`

### 3.3 MIME type
- 从 download 响应 `Content-Type` 取
- 兜底 `application/octet-stream`

### 3.4 大小阈值与判断时机
- 阈值：**10 MB**（base64 化后约 13 MB；与现有图片体验对齐）
- 判断顺序：
  1. 优先使用 `data-size` 属性（来自 block.file.size，零网络成本）
  2. 若无 size，发 HEAD 请求看 `Content-Length`
  3. HEAD 不支持时（403/405）回退：直接 GET 下载，下载完后看 bytes
- 超阈值 → 跳过 base64 化，输出 fallback 占位

### 3.5 大文件 fallback
markdown 输出：
```markdown
📎 **x.pdf** *(15.2 MB — 请到原飞书文档下载)*
```

具体 HTML（在 resolveFeishuFiles 中替换原 placeholder）：
```html
<p>📎 <strong>x.pdf</strong> <em>(15.2 MB — 请到原飞书文档下载)</em></p>
```

- 大小格式：`formatFileSize(bytes)` 用 KB/MB 单位
- **不**附带飞书原 URL：飞书 docx 中 file token 不能直接转用户可访问的 web URL（需登录态 + 复杂跳转），强行附 URL 可能误导用户

### 3.6 错误处理
- 下载失败（401/404/网络）：`logger.warn` + 输出 `📎 x.pdf (下载失败)` 占位
- **不抛错**——避免整篇文档剪存中断
- 与现有 `fetchFeishuImageDataUrl` 错误风格一致

### 3.7 飞书 API endpoint
- **沿用** `https://open.feishu.cn/open-apis/drive/v1/medias/{file_token}/download`
- 假设：file block 的 file_token 与 image block 的 token 都属于飞书"媒体"体系，可用同一接口下载
- 若 API 不通（404 / "wrong resource type"）：需调整 endpoint（候选：`/files/{token}/download`），方案 fallback 在 Phase 7（implementation）发现

### 3.8 Manifest
**无改动** —— `https://open.feishu.cn/*` host_permissions 已存在（图片复用）

### 3.9 用户文档
更新 `README.md` / `README_EN.md` 的飞书章节加一段：
> **附件下载**：文档内的 PDF / Office / 通用附件会自动下载并以 base64 data URL 嵌入 markdown（< 10 MB）。超过 10 MB 的附件留占位提示，请到原飞书文档手动下载。

## 4. 文件改动清单

**修改：**
- `src/utils/feishu-extractor.ts`
  - 改 `case FEISHU_BLOCK_TYPE.FILE`（行 676-682）：渲染为占位 `<a>` 标签
  - 新增 `resolveFeishuFiles(html: string): Promise<string>` 函数
  - 新增 `fetchFeishuFileDataUrl(token: string): Promise<{ dataUrl?: string; tooLarge?: boolean; size?: number; mimeType?: string; error?: string }>` 函数
  - 新增 `formatFileSize(bytes: number): string` helper
  - 在 `extractFeishuStructuredContent` 末尾 `resolveFeishuImages` 之后调用 `resolveFeishuFiles`

- `src/background.ts`
  - 新增 `fetchFeishuFileAsBase64(token: string): Promise<{ dataUrl?: string; tooLarge?: boolean; size?: number }>` 函数
  - 新增 `onMessage 'fetchFeishuFile' action`
  - 把 `'fetchFeishuFile'` 加入 message allowlist（与 `'fetchFeishuImage'` 同位置）

- `README.md`, `README_EN.md`
  - 飞书章节加一段附件说明（中英文）

**不修改：**
- `src/manifest.*.json`（host_permissions 已覆盖）
- `src/utils/feishu-extractor.ts` 其他 block 类型处理

## 5. 测试

### 5.1 静态验证
```bash
npx tsc --noEmit                # 无新错误
npm test                         # 574 + 3 known baseline
npm run build:chrome             # 成功
```

### 5.2 手测（Chrome）
- [ ] 含小 PDF（< 10MB）的飞书文档：剪存 → markdown 含 `[x.pdf](data:application/pdf;base64,...)`，粘到 Obsidian 后能点击 link 打开 PDF
- [ ] 含大文件（> 10MB）的飞书文档：剪存 → markdown 含 `📎 x.pdf (15.2 MB — 请到原飞书文档下载)`
- [ ] 多 file block 混合（图片 + PDF + 通用文件）：全部正常处理
- [ ] 飞书 API 凭证未配置 / 失效：file block 输出 `📎 x.pdf (下载失败)`，文档其他内容不受影响（**不中断剪存**）
- [ ] 含 PDF 的飞书 wiki 文档：同 docx 行为
- [ ] 回归：纯文本飞书文档（无附件）：行为不变
- [ ] 回归：含图片飞书文档：图片仍以 base64 嵌入

### 5.3 单元测试
不强制新增。如 `src/utils/feishu-extractor.test.ts` 已存在，加 placeholder 生成 + resolveFeishuFiles 的 mock 测试。

## 6. 风险与回滚

### 风险
1. **API endpoint 假设错**：file_token 不能走 `/medias/{token}/download` → 收到 404 / 错误响应
   - 缓解：实施时第一步在 Phase 7 加日志验证；如不通 fallback 到候选 endpoint
2. **大文件下载耗时**：10MB 文件 base64 化耗时几秒；用户感知"剪存慢"
   - 缓解：fetch 用 `cache: 'no-store'` 减少 stale 概率；UI 不阻塞（已是 async）
3. **HEAD 请求飞书不支持**：很多 API 服务器 HEAD 返回 405
   - 缓解：HEAD 失败回退 GET 后检查长度
4. **md 文件膨胀**：用户大量剪存含附件文档，每个 md 5-10MB
   - 缓解：README 加提示 + 推荐 Obsidian Local Image Plus 插件后处理

### 回滚
- 单文件 + 1 个 message action，回滚简单：`git revert <commit>`
- 文档改动单独 commit，可独立回滚

## 7. 范围之外

- **附件预览 / 内嵌 PDF iframe**：太重，YAGNI
- **下载到本地附件文件夹**：浏览器扩展无法直接写本地任意路径
- **不同 mime 不同处理**（如 PDF iframe、视频 video tag）：留作后续 feature
- **进度条 / 取消下载**：用户期望偶尔剪存，YAGNI
- **size cap 可配置**：默认 10MB 固定；如有需求再加 settings 项

---

**预计实施**：2-3 hr（实施）+ 30 min（手测）= ~3 hr
