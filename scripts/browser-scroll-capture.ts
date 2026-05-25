// scripts/browser-scroll-capture.ts
//
// Capture original webpage screenshots for ground-truth visual comparison
// with Obsidian markdown rendering. Output structure mirrors
// obsidian-scroll-capture.sh:
//
//   /tmp/browser-scroll-<ts>/
//     full-page.png         — page.screenshot({ fullPage: true })
//     scroll-001.png ...    — viewport PageDown frames, auto-stop at bottom
//
// Bottom detection mirrors obsidian-scroll-capture.sh: BOTTOM_RUN=3
// consecutive byte-identical frames + MIN_FRAMES=5 floor to avoid early
// "blank viewport" false positives during initial hydration.
//
// Usage:
//   npx tsx scripts/browser-scroll-capture.ts <url> [--profile <dir>] [--max <n>] [--scroll-selector <css>] [--content-selector <css>]
//
// --profile <dir>          persistent-context dir (e.g. .scys-pw-profile/ for
//                          scys login state). Required for any URL that needs
//                          login; the profile must already have valid cookies
//                          (run scripts/scys-login-persist.ts once to seed).
// --scroll-selector <css>  when content lives in an inner scrollable container
//                          (e.g. scys course .feishu-doc-content with its own
//                          overflow:auto), document-level PageDown and
//                          page.screenshot({ fullPage:true }) only capture the
//                          viewport. Pass the CSS selector to scroll that
//                          element's scrollTop instead. Also makes scrollIntoView
//                          on the element + screenshots the element bounds for
//                          the fullPage substitute.
// --content-selector <css> CSS selector that bounds the article-body container
//                          from which each frame extracts visible textContent
//                          → sibling scroll-NNN.txt. Used downstream by
//                          build-side-by-side-grid.py for L↔R alignment via
//                          fuzzy match to markdown lines. Distinct from
//                          --scroll-selector (which picks the SCROLLABLE
//                          element); content-selector limits text extraction
//                          scope to avoid picking up site nav / sidebar UI.
//                          Default = document.body if omitted.

import { chromium } from 'playwright';
import { mkdirSync, statSync, readFileSync, promises as fsPromises } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const BOTTOM_RUN = 3;
const MIN_FRAMES = 5;

const args = process.argv.slice(2);
let url = '';
let profileDir: string | undefined;
let maxPages = 1000;
let scrollSelector: string | undefined;
let contentSelector: string | null = null;

for (let i = 0; i < args.length; i++) {
	const a = args[i];
	if (a === '--profile') profileDir = resolve(args[++i]);
	else if (a === '--max') maxPages = Number(args[++i]);
	else if (a === '--scroll-selector') scrollSelector = args[++i];
	else if (a === '--content-selector') contentSelector = args[++i];
	else if (!url) url = a;
}

if (!url) {
	console.error('Usage: browser-scroll-capture.ts <url> [--profile <dir>] [--max <n>]');
	process.exit(2);
}

const outDir = `/tmp/browser-scroll-${Date.now()}`;
mkdirSync(outDir);
console.log(`==> Output dir: ${outDir}`);

(async () => {
	const launchOpts = {
		headless: false,
		viewport: { width: 1920, height: 1080 },
		locale: 'zh-CN',
		timezoneId: 'Asia/Shanghai',
		// Move off-screen so we don't steal focus during long runs.
		args: ['--window-position=-2400,-2400', '--window-size=1920,1080', '--no-first-run', '--no-default-browser-check'],
	};

	const context = profileDir
		? await chromium.launchPersistentContext(profileDir, launchOpts)
		: await (await chromium.launch({ headless: false, args: launchOpts.args })).newContext({
			viewport: { width: 1920, height: 1080 },
			locale: 'zh-CN',
			timezoneId: 'Asia/Shanghai',
		});

	const page = context.pages()[0] || (await context.newPage());

	console.log(`==> Navigating to ${url}`);
	await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 }).catch(async (e) => {
		console.error(`[WARN] networkidle timeout, falling back to domcontentloaded: ${e.message}`);
		await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
	});
	await page.waitForTimeout(2000);

	// String-based evaluate so tsx/esbuild __name helper doesn't leak into the page context.
	console.log(`==> Scrolling to bottom in chunks to trigger lazy-load (max 60s)${scrollSelector ? ` [inner=${scrollSelector}]` : ''}`);
	const triggerStart = Date.now();
	const lazyLoadJs = scrollSelector
		? `(async () => {
			const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
			const el = document.querySelector(${JSON.stringify(scrollSelector)});
			if (!el) { console.warn('[lazy-load] scroll-selector not found:', ${JSON.stringify(scrollSelector)}); return; }
			const start = Date.now();
			let stable = 0;
			let prev = -1;
			while (stable < 3 && Date.now() - start < 60000) {
				const h = el.scrollHeight;
				el.scrollTop = h;
				await sleep(900);
				if (el.scrollHeight === h && h === prev) stable++; else stable = 0;
				prev = h;
			}
		})()`
		: `(async () => {
			const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
			const start = Date.now();
			let stable = 0;
			let prev = -1;
			while (stable < 3 && Date.now() - start < 60000) {
				const h = document.documentElement.scrollHeight;
				window.scrollTo(0, h);
				await sleep(900);
				if (document.documentElement.scrollHeight === h && h === prev) stable++; else stable = 0;
				prev = h;
			}
		})()`;
	await page.evaluate(lazyLoadJs);
	console.log(`==> Lazy-load settled in ${Date.now() - triggerStart}ms`);

	// Back to top (document or inner scroller).
	if (scrollSelector) {
		await page.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(scrollSelector)}); if (el) el.scrollTop = 0; })()`);
	} else {
		await page.evaluate('window.scrollTo(0, 0)');
	}
	await page.waitForTimeout(1500);

	// 1. full-page screenshot
	console.log('==> 1. fullPage screenshot');
	const fullPath = join(outDir, 'full-page.png');
	try {
		if (scrollSelector) {
			// Inner scroller: page.screenshot({fullPage:true}) only captures viewport
			// since document.body doesn't grow. Use locator.screenshot which captures
			// the element's full content bounds.
			await page.locator(scrollSelector).screenshot({ path: fullPath, timeout: 60_000 });
		} else {
			await page.screenshot({ path: fullPath, fullPage: true, timeout: 60_000 });
		}
		const sz = statSync(fullPath).size;
		console.log(`   full-page.png (${sz} bytes)`);
	} catch (e) {
		console.error(`[WARN] fullPage screenshot failed (page may exceed 16384px limit): ${(e as Error).message}`);
	}

	// 2. viewport PageDown frames
	console.log(`==> 2. PageDown frames (auto-stop at bottom, max=${maxPages}, run=${BOTTOM_RUN}, min=${MIN_FRAMES})`);
	let prevHash = '';
	let run = 0;
	let final = 0;
	let hitBottom = false;

	for (let i = 1; i <= maxPages; i++) {
		const idx = String(i).padStart(3, '0');
		const path = join(outDir, `scroll-${idx}.png`);
		await page.screenshot({ path, fullPage: false });

		// Extract visible textContent from viewport → sibling scroll-NNN.txt.
		// Used by build-side-by-side-grid.py for L↔R alignment (fuzzy match
		// to markdown lines). content-selector bounds the search to the article
		// container so site nav / sidebar UI doesn't leak into the fuzzy match.
		const visibleText = await page.evaluate((selector) => {
			const root = selector ? document.querySelector(selector) : document.body;
			if (!root) return '';
			const blockSel = 'p, h1, h2, h3, h4, h5, h6, li, blockquote, td, pre, span';
			const nodes = Array.from(root.querySelectorAll(blockSel));
			const visible = nodes.filter((el) => {
				const r = (el as HTMLElement).getBoundingClientRect();
				return r.top >= 0 && r.bottom <= window.innerHeight && r.height > 0;
			});
			return visible
				.map((el) => (el.textContent || '').trim())
				.filter((t) => t.length > 0)
				.join('\n')
				.slice(0, 1500);
		}, contentSelector);
		const txtPath = path.replace(/\.png$/, '.txt');
		await fsPromises.writeFile(txtPath, visibleText, 'utf-8');

		const buf = readFileSync(path);
		const hash = createHash('md5').update(buf).digest('hex');
		const sz = buf.length;

		if (prevHash && hash === prevHash) run++; else run = 0;

		if (i >= MIN_FRAMES && run >= BOTTOM_RUN - 1) {
			console.log(`   ${idx}. ${path} (${sz} bytes) [BOTTOM — run of ${BOTTOM_RUN} identical frames]`);
			hitBottom = true;
			final = i;
			break;
		}
		console.log(`   ${idx}. ${path} (${sz} bytes)`);

		if (scrollSelector) {
			await page.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(scrollSelector)}); if (el) el.scrollTop += el.clientHeight * 0.92; })()`);
		} else {
			await page.keyboard.press('PageDown');
		}
		await page.waitForTimeout(500);
		prevHash = hash;
		final = i;
	}

	await context.close();

	if (!hitBottom) {
		console.error(`[FAIL] Hit MAX_PAGES=${maxPages} without bottom. Output: ${outDir}`);
		process.exit(1);
	}

	console.log(`==> Done. Touched bottom at frame ${final}. Output: ${outDir}`);
})().catch((e) => {
	console.error('[ERROR]', e);
	process.exit(3);
});
