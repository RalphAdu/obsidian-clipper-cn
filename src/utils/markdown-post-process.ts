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
//
// Platform note: PC Obsidian (Reading View) uses a virtual scroller that
// unmounts off-screen DOM nodes — when the user scrolls down past the audio
// element, the <audio> node is destroyed and playback pauses. Mobile Obsidian
// has no virtual scroller and plays continuously. We don't try to work around
// the PC behavior here (sticky/fixed positioning was tried 2026-05-29 and
// either failed to render or visually intrusive); accept it as upstream
// Obsidian limitation. Future: encourage users to install an Audio Player
// plugin if continuous background playback on PC is critical.
const AUDIO_IMAGE_EMBED_RE = /^!\[[^\]]*\]\((https?:\/\/[^)\s]+\.(?:m4a|mp3|wav|ogg|webm|flac|3gp|opus|oga))\)$/gm;

function convertAudioImageEmbedToHtml(markdown: string): string {
	return markdown.replace(AUDIO_IMAGE_EMBED_RE, (_match, url: string) =>
		`<audio controls src="${url}"></audio>`
	);
}

export function postProcessExtractorMarkdown(markdown: string): string {
	const calloutsFixed = markdown.replace(OBSIDIAN_CALLOUT_MARKER_RE, '[!$1]');
	const footnotesFixed = calloutsFixed.replace(FOOTNOTE_MARKER_RE, '[^$1]');
	const fencesFixed = fixFencedCodeBacktickEscapes(footnotesFixed);
	return convertAudioImageEmbedToHtml(fencesFixed);
}
