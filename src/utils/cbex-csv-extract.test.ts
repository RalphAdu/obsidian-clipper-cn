// src/utils/cbex-csv-extract.test.ts
import { describe, it, expect } from 'vitest';
import { FIELD_ORDER, normalize抵押, normalize排放标准, normalize日期, parseMarkdown, extractTableSections, splitToParagraphs } from './cbex-csv-extract';
import { readFileSync } from 'fs';
import { join } from 'path';

const MARKDOWN_DIR = join(__dirname, '../../.claude/cbex-batch-2238/markdown');

describe('cbex-csv-extract', () => {
	it('FIELD_ORDER 长度恰好 32', () => {
		expect(FIELD_ORDER.length).toBe(32);
	});

	it('FIELD_ORDER 首项 ID 末项 排放标准', () => {
		expect(FIELD_ORDER[0]).toBe('ID');
		expect(FIELD_ORDER[31]).toBe('排放标准');
	});

	it('FIELD_ORDER 含「法院」字段（阿杜约束 #1）', () => {
		expect(FIELD_ORDER).toContain('法院');
	});
});

describe('normalize抵押', () => {
	it.each([
		['是', '是'], ['已抵押', '是'], ['有抵押', '是'], ['有', '是'],
		['否', '否'], ['未抵押', '否'], ['无抵押', '否'], ['无', '否'],
		['', '未知'], ['未知形态', '未知'],
	])('%j → %j', (raw, expected) => {
		expect(normalize抵押(raw)).toBe(expected);
	});
});

describe('normalize排放标准', () => {
	it.each([
		['国三', '国三'], ['国3', '国三'], ['国III', '国三'], ['国三及以上', '国三'],
		['国四', '国四'], ['国IV', '国四'], ['国4', '国四'],
		['国五', '国五'], ['国V', '国五'], ['国Ⅴ', '国五'], ['国5', '国五'],
		['国六', '国六'], ['国VI', '国六'], ['国Ⅵ', '国六'], ['国6', '国六'],
		['未知排放', '未知排放'],
	])('%j → %j', (raw, expected) => {
		expect(normalize排放标准(raw)).toBe(expected);
	});
});

describe('normalize日期', () => {
	it.each([
		['2015/2/11', '2015-02-11'], ['2018-05-17', '2018-05-17'], ['2015.2.11', '2015-02-11'],
		['2018年3月6日', '2018-03-06'], ['2018年3月6', '2018-03-06'],
		['不详', ''], ['不祥', ''], ['不明', ''], ['无', ''], ['', ''],
		['未知格式', ''],
	])('%j → %j', (raw, expected) => {
		expect(normalize日期(raw)).toBe(expected);
	});
});

describe('parseMarkdown', () => {
	it('解析 521134 frontmatter + body', () => {
		const text = readFileSync(join(MARKDOWN_DIR, '521134.md'), 'utf-8');
		const { frontmatter, body } = parseMarkdown(text);
		expect(frontmatter.subject_id).toBe('202512AA5203');
		expect(frontmatter.start_price).toBe(87300);
		expect(body).toContain('<table');
	});
});

describe('extractTableSections', () => {
	it('提取 521134 的 3 段 + 公告头部', () => {
		const text = readFileSync(join(MARKDOWN_DIR, '521134.md'), 'utf-8');
		const { body } = parseMarkdown(text);
		const s = extractTableSections(body);
		expect(s.权利限制).toContain('丰台区');
		expect(s.标的介绍).toContain('车辆型号');
		expect(s.公告头部).toContain('北京市丰台区人民法院');
		expect(s.权利限制Paragraphs.length).toBeGreaterThan(0);
		expect(s.标的介绍Paragraphs.length).toBeGreaterThan(0);
	});
});

describe('splitToParagraphs', () => {
	it('按 <p> 拆段 + strip 全空白', () => {
		const html = '<p>X：Y</p><p>  A：B  </p><p></p><p>C：D</p>';
		const ps = splitToParagraphs(html);
		expect(ps).toEqual(['X：Y', 'A：B', 'C：D']);
	});
});

import { extract违章, extract抵押, clusterFeesByTotalMarker, extract费用, extract停车维修费用Block } from './cbex-csv-extract';

describe('extract违章', () => {
	it('标准三元组：0 起 0 分 0 元', () => {
		const r = extract违章('被法院查封；2、目前可查违章记录：0起，0分，0元；');
		expect(r).toEqual({ 次数: 0, 扣分: 0, 罚款: 0 });
	});
	it('标准三元组带罚款：7 起 0 分 300 元', () => {
		const r = extract违章('违章记录：7起，0分，300元，具体金额以实际处罚为准；');
		expect(r).toEqual({ 次数: 7, 扣分: 0, 罚款: 300 });
	});
	it('双地域：京内 1 起 1 分 100 元 + 京外 2 起', () => {
		const r = extract违章('违章记录：京内1起，1分，100元；京外2起；');
		expect(r).toEqual({ 次数: 3, 扣分: 1, 罚款: 100 });
	});
	it('短形态：1 起 200 元（缺扣分）', () => {
		const r = extract违章('违章记录：1起，200元；');
		expect(r).toEqual({ 次数: 1, 扣分: 0, 罚款: 200 });
	});
	it('未命中：返回 0', () => {
		expect(extract违章('（无违章描述）')).toEqual({ 次数: 0, 扣分: 0, 罚款: 0 });
	});
});

describe('extract抵押', () => {
	it.each([
		['3、是否抵押：否（如有抵押...）', '否'],
		['3、是否抵押：是', '是'],
		['抵押：未抵押；', '否'],
		['抵押：无', '否'],
		['抵押：有抵押', '是'],
		['抵押：已抵押（如有抵押...）', '是'],
		['抵押：无抵押 ；', '否'],
		['抵押：有 ；', '是'],
		['（无抵押字段）', '未知'],
	])('%j → %j', (text, expected) => {
		expect(extract抵押(text)).toBe(expected);
	});
});

describe('clusterFeesByTotalMarker', () => {
	it('单费用：返回 [X]', () => {
		expect(clusterFeesByTotalMarker('停车费 3011元')).toEqual([3011]);
	});
	it('共计 + 分项：返回总价，不算分项', () => {
		expect(clusterFeesByTotalMarker('维修费11378元，停车费2715元，共计14093元'))
			.toEqual([14093]);
	});
	it('共计约 + 分项', () => {
		expect(clusterFeesByTotalMarker('停车费960元、维修费4015元，共计约4975元'))
			.toEqual([4975]);
	});
	it('车辆的费用共计 + 其中分账户', () => {
		expect(clusterFeesByTotalMarker('车辆的费用共计16132元由竞买人负担（其中12980元汇入A账户，3152元汇入B账户）'))
			.toEqual([16132]);
	});
	it('无总价：各项独立', () => {
		expect(clusterFeesByTotalMarker('维修费用4100元、停车费用约12768元'))
			.toEqual([4100, 12768]);
	});
	it('空：返回 []', () => {
		expect(clusterFeesByTotalMarker('')).toEqual([]);
	});
});

describe('extract停车维修费用Block', () => {
	it('提取 "4、停车、维修等费用：X" 到 "5、" 之间', () => {
		const t = '3、是否抵押：否4、停车、维修等费用：3011元，由买受人承担5、其他瑕疵披露：不详';
		expect(extract停车维修费用Block(t)).toMatch(/停车.*维修等费用.*3011元.*买受人承担/);
	});
	it('无停车维修费 label：返回 ""', () => {
		expect(extract停车维修费用Block('3、是否抵押：否5、其他瑕疵披露：不详')).toBe('');
	});
});

describe('extract费用', () => {
	it('521134 简单：停车维修费 3011，其他全 0', () => {
		const t = '违章记录：0起，0分，0元；3、是否抵押：否4、停车、维修等费用：3011元，由买受人承担5、其他瑕疵披露：不详；';
		const r = extract费用(t);
		expect(r).toEqual({ 违章罚款: 0, 停车维修费: 3011, 配钥匙费: 0, 其他费用: 0 });
	});
	it('521479 配钥匙费 + 共计 12000', () => {
		const t = '违章记录：0起，0分，0元；3、是否抵押：是4、法院扣押期间无停车费，拍卖成交后拖车、维修等费用均由买受人承担；注：特别提示：车辆涉嫌改装，恢复原貌修理费用：5100元，拖车费2100元，配钥匙费用4800元，共计12000元，由买受人承担5、其他瑕疵披露：车辆曾存在改装。';
		const r = extract费用(t);
		expect(r.配钥匙费).toBe(4800);
		expect(r.停车维修费).toBe(0);
		expect(r.其他费用).toBe(7200); // 12000 - 4800 = 7200（修理费 + 拖车费 = 共计 12000 - 配钥匙 4800）
		expect(r.违章罚款).toBe(0);
	});
	it('522066 维修+停车+共计 14093', () => {
		const t = '违章记录：0起，0分，0元；3、是否抵押：否4、停车、维修等费用：维修费11378元，停车费2715元，共计14093元，由买受人承担5、其他瑕疵披露：不详；';
		const r = extract费用(t);
		expect(r.停车维修费).toBe(14093);
		expect(r.其他费用).toBe(0);
	});
	it('排除"每天 16 元" 日费率', () => {
		const t = '4、停车、维修等费用：3011元5、买受人自后将车辆移出停车场需要另行按照每天16元的标准支付停车费';
		const r = extract费用(t);
		expect(r.停车维修费).toBe(3011);
		expect(r.其他费用).toBe(0);
	});
	it('双地域违章罚款不入费用', () => {
		const t = '违章记录：京内1起，1分，100元；京外2起；3、是否抵押：否4、停车、维修等费用：500元5、';
		const r = extract费用(t);
		expect(r.违章罚款).toBe(100);
		expect(r.停车维修费).toBe(500);
		expect(r.其他费用).toBe(0);
	});
	it('配钥匙的相关费用为 X 元 alt label', () => {
		const t = '4、法院扣押期间无停车费5、注：特别提示：车辆配钥匙的相关费用为1850元，由买受人承担';
		const r = extract费用(t);
		expect(r.配钥匙费).toBe(1850);
	});
});

import { extract车辆参数, getFieldFromParagraphs, extract法院, normalize法院, compute总价, compute登记至今间隔, extractAllFields, ExtractedRow, isDetailHtml, extractFrontmatterFromDetailHtml } from './cbex-csv-extract';

describe('getFieldFromParagraphs', () => {
	it('按 label 找 <p>', () => {
		const ps = ['车辆型号：BJ7182EVXL', '发动机号：80387758'];
		expect(getFieldFromParagraphs(ps, '车辆型号')).toBe('BJ7182EVXL');
	});
	it('多 label alias', () => {
		const ps = ['车辆出厂日期：不详', '里程表显示行车里程（约）：159853km'];
		expect(getFieldFromParagraphs(ps, '出厂日期', '车辆出厂日期')).toBe('不详');
	});
	it('未命中：返回 ""', () => {
		expect(getFieldFromParagraphs([], '车辆型号')).toBe('');
	});
});

describe('extract车辆参数', () => {
	it('521134 全字段命中', () => {
		const ps = [
			'1、车辆出厂日期：不详',
			'初次登记日期：2015/2/11',
			'2、里程表显示行车里程（约）：159853km',
			'3、强制保险终止日期：不详',
			'商业保险终止日期：不详',
			'4、检验有效期终止日期：2025年2月28日',
			'5、车辆报废止期：2099年12月31日',
			'6、逾期检验报废期：2028年2月29日',
			'7、车辆型号：BJ7182EVXL',
			'发动机号：80387758',
			'车辆识别代码：LE4HG4HB5EL147667',
			'车辆登记证书编号:不详',
			'8、燃料种类：汽油',
			'9、排放标准：国五(国三及以上标准可办理过户)',
		];
		const r = extract车辆参数(ps);
		expect(r.车辆出厂日期).toBe('');
		expect(r.初次登记日期).toBe('2015-02-11');
		expect(r.行车里程).toBe('159853km');
		expect(r.强制保险终止日期).toBe('');
		expect(r.检验有效期终止日期).toBe('2025-02-28');
		expect(r.车辆报废止期).toBe('2099-12-31');
		expect(r.车辆型号).toBe('BJ7182EVXL');
		expect(r.发动机号).toBe('80387758');
		expect(r.车辆识别代码).toBe('LE4HG4HB5EL147667');
		expect(r.车辆登记证书编号).toBe('');
		expect(r.排放标准).toBe('国五');
	});

	it('"不祥" 错别字归一为空', () => {
		const r = extract车辆参数(['1、车辆出厂日期：不祥']);
		expect(r.车辆出厂日期).toBe('');
	});
});

describe('extract法院', () => {
	it('优先源：公告 "XX 法院将于"', () => {
		expect(extract法院('北京市丰台区人民法院将于2025年12月15日...', '')).toBe('北京市丰台区人民法院');
	});
	it('alt 源：公告末尾署名', () => {
		expect(extract法院('...本院公告\n北京市丰台区人民法院\n二〇二五年十二月三日', '')).toBe('北京市丰台区人民法院');
	});
	it('回退源：权利限制 "被 XX 法院"（不带北京市前缀）', () => {
		expect(extract法院('', '1、被丰台区人民法院查封；2、违章记录：0起')).toBe('丰台区人民法院');
	});
	it('全空：返回 ""', () => {
		expect(extract法院('', '')).toBe('');
	});
});

describe('normalize法院', () => {
	it('已带省/市前缀：原样', () => {
		expect(normalize法院('北京市丰台区人民法院', { 公告: '', 权利限制: '' })).toBe('北京市丰台区人民法院');
	});
	it('无前缀 + 公告含同名带前缀 → 补前缀', () => {
		expect(normalize法院('丰台区人民法院', {
			公告: '北京市丰台区人民法院将于...', 权利限制: '',
		})).toBe('北京市丰台区人民法院');
	});
	it('无前缀 + 公告也无前缀 → 白名单补北京市前缀（丰台区）', () => {
		expect(normalize法院('丰台区人民法院', { 公告: '', 权利限制: '' })).toBe('北京市丰台区人民法院');
	});
	it('外地：河北省 ...（保留原文）', () => {
		expect(normalize法院('河北省张家口市中级人民法院', { 公告: '', 权利限制: '' }))
			.toBe('河北省张家口市中级人民法院');
	});
	it('空：空', () => {
		expect(normalize法院('', { 公告: '', 权利限制: '' })).toBe('');
	});
	it('北京区白名单 5 个均补前缀', () => {
		for (const raw of ['丰台区人民法院', '房山区人民法院', '平谷区人民法院', '通州区人民法院', '石景山区人民法院']) {
			expect(normalize法院(raw, { 公告: '', 权利限制: '' }), raw).toBe('北京市' + raw);
		}
	});
	it('真外地无前缀（三河市）→ 保留原样 + WARN（不补北京市）', () => {
		// 三河市 is Hebei Langfang, NOT in BEIJING_DISTRICTS_NEEDING_PREFIX
		expect(normalize法院('三河市人民法院', { 公告: '', 权利限制: '' })).toBe('三河市人民法院');
	});
});

describe('compute总价', () => {
	it('cap_price + 4 费用项', () => {
		expect(compute总价({
			cap_price: 130950, 停车维修费: 3011, 违章罚款: 0, 配钥匙费: 0, 其他费用: 0,
		})).toBe(133961);
	});
	it('521479: cap 138450 + 配钥匙 4800 + 其他 7200', () => {
		expect(compute总价({
			cap_price: 138450, 停车维修费: 0, 违章罚款: 0, 配钥匙费: 4800, 其他费用: 7200,
		})).toBe(150450);
	});
});

describe('compute登记至今间隔', () => {
	it('2015-02-11 → 2026-05-30 ≈ 11.3 年', () => {
		const r = compute登记至今间隔('2015-02-11', '2026-05-30');
		expect(r).toBe('11.3');
	});
	it('空登记 → 空间隔', () => {
		expect(compute登记至今间隔('', '2026-05-30')).toBe('');
	});
});

describe('extractAllFields (integration)', () => {
	it('521134 全 32 字段', () => {
		const text = readFileSync(join(MARKDOWN_DIR, '521134.md'), 'utf-8');
		const row = extractAllFields({
			id: '521134', rawText: text, today: '2026-05-30',
		});
		expect(row['ID']).toBe('521134');
		expect(row['标的物编号']).toBe('202512AA5203');
		expect(row['标题']).toContain('梅赛德斯');
		expect(row['车辆URL']).toBe('https://jpxkc.cbex.com/jpxkc/prj/detail/521134.html');
		expect(row['法院']).toBe('北京市丰台区人民法院');
		expect(row['竞价开始时间']).toBe('2025-12-15 08:00');
		expect(row['起始价']).toBe(87300);
		expect(row['评估价']).toBe(87300);
		expect(row['保证金']).toBe(80000);
		expect(row['最高限价']).toBe(130950);
		expect(row['总价']).toBe(133961); // 130950 + 3011
		expect(row['违章次数']).toBe(0);
		expect(row['违章罚款']).toBe(0);
		expect(row['扣分']).toBe(0);
		expect(row['停车维修费']).toBe(3011);
		expect(row['配钥匙费']).toBe(0);
		expect(row['其他费用']).toBe(0);
		expect(row['是否抵押']).toBe('否');
		expect(row['行车里程']).toBe('159853km');
		expect(row['车辆出厂日期']).toBe('');
		expect(row['初次登记日期']).toBe('2015-02-11');
		expect(row['登记至今间隔']).toBe('11.3');
		expect(row['强制保险终止日期']).toBe('');
		expect(row['检验有效期终止日期']).toBe('2025-02-28');
		expect(row['车辆报废止期']).toBe('2099-12-31');
		expect(row['逾期检验报废期']).toBe('2028-02-29');
		expect(row['车辆型号']).toBe('BJ7182EVXL');
		expect(row['发动机号']).toBe('80387758');
		expect(row['车辆识别代码']).toBe('LE4HG4HB5EL147667');
		expect(row['车辆登记证书编号']).toBe('');
		expect(row['排放标准']).toBe('国五');
	});

	it('row 含全 32 个 key', () => {
		const text = readFileSync(join(MARKDOWN_DIR, '521134.md'), 'utf-8');
		const row = extractAllFields({ id: '521134', rawText: text, today: '2026-05-30' });
		const keys = Object.keys(row);
		expect(keys.length).toBe(32);
		for (const f of FIELD_ORDER) {
			expect(keys).toContain(f);
		}
	});
});

// ── Task 12: Multi-fixture integration tests covering Phase 0 discovery 形态 ──

/**
 * FIXTURES covers 12 distinct data forms discovered in Phase 0:
 *
 * 形态覆盖清单:
 * 1. 521134  基础（unit test 已覆盖，作 describe.each anchor）
 * 2. 522354  配钥匙的相关费用为 1850 元（昌平法院，无停车费，国三）
 * 3. 522582  配钥匙的相关费用为 1000 元（另一昌平案，国三）
 * 4. 522601  配钥匙 4800 + 共计 12000（其他费用 7200，昌平，7 起违章）
 * 5. 522340  国三及以上 + 有抵押 + 停车费 0（昌平）
 * 6. 522401  已抵押 + 违章 3 起 400 元（东城法院，国五）
 * 7. 522611  双地域违章 京内 0 起 + 京外 0 起（第一中级，国四）
 * 8. 522405  "不祥"错别字 → 出厂日期空 + 双地域违章 3 起（国四）
 * 9. 521474  短违章 1 起 100 元（丰台法院，国五）
 * 10. 522072 国六 + 维修费+停车费分项共计（海淀法院）
 * 11. 523385 "车辆的费用共计 + 其中分账户"（房山法院，无违章）
 * 12. 522985 三河市法院查封、延庆区法院发公告（法院字段取公告方延庆区）
 *
 * NOTE on 522985: The 法院 field returns the court that publishes the 公告
 * (北京市延庆区人民法院), not the seizing court (三河市人民法院). This is
 * correct by design — the seizing court info is only in 权利限制 and the
 * algorithm prioritises the announcing court.
 *
 * NOTE on 行车里程 returning "": getMileage() returns '' when text contains
 * "见图片展示" (even if a number precedes it), because the value is stated
 * as approximate and photo-verified. This is correct per spec.
 */
const FIXTURES: Array<{ id: string; desc: string; expect: Partial<ExtractedRow> }> = [
	{
		id: '521134',
		desc: '基础（anchor）',
		expect: {
			法院: '北京市丰台区人民法院',
			违章次数: 0,
			违章罚款: 0,
			是否抵押: '否',
			停车维修费: 3011,
			配钥匙费: 0,
			排放标准: '国五',
			行车里程: '159853km',
			初次登记日期: '2015-02-11',
		},
	},
	{
		id: '522354',
		desc: '配钥匙的相关费用为1850元_无停车费_国三',
		expect: {
			法院: '北京市昌平区人民法院',
			违章次数: 0,
			是否抵押: '否',
			停车维修费: 0,
			配钥匙费: 1850,
			其他费用: 0,
			排放标准: '国三',
			行车里程: '23065公里',
		},
	},
	{
		id: '522582',
		desc: '配钥匙的相关费用为1000元_昌平_国三',
		expect: {
			法院: '北京市昌平区人民法院',
			违章次数: 0,
			是否抵押: '否',
			停车维修费: 0,
			配钥匙费: 1000,
			其他费用: 0,
			排放标准: '国三',
			行车里程: '162181公里',
		},
	},
	{
		id: '522601',
		desc: '配钥匙4800+共计12000+其他费用7200_7起违章',
		expect: {
			法院: '北京市昌平区人民法院',
			违章次数: 7,
			违章罚款: 1100,
			扣分: 1,
			是否抵押: '是',
			停车维修费: 0,
			配钥匙费: 4800,
			其他费用: 7200,
			排放标准: '国三',
		},
	},
	{
		id: '522340',
		desc: '国三及以上+有抵押+停车费0',
		expect: {
			法院: '北京市昌平区人民法院',
			违章次数: 0,
			是否抵押: '是',
			停车维修费: 0,
			配钥匙费: 0,
			排放标准: '国三',
			行车里程: '160973公里',
		},
	},
	{
		id: '522401',
		desc: '已抵押+违章3起400元+国五',
		expect: {
			法院: '北京市东城区人民法院',
			违章次数: 3,
			违章罚款: 400,
			扣分: 3,
			是否抵押: '是',
			停车维修费: 5170,
			配钥匙费: 0,
			排放标准: '国五',
			初次登记日期: '2013-08-01',
		},
	},
	{
		id: '522611',
		desc: '双地域违章京内0起+京外0起+国四',
		expect: {
			法院: '北京市第一中级人民法院',
			违章次数: 0,
			违章罚款: 0,
			是否抵押: '否',
			停车维修费: 5542,
			配钥匙费: 0,
			排放标准: '国四',
			初次登记日期: '2010-06-29',
		},
	},
	{
		id: '522405',
		desc: '不祥错别字→出厂日期空+双地域违章3起6分200元+国四',
		expect: {
			车辆出厂日期: '',   // "不祥" 错别字归一为 ''
			违章次数: 3,
			违章罚款: 200,
			扣分: 6,
			是否抵押: '否',
			停车维修费: 3716,
			排放标准: '国四',
		},
	},
	{
		id: '521474',
		desc: '短违章1起0分100元_丰台法院_国五',
		expect: {
			法院: '北京市丰台区人民法院',
			违章次数: 1,
			违章罚款: 100,
			扣分: 0,
			是否抵押: '否',
			停车维修费: 1792,
			排放标准: '国五',
			行车里程: '43142km',
		},
	},
	{
		id: '522072',
		desc: '国六+维修费360+停车费1485分项共计1845_海淀法院',
		expect: {
			法院: '北京市海淀区人民法院',
			违章次数: 3,
			违章罚款: 300,
			扣分: 2,
			是否抵押: '否',
			停车维修费: 1845,
			配钥匙费: 0,
			排放标准: '国六',
			行车里程: '30940公里',
		},
	},
	{
		id: '523385',
		desc: '车辆的费用共计3716+其中分账户+房山法院+无违章',
		expect: {
			法院: '北京市房山区人民法院',
			违章次数: 0,
			违章罚款: 0,
			是否抵押: '否',
			停车维修费: 3716,
			配钥匙费: 0,
			排放标准: '国五',
		},
	},
	{
		id: '522985',
		desc: '三河市查封+延庆区发公告→法院取公告方延庆区_行车里程见图片→空',
		expect: {
			// 法院 = 公告发布方（北京市延庆区人民法院），非查封方（三河市人民法院）
			法院: '北京市延庆区人民法院',
			违章次数: 2,
			违章罚款: 300,
			扣分: 1,
			是否抵押: '否',
			停车维修费: 14427,
			排放标准: '国四',
			// 行车里程文本为 "187975km见图片展示，以实际情况为准" → getMileage 返回 ''
			行车里程: '',
		},
	},
];

describe('isDetailHtml', () => {
	it('真 detail HTML 命中', () => {
		expect(isDetailHtml('<div class="bd_detail_num">x</div><span class="bd_detail_name">y</span>')).toBe(true);
	});
	it('markdown 不命中', () => {
		expect(isDetailHtml('---\ntitle: foo\n---\n# Body')).toBe(false);
	});
	it('只含一个标记不命中', () => {
		expect(isDetailHtml('<div class="bd_detail_num">x</div>')).toBe(false);
	});
});

describe('extractFrontmatterFromDetailHtml', () => {
	it('抽 subject_id + title + 4 prices + bid_start', () => {
		const html = `<div class="bd_detail_num">标的物编号：202512QY97H8</div>
<a class="bd_detail_name">京QY97H8雅阁牌某型号小型汽车</a>
<p>起始价：¥ 82,700.00</p>
<p>评估价：¥ 82,700.00</p>
<p>保证金：¥ 80,000.00</p>
<p>最高限价：¥ 124,050.00</p>
<p>竞价开始时间：2025-12-15 08:00</p>`;
		const fm = extractFrontmatterFromDetailHtml(html, '521418');
		expect(fm.subject_id).toBe('202512QY97H8');
		expect(fm.title).toContain('雅阁');
		expect(fm.source).toBe('https://jpxkc.cbex.com/jpxkc/prj/detail/521418.html');
		expect(fm.start_price).toBe(82700);
		expect(fm.assess_price).toBe(82700);
		expect(fm.deposit).toBe(80000);
		expect(fm.cap_price).toBe(124050);
		expect(fm.bid_start).toBe('2025-12-15 08:00');
	});

	it('缺字段时 fm key 不存在（不填 undefined）', () => {
		const html = '<div class="bd_detail_num">标的物编号：X001</div><div class="bd_detail_name">测试</div>';
		const fm = extractFrontmatterFromDetailHtml(html, '111111');
		expect(fm.subject_id).toBe('X001');
		expect(fm.bid_start).toBeUndefined();
		expect(fm.start_price).toBeUndefined();
	});
});

describe('extractFrontmatterFromDetailHtml — bid_start 多种日期分隔符', () => {
	const base = '<div class="bd_detail_num">标的物编号：X001</div><a class="bd_detail_name">测试</a>';
	it.each([
		['2025.12.15 08:00', '2025-12-15 08:00'],   // dot separator (cbex detail HTML actual format)
		['2025-12-15 08:00', '2025-12-15 08:00'],   // dash separator (markdown frontmatter format)
		['2025/12/15 08:00', '2025-12-15 08:00'],   // slash separator
		['2025.1.5 09:30', '2025-01-05 09:30'],     // single-digit month/day
	])('竞价开始时间：%s → %s', (input, expected) => {
		const html = `${base}<p>竞价开始时间：${input}</p>`;
		const fm = extractFrontmatterFromDetailHtml(html, '999999');
		expect(fm.bid_start).toBe(expected);
	});
});

describe.each(FIXTURES)('Fixture $id ($desc)', ({ id, expect: expected }) => {
	it('字段命中', () => {
		const text = readFileSync(join(MARKDOWN_DIR, `${id}.md`), 'utf-8');
		const row = extractAllFields({ id, rawText: text, today: '2026-05-30' });
		for (const [k, v] of Object.entries(expected)) {
			expect(row[k as keyof ExtractedRow], `字段 ${k}`).toBe(v);
		}
	});
});
