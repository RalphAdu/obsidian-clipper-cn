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
// broken-image icon + filename fallback. Need real playable widget — use
// HTML <audio>, wrapped in <div style="position:sticky">.
//
// Why sticky <div> wrap (not bare <audio>, not <iframe srcdoc>):
//
// Obsidian Reading View VIRTUALIZES the DOM (official forum 2024):
//   "the first paragraphs are unloaded from the DOM, and the later paragraphs
//    are loaded... This is the correct behavior, and cannot be disabled.
//    A plugin could do it, but that's the only option."
//   https://forum.obsidian.md/t/obsidian-reading-view-keeps-modifying-the-dom-in-long-notes/53709
//
// When the user scrolls past the audio, Obsidian unloads its parent paragraph
// div. Plain <audio> dies → playback pauses on BOTH mobile and PC (verified
// 2026-05-29 by reverting to bare <audio> — both platforms regressed).
//
// Sticky <div> wrapper saves MOBILE Obsidian: sticky positioning visually pins
// the player to viewport top AND keeps the DOM node in layout flow, so the
// virtualizer doesn't unload it. On mobile both behaviors engage.
//
// PC Obsidian Reading View: sticky positioning visually fails (parent layout
// in the markdown sandbox bounds sticky to its own height); the player scrolls
// out with the paragraph and Obsidian then unloads it → playback pauses.
// This is per-platform Obsidian behavior, not markdown-fixable.
//
// <iframe srcdoc> was tested 2026-05-29 as a deeper workaround (sub-document
// independent lifecycle?). Chromium-engine sandbox test (parent.removeChild +
// re-insert) showed iframe's setInterval STOPPED during detach (0 ticks in 3s)
// and re-loaded on re-attach (counter reset). iframe sub-document does NOT
// survive parent detach at the engine level — so iframe is not a fix and adds
// complexity. Reverted.
//
// Canonical PC workaround: install an Audio Player plugin (per Obsidian
// forum consensus). Not addressed in this extractor.
const AUDIO_IMAGE_EMBED_RE = /^!\[[^\]]*\]\((https?:\/\/[^)\s]+\.(?:m4a|mp3|wav|ogg|webm|flac|3gp|opus|oga))\)$/gm;
const AUDIO_WRAPPER_STYLE = 'position:sticky;top:0;z-index:100;background:var(--background-primary);padding:4px 0';

function convertAudioImageEmbedToHtml(markdown: string): string {
	return markdown.replace(AUDIO_IMAGE_EMBED_RE, (_match, url: string) =>
		`<div style="${AUDIO_WRAPPER_STYLE}"><audio controls src="${url}" style="width:100%"></audio></div>`
	);
}

export function postProcessExtractorMarkdown(markdown: string): string {
	const calloutsFixed = markdown.replace(OBSIDIAN_CALLOUT_MARKER_RE, '[!$1]');
	const footnotesFixed = calloutsFixed.replace(FOOTNOTE_MARKER_RE, '[^$1]');
	const fencesFixed = fixFencedCodeBacktickEscapes(footnotesFixed);
	return convertAudioImageEmbedToHtml(fencesFixed);
}
