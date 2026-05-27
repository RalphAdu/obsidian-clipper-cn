// src/utils/docs-qq-extractor.e2e.test.ts
//
// True end-to-end test: real chrome + dist/ extension + real docs.qq.com +
// real docx export endpoint + mammoth conversion + markdown generation.
//
// Login state: pycookiecheat 读 macOS Chrome cookie (开发者本机登录腾讯文档).
// 反爬: playwright-extra + stealth plugin 已经在 runRealClip 内置.
//
// Excluded from `npm test` by vitest.config.ts. Run via `npm run test:e2e`.

import { describe, it, expect, beforeAll } from 'vitest';
import { runRealClip, type ClipResult } from '../../scripts/e2e-clip-runner';

const URL = 'https://docs.qq.com/doc/DQmZvdEFOR0RFWU9t';

describe('docs.qq e2e (real chrome + real extension)', () => {
	let clip: ClipResult;

	beforeAll(async () => {
		clip = await runRealClip(URL, {
			cookies: 'docs.qq.com',  // 注入 chrome cookie 给 chromium
			wait: 'body',            // docs.qq.com 是 SPA，networkidle 永不触发；等 body 即可
			timeout: 120_000,         // docs.qq 导出 + 下载 docx + mammoth 转换可能 30s+
		});
	}, 180_000);

	it('clip succeeded (markdown + hydratedHtml non-empty)', () => {
		expect(clip.markdown.length).toBeGreaterThan(500);
		expect(clip.hydratedHtml.length).toBeGreaterThan(10_000);
		console.log(`[e2e] clip duration: ${clip.durationMs}ms, markdown ${clip.markdown.length}B, html ${clip.hydratedHtml.length}B`);
	});

	it('frontmatter has title', () => {
		expect(clip.markdown).toMatch(/^---\n[\s\S]*?title:\s+/m);
	});

	it('frontmatter source matches URL', () => {
		expect(clip.markdown).toContain(URL);
	});

	it('body non-trivial size (real doc content)', () => {
		// 删 frontmatter 后剩余应 > 200B
		const body = clip.markdown.replace(/^---\n[\s\S]+?\n---\n?/, '');
		expect(body.length).toBeGreaterThan(200);
	});

	it('no extractorWarnings banner in markdown (extractor 走 happy path)', () => {
		// happy path 下，markdown 内容 + 无 warning marker。如果 docsQQ extractor 失败回退 Defuddle，banner 不直接进 markdown but ContentResponse.extractorWarnings — popup 显示而非 markdown。所以这个测试主要为了观察:如果出现"docs.qq: ..."字串可能是 extractor failure 路径
		expect(clip.markdown).not.toContain('docs.qq:');
	});
});
