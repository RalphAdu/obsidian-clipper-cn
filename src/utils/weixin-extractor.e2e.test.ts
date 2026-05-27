// src/utils/weixin-extractor.e2e.test.ts
//
// True end-to-end test: real chrome + dist/ extension + real network +
// real extractor + real markdown generation. Asserts the produced .md
// matches what hydration-time DOM ground truth implies.
//
// Excluded from `npm test` by vitest.config.ts; run via `npm run test:e2e`.

import { describe, it, expect, beforeAll } from 'vitest';
import { parseHTML } from 'linkedom';
import { runRealClip, type ClipResult } from '../../scripts/e2e-clip-runner';
import { auditWeixinClip, formatReport } from '../../scripts/weixin-visual-audit';

// URL A — plain mp.weixin article (no mdnice editor decoration).
// Regression guarantee: existing audit must keep passing after mdnice
// normalizers are added.
const URL_PLAIN = 'https://mp.weixin.qq.com/s/SPLTD-hFAsyYAA7V1lU8OA';
// URL B — mdnice editor template article. New target of this spec.
const URL_MDNICE = 'https://mp.weixin.qq.com/s/HCBkgfIZkL939cQR67quEg';

describe('weixin e2e — plain article (regression, URL_PLAIN)', () => {
	let clip: ClipResult;

	beforeAll(async () => {
		clip = await runRealClip(URL_PLAIN, {
			wait: '#publish_time',
			timeout: 90_000,
		});
	}, 180_000);

	it('clip succeeded (markdown + hydratedHtml non-empty)', () => {
		expect(clip.markdown.length).toBeGreaterThan(1000);
		expect(clip.hydratedHtml.length).toBeGreaterThan(10_000);
		console.log(`[e2e-plain] clip ${clip.durationMs}ms md ${clip.markdown.length}B`);
	});

	it('frontmatter published matches DOM #publish_time text', () => {
		const { document } = parseHTML(clip.hydratedHtml);
		const text = document.querySelector('#publish_time')?.textContent?.trim() ?? '';
		const m = text.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
		const expected = m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : '';
		expect(expected).toBeTruthy();
		expect(clip.markdown).toMatch(new RegExp(`^published: ${expected}$`, 'm'));
	});

	it('body contains PARA folder structure verbatim', () => {
		for (const folder of ['Vault/', '1-Projects/', '2-Areas/', '3-Resources/', '4-Archives/']) {
			expect(clip.markdown).toContain(folder);
		}
		expect(clip.markdown).toContain('├── 1-Projects/');
	});

	it('no backslash-escaped backtick leakage in markdown', () => {
		expect(clip.markdown).not.toMatch(/\\`/);
	});

	it('no leftover <span> in markdown body', () => {
		expect(clip.markdown).not.toMatch(/<span/);
	});

	it('full content audit: every visible block in #js_content appears in markdown (0 mismatch)', () => {
		const report = auditWeixinClip(clip.hydratedHtml, clip.markdown);
		console.log(formatReport(report));
		expect(report.mismatches, `${report.mismatches.length} blocks missing in markdown`).toHaveLength(0);
	});
});

describe('weixin e2e — mdnice article (URL_MDNICE)', () => {
	let clip: ClipResult;

	beforeAll(async () => {
		clip = await runRealClip(URL_MDNICE, {
			wait: '#publish_time',
			timeout: 90_000,
		});
	}, 180_000);

	it('clip succeeded (markdown + hydratedHtml non-empty)', () => {
		expect(clip.markdown.length).toBeGreaterThan(2000);
		expect(clip.hydratedHtml.length).toBeGreaterThan(10_000);
		console.log(`[e2e-mdnice] clip ${clip.durationMs}ms md ${clip.markdown.length}B`);
	});

	it('frontmatter has published date', () => {
		expect(clip.markdown).toMatch(/^published: \d{4}-\d{2}-\d{2}$/m);
	});

	it('chapter headings rendered as H1 (先采集 / 怎么搭的)', () => {
		expect(clip.markdown).toMatch(/^# 先采集\s*$/m);
		expect(clip.markdown).toMatch(/^# 怎么搭的\s*$/m);
	});

	it('sub-headings rendered as H2 (监听更新 / 后筛选 / 沉淀到笔记里 / 先解决采集这一步 / 封装成了一个 Skill)', () => {
		for (const t of ['监听更新', '后筛选', '沉淀到笔记里', '先解决采集这一步', '封装成了一个 Skill']) {
			expect(clip.markdown, `expected H2 "${t}"`).toMatch(new RegExp(`^## ${t}\\s*$`, 'm'));
		}
	});

	it('small heading 流程闭环 rendered as H3', () => {
		expect(clip.markdown).toMatch(/^### 流程闭环\s*$/m);
	});

	it('inline bold "标题、封面、发布时间、原文链接。" rendered as **strong**', () => {
		expect(clip.markdown).toContain('**标题、封面、发布时间、原文链接。**');
	});

	it('decoration removed: no Reading Time, no WECHAT_MONITOR, no EXPORT_AND_SKILL, no javascript:;', () => {
		expect(clip.markdown).not.toContain('Reading Time');
		expect(clip.markdown).not.toContain('WECHAT_MONITOR');
		expect(clip.markdown).not.toContain('EXPORT_AND_SKILL');
		expect(clip.markdown).not.toContain('javascript:;');
	});

	it('no inline <sup> HTML leakage', () => {
		expect(clip.markdown).not.toMatch(/<sup\b/);
	});

	it('at least 2 fenced code blocks (terminal step list + directory tree)', () => {
		const fences = (clip.markdown.match(/^```/gm) || []).length;
		expect(fences, 'should have ≥4 fence markers (2 blocks × 2 fences each)').toBeGreaterThanOrEqual(4);
	});

	it('no duplicate image caption (alt-equal section/p)', () => {
		const imgPattern = /!\[([^\]]+)\]\([^)]+\)\n\n([^\n]+)\n/g;
		let m: RegExpExecArray | null;
		while ((m = imgPattern.exec(clip.markdown)) !== null) {
			expect(m[2].trim(), `image alt "${m[1]}" should not have duplicate caption "${m[2].trim()}"`).not.toBe(m[1].trim());
		}
	});

	it('contains markdown footnote definitions [^1]: ... and [^2]: ...', () => {
		expect(clip.markdown).toMatch(/^\[\^1\]:\s+wechat-article-exporter\s+—\s+https?:\/\//m);
		expect(clip.markdown).toMatch(/^\[\^2\]:\s+wechat-article-exporter-api\s+—\s+https?:\/\//m);
	});
});
