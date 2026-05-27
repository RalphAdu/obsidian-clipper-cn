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
});
