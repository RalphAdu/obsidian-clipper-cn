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

// Turndown also escapes Obsidian/CommonMark footnote markers, e.g.
//   inline ref:  `\[^1\]`  (should be `[^1]`)
//   definition:  `\[^1\]:` (should be `[^1]:`)
// Turndown escapes the brackets but NOT the caret, so the on-disk form is
// `\[^N\]` (3 escaped chars: `[` becomes `\[`, `]` becomes `\]`, `^` stays
// as bare `^` because turndown doesn't consider it dangerous). One regex
// covers both inline and definition since they share the same opening shape.
// mp.weixin's mdnice template normalizer emits these as part of the
// trailing Sources footnote block; un-escape them so Obsidian recognises
// the footnote syntax and renders backlinks.
const FOOTNOTE_MARKER_RE = /\\\[\^(\d+)\\\]/g;

// Defuddle's preformattedCode turndown rule emits fenced code blocks with a
// fixed 3-backtick fence AND unconditionally escapes every inner backtick as
// `\\\``. That's a bug: CommonMark spec says backslash escapes inside fenced
// code blocks are NOT recognised, so `\\\`` renders literally as backslash +
// backtick in Obsidian. The correct way to embed a 3+ backtick run inside a
// fenced block is to lengthen the OUTER fence (3 backticks → 4+). We undo
// the escape here and lengthen fences as needed. Safe for all sites because
// fenced-code-block escape is invalid markdown to begin with.
const FENCED_CODE_BLOCK_RE = /^(```[A-Za-z0-9_\-]*)\n([\s\S]*?)\n(```)$/gm;

function fixFencedCodeBacktickEscapes(markdown: string): string {
	return markdown.replace(FENCED_CODE_BLOCK_RE, (match, openFence: string, body: string, closeFence: string) => {
		if (!body.includes('\\`')) return match;
		const unescaped = body.replace(/\\`/g, '`');
		const runs = unescaped.match(/`+/g) || [];
		const longestRun = runs.reduce((m, r) => Math.max(m, r.length), 0);
		const lang = openFence.slice(3);
		if (longestRun >= 3) {
			const newFence = '`'.repeat(longestRun + 1);
			return `${newFence}${lang}\n${unescaped}\n${newFence}`;
		}
		return `${openFence}\n${unescaped}\n${closeFence}`;
	});
}

// Obsidian's image-embed syntax `![](url)` only renders inline <img> for image
// MIME types. Audio file URLs (.m4a/.mp3/.wav/.ogg/.webm/.flac/.3gp) hit the
// broken-image icon + filename fallback (verified 2026-05-29 with xiaoyuzhou
// audio embed in Live Preview view). HTML `<audio controls src="...">` is the
// supported way to render an external audio URL as a playable widget — Obsidian
// passes block-level HTML through to the rendered view.
// Pattern matches markdown-on-its-own-line audio image-embed (avoiding inline
// edge cases) and rewrites to <audio> tag. Site-agnostic but in practice only
// triggers for xiaoyuzhou which emits .m4a embed at note top.
//
// position:sticky keeps the player pinned to viewport top when the user scrolls
// down to read shownote / comments — otherwise Obsidian's preview-view virtual
// scroller unmounts off-screen DOM nodes and the audio element gets paused/
// destroyed mid-playback (verified 2026-05-29 with xiaoyuzhou clip in Reading
// View — playback halted whenever the embed scrolled out of view).
// top:0 anchors against the markdown view scroll container; z-index keeps it
// above heading anchors / callout boxes.
const AUDIO_IMAGE_EMBED_RE = /^!\[[^\]]*\]\((https?:\/\/[^)\s]+\.(?:m4a|mp3|wav|ogg|webm|flac|3gp|opus|oga))\)$/gm;
const AUDIO_EMBED_STYLE = 'position:sticky;top:0;z-index:100;width:100%;background:var(--background-primary);padding:4px 0';

function convertAudioImageEmbedToHtml(markdown: string): string {
	return markdown.replace(AUDIO_IMAGE_EMBED_RE, (_match, url: string) =>
		`<audio controls src="${url}" style="${AUDIO_EMBED_STYLE}"></audio>`
	);
}

export function postProcessExtractorMarkdown(markdown: string): string {
	const calloutsFixed = markdown.replace(OBSIDIAN_CALLOUT_MARKER_RE, '[!$1]');
	const footnotesFixed = calloutsFixed.replace(FOOTNOTE_MARKER_RE, '[^$1]');
	const fencesFixed = fixFencedCodeBacktickEscapes(footnotesFixed);
	return convertAudioImageEmbedToHtml(fencesFixed);
}
