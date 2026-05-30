// scripts/e2e-clip-runner.ts
//
// E2E test runner: launches real Chrome with the obsidian-clipper-cn
// extension loaded, navigates to a URL, triggers the page-world test
// bridge, intercepts the obsidianNote markdown via a localhost receiver,
// returns { markdown, hydratedHtml }.
//
// Usage from vitest:
//   import { runRealClip } from '../../scripts/e2e-clip-runner';
//   const clip = await runRealClip('https://mp.weixin.qq.com/s/...');
//   // clip.markdown — byte-equivalent to user's manual clip
//   // clip.hydratedHtml — document.documentElement.outerHTML after hydration
//
// For batch usage (reuse chromium across multiple URLs):
//   import { startBatchSession, runRealClipBatch } from '../../scripts/e2e-clip-runner';
//   const session = await startBatchSession(opts);
//   const r1 = await session.clip('https://...');
//   const r2 = await session.clip('https://...');
//   await session.close();
//   // or simply:
//   const results = await runRealClipBatch(['https://...', 'https://...'], opts);

import { chromium as chromiumExtra } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, unlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';

chromiumExtra.use(stealth());

export interface ClipResult {
	markdown: string;
	hydratedHtml: string;
	durationMs: number;
}

export interface ClipOptions {
	cookies?: string;          // domain, triggers read-chrome-cookies.py
	wait?: string;             // selector or 'networkidle'; default 'networkidle'
	headed?: boolean;          // default true (dev-friendly); MV3 extensions don't load in headless
	timeout?: number;          // ms; default 60_000
	userDataDir?: string;      // persistent profile dir (e.g. scys post-QR-login). When set,
	                           // the dir is NOT removed on exit so subsequent runs reuse login.
	offscreen?: boolean;       // default true: position window at -2400,-2400 so it doesn't
	                           // steal focus while still being 'headed' (needed for extensions)
	feishuSettings?: { appId: string; appSecret: string };  // inject into chrome.storage.local.feishu_settings
	                                                         // so feishu-extractor's background OpenAPI calls auth
}

export interface ClipSession {
	clip: (url: string, opts?: { wait?: string; timeout?: number }) => Promise<ClipResult>;
	close: () => Promise<void>;
}

const SCRIPTS_DIR = __dirname;
const REPO_ROOT = resolve(SCRIPTS_DIR, '..');
const DIST_DIR = join(REPO_ROOT, 'dist');
const RECV_SERVER_SCRIPT = join(SCRIPTS_DIR, 'recv-server.py');
const COOKIES_SCRIPT = join(SCRIPTS_DIR, 'read-chrome-cookies.py');

// Match latest stable chrome User-Agent string (update periodically).
const FAKE_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function getFreePort(): Promise<number> {
	return new Promise((res, rej) => {
		const srv = createServer();
		srv.listen(0, () => {
			const addr = srv.address();
			if (typeof addr === 'object' && addr) {
				const port = addr.port;
				srv.close(() => res(port));
			} else {
				rej(new Error('no port assigned'));
			}
		});
	});
}

async function pollForFile(path: string, timeoutMs: number): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (existsSync(path)) {
			// File may still be being written; give it a moment
			await new Promise(r => setTimeout(r, 100));
			return;
		}
		await new Promise(r => setTimeout(r, 200));
	}
	throw new Error(`File ${path} not created within ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// startBatchSession — launch chromium + recv-server once, reuse across clips
// ---------------------------------------------------------------------------

export async function startBatchSession(opts: ClipOptions = {}): Promise<ClipSession> {
	if (!existsSync(DIST_DIR)) {
		throw new Error(`dist/ does not exist; run 'npm run build:chrome' first`);
	}

	// Start receiver server (stays alive; each clip uses a different ?path= file)
	const recvPort = await getFreePort();
	const recv: ChildProcess = spawn('python3', [RECV_SERVER_SCRIPT, String(recvPort)], { stdio: 'pipe' });
	await new Promise(r => setTimeout(r, 500));  // give it time to bind port

	// Temp files to clean up on close
	const tempFiles: string[] = [];

	// Load cookies once for the session
	let cookies: Array<Record<string, unknown>> = [];
	if (opts.cookies) {
		const result = spawnSync('uv', ['run', COOKIES_SCRIPT, opts.cookies], {
			cwd: SCRIPTS_DIR,
			encoding: 'utf-8',
		});
		if (result.status !== 0) {
			recv.kill();
			throw new Error(`read-chrome-cookies failed for ${opts.cookies}: ${result.stderr}`);
		}
		cookies = JSON.parse(result.stdout);
	}

	// Launch chrome with extension + anti-fingerprint hardening.
	// MV3 extensions don't load in headless mode; always run headed but move
	// the window off-screen (offscreen=true, default) so it doesn't steal focus.
	const usePersistent = !!opts.userDataDir;
	const profileDir = usePersistent ? opts.userDataDir! : mkdtempSync(join(tmpdir(), 'playwright-test-profile-'));
	const offscreenArgs = opts.offscreen !== false
		? ['--window-position=-2400,-2400', '--window-size=1920,1080']
		: [];
	const context = await chromiumExtra.launchPersistentContext(profileDir, {
		headless: false,  // MV3 extensions need headed
		userAgent: FAKE_UA,
		viewport: { width: 1920, height: 1080 },
		locale: 'zh-CN',
		timezoneId: 'Asia/Shanghai',
		colorScheme: 'light',
		extraHTTPHeaders: {
			'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
		},
		args: [
			`--disable-extensions-except=${DIST_DIR}`,
			`--load-extension=${DIST_DIR}`,
			'--no-first-run',
			'--no-default-browser-check',
			...offscreenArgs,
		],
	});

	// Anti-fingerprint: align navigator.userAgentData with the UA string above.
	// Stealth plugin keeps default userAgentData (non-zh, chrome version mismatch).
	await context.addInitScript(() => {
		try {
			Object.defineProperty(navigator, 'userAgentData', {
				get: () => ({
					brands: [
						{ brand: 'Chromium', version: '131' },
						{ brand: 'Not_A Brand', version: '24' },
						{ brand: 'Google Chrome', version: '131' },
					],
					mobile: false,
					platform: 'macOS',
				}),
				configurable: true,
			});
		} catch { /* already overridden */ }
	});

	if (cookies.length > 0) {
		await context.addCookies(cookies as any);
	}

	// Inject feishu_settings into background SW chrome.storage.local so the
	// feishu extractor can mint a tenant_access_token via background.ts
	// `getFeishuTenantToken`. Fresh playwright profile has empty
	// chrome.storage.local — without this, feishu OpenAPI calls 401.
	if (opts.feishuSettings) {
		let sw = context.serviceWorkers()[0];
		if (!sw) {
			sw = await Promise.race([
				context.waitForEvent('serviceworker', { timeout: 15_000 }),
				new Promise<never>((_, rej) =>
					setTimeout(() => rej(new Error('background SW not ready within 15s')), 15_000)
				),
			]) as any;
		}
		await sw!.evaluate(async (s) => {
			// @ts-expect-error chrome global in SW
			await chrome.storage.local.set({ feishu_settings: s });
		}, opts.feishuSettings);
	}

	// -----------------------------------------------------------------------
	// session.clip — navigate to URL, trigger bridge, return markdown
	// -----------------------------------------------------------------------
	const clip = async (url: string, clipOpts?: { wait?: string; timeout?: number }): Promise<ClipResult> => {
		const start = Date.now();
		const outputPath = join(tmpdir(), `e2e-clip-${Date.now()}-${Math.random().toString(36).slice(2)}.md`);
		tempFiles.push(outputPath);
		if (existsSync(outputPath)) unlinkSync(outputPath);
		const uploadUrl = `http://127.0.0.1:${recvPort}/?path=${encodeURIComponent(outputPath)}`;
		const waitOpt = clipOpts?.wait ?? opts.wait;
		const timeoutMs = clipOpts?.timeout ?? opts.timeout ?? 60_000;

		const page = await context.newPage();
		try {
			await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
			if (waitOpt && waitOpt !== 'networkidle') {
				await page.waitForSelector(waitOpt, { timeout: timeoutMs });
			} else {
				await page.waitForLoadState('networkidle', { timeout: timeoutMs });
			}

			// Wait for content script injection.
			// Content scripts live in the extension's isolated world — their
			// window.obsidianClipperGeneration is NOT visible to page.evaluate
			// (which runs in page main world). Just wait a fixed budget for
			// chrome to inject the content script after page load.
			await page.waitForTimeout(1500);

			// Anti-fingerprint: simulate small user activity before trigger.
			// Pure-static pages with no mouse movement are a behavioral bot signal.
			await page.mouse.move(640, 360);
			await page.mouse.wheel(0, 200);
			await page.waitForTimeout(300);

			// Trigger bridge
			await page.evaluate((cfg) => {
				window.postMessage({
					type: '__obsidianClipperTestExtract__',
					testId: cfg.testId,
					uploadUrl: cfg.uploadUrl,
				}, '*');
			}, { testId: `e2e-${Date.now()}`, uploadUrl });

			// Wait for receiver to write file
			await pollForFile(outputPath, timeoutMs);

			// Read markdown + hydratedHtml
			const markdown = readFileSync(outputPath, 'utf-8');
			const hydratedHtml = await page.evaluate(() => document.documentElement.outerHTML);

			return {
				markdown,
				hydratedHtml,
				durationMs: Date.now() - start,
			};
		} finally {
			await page.close();
		}
	};

	// -----------------------------------------------------------------------
	// session.close — teardown chromium + recv-server + cleanup
	// -----------------------------------------------------------------------
	const close = async (): Promise<void> => {
		await context.close();
		recv.kill();
		// Only remove ephemeral profile (mkdtempSync); preserve persistent userDataDir
		if (!usePersistent && profileDir && existsSync(profileDir)) {
			rmSync(profileDir, { recursive: true, force: true });
		}
		// Clean up all temp output files accumulated during the session
		for (const f of tempFiles) {
			if (existsSync(f)) unlinkSync(f);
		}
	};

	return { clip, close };
}

// ---------------------------------------------------------------------------
// runRealClip — thin wrapper around startBatchSession for single-URL callers
// (semantics unchanged; all existing e2e tests continue to work as-is)
// ---------------------------------------------------------------------------

export async function runRealClip(url: string, opts: ClipOptions = {}): Promise<ClipResult> {
	const session = await startBatchSession(opts);
	try {
		return await session.clip(url, { wait: opts.wait, timeout: opts.timeout });
	} finally {
		await session.close();
	}
}

// ---------------------------------------------------------------------------
// runRealClipBatch — reuse chromium across multiple URLs (~3x speedup)
// ---------------------------------------------------------------------------

export async function runRealClipBatch(urls: string[], opts?: ClipOptions): Promise<ClipResult[]> {
	const session = await startBatchSession(opts);
	const results: ClipResult[] = [];
	try {
		for (const url of urls) {
			const r = await session.clip(url, { wait: opts?.wait, timeout: opts?.timeout });
			results.push(r);
		}
	} finally {
		await session.close();
	}
	return results;
}
