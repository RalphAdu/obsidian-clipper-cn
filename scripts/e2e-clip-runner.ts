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
	headed?: boolean;          // default true (dev-friendly)
	timeout?: number;          // ms; default 60_000
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

export async function runRealClip(url: string, opts: ClipOptions = {}): Promise<ClipResult> {
	if (!existsSync(DIST_DIR)) {
		throw new Error(`dist/ does not exist; run 'npm run build:chrome' first`);
	}
	const start = Date.now();
	const recvPort = await getFreePort();
	const outputPath = join(tmpdir(), `e2e-clip-${Date.now()}.md`);
	if (existsSync(outputPath)) unlinkSync(outputPath);
	const uploadUrl = `http://127.0.0.1:${recvPort}/?path=${encodeURIComponent(outputPath)}`;

	// 1. Start receiver server
	const recv: ChildProcess = spawn('python3', [RECV_SERVER_SCRIPT, String(recvPort)], { stdio: 'pipe' });
	await new Promise(r => setTimeout(r, 500));  // give it time to bind port

	let profileDir = '';
	try {
		// 2. Load cookies if requested
		let cookies: Array<Record<string, unknown>> = [];
		if (opts.cookies) {
			const result = spawnSync('uv', ['run', COOKIES_SCRIPT, opts.cookies], {
				cwd: SCRIPTS_DIR,
				encoding: 'utf-8',
			});
			if (result.status !== 0) {
				throw new Error(`read-chrome-cookies failed for ${opts.cookies}: ${result.stderr}`);
			}
			cookies = JSON.parse(result.stdout);
		}

		// 3. Launch chrome with extension + anti-fingerprint hardening
		profileDir = mkdtempSync(join(tmpdir(), 'playwright-test-profile-'));
		const context = await chromiumExtra.launchPersistentContext(profileDir, {
			headless: opts.headed === false,
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

		try {
			const page = await context.newPage();
			await page.goto(url, { waitUntil: 'domcontentloaded', timeout: opts.timeout ?? 60_000 });
			if (opts.wait && opts.wait !== 'networkidle') {
				await page.waitForSelector(opts.wait, { timeout: opts.timeout ?? 60_000 });
			} else {
				await page.waitForLoadState('networkidle', { timeout: opts.timeout ?? 60_000 });
			}

			// 4. Wait for content script (poll window.obsidianClipperGeneration)
			await page.waitForFunction(() => typeof (window as any).obsidianClipperGeneration === 'number', { timeout: 10_000 });

			// 4a. Anti-fingerprint: simulate small user activity before trigger.
			// Pure-static pages with no mouse movement are a behavioral bot signal.
			await page.mouse.move(640, 360);
			await page.mouse.wheel(0, 200);
			await page.waitForTimeout(300);

			// 5. Trigger bridge
			await page.evaluate((cfg) => {
				window.postMessage({
					type: '__obsidianClipperTestExtract__',
					testId: cfg.testId,
					uploadUrl: cfg.uploadUrl,
				}, '*');
			}, { testId: `e2e-${Date.now()}`, uploadUrl });

			// 6. Wait for receiver to write file
			await pollForFile(outputPath, opts.timeout ?? 60_000);

			// 7. Read markdown + hydratedHtml
			const markdown = readFileSync(outputPath, 'utf-8');
			const hydratedHtml = await page.evaluate(() => document.documentElement.outerHTML);

			return {
				markdown,
				hydratedHtml,
				durationMs: Date.now() - start,
			};
		} finally {
			await context.close();
		}
	} finally {
		// Clean up
		recv.kill();
		if (profileDir && existsSync(profileDir)) {
			rmSync(profileDir, { recursive: true, force: true });
		}
		if (existsSync(outputPath)) {
			unlinkSync(outputPath);
		}
	}
}
