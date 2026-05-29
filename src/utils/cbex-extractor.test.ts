import { describe, it, expect } from 'vitest';
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

import { extractCbexParams } from './cbex-extractor';
import { parseHTML } from 'linkedom';

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
