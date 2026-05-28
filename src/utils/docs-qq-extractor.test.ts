import { describe, it, expect, vi, beforeEach } from 'vitest';

// Top-level vi.mock is hoisted before any import, so it applies to the
// static `import mammothStatic from 'mammoth'` in docs-qq-extractor.ts.
// Per-test vi.doMock + vi.resetModules() + re-import overrides this for
// convertDocxToHtml-specific tests. The default mock here satisfies the
// orchestration test which uses the top-level imported extractDocsQQContent.
vi.mock('mammoth', () => ({
  default: {
    convertToHtml: vi.fn().mockResolvedValue({ value: '<p>MockedBody</p>', messages: [] }),
    images: {
      imgElement: (_handler: unknown) => 'IMG_HANDLER_TOKEN',
    },
  },
  // Also provide top-level exports (CJS interop)
  convertToHtml: vi.fn().mockResolvedValue({ value: '<p>MockedBody</p>', messages: [] }),
  images: {
    imgElement: (_handler: unknown) => 'IMG_HANDLER_TOKEN',
  },
}));

import { parseDocsQQUrl, isDocsQQDocUrl, fetchDocMetadata, requestExportTask, pollExportStatus, fetchDocxFile, convertDocxToHtml, postProcessHtml, extractDocsQQContent } from './docs-qq-extractor';
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
    // mock document.cookie with TOK (= xsrf token) via vi.stubGlobal (node env has no document)
    vi.stubGlobal('document', { cookie: 'TOK=0000000000000000; other=foo' });
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

  it('throws DocsQQAuthError if neither TOK nor xsrf cookie', async () => {
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

describe('convertDocxToHtml', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    // Always unregister mocks to avoid cross-test contamination when a test crashes
    vi.doUnmock('mammoth');
    vi.doUnmock('mathml-to-latex');
  });

  it('returns HTML string from valid docx ArrayBuffer (mocked mammoth)', async () => {
    vi.doMock('mammoth', () => ({
      default: {
        convertToHtml: vi.fn().mockResolvedValue({
          value: '<p>Hello</p>',
          messages: [],
        }),
        images: {
          imgElement: (_handler: unknown) => 'IMG_HANDLER_TOKEN',
        },
      },
    }));

    const { convertDocxToHtml: fn } = await import('./docs-qq-extractor');
    const buf = new ArrayBuffer(8);
    const html = await fn(buf);
    expect(html).toContain('<p>Hello</p>');

    vi.doUnmock('mammoth');
  });

  it('throws DocsQQConvertError when mammoth throws', async () => {
    vi.doMock('mammoth', () => ({
      default: {
        convertToHtml: vi.fn().mockRejectedValue(new Error('corrupt docx')),
        images: { imgElement: (_h: unknown) => 'X' },
      },
    }));

    const { convertDocxToHtml: fn, DocsQQConvertError: Err } = await import('./docs-qq-extractor');
    await expect(fn(new ArrayBuffer(8))).rejects.toBeInstanceOf(Err);

    vi.doUnmock('mammoth');
  });

  // NOTE: The "throws when import('mammoth') fails" test was removed.
  // mammoth is now statically imported (bundled into content.js) so dynamic
  // import failure is no longer a valid code path.
});

describe('postProcessHtml', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    // Always unregister mocks to avoid cross-test contamination when a test crashes
    vi.doUnmock('mammoth');
    vi.doUnmock('mathml-to-latex');
  });

  it('converts inline MathML to $latex$', async () => {
    vi.doMock('mathml-to-latex', () => ({
      default: (_xml: string) => 'x^2',
    }));
    const { postProcessHtml: fn } = await import('./docs-qq-extractor');
    const html = '<p>Eq: <math><mi>x</mi></math></p>';
    const result = await fn(html);
    expect(result).toContain('$x^2$');
    vi.doUnmock('mathml-to-latex');
  });

  it('converts block MathML to $$latex$$', async () => {
    vi.doMock('mathml-to-latex', () => ({
      default: (_xml: string) => 'a + b = c',
    }));
    const { postProcessHtml: fn } = await import('./docs-qq-extractor');
    const html = '<p><math display="block"><mi>a</mi></math></p>';
    const result = await fn(html);
    expect(result).toContain('$$a + b = c$$');
    vi.doUnmock('mathml-to-latex');
  });

  it('removes empty <p>', async () => {
    const { postProcessHtml: fn } = await import('./docs-qq-extractor');
    const html = '<p>foo</p><p></p><p>bar</p>';
    const result = await fn(html);
    expect(result).not.toMatch(/<p>\s*<\/p>/);
    expect(result).toContain('<p>foo</p>');
    expect(result).toContain('<p>bar</p>');
  });

  it('keeps MathML untouched if mathml-to-latex throws', async () => {
    vi.doMock('mathml-to-latex', () => ({
      default: (_xml: string) => { throw new Error('cant parse'); },
    }));
    const { postProcessHtml: fn } = await import('./docs-qq-extractor');
    const html = '<p><math><mi>x</mi></math></p>';
    const result = await fn(html);
    expect(result).toContain('<math');  // 保留原 MathML 标签
    vi.doUnmock('mathml-to-latex');
  });

  it('returns html unchanged if no math/empty-p/double-br', async () => {
    const { postProcessHtml: fn } = await import('./docs-qq-extractor');
    const html = '<h1>Title</h1><p>Plain text</p>';
    const result = await fn(html);
    expect(result).toContain('<h1>Title</h1>');
    expect(result).toContain('<p>Plain text</p>');
  });

  it('unwraps <img> from heading-only-image (docx style bug)', async () => {
    const { postProcessHtml: fn } = await import('./docs-qq-extractor');
    const html = '<p>before</p><h3><img alt="x" src="data:image/png;base64,Z" /></h3><p>after</p>';
    const result = await fn(html);
    // heading 已删除
    expect(result).not.toMatch(/<h3>/);
    // img 提到独立 <p>
    expect(result).toMatch(/<p><img[^>]*alt="x"[^>]*\/?>\s*<\/p>/);
    // 上下文 paragraph 保留
    expect(result).toContain('<p>before</p>');
    expect(result).toContain('<p>after</p>');
  });

  it('keeps heading containing both image AND text untouched (only no-text image is unwrapped)', async () => {
    const { postProcessHtml: fn } = await import('./docs-qq-extractor');
    const html = '<h3>Section: <img alt="icon" src="data:image/png;base64,Y" /></h3>';
    const result = await fn(html);
    // heading 不动 — 因为还有 'Section:' 文本
    expect(result).toContain('<h3>');
    expect(result).toContain('Section:');
    expect(result).toMatch(/<img[^>]*alt="icon"/);
  });
});

describe('extractDocsQQContent (orchestration)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal('document', { cookie: 'TOK=0000000000000000' });
  });

  it('runs full pipeline: meta → export → poll → download → mammoth → postProcess', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    // 1. fetchGlobalPadId
    spy.mockResolvedValueOnce(new Response(JSON.stringify({
      retcode: 0, msg: '成功',
      data: {
        padInfo: { localPadId: 'BfotANGDEYOm', domainId: '300000000', globalPadId: '300000000$BfotANGDEYOm' },
        privilegeAttribute: { can_export: 1 },
        title: 'My Doc',
      },
    }), { status: 200 }));
    // 2. fetchDocMetadata (same endpoint, but extractor 内部可能 2 次调或合并为 1 次)
    spy.mockResolvedValueOnce(new Response(JSON.stringify({
      retcode: 0,
      data: {
        padInfo: { globalPadId: '300000000$BfotANGDEYOm' },
        privilegeAttribute: { can_export: 1 },
        title: 'My Doc',
      },
    }), { status: 200 }));
    // 3. requestExportTask
    spy.mockResolvedValueOnce(new Response(JSON.stringify({
      ret: 0, operationId: 'op-1',
    }), { status: 200 }));
    // 4. pollExportStatus
    spy.mockResolvedValueOnce(new Response(JSON.stringify({
      ret: 0, status: 'Done', progress: 100, file_url: 'https://cdn/x.docx',
    }), { status: 200 }));
    // 5. fetchDocxFile
    spy.mockResolvedValueOnce(new Response(new ArrayBuffer(64), { status: 200 }));

    // mammoth is mocked via top-level vi.mock() — returns '<p>MockedBody</p>'
    const result = await extractDocsQQContent({
      token: 'DQmZvdEFOR0RFWU9t',
      url: 'https://docs.qq.com/doc/DQmZvdEFOR0RFWU9t',
      doc: globalThis.document as unknown as Document,
    });

    expect(result.title).toBe('My Doc');
    expect(result.author).toBe('');
    expect(result.published).toBe('');
    expect(result.content).toContain('<p>MockedBody</p>');
    expect(typeof result.wordCount).toBe('number');
  });

  it('propagates DocsQQAuthError from first fetch', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('', { status: 401 }));
    await expect(extractDocsQQContent({
      token: 'X', url: 'https://docs.qq.com/doc/X', doc: globalThis.document as unknown as Document,
    })).rejects.toBeInstanceOf(DocsQQAuthError);
  });
});
