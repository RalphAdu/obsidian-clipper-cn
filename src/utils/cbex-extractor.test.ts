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
