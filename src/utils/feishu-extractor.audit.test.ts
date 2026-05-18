import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { convertBlocksToHtml, resolveFeishuFiles, type FeishuBlock } from './feishu-extractor';
import sa5wFixture from './fixtures/feishu-sa5w-inline-block-source-synced.json';

// One-shot audit test loading the user's reproducing doc
// (https://ly5achi80l.feishu.cn/docx/KREbdOvMsoowcrxt9Bbcc9w7n2d)
// fetched via the Feishu OpenAPI into /tmp/all_blocks.json.
// Skipped if the file is missing — it is not committed to the repo.

const FIXTURE = '/tmp/all_blocks.json';
const haveFixture = existsSync(FIXTURE);
const blocks = haveFixture
	? (JSON.parse(readFileSync(FIXTURE, 'utf8')) as FeishuBlock[])
	: [];

(haveFixture ? describe : describe.skip)(
	'audit — full doc KREbdOvMsoowcrxt9Bbcc9w7n2d',
	() => {
		const html = haveFixture ? convertBlocksToHtml(blocks) : '';

		// Block type tallies from raw input — confirm fixture shape before
		// asserting on extractor output.
		const tally = (n: number) => blocks.filter((b) => b.block_type === n).length;
		const PAGE = 1, TEXT = 2, BULLET = 12, ORDERED = 13, CALLOUT = 19, IFRAME = 26;

		it('fixture has the expected block-type distribution', () => {
			expect(blocks.length).toBe(201);
			expect(tally(PAGE)).toBe(1);
			expect(tally(TEXT)).toBe(144);
			expect(tally(BULLET)).toBe(23);
			expect(tally(ORDERED)).toBe(18);
			expect(tally(CALLOUT)).toBe(7);
			expect(tally(IFRAME)).toBe(2);
		});

		it('every IFRAME block renders as a clickable link (no placeholder remains)', () => {
			const iframeBlocks = blocks.filter((b) => b.block_type === IFRAME);
			// Each IFRAME's decoded URL must appear inside an <a href="...">
			for (const b of iframeBlocks) {
				const raw = (b as any).iframe?.component?.url as string;
				expect(typeof raw).toBe('string');
				const decoded = decodeURIComponent(raw);
				expect(html).toContain(`<a href="${decoded}"`);
			}
			// No leftover placeholder for type 26.
			expect(html).not.toContain('[Embedded content: type 26]');
		});

		it('ORDERED list groups collapse from 18 standalone <ol> to far fewer (regression sentinel)', () => {
			const olCount = (html.match(/<ol>/g) || []).length;
			// Before the fix: 18 (one <ol> per ORDERED block).
			// After the fix: equals the number of LOGICAL ordered lists in the doc.
			// We don't know the exact logical count without reading the doc, so we
			// assert "substantially fewer than 18" — a tight upper bound documents
			// the regression risk.
			expect(olCount).toBeLessThan(18);
			expect(olCount).toBeGreaterThan(0);
			// Print a diagnostic so the audit run shows the actual number.
			console.log(`[audit] <ol> count after merge: ${olCount} (raw ORDERED blocks: 18)`);
		});

		it('every <ol> contains at least one <li>; total <li> count equals raw ORDERED count', () => {
			// Each ORDERED block becomes exactly one <li> inside some <ol> — this
			// is the invariant that protects against "items got dropped".
			// Note: <li> also appears for BULLET and TODO, so count <li> only inside <ol>...</ol>.
			const olBlocks = [...html.matchAll(/<ol>([\s\S]*?)<\/ol>/g)].map((m) => m[1]);
			const totalLi = olBlocks.reduce(
				(sum, body) => sum + (body.match(/<li>/g) || []).length,
				0,
			);
			expect(totalLi).toBe(18);
			console.log(`[audit] <li> in <ol>: ${totalLi} (raw ORDERED: 18)`);
		});

		it('the cross-discipline thinking-models segment is one <ol> with all 18 <li>', () => {
			// 18 consecutive ORDERED blocks (page children 148, 150, …, 182) head
			// "哲学的辩证" and end "现代工学的拆解". They must all live inside
			// ONE <ol> with progression 1→18. (User screenshot 20 only captured the
			// first 4 — the actual logical list is 18 items.)
			const headTitle = '哲学的辩证：以退为进的破局';
			const tailTitle = '现代工学的拆解：化繁为简';

			const headIdx = html.indexOf(headTitle);
			const tailIdx = html.indexOf(tailTitle);
			expect(headIdx).toBeGreaterThan(-1);
			expect(tailIdx).toBeGreaterThan(headIdx);

			// Find the <ol> wrapping the head — its matching </ol> must come AFTER tailTitle.
			const olOpenBefore = html.lastIndexOf('<ol>', headIdx);
			const olCloseAfter = html.indexOf('</ol>', olOpenBefore);
			expect(olOpenBefore).toBeGreaterThan(-1);
			expect(olCloseAfter).toBeGreaterThan(tailIdx);

			const segment = html.slice(olOpenBefore, olCloseAfter);
			const liInSegment = (segment.match(/<li>/g) || []).length;
			expect(liInSegment).toBe(18);
			console.log(`[audit] cross-discipline <ol>: ${liInSegment} <li>(s)`);

			// Sample three explanation paragraphs to confirm follower-merge works
			// at the head, middle, and tail of the long list.
			expect(segment).toMatch(/<li>[\s\S]*哲学的辩证[\s\S]*?<p>[\s\S]*停播七个月[\s\S]*<\/p>[\s\S]*?<\/li>/);
			expect(segment).toMatch(/<li>[\s\S]*经济学的成本[\s\S]*?<p>[\s\S]*机会成本[\s\S]*<\/p>[\s\S]*?<\/li>/);
			expect(segment).toMatch(/<li>[\s\S]*现代工学的拆解[\s\S]*?<p>[\s\S]*<\/p>[\s\S]*?<\/li>/);
		});

		it('IFRAME labels look right for the two real URLs in the doc', () => {
			expect(html).toContain('🌐 <a href="https://www.join-tsinghua.edu.cn/ebook/index.html">join-tsinghua.edu.cn/ebook/index.html</a>');
			expect(html).toContain('🌐 <a href="https://book.yunzhan365.com/pidiw/dsss/mobile/index.html">book.yunzhan365.com/pidiw/dsss/mobile/index.html</a>');
		});

		it('dumps useful diagnostics (info only, never fails)', () => {
			const olCount = (html.match(/<ol>/g) || []).length;
			const ulCount = (html.match(/<ul>/g) || []).length;
			const liCount = (html.match(/<li>/g) || []).length;
			const aCount = (html.match(/<a href=/g) || []).length;
			console.log(
				`[audit] summary: ol=${olCount} ul=${ulCount} li=${liCount} a=${aCount} bytes=${html.length}`,
			);
			expect(html.length).toBeGreaterThan(1000);
		});
	},
);

describe('audit — Sa5W… (SOURCE_SYNCED + inline_block + IMAGE caption)', () => {
	const docUrl = 'https://my.feishu.cn/docx/Sa5Wdx0Naoq2AExhFx1cKFrUnXd';

	it('full pipeline preserves all three previously-lost content kinds', () => {
		const rawHtml = convertBlocksToHtml(sa5wFixture as unknown as FeishuBlock[]);
		const finalHtml = resolveFeishuFiles(rawHtml, docUrl);

		// (1) SOURCE_SYNCED container's IMAGE survived
		expect(finalHtml).toContain('feishu-image://GI3bbDFW9oUf1WxuiAdcTsIrn9e');

		// (2) IMAGE caption surfaced
		expect(finalHtml).toContain('<figcaption>EXE为更新和启动的主要组件。</figcaption>');

		// (3) inline_block → FILE resolved to anchor link inside parent <p>
		expect(finalHtml).toContain(`<a href="${docUrl}#file1">测试连通多账号软件小工具.bat</a>`);
		// …and that anchor is NOT wrapped in a stray <p>📎
		expect(finalHtml).not.toMatch(/<p>📎 <a[^>]*>测试连通多账号软件小工具\.bat<\/a><\/p>/);

		// (4) Top-level VIEW→FILE (.mp4 control group) still renders with <p>📎 wrap
		expect(finalHtml).toContain(`<p>📎 <a href="${docUrl}#file2">1.软件使用方法.mp4</a></p>`);

		// (5) No unknown-block fallback marker (means all referenced inline targets resolved)
		expect(finalHtml).not.toContain('[内联块');
	});
});
