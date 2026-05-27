import { describe, it, expect } from 'vitest';
import { parseDocsQQUrl, isDocsQQDocUrl } from './docs-qq-extractor';
import {
  DocsQQAuthError,
  DocsQQNotFoundError,
  DocsQQTransientError,
  DocsQQExportFailedError,
  DocsQQConvertError,
} from './docs-qq-extractor';

describe('parseDocsQQUrl', () => {
  it('parses doc URL with bare token', () => {
    expect(parseDocsQQUrl('https://docs.qq.com/doc/DQmZvdEFOR0RFWU9t')).toEqual({
      type: 'doc', token: 'DQmZvdEFOR0RFWU9t',
    });
  });

  it('strips hash anchor', () => {
    expect(parseDocsQQUrl('https://docs.qq.com/doc/DQmZvdEFOR0RFWU9t#?foo=bar')).toEqual({
      type: 'doc', token: 'DQmZvdEFOR0RFWU9t',
    });
  });

  it('strips query string', () => {
    expect(parseDocsQQUrl('https://docs.qq.com/doc/DQmZvdEFOR0RFWU9t?p=123')).toEqual({
      type: 'doc', token: 'DQmZvdEFOR0RFWU9t',
    });
  });

  it('returns null for /sheet/ URL (v2)', () => {
    expect(parseDocsQQUrl('https://docs.qq.com/sheet/DQmZvdEFOR0RFWU9t')).toBeNull();
  });

  it('returns null for /slide/ URL (v2)', () => {
    expect(parseDocsQQUrl('https://docs.qq.com/slide/DQmZvdEFOR0RFWU9t')).toBeNull();
  });

  it('returns null for non-docs.qq URL', () => {
    expect(parseDocsQQUrl('https://example.com/doc/abc')).toBeNull();
  });

  it('returns null for http (not https)', () => {
    expect(parseDocsQQUrl('http://docs.qq.com/doc/abc')).toBeNull();
  });
});

describe('isDocsQQDocUrl', () => {
  it('returns true for doc URL', () => {
    expect(isDocsQQDocUrl('https://docs.qq.com/doc/DQmZvdEFOR0RFWU9t')).toBe(true);
  });
  it('returns false for non-doc URL', () => {
    expect(isDocsQQDocUrl('https://docs.qq.com/sheet/abc')).toBe(false);
    expect(isDocsQQDocUrl('https://example.com/doc/abc')).toBe(false);
  });
});

describe('Error classes', () => {
  it('DocsQQAuthError instanceof Error and carries message', () => {
    const e = new DocsQQAuthError('未登录');
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toBe('未登录');
    expect(e.name).toBe('DocsQQAuthError');
  });

  it('all error subclasses have distinct names', () => {
    const errors = [
      new DocsQQAuthError('a'),
      new DocsQQNotFoundError('b'),
      new DocsQQTransientError('c'),
      new DocsQQExportFailedError('d'),
      new DocsQQConvertError('e'),
    ];
    const names = errors.map(e => e.name);
    expect(new Set(names).size).toBe(5);
  });
});
