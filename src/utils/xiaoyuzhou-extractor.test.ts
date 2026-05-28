import { describe, it, expect } from 'vitest';
import {
  isXiaoyuzhouEpisodeUrl,
  parseXiaoyuzhouUrl,
  canonicalizeUrl,
} from './xiaoyuzhou-extractor';

describe('isXiaoyuzhouEpisodeUrl', () => {
  it('matches www.xiaoyuzhoufm.com/episode/<id>', () => {
    expect(isXiaoyuzhouEpisodeUrl('https://www.xiaoyuzhoufm.com/episode/6850d2ed4abe6e29cb814160')).toBe(true);
  });
  it('matches with share token query', () => {
    expect(isXiaoyuzhouEpisodeUrl('https://www.xiaoyuzhoufm.com/episode/6850d2ed4abe6e29cb814160?s=REDACTED')).toBe(true);
  });
  it('rejects /podcast/<id>', () => {
    expect(isXiaoyuzhouEpisodeUrl('https://www.xiaoyuzhoufm.com/podcast/6388760f22567e8ea6ad070f')).toBe(false);
  });
  it('rejects other hosts', () => {
    expect(isXiaoyuzhouEpisodeUrl('https://example.com/episode/123')).toBe(false);
  });
  it('rejects malformed URL', () => {
    expect(isXiaoyuzhouEpisodeUrl('not a url')).toBe(false);
  });
});

describe('parseXiaoyuzhouUrl', () => {
  it('extracts episodeId', () => {
    expect(parseXiaoyuzhouUrl('https://www.xiaoyuzhoufm.com/episode/6850d2ed4abe6e29cb814160?s=token'))
      .toEqual({ type: 'episode', episodeId: '6850d2ed4abe6e29cb814160' });
  });
  it('returns null for non-episode URL', () => {
    expect(parseXiaoyuzhouUrl('https://example.com')).toEqual({ type: null, episodeId: null });
  });
});

describe('canonicalizeUrl', () => {
  it('strips all query params', () => {
    expect(canonicalizeUrl('https://www.xiaoyuzhoufm.com/episode/abc?s=token&t=120'))
      .toBe('https://www.xiaoyuzhoufm.com/episode/abc');
  });
  it('strips fragment', () => {
    expect(canonicalizeUrl('https://www.xiaoyuzhoufm.com/episode/abc#section'))
      .toBe('https://www.xiaoyuzhoufm.com/episode/abc');
  });
  it('passes invalid URL through unchanged', () => {
    expect(canonicalizeUrl('not a url')).toBe('not a url');
  });
});
