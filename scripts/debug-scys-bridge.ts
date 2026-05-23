// One-shot debug: launch chrome with extension, navigate, trigger bridge,
// log page URL / title / localStorage state across the lifecycle. NO cookies
// to isolate "does scys need login" hypothesis.
//
// Run: npx ts-node --project scripts/tsconfig.json scripts/debug-scys-bridge.ts <url>

import { chromium as chromiumExtra } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

chromiumExtra.use(stealth());

const URL_ARG = process.argv[2] || 'https://scys.com/articleDetail/xq_topic/55188248452852824';
const SCRIPTS_DIR = __dirname;
const REPO_ROOT = resolve(SCRIPTS_DIR, '..');
const DIST_DIR = join(REPO_ROOT, 'dist');
const FAKE_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function main() {
	if (!existsSync(DIST_DIR)) throw new Error(`dist/ missing`);
	const profileDir = mkdtempSync(join(tmpdir(), 'pw-debug-'));
	const context = await chromiumExtra.launchPersistentContext(profileDir, {
		// chromium headless can't load MV3 extensions; use headed + offscreen window
		headless: false,
		userAgent: FAKE_UA,
		viewport: { width: 1920, height: 1080 },
		locale: 'zh-CN',
		timezoneId: 'Asia/Shanghai',
		extraHTTPHeaders: { 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' },
		args: [
			`--disable-extensions-except=${DIST_DIR}`,
			`--load-extension=${DIST_DIR}`,
			'--no-first-run',
			'--no-default-browser-check',
			'--window-position=-2400,-2400',
			'--window-size=1920,1080',
		],
	});

	try {
		const page = await context.newPage();
		page.on('console', msg => {
			const t = msg.text();
			if (/clipper|obsidian|cn|bridge|extens|extract|hydrat/i.test(t)) console.log(`[page:console:${msg.type()}] ${t}`);
		});
		page.on('pageerror', err => console.log(`[page:error] ${err.message}`));
		// also log extension service worker / background console via context
		context.on('serviceworker', sw => {
			console.log(`[ctx:sw] new ${sw.url()}`);
		});
		console.log(`[debug] goto ${URL_ARG}`);
		await page.goto(URL_ARG, { waitUntil: 'domcontentloaded', timeout: 30_000 });
		console.log(`[debug] after goto: url=${page.url()}`);
		console.log(`[debug] title=${await page.title()}`);

		try {
			await page.waitForLoadState('networkidle', { timeout: 15_000 });
			console.log(`[debug] networkidle reached`);
		} catch (e: any) {
			console.log(`[debug] networkidle TIMEOUT: ${e.message}`);
		}
		console.log(`[debug] after idle: url=${page.url()}`);

		await page.waitForTimeout(2000);

		// snapshot DOM presence
		const probe = await page.evaluate(() => {
			const has = (sel: string) => Boolean(document.querySelector(sel));
			return {
				bodyText: (document.body.textContent || '').slice(0, 500),
				bodyLen: (document.body.textContent || '').length,
				htmlLen: document.documentElement.outerHTML.length,
				hasVcDocItem: has('.vc-doc-item'),
				vcDocItemCount: document.querySelectorAll('.vc-doc-item').length,
				hasLoginModal: has('.login-modal') || has('[class*="login"]') || has('[class*="Login"]'),
				hasArticle: has('article') || has('[class*="article"]') || has('[class*="Article"]'),
				dataCnClipperBuild: document.documentElement.getAttribute('data-cn-clipper-build') || null,
				topClasses: Array.from(document.querySelectorAll('body > div')).slice(0, 5).map(d => (d as HTMLElement).className),
			};
		});
		console.log('[debug] DOM probe:', JSON.stringify(probe, null, 2));

		// check if content.js really injected by looking for the marker via
		// page-world JS evaluating from inside an injected world (but this still
		// reads attribute set in isolated world — they share the same dom).
		const markerCheck = await page.evaluate(() => {
			return {
				attr: document.documentElement.getAttribute('data-cn-clipper-build'),
				hasListener: 'unknown', // can't introspect cross-world
				domReadyState: document.readyState,
				url: location.href,
			};
		});
		console.log('[debug] marker check:', JSON.stringify(markerCheck));

		// trigger bridge
		const testId = `debug-${Date.now()}`;
		const uploadUrl = 'http://127.0.0.1:99999/never'; // intentionally invalid
		await page.evaluate((cfg) => {
			window.postMessage({ type: '__obsidianClipperTestExtract__', testId: cfg.testId, uploadUrl: cfg.uploadUrl }, '*');
		}, { testId, uploadUrl });
		console.log(`[debug] bridge triggered testId=${testId}`);

		// poll localStorage for status
		for (let i = 0; i < 30; i++) {
			await page.waitForTimeout(500);
			const status = await page.evaluate((id) => {
				const k = '__obsidianClipperTestResult__:' + id;
				return localStorage.getItem(k);
			}, testId);
			if (status) {
				console.log(`[debug] localStorage status @${(i+1)*500}ms: ${status}`);
				if (status.includes('error') || status.includes('done')) break;
			}
		}

		const finalStatus = await page.evaluate((id) => {
			const k = '__obsidianClipperTestResult__:' + id;
			return localStorage.getItem(k);
		}, testId);
		console.log(`[debug] FINAL localStorage: ${finalStatus}`);
	} finally {
		await context.close();
		rmSync(profileDir, { recursive: true, force: true });
	}
}

main().catch(e => { console.error(e); process.exit(1); });
