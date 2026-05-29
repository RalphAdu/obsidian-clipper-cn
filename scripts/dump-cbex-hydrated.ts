// Dump hydrated HTML of a cbex page directly via Playwright (no bridge needed).
// Usage: npx ts-node --project scripts/tsconfig.json scripts/dump-cbex-hydrated.ts <URL> <outPath>

import { chromium as chromiumExtra } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import { writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

chromiumExtra.use(stealth());

const FAKE_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const DIST_DIR = resolve(__dirname, '..', 'dist');

async function main() {
  const url = process.argv[2];
  const out = process.argv[3];
  if (!url || !out) {
    console.error('Usage: dump-cbex-hydrated.ts <URL> <outPath>');
    process.exit(2);
  }
  if (!existsSync(DIST_DIR)) {
    console.error('dist/ not present; run npm run build:chrome first');
    process.exit(2);
  }
  const profileDir = mkdtempSync(join(tmpdir(), 'cbex-dump-'));
  const ctx = await chromiumExtra.launchPersistentContext(profileDir, {
    headless: false,
    userAgent: FAKE_UA,
    viewport: { width: 1920, height: 1080 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    colorScheme: 'light',
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
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForSelector('.bd_detail_name', { timeout: 30_000 });
    await page.waitForTimeout(2000);
    const html = await page.evaluate(() => document.documentElement.outerHTML);
    writeFileSync(out, html, 'utf-8');
    console.log(`wrote ${html.length}B to ${out}`);
  } finally {
    await ctx.close();
    rmSync(profileDir, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
