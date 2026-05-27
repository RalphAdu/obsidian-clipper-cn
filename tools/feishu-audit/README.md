# feishu-audit

Node CLI that audits a feishu docx against the cn extractor pipeline + a
"feishu front-end convention knowledge base", reporting any mismatch.

## Usage

```bash
npx tsx --tsconfig tools/feishu-audit/tsconfig.json tools/feishu-audit/feishu-audit.ts <feishu-doc-url> [--vault-md <path>]
```

`--vault-md` is optional — when provided, enables 2 additional buckets that read the actual Obsidian vault markdown the user clipped. Recommended for verifying real-world output after each cn extractor change.

Reads credentials from `docs/superpowers/feishu.md` (git-ignored).

Output:

- Renders the doc + its comments to `/tmp/feishu-audit-output.md` (so a
  human can read the actual markdown).
- Prints a 10-bucket mismatch report (12 buckets when `--vault-md` is supplied).
- Exits 0 on full pass, 1 if any bucket has misses, 2 on tool error.

## Buckets

| Bucket | What it verifies |
|---|---|
| `h1_numbering` | Each HEADING1 block produces a markdown line `# N. title`, N by document order |
| `mention_link` | Each `mention_doc` element with a URL produces a `[title](url)` markdown link |
| `iframe_link` | Each IFRAME block produces a markdown link to its decoded URL |
| `section_header_misplaced` | All-bold-only TEXT blocks render as standalone `**text**` lines, NOT inside a list item |
| `orderedlist_split` | Each ORDERED block has a matching `N. ...` line; no items dropped during list merging |
| `bulletlist_split` | Each BULLET block has a matching `- ...` line; no items dropped |
| `placeholder_residue` | No `[Embedded content: type N]` placeholder strings remain |
| `comments_section` | When comments exist, the markdown contains `---\n## 评论` anchor |
| `comment_thread` | Each comment thread renders as an Obsidian callout with the right kind, author, and timestamp |
| `comment_image` | Each comment with images has a `data:image/...` URI or a fallback placeholder somewhere |
| `image_mime_invalid` | (--vault-md only) vault `.md` has no `![](data:<non-image-mime>;...)` entries — catches the "broken inline image" bug where feishu's encrypted bytes leak through as data URLs |
| `frontmatter_field_empty` | (--vault-md only) vault `.md` frontmatter has non-empty `author:` and `published:` — catches the "doc metadata not piped to frontmatter" bug |

## Limitations (BACKLOG)

- Comment authors show as `评论者 <last 8 chars of open_id>`. Real names
  require `contact:user.base:readonly` permission on the App.
- Both `/docx/{id}` and `/wiki/{token}` URLs supported; `/wiki/` URLs are resolved via the `wiki.v2.spaces.get_node` API before fetching blocks.
- DOM-driven audit is deferred — current audit only validates conventions
  the OpenAPI data can prove. Truly OpenAPI-invisible web-only differences
  (CSS-only decorations, etc.) are not caught.
- Audit pipeline uses a vanilla `TurndownService` config in Node. The real
  Chrome extension pipeline uses defuddle's turndown, which may have
  different escape behavior. Audit verifies extractor logic + structural
  correctness, not byte-perfect parity with extension output.
