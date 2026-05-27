import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseDocsQQUrl, isDocsQQDocUrl, fetchDocMetadata, requestExportTask, pollExportStatus, fetchDocxFile } from './docs-qq-extractor';
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

describe('requestExportTask', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('returns operationId on 200', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ ret: 0, operationId: 'task-xyz-123' }), { status: 200 })
    );
    const id = await requestExportTask('300000000$BfotANGDEYOm', 'DQmZvdEFOR0RFWU9t');
    expect(id).toBe('task-xyz-123');
  });

  it('throws DocsQQAuthError on 401', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('', { status: 401 }));
    await expect(requestExportTask('300000000$BfotANGDEYOm', 'X')).rejects.toBeInstanceOf(DocsQQAuthError);
  });

  it('throws DocsQQExportFailedError if response has no operationId', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ ret: 0 }), { status: 200 })
    );
    await expect(requestExportTask('300000000$BfotANGDEYOm', 'X')).rejects.toBeInstanceOf(DocsQQExportFailedError);
  });

  it('throws DocsQQExportFailedError if ret != 0', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ ret: 100, operationId: 'x' }), { status: 200 })
    );
    await expect(requestExportTask('300000000$BfotANGDEYOm', 'X')).rejects.toBeInstanceOf(DocsQQExportFailedError);
  });

  it('sends correct form-urlencoded body', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ ret: 0, operationId: 'x' }), { status: 200 })
    );
    await requestExportTask('300000000$BfotANGDEYOm', 'DQmZvdEFOR0RFWU9t');
    const init = spy.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toContain('application/x-www-form-urlencoded');
    const body = init.body as string;
    expect(body).toContain('exportType=0');
    expect(body).toContain('exportSource=client');
    expect(body).toContain('docId=300000000%24BfotANGDEYOm');  // $ encoded
    expect(body).toContain('switches=');
    expect(body).toContain('objectMapping=');
  });
});

describe('pollExportStatus', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('returns file_url when status=Done first poll', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({
        ret: 0, status: 'Done', progress: 100,
        file_url: 'https://cdn/x.docx',
      }), { status: 200 })
    );
    const url = await pollExportStatus('task-xyz', 'DQmZvdEFOR0RFWU9t', { timeoutMs: 5000, intervalMs: 50 });
    expect(url).toBe('https://cdn/x.docx');
  });

  it('polls multiple times until Done', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    spy.mockResolvedValueOnce(new Response(JSON.stringify({ ret: 0, status: 'Processing', progress: 0 }), { status: 200 }));
    spy.mockResolvedValueOnce(new Response(JSON.stringify({ ret: 0, status: 'Processing', progress: 50 }), { status: 200 }));
    spy.mockResolvedValueOnce(new Response(JSON.stringify({
      ret: 0, status: 'Done', progress: 100, file_url: 'https://example.com/x.docx',
    }), { status: 200 }));

    const url = await pollExportStatus('task-xyz', 'X', { timeoutMs: 5000, intervalMs: 30 });
    expect(url).toBe('https://example.com/x.docx');
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('throws DocsQQExportFailedError when status=Failed', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ ret: 0, status: 'Failed' }), { status: 200 })
    );
    await expect(
      pollExportStatus('task-xyz', 'X', { timeoutMs: 1000, intervalMs: 50 })
    ).rejects.toBeInstanceOf(DocsQQExportFailedError);
  });

  it('throws DocsQQExportFailedError on status=Done but no file_url', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ ret: 0, status: 'Done', progress: 100 }), { status: 200 })
    );
    await expect(
      pollExportStatus('task-xyz', 'X', { timeoutMs: 1000, intervalMs: 50 })
    ).rejects.toBeInstanceOf(DocsQQExportFailedError);
  });

  it('throws DocsQQTransientError on timeout', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ret: 0, status: 'Processing', progress: 0 }), { status: 200 })
    );
    await expect(
      pollExportStatus('task-xyz', 'X', { timeoutMs: 200, intervalMs: 30 })
    ).rejects.toBeInstanceOf(DocsQQTransientError);
  });
});

describe('fetchDocxFile', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('returns ArrayBuffer on 200', async () => {
    const fakeBuffer = new TextEncoder().encode('PK\x03\x04...').buffer;
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(fakeBuffer, { status: 200 })
    );
    const buf = await fetchDocxFile('https://example.com/file.docx');
    expect(buf).toBeInstanceOf(ArrayBuffer);
    expect(buf.byteLength).toBeGreaterThan(0);
  });

  it('throws DocsQQTransientError on 404 (CDN gone)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('', { status: 404 }));
    await expect(fetchDocxFile('https://example.com/x.docx')).rejects.toBeInstanceOf(DocsQQTransientError);
  });

  it('throws DocsQQTransientError if Content-Length > 50MB', async () => {
    const resp = new Response(new ArrayBuffer(0), {
      status: 200,
      headers: { 'Content-Length': String(51 * 1024 * 1024) },
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(resp);
    await expect(fetchDocxFile('https://example.com/big.docx')).rejects.toBeInstanceOf(DocsQQTransientError);
  });

  it('uses credentials: omit (no cookie sent to CDN)', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(new ArrayBuffer(8), { status: 200 })
    );
    await fetchDocxFile('https://example.com/x.docx');
    const init = spy.mock.calls[0][1] as RequestInit;
    expect(init.credentials).toBe('omit');
  });
});
