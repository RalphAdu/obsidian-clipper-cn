# feishu-audit

Node CLI that audits a feishu docx against the cn extractor pipeline + a
"feishu front-end convention knowledge base", reporting any mismatch.

## Usage

```bash
npx tsx --tsconfig tools/feishu-audit/tsconfig.json tools/feishu-audit/feishu-audit.ts <feishu-doc-url>
```

Credentials are read from `docs/superpowers/feishu.md` (git-ignored).

## Buckets

(Filled in by Task 12 after all modules land.)
