export interface DocsQQParsedUrl {
  type: 'doc';
  token: string;
}

export function parseDocsQQUrl(url: string): DocsQQParsedUrl | null {
  const match = url.match(/^https:\/\/docs\.qq\.com\/doc\/([A-Za-z0-9]+)/);
  if (!match) return null;
  return { type: 'doc', token: match[1] };
}

export function isDocsQQDocUrl(url: string): boolean {
  return parseDocsQQUrl(url) !== null;
}

// ============================================
// TypeScript Interfaces
// ============================================

export interface DocsQQMetadata {
  title: string;
  author: string;
  createTime: string;  // YYYY-MM-DD
  modifyTime: string;  // YYYY-MM-DD
  wordCount: number;
}

export interface DocsQQStructuredContent {
  title: string;
  author: string;
  content: string;        // HTML (待主流程 turndown)
  published: string;      // YYYY-MM-DD, from modifyTime
  wordCount: number;
}

export interface DocsQQExtractOpts {
  token: string;
  url: string;
  doc: Document;
}

// ============================================
// Error 子类
// ============================================

export class DocsQQAuthError extends Error {
  constructor(message: string) { super(message); this.name = 'DocsQQAuthError'; }
}
export class DocsQQNotFoundError extends Error {
  constructor(message: string) { super(message); this.name = 'DocsQQNotFoundError'; }
}
export class DocsQQTransientError extends Error {
  constructor(message: string) { super(message); this.name = 'DocsQQTransientError'; }
}
export class DocsQQExportFailedError extends Error {
  constructor(message: string) { super(message); this.name = 'DocsQQExportFailedError'; }
}
export class DocsQQConvertError extends Error {
  constructor(message: string) { super(message); this.name = 'DocsQQConvertError'; }
}
