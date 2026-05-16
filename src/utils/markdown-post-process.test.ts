import { describe, it, expect } from 'vitest';
import { postProcessExtractorMarkdown } from './markdown-post-process';

describe('postProcessExtractorMarkdown', () => {
	it('unescapes Obsidian callout type markers mangled by turndown', () => {
		const input = '> \\[!tip\\] 💡 查看顺序\n> body line';
		const out = postProcessExtractorMarkdown(input);
		expect(out).toBe('> [!tip] 💡 查看顺序\n> body line');
	});

	it('unescapes all standard Obsidian callout types', () => {
		const types = ['note', 'tip', 'info', 'warning', 'danger', 'success', 'failure',
			'question', 'example', 'important', 'abstract', 'quote', 'bug'];
		for (const t of types) {
			const out = postProcessExtractorMarkdown(`> \\[!${t}\\] title`);
			expect(out).toBe(`> [!${t}] title`);
		}
	});

	it('handles multiple callouts in a single document', () => {
		const input = [
			'> \\[!tip\\] first',
			'> body 1',
			'',
			'normal paragraph',
			'',
			'> \\[!info\\] second',
			'> body 2',
		].join('\n');
		const out = postProcessExtractorMarkdown(input);
		expect(out).toContain('> [!tip] first');
		expect(out).toContain('> [!info] second');
		expect(out).toContain('normal paragraph');
		expect(out).not.toContain('\\[!');
	});

	it('does not touch genuine markdown links with bracket-like syntax', () => {
		// A regular link [text](url) shouldn't be affected — only the
		// callout-marker pattern \[!word\] gets restored.
		const input = '[click here](https://example.com) and \\[brackets\\] elsewhere';
		const out = postProcessExtractorMarkdown(input);
		expect(out).toBe('[click here](https://example.com) and \\[brackets\\] elsewhere');
	});

	it('returns input unchanged when no callout markers present', () => {
		const input = '# heading\n\nordinary paragraph with **bold** and `code`.';
		expect(postProcessExtractorMarkdown(input)).toBe(input);
	});

	it('handles empty string', () => {
		expect(postProcessExtractorMarkdown('')).toBe('');
	});

	// scys article: red color emphasis on prose paragraphs (text_color=1).
	// Extractor emits [[SCYS-COLOR-N]]…[[/SCYS-COLOR]] placeholders that
	// survive defuddle's HTML→markdown conversion; post-process restores
	// them to inline <span style="color:…"> for Obsidian Reading view.
	it('restores [[SCYS-COLOR-1]]…[[/SCYS-COLOR]] to <span style="color:#e83e3a">', () => {
		const input = '亦仁老大说过，[[SCYS-COLOR-1]]默认项目都是通的[[/SCYS-COLOR]]。';
		const out = postProcessExtractorMarkdown(input);
		expect(out).toContain('<span style="color: #e83e3a">默认项目都是通的</span>');
		expect(out).not.toContain('SCYS-COLOR');
	});

	it('handles turndown-escaped color placeholders ([[\\[\\[ etc.)', () => {
		// Turndown defensively escapes `[` and `]`; the placeholder may arrive as
		// `\[\[SCYS-COLOR-1\]\]…\[\[/SCYS-COLOR\]\]` rather than the original form.
		const input = '\\[\\[SCYS-COLOR-1\\]\\]红字\\[\\[/SCYS-COLOR\\]\\]';
		const out = postProcessExtractorMarkdown(input);
		expect(out).toContain('<span style="color: #e83e3a">红字</span>');
	});

	it('restores all 7 color slots in the feishu palette', () => {
		const colors = {
			'1': '#e83e3a', '2': '#ff8800', '3': '#f5b400', '4': '#2dd24d',
			'5': '#28d4e8', '6': '#2da3eb', '7': '#8e3eea',
		};
		for (const [n, hex] of Object.entries(colors)) {
			const out = postProcessExtractorMarkdown(`[[SCYS-COLOR-${n}]]x[[/SCYS-COLOR]]`);
			expect(out).toBe(`<span style="color: ${hex}">x</span>`);
		}
	});

	// scys article: centered headings (block.style.align == 2). Extractor emits
	// [[SCYS-ALIGN-center]]…[[/SCYS-ALIGN]] around the <h*> tag.
	it('restores [[SCYS-ALIGN-center]] to <div align="center">…</div>', () => {
		const input = '[[SCYS-ALIGN-center]]## 零、前言[[/SCYS-ALIGN]]';
		const out = postProcessExtractorMarkdown(input);
		expect(out).toContain('<div align="center">');
		expect(out).toContain('## 零、前言');
		expect(out).toContain('</div>');
	});

	it('restores escaped alignment placeholders too', () => {
		const input = '\\[\\[SCYS-ALIGN-right\\]\\]X\\[\\[/SCYS-ALIGN\\]\\]';
		const out = postProcessExtractorMarkdown(input);
		expect(out).toContain('<div align="right">');
	});
});
