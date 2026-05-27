import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseDocsQQUrl, isDocsQQDocUrl, fetchDocMetadata } from './docs-qq-extractor';
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

describe('fetchDocMetadata', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // mock document.cookie for xsrf via vi.stubGlobal (node env has no document)
    vi.stubGlobal('document', { cookie: 'xsrf=2f43999878bb37d0; other=foo' });
  });

  it('returns parsed metadata on 200', async () => {
    const mockResponse = {
      retcode: 0,
      msg: '成功',
      data: {
        padInfo: {
          localPadId: 'BfotANGDEYOm',
          domainId: '300000000',
          globalPadId: '300000000$BfotANGDEYOm',
        },
        privilegeAttribute: { can_export: 1, can_export_online: 1 },
        title: '望岳投资250618十小时全文',
      },
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify(mockResponse), { status: 200 })
    );

    const meta = await fetchDocMetadata('DQmZvdEFOR0RFWU9t');
    expect(meta.title).toBe('望岳投资250618十小时全文');
    expect(meta.author).toBe('');
    expect(meta.createTime).toBe('');
    expect(meta.modifyTime).toBe('');
    expect(meta.wordCount).toBe(0);
  });

  it('throws DocsQQAuthError on 401', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('', { status: 401 }));
    await expect(fetchDocMetadata('X')).rejects.toBeInstanceOf(DocsQQAuthError);
  });

  it('throws DocsQQAuthError on 403', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('', { status: 403 }));
    await expect(fetchDocMetadata('X')).rejects.toBeInstanceOf(DocsQQAuthError);
  });

  it('throws DocsQQNotFoundError on 404', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('', { status: 404 }));
    await expect(fetchDocMetadata('X')).rejects.toBeInstanceOf(DocsQQNotFoundError);
  });

  it('throws DocsQQTransientError on 5xx', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('', { status: 500 }));
    await expect(fetchDocMetadata('X')).rejects.toBeInstanceOf(DocsQQTransientError);
  });

  it('throws DocsQQAuthError if no xsrf cookie', async () => {
    vi.stubGlobal('document', { cookie: 'other=foo' });
    await expect(fetchDocMetadata('X')).rejects.toBeInstanceOf(DocsQQAuthError);
  });
});
