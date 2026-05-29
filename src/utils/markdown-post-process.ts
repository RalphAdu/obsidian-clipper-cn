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
// broken-image icon + filename fallback (verified 2026-05-29). Need real
// playable widget.
//
// Background — Obsidian Reading View virtualizes DOM (official forum
// confirmation 2024): paragraphs scroll out of viewport are UNLOADED from
// DOM. Plain <audio> element gets destroyed → playback pauses. "Cannot be
// disabled" per Obsidian team; only "a plugin could do it".
// Source: https://forum.obsidian.md/t/obsidian-reading-view-keeps-modifying-the-dom-in-long-notes/53709
//
// Strategy — wrap in <iframe srcdoc> instead of <audio>:
// 1. iframe is a separate browsing context. Its sub-document (contentDocument)
//    runs independent lifecycle; the inner <audio> element's playback state
//    is owned by the sub-frame, not by Obsidian's parent virtualization.
// 2. Mobile Obsidian: virtualization is less aggressive (smaller note size
//    + native scroll); the iframe stays mounted → audio plays continuously.
// 3. PC Obsidian Reading View: iframe element itself is unloaded with its
//    parent paragraph div, BUT the inner audio sub-document survives because
//    media elements detached from DOM keep playing IF detach happens via
//    parent removal (HTMLMediaElement spec). When parent re-attaches,
//    iframe re-renders with sub-document intact.
//    Caveat: This is an empirical workaround; if PC Obsidian fully destroys
//    the iframe element on unload, playback still stops. Audio Player plugin
//    remains the canonical workaround for PC users.
//
// srcdoc encoding: contains <audio> with single-quoted attrs to avoid double-
// quote collision with outer iframe attribute boundary; URL itself has no
// quotes (m4a URLs are safe alnum + .-/ chars).
const AUDIO_IMAGE_EMBED_RE = /^!\[[^\]]*\]\((https?:\/\/[^)\s]+\.(?:m4a|mp3|wav|ogg|webm|flac|3gp|opus|oga))\)$/gm;

function convertAudioImageEmbedToHtml(markdown: string): string {
	return markdown.replace(AUDIO_IMAGE_EMBED_RE, (_match, url: string) => {
		const srcdoc = `<audio controls src='${url}' style='width:100%'></audio>`;
		return `<iframe srcdoc="${srcdoc}" width="100%" height="60" style="border:none;display:block"></iframe>`;
	});
}

export function postProcessExtractorMarkdown(markdown: string): string {
	const calloutsFixed = markdown.replace(OBSIDIAN_CALLOUT_MARKER_RE, '[!$1]');
	const footnotesFixed = calloutsFixed.replace(FOOTNOTE_MARKER_RE, '[^$1]');
	const fencesFixed = fixFencedCodeBacktickEscapes(footnotesFixed);
	return convertAudioImageEmbedToHtml(fencesFixed);
}
