// @vitest-environment happy-dom
//
// Turndown (used inside defuddle/full → createMarkdownContent) needs document
// and DOMParser globals. Without a DOM environment it silently fails with
// "Partial conversion completed with errors." The existing linkedom-based tests
// are unaffected — they parse their own DOM with parseHTML() regardless of env.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isCbexPrjDetailUrl, parseCbexUrl, ct4FragmentToMarkdown, ct7FragmentToMarkdown, ct8FragmentToMarkdown } from './cbex-extractor';

describe('isCbexPrjDetailUrl', () => {
  it('matches jpxkc.cbex.com prj detail URLs', () => {
    expect(isCbexPrjDetailUrl('https://jpxkc.cbex.com/jpxkc/prj/detail/522611.html')).toBe(true);
    expect(isCbexPrjDetailUrl('http://jpxkc.cbex.com/jpxkc/prj/detail/12345.html')).toBe(true);
  });

  it('rejects other cbex URLs', () => {
    expect(isCbexPrjDetailUrl('https://jpxkc.cbex.com/jpxkc/zc_prjs/2238.html')).toBe(false);
    expect(isCbexPrjDetailUrl('https://otc.cbex.com/page/s/index')).toBe(false);
    expect(isCbexPrjDetailUrl('https://www.cbex.com.cn/')).toBe(false);
  });

  it('rejects non-cbex URLs', () => {
    expect(isCbexPrjDetailUrl('https://example.com/jpxkc/prj/detail/522611.html')).toBe(false);
    expect(isCbexPrjDetailUrl('not a url')).toBe(false);
  });
});

describe('parseCbexUrl', () => {
  it('extracts prjId from valid URL', () => {
    expect(parseCbexUrl('https://jpxkc.cbex.com/jpxkc/prj/detail/522611.html')).toEqual({ prjId: '522611' });
  });

  it('returns null for invalid URLs', () => {
    expect(parseCbexUrl('https://example.com/foo')).toBeNull();
  });
});

import {
  extractCbexParams,
  extractTitle,
  extractSubjectId,
  extractStatus,
  extractEndTime,
  extractBidStartTime,
  extractSignupEndTime,
  extractPrices,
  extractBuyerInfo,
  extractStats,
  extractCbexTopFields,
  extractBdwjsHtml,
  extractTpzslist,
  fetchCbexTabContent,
} from './cbex-extractor';
import { parseHTML } from 'linkedom';

function loadFixture(name: string): Document {
  const html = readFileSync(join(__dirname, name), 'utf-8');
  const { document } = parseHTML(html);
  return document as unknown as Document;
}

describe('extractCbexParams', () => {
  it('extracts BDID, cpdm, zgxj, jjcc from inline scripts', () => {
    const html = `<html><body>
      <script>var foo = 1;
      var bdid = "4185";
      var cpdm = "522611";
      var zgxj = "30000.00";
      var jjcc = "1";
      </script></body></html>`;
    const { document: doc } = parseHTML(html);
    expect(extractCbexParams(doc)).toEqual({ bdid: '4185', cpdm: '522611', zgxj: '30000.00', jjcc: '1' });
  });

  it('tolerates colon-style assignments (object literals)', () => {
    const html = `<html><body>
      <script>var opts = { BDID: 999, prjId: 111, cpdm: '777', zgxj: '20000.00', jjcc: '2' };</script></body></html>`;
    const { document: doc } = parseHTML(html);
    expect(extractCbexParams(doc)).toEqual({ bdid: '999', cpdm: '777', zgxj: '20000.00', jjcc: '2' });
  });

  it('returns null for any missing param', () => {
    const html = `<html><body><script>var bdid = "4185";</script></body></html>`;
    const { document: doc } = parseHTML(html);
    expect(extractCbexParams(doc)).toBeNull();
  });
});

describe('top-level field extractors', () => {
  const doc = loadFixture('cbex-extractor.fixture.html');

  it('extractTitle returns .bd_detail_name text', () => {
    expect(extractTitle(doc)).toBe('京NC6575别克牌SGM6527AT蓝小型汽车');
  });

  it('extractSubjectId strips 标的物编号： prefix', () => {
    expect(extractSubjectId(doc)).toBe('202512NC6575');
  });

  it('extractStatus returns .state_mark text', () => {
    expect(extractStatus(doc)).toBe('竞价结束');
  });

  it('extractEndTime composes ymd hm from .time_num span sequence', () => {
    expect(extractEndTime(doc)).toBe('2025-12-15 16:00');
  });

  it('extractBidStartTime parses 竞价开始时间：YYYY.MM.DD HH:MM', () => {
    expect(extractBidStartTime(doc)).toBe('2025-12-15 08:00');
  });

  it('extractSignupEndTime parses Chinese date', () => {
    expect(extractSignupEndTime(doc)).toBe('2025-12-12 15:00');
  });

  it('extractPrices returns all numeric values', () => {
    expect(extractPrices(doc)).toEqual({
      start_price: 20000,
      assess_price: 20000,
      cap_price: 30000,
      deposit: 20000,
      final_price: 30000,
    });
  });

  it('extractBuyerInfo returns lottery code/count/registered_at', () => {
    expect(extractBuyerInfo(doc)).toEqual({
      lottery_code: '6035100088419',
      lottery_count: '87',
      lottery_registered: '2011-01-02 13:23',
    });
  });

  it('extractStats returns followers/views/bid_count', () => {
    expect(extractStats(doc)).toEqual({
      followers: 411,
      views: 124489,
      bid_count: 265,
    });
  });

  it('extractCbexTopFields composes everything', () => {
    const result = extractCbexTopFields(doc);
    expect(result.title).toBe('京NC6575别克牌SGM6527AT蓝小型汽车');
    expect(result.subject_id).toBe('202512NC6575');
    expect(result.prices.final_price).toBe(30000);
    expect(result.stats.bid_count).toBe(265);
    expect(result.buyer.lottery_code).toBe('6035100088419');
  });
});

describe('extractBdwjsHtml', () => {
  it('decodes HTML-encoded content of #content_BDWJS textarea', () => {
    const html = `<html><body><textarea id="content_BDWJS">&lt;p&gt;hello&lt;/p&gt;&lt;img src="/foo.jpg"&gt;</textarea></body></html>`;
    const { document: doc } = parseHTML(html);
    expect(extractBdwjsHtml(doc)).toBe('<p>hello</p><img src="/foo.jpg">');
  });

  it('returns empty string if textarea missing', () => {
    const { document: doc } = parseHTML('<html></html>');
    expect(extractBdwjsHtml(doc)).toBe('');
  });
});

describe('extractTpzslist', () => {
  it('parses tpzslist JSON array', () => {
    const html = `<html><body><script>
      var oldtpzs = "/foo.jpg";
      var tpzslist = ["/editorUpload/file/2025/11/aaa.jpg","/editorUpload/file/2025/11/bbb.jpg"];
      </script></body></html>`;
    const { document: doc } = parseHTML(html);
    expect(extractTpzslist(doc)).toEqual([
      '/editorUpload/file/2025/11/aaa.jpg',
      '/editorUpload/file/2025/11/bbb.jpg',
    ]);
  });

  it('returns empty array if not found', () => {
    const { document: doc } = parseHTML('<html></html>');
    expect(extractTpzslist(doc)).toEqual([]);
  });

  it('parses real fixture tpzslist (9 images)', () => {
    const fixture = readFileSync(join(__dirname, 'cbex-extractor.fixture.html'), 'utf-8');
    const { document: doc } = parseHTML(fixture);
    const list = extractTpzslist(doc);
    expect(list.length).toBeGreaterThanOrEqual(9);
    expect(list[0]).toMatch(/^\/?editorUpload\/file\//);
  });
});

describe('fetchCbexTabContent', () => {
  it('POSTs form body with X-Requested-With header', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response('<table>x</table>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      });
    });
    const text = await fetchCbexTabContent(
      '/page/jpxkc/prj/ggnr',
      'BDID=4185',
      fakeFetch as unknown as typeof fetch,
    );
    expect(text).toBe('<table>x</table>');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/page/jpxkc/prj/ggnr');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.body).toBe('BDID=4185');
    expect((calls[0].init.headers as Record<string, string>)['X-Requested-With']).toBe('XMLHttpRequest');
    expect((calls[0].init.headers as Record<string, string>)['Content-Type']).toBe('application/x-www-form-urlencoded; charset=UTF-8');
    expect(calls[0].init.credentials).toBe('include');
  });

  it('throws on non-2xx', async () => {
    const fakeFetch = vi.fn(async () => new Response('nope', { status: 401 }));
    await expect(
      fetchCbexTabContent('/page/jpxkc/prj/ggnr', 'BDID=4185', fakeFetch as unknown as typeof fetch),
    ).rejects.toThrow(/401/);
  });
});

describe('ct4 fragment to markdown', () => {
  it('converts styled paragraphs to plain markdown', () => {
    const fragment = `<p style="font-family: 'Times New Roman'; font-size: 14px;">第一段</p><p>第二段</p>`;
    const md = ct4FragmentToMarkdown(fragment, 'https://jpxkc.cbex.com/');
    expect(md).toContain('第一段');
    expect(md).toContain('第二段');
    expect(md).not.toContain('Times New Roman');
  });
});

describe('ct7 fragment to markdown', () => {
  it('converts bid-record table to GFM table', () => {
    const fragment = `<table class="bd_detail_record">
      <tr><th>序号</th><th>名称</th><th>出价人</th><th>价格</th><th>时间</th></tr>
      <tr><td>265</td><td>京NC6575...</td><td>640610036...</td><td>30000.00</td><td>2025-12-15 16:00</td></tr>
    </table>`;
    const md = ct7FragmentToMarkdown(fragment, 'https://jpxkc.cbex.com/');
    expect(md).toContain('| 序号 |');
    expect(md).toContain('30000.00');
  });

  it('converts real ct7 fixture table to GFM table', () => {
    const fragment = readFileSync(join(__dirname, 'cbex-extractor.fixture-ct7.html'), 'utf-8');
    const md = ct7FragmentToMarkdown(fragment, 'https://jpxkc.cbex.com/');
    expect(md).toContain('| 报价轮次 |');
    expect(md).toContain('30,000.00');
  });
});

describe('ct8 fragment to markdown', () => {
  it('converts result table to GFM table', () => {
    const fragment = `<table class="table_default">
      <tr><th>委托方</th><th>受让方</th><th>联系电话</th></tr>
      <tr><td>北京一中院</td><td>(脱敏)</td><td>(脱敏)</td></tr>
    </table>`;
    const md = ct8FragmentToMarkdown(fragment, 'https://jpxkc.cbex.com/');
    expect(md).toContain('委托方');
    expect(md).toContain('受让方');
  });

  it('converts real ct8 fixture table to GFM table', () => {
    const fragment = readFileSync(join(__dirname, 'cbex-extractor.fixture-ct8.html'), 'utf-8');
    const md = ct8FragmentToMarkdown(fragment, 'https://jpxkc.cbex.com/');
    expect(md).toContain('竞价编号');
    expect(md).toContain('30,000.00');
  });
});
