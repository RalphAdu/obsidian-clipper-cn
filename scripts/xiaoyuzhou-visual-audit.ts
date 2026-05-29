// scripts/xiaoyuzhou-visual-audit.ts
//
// Full-content audit for www.xiaoyuzhoufm.com /episode/<id>. Thin wrapper around
// visual-audit-framework with xiaoyuzhou-specific config.
//
// 双 root 策略：
//   1) <article> = shownote 段落（rootSelector='article'）
//   2) <div class="comment"> 是评论的 root（每条作为单独 audit unit）
// 框架本身只支持 single rootSelector，所以本文件跑两次 audit 再合并。
//
// imageAssert 返回 true：小宇宙 article 内含 SVG 订阅按钮 / podcast cover 等
// 装饰图，这些通过 unwrapAnchorImages 拆出来后仍可能在 article 内但被 turndown
// 转成 ![alt](url) inline embed；audit framework 默认要求 src 出现在 markdown，
// 但 turndown 可能改写 src 形态。decoration img 不参与 ship gate。Audio embed
// 已被 extractor 强插到 content 顶部（在 article 之外）—— 它的 src 一定在
// markdown 里，但它也不在 article DOM 内，audit 不扫它。
//
// Usage:
//   CLI:  npx ts-node --project scripts/tsconfig.json scripts/xiaoyuzhou-visual-audit.ts <md-file> <html-file>
//   Lib:  import { auditXiaoyuzhouClip } from '../../scripts/xiaoyuzhou-visual-audit';

import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';
import {
	runVisualAudit,
	formatReport,
	defaultNormalizeText,
	defaultNormalizeForCompare,
	AuditConfig,
	AuditReport,
	AuditMismatch,
} from './visual-audit-framework';

export type { AuditReport, AuditMismatch };
export { formatReport };

export const xiaoyuzhouArticleAuditConfig: AuditConfig = {
	rootSelector: 'article',
	imageAssert: () => true,
};

export function auditXiaoyuzhouClip(hydratedHtml: string, markdown: string): AuditReport {
	// Audit 1: shownote (article)
	const articleReport = runVisualAudit(hydratedHtml, markdown, xiaoyuzhouArticleAuditConfig);

	// Audit 2: 评论 - 每条 .comment 的 textContent 必须出现在 markdown
	// 用框架的 normalize 函数保持与 article audit 一致
	const normalizedHtml = hydratedHtml.replace(/<br\s*\/?\s*>/gi, '\n');
	const { document } = parseHTML(normalizedHtml);
	const mdNorm = defaultNormalizeForCompare(markdown);
	const commentEls = Array.from(document.querySelectorAll('.comment'));
	const commentMismatches: AuditMismatch[] = [];
	let commentCounted = 0;

	for (const el of commentEls) {
		// 取评论正文（剥 metadata + 嵌套 .comment + svg/img 装饰）
		const clone = el.cloneNode(true) as Element;
		clone.querySelectorAll('.info, .pinned, .replies, .comment, svg, img').forEach((n) => n.remove());
		const text = defaultNormalizeText(clone.textContent || '');
		if (!text) continue;
		commentCounted++;
		const fuzzy = defaultNormalizeForCompare(text);
		// 锚：前 30 字符（评论较短，比 article 段落用 40 更宽容）
		const anchor = fuzzy.slice(0, Math.min(30, fuzzy.length));
		if (!mdNorm.includes(anchor)) {
			commentMismatches.push({
				kind: 'missing',
				tag: 'comment',
				excerpt: text.slice(0, 60),
				fullText: text,
			});
		}
	}

	return {
		mismatches: [...articleReport.mismatches, ...commentMismatches],
		totalBlocks: articleReport.totalBlocks + commentCounted,
		mdSize: markdown.length,
		htmlSize: hydratedHtml.length,
	};
}

async function main() {
	const mdFile = process.argv[2] || '/tmp/clip-md.txt';
	const htmlFile = process.argv[3] || '/tmp/clip-html.txt';

	const md = readFileSync(mdFile, 'utf-8');
	const html = readFileSync(htmlFile, 'utf-8');

	const report = auditXiaoyuzhouClip(html, md);
	console.log(formatReport(report));
	process.exit(report.mismatches.length === 0 ? 0 : 1);
}

if (require.main === module) {
	main().catch((e) => {
		console.error(e);
		process.exit(2);
	});
}
