// One-shot: fetch a scys article raw via the live session profile, dump
// articleContent / docBlocks for inspection. Use to verify entity attribute
// orders and other extractor assumptions.
//
// Run: npx ts-node --project scripts/tsconfig.json scripts/fetch-scys-article-raw.ts 22255855424524441

import { chromium as chromiumExtra } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import { resolve } from 'node:path';

chromiumExtra.use(stealth());

const PROFILE = resolve(__dirname, '..', '.scys-pw-profile');
const FAKE_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function main() {
	const entityId = process.argv[2] || '22255855424524441';
	const entityType = process.argv[3] || 'xq_topic';

	const ctx = await chromiumExtra.launchPersistentContext(PROFILE, {
		headless: false,
		userAgent: FAKE_UA,
		viewport: { width: 1280, height: 800 },
		args: ['--no-first-run', '--no-default-browser-check', '--window-position=-2400,-2400', '--window-size=1280,800'],
	});

	try {
		const page = await ctx.newPage();
		// Need to be on scys.com domain to get cookies attached.
		await page.goto('https://scys.com/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
		await page.waitForTimeout(1000);

		const data = await page.evaluate(async ({ entityId, entityType }) => {
			const res = await fetch('/shengcai-web/client/homePage/topicDetail', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'include',
				body: JSON.stringify({ entityId, entityType }),
			});
			if (!res || !res.ok) return { error: `HTTP ${res ? res.status : 'no-response'}` };
			return await res.json();
		}, { entityId, entityType });

		const topic = data?.data?.topicDTO;
		if (!topic) {
			console.log('Unexpected shape:', JSON.stringify(data).slice(0, 500));
			return;
		}
		console.log('--- articleContent (raw) ---');
		console.log(JSON.stringify(topic.articleContent ?? null));
		console.log();
		console.log('--- docBlocks present?', Boolean(topic.docBlocks && topic.docBlocks.length));
		console.log('--- imageList?', JSON.stringify(topic.imageList ?? null));
	} finally {
		await ctx.close();
	}
}

main().catch(e => { console.error(e); process.exit(1); });
