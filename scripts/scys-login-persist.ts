// scripts/scys-login-persist.ts
//
// One-time interactive: launches headed playwright with a persistent profile,
// navigates to a scys article URL, waits for the user to complete WeChat QR
// scan login. After login is detected (article DOM hydrates with vc-doc-item),
// the profile is saved to disk. Subsequent e2e runs reuse this profile to
// skip the login wall.
//
// Run: npx ts-node --project scripts/tsconfig.json scripts/scys-login-persist.ts
//
// Profile dir: <repo>/.scys-pw-profile/  (gitignored)

import { chromium as chromiumExtra } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

chromiumExtra.use(stealth());

const SCRIPTS_DIR = __dirname;
const REPO_ROOT = resolve(SCRIPTS_DIR, '..');
const DIST_DIR = resolve(REPO_ROOT, 'dist');
const PROFILE_DIR = resolve(REPO_ROOT, '.scys-pw-profile');
const FAKE_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Use an article URL — the homepage doesn't force login, only article does.
const LOGIN_TRIGGER_URL = 'https://scys.com/articleDetail/xq_topic/55188248452852824';

async function main() {
	if (!existsSync(DIST_DIR)) throw new Error(`dist/ missing — run 'npm run build:chrome' first`);
	if (!existsSync(PROFILE_DIR)) mkdirSync(PROFILE_DIR, { recursive: true });

	console.log(`[scys-login] profile dir: ${PROFILE_DIR}`);
	console.log(`[scys-login] launching headed chromium (NOT off-screen — you need to see the QR)`);

	const context = await chromiumExtra.launchPersistentContext(PROFILE_DIR, {
		headless: false,  // MUST be visible — user scans QR
		userAgent: FAKE_UA,
		viewport: { width: 1280, height: 900 },
		locale: 'zh-CN',
		timezoneId: 'Asia/Shanghai',
		extraHTTPHeaders: { 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' },
		args: [
			`--disable-extensions-except=${DIST_DIR}`,
			`--load-extension=${DIST_DIR}`,
			'--no-first-run',
			'--no-default-browser-check',
		],
	});

	try {
		const page = await context.newPage();
		console.log(`[scys-login] goto ${LOGIN_TRIGGER_URL}`);
		await page.goto(LOGIN_TRIGGER_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
		console.log(`[scys-login] page url after goto: ${page.url()}`);
		console.log(`[scys-login] ⚠️  please scan WeChat QR code in the browser window now`);
		console.log(`[scys-login] waiting up to 5 min for vc-doc-item (login completion signal)…`);

		// Wait for article content to appear (vc-doc-item is the article content block).
		// After QR scan completes, scys auto-redirects back to article and hydrates.
		await page.waitForSelector('.vc-doc-item', { timeout: 5 * 60_000 });
		console.log(`[scys-login] ✅ vc-doc-item detected — login successful`);

		// Verify: count cookies & dump scys-related storage state.
		const cookies = await context.cookies();
		const scysCookies = cookies.filter(c => /scys|shengcai/.test(c.domain));
		console.log(`[scys-login] cookies set on scys-related domains: ${scysCookies.length}`);
		for (const c of scysCookies) {
			console.log(`  - ${c.domain} :: ${c.name} (httpOnly=${c.httpOnly}, secure=${c.secure})`);
		}

		const lsKeys = await page.evaluate(() => Object.keys(localStorage));
		console.log(`[scys-login] localStorage keys: ${lsKeys.length}`);
		for (const k of lsKeys) {
			console.log(`  - ${k}`);
		}

		console.log(`[scys-login] giving 2s for cookies/storage to flush to disk before closing`);
		await page.waitForTimeout(2000);
	} finally {
		await context.close();
		console.log(`[scys-login] profile saved to ${PROFILE_DIR}`);
		console.log(`[scys-login] next: 'npx ts-node ... find-scys-root-selector.ts' will use this profile`);
	}
}

main().catch(e => { console.error(e); process.exit(1); });
