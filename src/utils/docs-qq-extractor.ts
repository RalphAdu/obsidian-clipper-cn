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
