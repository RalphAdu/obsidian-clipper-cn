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

	it('unescapes footnote inline ref [^N] mangled by turndown (turndown leaves ^ unescaped)', () => {
		// Turndown escapes [ and ] but not ^. So real on-disk markdown is `\[^1\]`,
		// not `\[\^1\]`. Verified against actual mp.weixin clip output.
		const input = '正文 \\[^1\\] 引用';
		expect(postProcessExtractorMarkdown(input)).toBe('正文 [^1] 引用');
	});

	it('unescapes footnote definition [^N]: mangled by turndown', () => {
		const input = '\\[^1\\]: wechat-article-exporter — https://github.com/x';
		expect(postProcessExtractorMarkdown(input)).toBe('[^1]: wechat-article-exporter — https://github.com/x');
	});

	it('unescapes multi-digit footnote markers', () => {
		const input = 'see \\[^12\\] and \\[^99\\]:';
		expect(postProcessExtractorMarkdown(input)).toBe('see [^12] and [^99]:');
	});

	it('does not touch plain [N] without caret (so non-footnote bracket text stays escaped)', () => {
		const input = 'item \\[1\\] only, not a footnote';
		expect(postProcessExtractorMarkdown(input)).toBe('item \\[1\\] only, not a footnote');
	});

	// audio embed: turndown emits ![](url.m4a) for <img> tags pointing at audio
	// files, but Obsidian's image-embed only renders image MIME — audio URLs
	// hit broken-image icon. Convert to <audio controls src=...> HTML so
	// Obsidian renders an inline audio player.
	//
	// Sticky-wrapped <audio> keeps DOM mounted during virtual scroll (mobile
	// Obsidian: visually pins + plays continuously; PC Obsidian: sticky may
	// not visually engage but wrapper still helps audio survive scroll-out).
	// Bare <audio> caused playback to pause on both platforms (2026-05-29 revert
	// regression). Wrapper protects mobile playback at minimum.
	const STICKY_WRAPPER_STYLE = 'position:sticky;top:0;z-index:100;background:var(--background-primary);padding:4px 0';
	const wrap = (url: string) => `<div style="${STICKY_WRAPPER_STYLE}"><audio controls src="${url}" style="width:100%"></audio></div>`;

	it('converts audio image-embed to wrapped <audio> HTML with sticky div (m4a)', () => {
		const input = '![](https://media.xyzcdn.net/abc/X.m4a)';
		expect(postProcessExtractorMarkdown(input)).toBe(wrap('https://media.xyzcdn.net/abc/X.m4a'));
	});

	it('converts audio image-embed for all supported extensions', () => {
		const exts = ['mp3', 'wav', 'ogg', 'webm', 'flac', '3gp', 'opus', 'oga'];
		for (const ext of exts) {
			const input = `![](https://e.com/a.${ext})`;
			expect(postProcessExtractorMarkdown(input)).toBe(wrap(`https://e.com/a.${ext}`));
		}
	});

	it('preserves alt text by ignoring it (audio embed needs URL only)', () => {
		const input = '![my podcast](https://e.com/a.m4a)';
		expect(postProcessExtractorMarkdown(input)).toBe(wrap('https://e.com/a.m4a'));
	});

	it('does not touch image embeds (png/jpg etc)', () => {
		const input = '![](https://e.com/a.png)';
		expect(postProcessExtractorMarkdown(input)).toBe('![](https://e.com/a.png)');
	});

	it('does not touch inline audio embed (mid-line, not standalone)', () => {
		// Inline audio inside a paragraph stays as image-embed (rare in practice)
		const input = 'prefix ![](https://e.com/a.m4a) suffix';
		expect(postProcessExtractorMarkdown(input)).toBe('prefix ![](https://e.com/a.m4a) suffix');
	});

	it('handles audio embed in multi-line markdown', () => {
		const input = '# Title\n\n![](https://e.com/a.m4a)\n\nbody';
		expect(postProcessExtractorMarkdown(input)).toBe(`# Title\n\n${wrap('https://e.com/a.m4a')}\n\nbody`);
	});
});
