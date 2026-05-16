// Post-processor for markdown emitted by defuddle's `createMarkdownContent`.
//
// Turndown (used inside defuddle) escapes `[` and `]` aggressively to avoid
// accidental link/reference syntax, which mangles Obsidian-native callout
// markers we deliberately emit from extractors. e.g. `> [!tip] 💡 查看顺序`
// becomes `> \[!tip\] 💡 查看顺序`, which Obsidian's reading-view callout
// parser does NOT recognise (it would render a plain gray blockquote).
//
// This is invoked from every extractor markdown-conversion site (popup path
// via content-extractor.ts, automated test bridge in content.ts).

const OBSIDIAN_CALLOUT_MARKER_RE = /\\\[!(\w+)\\\]/g;

// scys/feishu text_color enum → CSS color. Keep in sync with feishu-extractor.
const SCYS_COLOR_MAP: Record<string, string> = {
	'1': '#e83e3a', '2': '#ff8800', '3': '#f5b400', '4': '#2dd24d',
	'5': '#28d4e8', '6': '#2da3eb', '7': '#8e3eea',
};

export function postProcessExtractorMarkdown(markdown: string): string {
	let s = markdown.replace(OBSIDIAN_CALLOUT_MARKER_RE, '[!$1]');
	// Restore color placeholders to inline <span style="color: …">. Defuddle's
	// HTML→markdown conversion strips inline-style attributes, so the extractor
	// emits literal `[[SCYS-COLOR-N]]…[[/SCYS-COLOR]]` markers that survive
	// untouched (turndown also escapes the brackets defensively as \[\[…\]\];
	// match both forms).
	s = s.replace(/\\?\[\\?\[SCYS-COLOR-(\d+)\\?\]\\?\]([\s\S]*?)\\?\[\\?\[\/SCYS-COLOR\\?\]\\?\]/g,
		(_m, n, body) => {
			const color = SCYS_COLOR_MAP[n] || '#000';
			return `<span style="color: ${color}">${body}</span>`;
		});
	// Restore alignment placeholders to <div align="…">…</div>. The blank lines
	// around the inner content let Obsidian Reading-view re-parse the markdown
	// inside the div (otherwise the H tag would be treated as raw HTML).
	s = s.replace(/\\?\[\\?\[SCYS-ALIGN-(center|right|left)\\?\]\\?\]([\s\S]*?)\\?\[\\?\[\/SCYS-ALIGN\\?\]\\?\]/g,
		(_m, dir, body) => `<div align="${dir}">\n\n${body.trim()}\n\n</div>`);
	return s;
}
