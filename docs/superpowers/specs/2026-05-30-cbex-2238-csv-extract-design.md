# cbex-2238 markdown → CSV 结构化提取（设计）

**Date**: 2026-05-30
**Status**: Design（Phase 0 discovery 已完成）
**Predecessor**: `2026-05-30-cbex-jpxkc-batch-audit-2238-design.md`
**Methodology**: 完全套用 `batch-clip-audit` skill（应审尽审 + 100% PASS + 单次阿杜介入 + 阶段闸门）

## 1. 背景与目标

`.claude/cbex-batch-2238/markdown/*.md` 已有 542 个通过 audit 的 cbex/jpxkc 标的物裁剪结果。目标：把每个 markdown 解析为一行 **32 列**的 CSV，供数据分析使用。

阿杜约束（不可妥协）：
1. 数据形态盘点覆盖**全 542 辆**（已落地，见 §3）
2. 费用项目名目不固定，处理"先总价再细分"重复计算陷阱
3. 测试 + 验收完全按 `batch-clip-audit`：100% PASS 才能给阿杜看
4. **每 Phase 都要阶段报告 + checklist + PASS 才进下一 Phase**
5. A/B 路径：markdown 不是唯一 source — **原车辆 URL 内容是独立 ground truth**

## 2. 32 字段列表（阿杜锁定，不可增删）

```
ID, 标的物编号, 标题, 车辆URL, 法院, 竞价开始时间, 总价, 起始价, 评估价,
保证金, 最高限价, 违章罚款, 违章次数, 扣分, 停车维修费, 配钥匙费,
其他费用, 是否抵押, 行车里程, 车辆出厂日期, 初次登记日期, 登记至今间隔,
强制保险终止日期, 商业保险终止日期, 检验有效期终止日期, 车辆报废止期,
逾期检验报废期, 车辆型号, 发动机号, 车辆识别代码, 车辆登记证书编号, 排放标准
```

（共 32 列，含 ID。其中 4 字段来自 frontmatter 直接透传 + 28 字段从 markdown body / ggnr 公告解析或计算）

## 3. Phase 0：数据形态全量发现（已完成）

### 3.1 脚本

`scripts/cbex-csv-pattern-discovery.ts` 扫全 542 个 markdown，输出：

| 文件 | 内容 |
|---|---|
| `.claude/cbex-batch-2238/discovery/section-text.json` | 每文件 4 段 textContent（权利限制 / 标的现状 / 标的介绍 / 公告头部） |
| `.../discovery/labels.json` | 两个 section 的中文 label 全集 |
| `.../discovery/value-patterns.json` | 21 个字段的 unique raw value top-50 |
| `.../discovery/fee-patterns.json` | 80 类费用名目聚类 + 出现次数 |
| `.../discovery/court-patterns.json` | 48 个法院 + 195 个双源不一致案例 |

### 3.2 关键发现（驱动 §4 算法设计）

**违章记录 168 unique 形态**：
- 标准三元组：`X 起，Y 分，Z 元；`
- 双地域：`京内 X 起，Y 分，Z 元；京外 X 起；` （107 个文件）
- 短形态：`X 起，Z 元`（缺 Y 分；3 个文件）
- 极短：`X 起，Y 分，`（缺罚款；样本中存在）
- 55 个文件该 label regex 完全未命中（可能是更早终止符或格式异常）

**是否抵押 9 unique 值**（已覆盖）：
- 是 / 已抵押 / 有抵押 / 有 → 归一为 `是`
- 否 / 未抵押 / 无抵押 / 无 → 归一为 `否`
- empty (8 个文件) → `未知`

**排放标准 17 unique 值**：
- 国五 / 国V / 国Ⅴ / 国 5 / 国 5 → `国五`
- 国四 / 国IV / 国 IV → `国四`
- 国六 / 国VI → `国六`
- 国三 / 国三及以上 → `国三`

**法院**：
- **48 个不同法院** — 不止北京市，含河北省、外地（如"河北省张家口市中级人民法院"、"三河市人民法院"、"保定市莲池区人民法院"）
- **195 个文件双源不一致**：
  - 157 个仅前缀差（如"丰台区人民法院" vs "北京市丰台区人民法院"）→ 公告源更标准（带"北京市"）
  - 38 个跨法院差（如"三河市人民法院"权利限制 vs "北京市延庆区人民法院"公告）→ 语义差异：权利限制段是**查封法院**，公告段是**处置法院**。阿杜要的"管辖法院"= 公告源（处置法院）

**费用模式**：
- "需要另行按照每天 X 元"出现 **483 次**（日费率 — 必须排除）
- "停车、维修等费用：X 元"347 次（最常见标准）
- 总价 marker 5 种："共计 / 共计约 / 合计 / 总计 / 车辆的费用共计"
- 配钥匙费两种 label："配钥匙费用 X 元" / "配钥匙的相关费用为 X 元"
- 分项明细句式（**"先总价后分项"陷阱**）：
  - `维修费 X 元、停车费 X 元，共计 Z 元`（37 次）→ 用 Z 跳过 X
  - `车辆的费用共计 Z 元（其中 A 元汇入...账户，B 元...）`（37 次）→ 用 Z 跳过 A+B
  - `维修费用 X 元、停车费用约 Y 元`（23 次）→ 无总价 → 直接 X+Y

**车辆出厂日期 364 个文件命中**：
- 4 unique 值，全是"不详"变体（`不详 / 不详；/ 不祥 / 不详。`）— 含错别字"不祥"
- 164 文件 regex 未命中（标的介绍 row 末尾的 `<p>` 结构差异 — Phase 1 用按 `<p>` block 解析覆盖）

**初次登记日期 540 文件 empty**：discovery regex 完全失败（受 `[^123、，,]{1,20}` 限制太严）— Phase 1 算法须按 `<p>` 单段解析，不能依赖数字编号 lookahead

**车辆识别代码 (VIN) 等定长字段**：长度 17 位字母数字 — 可作格式自校验

## 4. 字段提取算法（基于 §3 discovery 数据）

### 4.1 通用解析策略

**统一按 `<p>` block 解析**（不依赖"1、2、3、"数字编号 lookahead，避免 §3 发现的 540 个初次登记日期 empty 问题）：

```ts
function splitToParagraphs(html: string): string[] {
  const { document } = parseHTML(`<html><body>${html}</body></html>`);
  return Array.from(document.querySelectorAll('p')).map((p) =>
    (p.textContent || '').replace(/[\s ]+/g, '').trim()
  ).filter(Boolean);
}
```

每个 `<p>` ≈ 一个字段或一句话。按 paragraph 找含特定 label 的那段，再 split `[：:]` 取后半部分。

### 4.2 来自 frontmatter（直接透传）

| CSV 列 | frontmatter key |
|---|---|
| ID | 文件名 `basename(file, '.md')` |
| 标的物编号 | `subject_id` |
| 标题 | `title` |
| 车辆URL | `source` |
| 竞价开始时间 | `bid_start` |
| 起始价 | `start_price` |
| 评估价 | `assess_price` |
| 保证金 | `deposit` |
| 最高限价 | `cap_price` |

### 4.3 来自"权利限制及瑕疵"行

| CSV 列 | 算法 |
|---|---|
| 违章次数 | scan 该行内所有 `(\d+)\s*起[，,]` → sum |
| 扣分 | scan 所有 `\d+\s*起[，,]\s*(\d+)\s*分` → sum |
| 违章罚款 | scan 所有 `\d+\s*起[，,].*?[，,]\s*(\d+)\s*元` → sum（容错短形态：`X 起，Z 元` 也接受） |
| 是否抵押 | 找以 `(?:是否)?抵押[：:]` 起始的 `<p>`（discovery: 0 个文件存在"是否抵押"前缀，但容错保留）→ 取 `[：:]` 后段 → 在第一个 `（` / `；` / 数字编号前截断 → `normalize抵押()` |
| 停车维修费 | 见 §4.5 算法 |
| 配钥匙费 | 见 §4.5 |
| 其他费用 | 见 §4.5 |

### 4.4 来自"标的介绍"行（按 `<p>` block，每段一字段）

| CSV 列 | 该段 label（在 `<p>` textContent 起始处） |
|---|---|
| 车辆出厂日期 | `车辆出厂日期` / `出厂日期` |
| 初次登记日期 | `初次登记日期` |
| 行车里程 | `行车里程` / `里程表显示行车里程` |
| 强制保险终止日期 | `强制保险终止日期` |
| 商业保险终止日期 | `商业保险终止日期` |
| 检验有效期终止日期 | `检验有效期终止日期` |
| 车辆报废止期 | `车辆报废止期` |
| 逾期检验报废期 | `逾期检验报废期` |
| 车辆型号 | `车辆型号` |
| 发动机号 | `发动机号` |
| 车辆识别代码 | `车辆识别代码` |
| 车辆登记证书编号 | `车辆登记证书编号` |
| 排放标准 | `排放标准` |

提取通用代码：

```ts
function getField(paragraphs: string[], ...labels: string[]): string {
  for (const p of paragraphs) {
    for (const l of labels) {
      // 必须 `^label:` 起始（label-prefix），不允许子串
      const re = new RegExp(`^${l}[：:]([^]+)$`);
      const m = p.match(re);
      if (m) return m[1].trim().replace(/^\d+[、.]/, ''); // 去尾巴可能粘的下一字段开头数字编号
    }
  }
  return '';
}
```

对日期字段：调用 `normalize日期()`（§4.6）。对排放标准：`normalize排放标准()`。对其他：原文 trim。

### 4.5 费用算法（基于 §3 fee-patterns 真实数据）

```ts
function extract费用(权利限制Text: string): {
  违章罚款: number;
  停车维修费: number;
  配钥匙费: number;
  其他费用: number;
} {
  // STEP 1: 排除非费用片段（这些 X 元不参与 cluster）
  //   ① "每天 X 元" / "24 小时 X 元" / "X 小时 X 元" — 日/时费率（discovery: 483 + 8 次）
  //   ② "X 元/天" / "X 元/小时" 反向同义
  //   ③ 违章罚款 "X 起，Y 分，Z 元" 的 Z 元（避免与 STEP 2 双算）
  let cleaned = 权利限制Text
    .replace(/(?:每天|24\s*小时|\d+\s*小时)\s*\d+(\.\d+)?\s*元/g, '')
    .replace(/\d+(\.\d+)?\s*元\s*\/\s*(天|小时)/g, '')
    .replace(/\d+\s*起[，,][^；;]*?元/g, '');

  // STEP 2: 违章罚款（原文，京内 + 京外求和）
  const 违章罚款 = sum 京内/京外 中 `\d+起[，,].*?(\d+)\s*元` 的 \1
                 + 短形态 `(\d+)起[，,]\s*(\d+)\s*元`（缺扣分时）的 \2;

  // STEP 3: 命名费用项 — 在 cleaned text 上跑
  //   停车维修费的多种形态（discovery 发现）：
  //     a) "停车、维修等费用：X 元"
  //     b) "停车、维修等费用：维修费 X 元，停车费 Y 元，共计 Z 元"  → 用 Z
  //     c) "停车、维修等费用：拖运费用 X 元、停车费用 Y 元、维修费用 Z 元、其他费用 W 元" → sum 或共计 total
  //     d) "停车、维修等费用：车辆的费用共计 X 元由竞买人负担（其中 A 元汇入..账户，B 元...）" → 用 X
  //   策略：定位"停车、维修等费用：" 后到下一个段落"5、" / "其他瑕疵" 之间的整段（feeBlock）
  //         在 feeBlock 内调 clusterFeesByTotalMarker（§4.5.1）
  //   extract停车维修费用Block 实现：
  //     输入 cleaned，找 /(?:4、)?停车[、，]?维修[^：:]{0,5}[：:]/ 起始 offset
  //     找下一个 /5、|其他瑕疵披露|拟提供的文件|备注/ 作终止 offset
  //     返回该区间 substring；无停车维修费 label 时返回 ''
  const feeBlock = extract停车维修费用Block(cleaned);
  const 停车维修费 = clusterFeesByTotalMarker(feeBlock).sum();
  //   若 feeBlock 内含"无停车费" / "0 元" → 停车维修费 = 0

  // STEP 4: 配钥匙费（两种 label，discovery 都见过）
  const 配钥匙费 = match(/配钥匙费用?\s*[：:]?\s*(\d+)\s*元/, cleaned)
                ?? match(/配钥匙的相关费用为\s*(\d+)\s*元/, cleaned)
                ?? 0;

  // STEP 5: 其他费用 — cleaned 内 feeBlock 之外的其余 X 元
  //   包括"特别提示"段里的拖车费 / 修理费 / 恢复原貌修理费用 等
  const restText = cleaned.replace(feeBlock, '').replace(/配钥匙费用?\s*[：:]?\s*\d+\s*元/g, '');
  const 其他费用 = clusterFeesByTotalMarker(restText).sum();

  return { 违章罚款, 停车维修费, 配钥匙费, 其他费用 };
}
```

#### 4.5.1 clusterFeesByTotalMarker — 处理"先总价后分项"

```ts
function clusterFeesByTotalMarker(text: string): number[] {
  // 找所有 X 元的 (number, offset)
  const fees = [...text.matchAll(/(\d+(?:\.\d+)?)\s*元/g)]
    .map(m => ({ value: +m[1], offset: m.index! }));

  // 找所有总价 marker 的位置（discovery 发现 5 种）
  //   "共计 X 元" / "共计约 X 元" / "合计 X 元" / "总计 X 元" / "车辆的费用共计 X 元"
  const totalMarkers = [...text.matchAll(
    /(?:车辆的费用)?(?:共|合|总)计(?:约)?\s*(\d+(?:\.\d+)?)\s*元/g
  )].map(m => ({ value: +m[1], offset: m.index! }));

  // 划组：对每个 totalMarker，往前回看 100 字内的所有 fee 划入"该组"，组取 totalMarker.value
  // 同时 totalMarker 自身的 fee 也归该组
  const grouped = new Set<number>(); // fee offset
  const groupReps: number[] = [];

  for (const tm of totalMarkers) {
    groupReps.push(tm.value);
    grouped.add(tm.offset);
    for (const f of fees) {
      if (f.offset < tm.offset && tm.offset - f.offset < 100 && !grouped.has(f.offset)) {
        grouped.add(f.offset);
      }
    }
  }

  // 没被任何 total 覆盖的 fee → 各自独立成项
  for (const f of fees) {
    if (!grouped.has(f.offset)) groupReps.push(f.value);
  }
  return groupReps;
}
```

### 4.6 法院字段（来自公告 section，阿杜约束 #1）

```ts
function extract法院(公告Text: string, 权利限制Text: string): string {
  // 优先源：公告 section 头 "XX人民法院将于"
  //   该源 discovery 显示 14 个文件 empty（公告段头部模板异常）
  const m1 = 公告Text.match(/([一-龥]{2,20}人民法院)将于/);
  if (m1) return m1[1];

  // 公告 alt 路径：公告 section 末尾署名
  //   实际文件公告段尾多有 "北京市XXX人民法院\n二〇XX年X月X日" 署名
  const m1b = 公告Text.match(/([一-龥]{2,20}人民法院)\s*$/m);
  if (m1b) return m1b[1];

  // 回退源：权利限制段 "被 XX 法院查封"
  //   ⚠️ 该回退源在 38/542 文件里 ≠ 公告源（查封法院 ≠ 处置法院）— stderr WARN
  //   discovery 显示该源常缺省市前缀，但不能盲目补"北京市"（如"安次区人民法院"在河北廊坊）
  //   策略：原文返回 + 留 normalize法院() 跟同 ID 公告源对照补全
  const m2 = 权利限制Text.match(/被([一-龥]{2,20}人民法院)/);
  if (m2) return m2[1];

  return '';
}

function normalize法院(raw: string, sources: { 公告: string; 权利限制: string }): string {
  if (!raw) return '';
  // 若 raw 带省/市前缀 → 直接 trim 返回
  if (/^(.{2,5}省|.{2,5}市|北京市|天津市|上海市|重庆市)/.test(raw)) return raw.trim();
  // 若 raw 无前缀 → 看公告源是否有 "XXX市|XXX省" 前缀含同名 raw → 补前缀
  const m = sources.公告.match(new RegExp(`(.{2,5}(?:市|省))${raw}`));
  if (m) return m[1] + raw;
  // 都拿不到 → 原文 + stderr WARN
  process.stderr.write(`[WARN] 法院字段无法补全前缀: raw='${raw}'\n`);
  return raw;
}
```

### 4.7 计算列

```ts
总价 = cap_price + 停车维修费 + 违章罚款 + 配钥匙费 + 其他费用
登记至今间隔 = ((today - 初次登记日期) / 365.25).toFixed(1)
   // today = 脚本启动时的 YYYY-MM-DD
   // 初次登记空 → 间隔空
   // 日期解析失败 → 间隔空
```

### 4.8 归一化函数

```ts
normalize抵押(raw) → '是' | '否' | '未知'
  '是' | '已抵押' | '有抵押' | '有'             → '是'
  '否' | '未抵押' | '无抵押' | '无'              → '否'
  ''                                              → '未知'
  其他                                            → '未知' + stderr WARN

normalize排放标准(raw) → '国三' | '国四' | '国五' | '国六' | raw
  正则 `国(三|3|III)`                            → '国三'
  正则 `国(四|4|IV)`                             → '国四'
  正则 `国(五|5|V|Ⅴ)`                            → '国五'
  正则 `国(六|6|VI|Ⅵ)`                           → '国六'
  其他                                            → raw + stderr WARN

normalize日期(raw) → YYYY-MM-DD | ''
  '不详' | '不祥' | '不明' | '无' | ''           → ''  (含错别字)
  YYYY[/-.]M[/-.]D                                → 补零后输出
  YYYY 年 M 月 D 日?                              → 补零后输出
  其他                                            → '' + stderr WARN
```

（`normalize法院` 见 §4.6，由于依赖同 ID 双源对照不能纯归一表表达）


## 5. A/B 路径设计（阿杜约束 #3）

**A 路径** = 远端 `cbex.com/page/jpxkc/prj/ggnr` XHR 返回的公告 HTML + cbex/jpxkc list-item HTML（联合 source），独立解析 32 字段
**B 路径** = 本地 markdown（frontmatter + body）解析 32 字段

两路径都用 §4 的同一套算法（接受 raw HTML / raw markdown 任一），但解析 input 完全独立。audit = A == B。

| 字段类 | A 路径 source | B 路径 source |
|---|---|---|
| frontmatter 9 字段（ID/编号/标题/URL/竞价时间/起始价/评估价/保证金/最高限价） | list-item HTML（ID/编号/标题/URL/起始价/竞价时间）+ ggnr XHR 公告头部段（评估价/保证金/最高限价） — 2 源联合 | 本地 markdown frontmatter |
| 法院 | ggnr XHR 公告 section | 本地 markdown 公告 section |
| 违章 3 字段 + 是否抵押 + 停车维修费 + 配钥匙费 + 其他费用 | ggnr XHR 权利限制 row | 本地 markdown 权利限制 row |
| 7 个日期字段（出厂/初登/强保/商保/检验/报废止/逾期检验） + 行车里程 + 4 个车辆参数（型号/发动机号/VIN/登记证书） + 排放标准 | ggnr XHR 标的介绍 row | 本地 markdown 标的介绍 row |
| 总价（derived） | A 路径计算 | B 路径计算 |
| 登记至今间隔（derived） | A 路径计算 | B 路径计算 |

**ggnr XHR 已是 cbex-batch-audit-2238 的现成工具**（详 `scripts/cbex-batch-audit.ts` L186）：

```ts
ggnrXhr = await refetchXhr(
  'https://jpxkc.cbex.com/page/jpxkc/prj/ggnr',
  `BDID=${bdid}`,
  listUrl
);
```

3 次重试，5/10/20s backoff。失败 → audit_infrastructure_error（停跑修工具，不当字段 FAIL）。

**A == B 校验规则**：

| 字段类型 | 校验 |
|---|---|
| string（标题 / 法院 / 车辆型号 / VIN / ...） | `normalize ws` 后 `===` |
| number（价格 / 费用 / 里程） | `Math.abs(a - b) < 0.01` |
| 日期（YYYY-MM-DD） | `===` |
| derived（总价 / 登记至今间隔） | A 路径 derived == B 路径 derived |
| 归一化字段（抵押 / 排放） | 归一后 `===` |

## 6. 架构

```
scripts/
├─ cbex-csv-pattern-discovery.ts   # Phase 0：已完成
├─ cbex-csv-extractor.ts           # §4 32 字段 extractor（input 兼容 markdown / ggnr HTML）
├─ cbex-csv-validator.ts           # §5 A/B 双路径 audit
├─ cbex-csv-report.ts              # REPORT.md generator
└─ cbex-csv-batch-export.ts        # CLI：跑全 542 → CSV + progress.json + diffs-fail + REPORT.md

src/utils/
├─ cbex-csv-extract.ts             # 纯函数
│   ├─ parseMarkdown(text)
│   ├─ extractTableSections(htmlOrMd) → { 权利限制Text, 标的介绍Text, 公告Text }
│   ├─ extract违章 / extract抵押 / extract费用（含 clusterFeesByTotalMarker）
│   ├─ extract车辆参数 / extract法院
│   ├─ normalize抵押 / normalize排放 / normalize日期 / normalize法院
│   ├─ compute总价 / compute登记至今间隔
│   └─ extractAllFields(input) → Record<32 fields>
├─ cbex-csv-extract.test.ts
└─ cbex-csv-validator.test.ts
```

## 7. 阶段闸门（阿杜约束 #4，按 batch-clip-audit）

### 7.0 Step Report 必填 schema

每 Phase 完成强制落一份 step report，**严格按** `.claude/skills/batch-clip-audit/references/step-report-template.md` schema：

```markdown
# Step <step-id> — <title>

- 时间：YYYY-MM-DD HH:MM → HH:MM（耗时 X 分钟）
- worktree 状态：commit SHA `<hash>` on branch `<branch>`
- 类型：[code-phase-A | code-phase-B | audit-round | fix | verify | ship]
- 上游依赖 step：[step-XX] | 无
- 下游影响 step：[step-YY] | 末 step

## 目标
<本 step 想达成什么具体结果>

## 工作内容
<具体做了哪些事，按时间序>

## 遇到的问题
- P1: <问题描述>
- P2: ...
（若无填「无」）

## 解决方案
- P1 → <解决方案>
- P2 → ...

## 验收标准
- [ ] 标准 1
- [ ] 标准 2

## 验收结果
- ✅ 标准 1: <证据>
- ✅ 标准 2: ...

## 决策声明（强制 6 项）
- 擅自降级 audit 标准: **否** ✓
- 偷懒/跳步: **否** ✓
- 妥协/接受次优: **否** ✓
- 问题应修尽修（fix/audit-round/verify/ship 必填）: **是** ✓
- 字段集合应审尽审（audit-field-discovery + code-phase-B 必填）: **是** ✓
- 字段 5-attempt 充分搜索（audit-field-path-design + code-phase-B 必填）: **是** ✓

## 后续影响
<对下一 step 的约束/输入>

## 产物清单
- code commits: <SHA list>
- new files: <path list>
- modified files: <path list>
- artifacts: <path list>
```

**判定标准**（参 batch-clip-audit/references/step-report-template.md 完整章节）：

- 决策声明任一项写"是"（前 3 项）或"否"（后 3 项）→ **回 fix loop 重做，不允许 step 通过**
- "问题应修尽修" 打"否" 仅"阿杜在 brainstorm 明示不修"是合法理由；其他都必须回头补修
- "降级 audit 标准" 边界：threshold 校准（heuristic 内调整）✅；strict → contains/soft/skip ❌；audit-validator 加 TODO/FIXME 标记跳过 ❌
- "偷懒" 边界：少写 audit fn / 缺 test / 跳 fix loop / 漏写 step report ❌

### 7.1 进 step 的三件套

```
[1] step-report-<N>-<slug>.md 落盘，schema 严格按 §7.0
[2] checklist 全 PASS
[3] 阶段产物落盘（代码 / json / log / artifact）
```

三件套缺任一项 → 不允许进下一 Phase。

### 7.2 Phase 清单

**Phase 0 — Discovery（脚本 + 数据已落盘，step-00-discovery.md 在 Phase 1 启动前补写完成）**
- step-report：`step-00-discovery.md`（**Phase 1 启动的前置**）
- 产物已落盘：scripts/cbex-csv-pattern-discovery.ts + 5 个 discovery json
- checklist：
  - [x] 542 个文件全扫，0 errors
  - [x] section-text / labels / value-patterns / fee-patterns / court-patterns 5 json 落盘
  - [x] 关键字段 unique 数量符合 discovery 预期（违章 168 / 抵押 9 / 排放 17 / 法院 48）
  - [x] fee-patterns 含 5 类总价 marker 全部命中
  - [ ] step-00-discovery.md 落盘（**未完成；进 Phase 1 前必填**）
- step report 重点：
  - 目标 = 全 542 字段形态摸清，为 §4 算法设计提供数据
  - 遇到的问题 = labels 第 1 版正则把"前字段值+下字段名"当 label（标的介绍 1126 噪声）
  - 解决方案 = labels.json 仅作辅助，主信号读 value-patterns.json + fee-patterns.json
  - 决策声明："偷懒/跳步" = 否（扫了全 542 而非抽样）

**Phase 1 — Extractor 实现 + 单测**
- step-report：`step-01-extractor-impl.md`（type=code-phase-B）
- 产物：src/utils/cbex-csv-extract.ts + cbex-csv-extract.test.ts
- 单测 fixture ≥ 12，覆盖 Phase 0 发现的所有形态（具体 ID 在 plan 阶段从 `discovery/value-patterns.json` + `discovery/fee-patterns.json` 的 sample_ids 字段选取确认）：
  - 基础三元违章 `X 起，Y 分，Z 元`
  - 双地域违章 `京内 X 起，Y 分，Z 元；京外 X 起；`
  - 短违章缺扣分 `X 起，Z 元`
  - 违章 `:` 半角冒号变体
  - 抵押 9 种 raw value（是 / 已抵押 / 有抵押 / 有 / 否 / 未抵押 / 无抵押 / 无 / empty）
  - 配钥匙费 2 种 label（"配钥匙费用 X 元" / "配钥匙的相关费用为 X 元"）
  - 5 类总价 marker（共计 / 共计约 / 合计 / 总计 / 车辆的费用共计）
  - "其中分账户"句式
  - "每天 16 元 / 24 小时 38 元"日费率
  - "不祥"出厂日期错别字
  - "见图片展示"无数字里程
  - "国 IV / 国Ⅴ"罗马数字排放
  - 跨省法院（如河北省 / 三河市 — 验证 normalize 不盲补"北京市"）
- checklist：
  - [ ] 12+ fixture 全 PASS
  - [ ] normalize 4 函数全测过
  - [ ] clusterFeesByTotalMarker 单测覆盖 5 类总价 marker
  - [ ] extract法院 三级 fallback 单测
  - [ ] 按 `<p>` block 解析不依赖数字编号 lookahead
- step report 重点：决策声明含"字段集合应审尽审 = 是 ✓"（已按阿杜锁定的 32 字段全实现，无 skip）+ "字段 5-attempt 充分搜索 = 是 ✓"（已对 32 字段每个尝试 ≥5 个独立 source pattern）

**Phase 2 — Validator 实现 + 单测**
- step-report：`step-02-validator-impl.md`（type=code-phase-B）
- 产物：src/utils/cbex-csv-validator.ts + cbex-csv-validator.test.ts
- A/B 路径双独立解析 + 校验
- checklist：
  - [ ] 单测全 PASS
  - [ ] ggnr XHR refetch 3 次重试 logic 验证（mock fetch）
  - [ ] 32 字段每个对应 1 audit point
  - [ ] derived 字段（总价/登记至今间隔）A==B 校验严格
- step report 重点：决策声明含"字段集合应审尽审 = 是 ✓"+"字段 5-attempt = 是 ✓"

**Phase 3 — Batch orchestrator + Round 1**
- step-report：`step-03-audit-round-01.md`（type=audit-round）
- 产物：scripts/cbex-csv-batch-export.ts + 跑全 542 → progress.json / diffs-fail/<ID>.json / round-01.log
- checklist：
  - [ ] progress.json 显示 542 全处理
  - [ ] PASS + FAIL + infra_error = 542
  - [ ] diffs-fail/<ID>.json 含字段级 FAIL 细节（哪个字段 A != B + 各自值）
  - [ ] infra_error = 0（ggnr XHR 全成功；若有 infra_error 必须修工具回零）
- step report 重点：
  - 目标 = Round 1 跑全 542，统计 PASS/FAIL 分布
  - 工作内容 = ggnr 串行抓取 + extractor 双路径 + validator 比对
  - 遇到的问题 = 列前 5 类 FAIL 字段聚类
  - 决策声明含"问题应修尽修 = 是/否" 视实际 FAIL 处理状态

**Phase 4 — Fix Loop（PASS != 100% 才进；无 round 上限）**
- 每 round 一份 step report，命名 `step-fix-NN-<bug-summary>.md`（type=fix）+ 紧跟一份 `step-NN-audit-round-NN.md`（type=audit-round）
- 操作：聚类 FAIL → 5 类根因决策树（参 batch-clip-audit/references/fix-loop.md）→ 修代码 + commit → Round N+1 subset → subset PASS → 全 542 final verify
- checklist（每 round）：
  - [ ] step-fix-N.md 决策声明前 3 项"否" + 第 4 项"问题应修尽修 = 是"（fix step 必填）
  - [ ] 主路径 grep 验证未破坏既有功能
  - [ ] subset 全 PASS
  - [ ] commit message 含根因 + 修复
- step report 重点：
  - 问题：从 diffs-fail 聚类（如"34 个文件 排放标准 audit A=国 IV vs B=国Ⅴ"）
  - 解决方案：扩 normalize排放标准 加 Ⅴ 等罗马数字变体
  - "问题应修尽修" 必须打"是"（含 pre-existing 都修，不留 TODO）
  - "妥协/接受次优" 必须打"否"（严禁"修不动就接受次优"）

**Phase 5 — Final verify + REPORT**
- step-report：`step-final-verify.md`（type=verify）
- 产物：`.claude/cbex-batch-2238/REPORT-csv.md`（含 §8 模板内容）
- checklist：
  - [ ] 542/542 PASS（A==B 全字段）
  - [ ] CSV 543 行（1 表头 + 542 数据）
  - [ ] CSV UTF-8 BOM，Excel/Numbers 中文不乱码
  - [ ] pandas df.describe() 数值列正常
  - [ ] REPORT-csv.md 决策声明 6 项 PASS（前 3 否 + 后 3 是）
  - [ ] 阿杜审 REPORT 回"通过" → 进 ship ⚠️ **唯一介入点**

**Phase 6 — Ship**（阿杜回"通过"后）
- step-report：`step-ship.md`（type=ship）
- 按 batch-clip-audit/references/ship-flow.md 流程

## 8. REPORT-csv.md 模板

```markdown
# cbex-2238 CSV 提取 final REPORT

**Date**: YYYY-MM-DD
**Total**: 542 markdowns → 542 CSV rows
**Audit**: 32 字段 per row, A/B 双路径独立解析，100% PASS
**Rounds**: N

## 概览
- Extractor: scripts/cbex-csv-batch-export.ts
- Input: 542 个 markdown + 542 ggnr XHR refetch
- Output: .claude/cbex-batch-2238/cbex-2238.csv (UTF-8 BOM, 543 行)

## Round 历史
| Round | Subset | PASS | FAIL | FAIL 字段聚类 | 修复 |
|---|---|---|---|---|---|
| 1 | 全 542 | X | Y | 法院 (X 个跨省未归一)、其他费用 (X 个共计 marker 漏识别) | extend normalize法院 / fee marker 字典 |
| 2 | Round 1 FAIL Y | Y | 0 | — | — |
| Final | 全 542 | 542 | 0 | — | — |

## 字段统计
| 字段 | 非空 | 空 | 唯一值数 | top 5 示例 |
|---|---|---|---|---|
| 法院 | 542 | 0 | 48 | 北京市第一中级人民法院:100, 北京市朝阳区人民法院:74, ... |
| 排放标准 | 540 | 2 | 4 | 国五:380, 国四:120, 国六:30, 国三:10 |
| 是否抵押 | 542 | 0 | 3 | 否:412, 是:118, 未知:12 |
| 初次登记日期 | 540 | 2 | 530 | 2015-02-11, 2018-03-06, ... |
| 总价 | 542 | 0 | (median ¥105000) | ... |
| ... | ... | ... | ... | ... |

## Phase 0 发现回顾
- labels.json: 权利限制 16 个有效 label（标的介绍 labels 含数字噪声，主信号读 value-patterns）
- value-patterns.json: 21 字段全形态覆盖（违章 168 / 抵押 9 / 排放 17 / ...）
- fee-patterns.json: 80 类费用名目（top: 每天 X 元 日费率 483 次，停车、维修等费用 347 次）
- court-patterns.json: 48 个法院（含河北省、外地 / 195 个文件双源不一致 / 38 个跨法院差）

## 决策声明（强制 6 项，按 batch-clip-audit step-report-template.md）
- 擅自降级 audit 标准: **否** ✓
- 偷懒 / 跳过部分文件: **否** ✓
- 妥协/接受次优: **否** ✓
- 问题应修尽修: **是** ✓
- 字段集合应审尽审: **是** ✓
- 字段 5-attempt 充分搜索: **是** ✓

## 验收 checklist
- [x] 542/542 PASS (A 路径 == B 路径 全字段)
- [x] CSV 用 Excel 打开中文不乱码
- [x] pandas df.describe() 数值列正常
- [x] 抽 5 行随机对照原 markdown 字段值正确
- [x] 阿杜审 REPORT 回"通过"
```

## 9. 容错策略

1. **Phase 0 discovery 已落盘**：不再 fail
2. **Phase 1-3 extractor regex 不匹配**：返回空字符串 + 进 audit FAIL → Fix Loop（不当 error 直接停）
3. **ggnr XHR 3 次重试均失败**：该 ID 标 `audit_infrastructure_error`，progress.json 累计 + REPORT 单独章节列出。**不当字段 FAIL**（防 audit 工具误归因）。所有 infra_error 必须修工具回零 才能 final verify
4. **frontmatter 解析失败**：单文件 skip + log error，不写入 CSV
5. **法院双源不一致**：取公告源（A 路径），权利限制源仅作 fallback。差异写 stderr WARN 但不 FAIL audit
6. **CSV 写入 IO 错**：fail-fast，不留半截 CSV

## 10. 验收标准（最终）

1. ✅ Phase 0 discovery 数据已落盘（已完成）
2. ✅ `npx vitest run src/utils/cbex-csv-extract.test.ts src/utils/cbex-csv-validator.test.ts` 全 PASS
3. ✅ `npx tsx scripts/cbex-csv-batch-export.ts` Round N 跑通，progress.json 显示 **542/542 PASS + 0 infra_error**
4. ✅ `.claude/cbex-batch-2238/cbex-2238.csv` 行数 = 543（1 表头 + 542 数据行），UTF-8 BOM，32 列
5. ✅ REPORT-csv.md 生成 + 决策声明 6 项符合（前 3 项"否"+ 后 3 项"是"）
6. ✅ Excel / Numbers 打开 CSV 中文不乱码
7. ✅ pandas.read_csv(p).describe() 数值列正常
8. ✅ 阿杜审 REPORT 回"通过"才进 ship（**唯一介入点**）

## 11. Ship（按 batch-clip-audit Phase D）

1. cd 回 main，抢 ship lock
2. rsync 代码 worktree → main（scripts/cbex-csv-*.ts、src/utils/cbex-csv-*.ts、.gitignore 更新）
3. rsync artifacts（cbex-2238.csv、discovery/、step-reports/、REPORT-csv.md）到 main 的 `.claude/cbex-batch-2238/`（已 git-ignored）
4. git add 代码 + .gitignore，commit
5. sanity check（npm test + npm run test:e2e + npm run build:chrome）
6. git push adu
7. 释 ship lock
8. 清 worktree
9. 报阿杜「ship 完毕」+ CSV 路径

## 12. 风险与未知

- **Phase 1 extractor 完成后 Round 1 PASS 可能 ≪ 100%**：discovery 给的是 label/形态盘点，但实际 §4 算法的 `<p>` block 解析 + cluster 算法跑全 542 才能知道命中率。乐观估计 Round 1 PASS ~ 70-80%，剩余 20-30% 进 Fix Loop 修 3-8 轮。**这是 batch-clip-audit 预期模式，不是 bug**。
- **ggnr XHR 反爬触发**：542 次串行 fetch 可能被 cbex 限流。降级策略：5/10/20s backoff + sleep 200ms / req + chromium fingerprint headers。**不**降低 audit 标准绕开。
- **法院字段双源 38 个跨法院案例**：spec 已明确"取公告源（处置法院）"。但如果阿杜后续认为"管辖法院 = 查封法院"，需要回 brainstorm 改语义 + Rerun Round。
- **总价 marker 5 种未必穷尽**：discovery 是字段抽样，实际 fix loop 可能发现新 marker（如"合计金额"/"总额"），按 Fix Loop 加映射 + step-fix report。
