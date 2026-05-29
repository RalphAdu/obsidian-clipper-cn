// Capture cbex XHR responses (ggnr / wtListPaging / jjjgListPaging) for fixtures.
// Hooks XHR open/send via addInitScript, navigates the page, clicks each tab,
// then dumps responses to files. Skips the extension load (not needed).

import { chromium as chromiumExtra } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

chromiumExtra.use(stealth());

const FAKE_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function main() {
  const url = process.argv[2];
  if (!url) { console.error('Usage: dump-cbex-xhr.ts <URL>'); process.exit(2); }
  const profileDir = mkdtempSync(join(tmpdir(), 'cbex-xhr-'));
  const ctx = await chromiumExtra.launchPersistentContext(profileDir, {
    headless: true,
    userAgent: FAKE_UA,
    viewport: { width: 1920, height: 1080 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    colorScheme: 'light',
    extraHTTPHeaders: { 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' },
  });
  try {
    const page = await ctx.newPage();
    await page.addInitScript(`
      (() => {
        window.__captured = [];
        const _open = XMLHttpRequest.prototype.open;
        const _send = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function(method, url) {
          this.__cap = { method: method, url: url };
          return _open.apply(this, arguments);
        };
        XMLHttpRequest.prototype.send = function(body) {
          const cap = this.__cap;
          if (cap) {
            cap.body = body == null ? null : String(body);
            this.addEventListener('loadend', () => {
              cap.status = this.status;
              cap.responseText = this.responseText || '';
              window.__captured.push(cap);
            });
          }
          return _send.apply(this, arguments);
        };
      })();
    `);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForSelector('.bd_detail_name', { timeout: 30_000 });
    // Click ct4, ct7, ct8
    for (const sel of ['#bd_detail_tab_ct4', '#bd_detail_tab_ct7', '#bd_detail_tab_ct8']) {
      try { await page.click(`a[href="${sel}"]`); await page.waitForTimeout(1800); } catch { /* tab may not exist for some pages */ }
    }
    await page.waitForTimeout(1500);
    const captured: Array<{url:string;method:string;body:string|null;status:number;responseText:string}> =
      await page.evaluate('window.__captured');
    const filtered = captured.filter(c => /\/(ggnr|wtListPaging|jjjgListPaging)\b/.test(c.url));
    for (const c of filtered) {
      const tab = c.url.match(/\/(ggnr|wtListPaging|jjjgListPaging)\b/)?.[1];
      const fname = `src/utils/cbex-extractor.fixture-${tab}.html`;
      writeFileSync(fname, c.responseText, 'utf-8');
      console.log(`${tab}: ${c.responseText.length}B body=${c.body} status=${c.status} → ${fname}`);
    }
  } finally {
    await ctx.close();
    rmSync(profileDir, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
