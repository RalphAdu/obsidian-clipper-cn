import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isCbexPrjDetailUrl, parseCbexUrl } from './cbex-extractor';

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
