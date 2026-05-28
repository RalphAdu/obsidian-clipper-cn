import { describe, it, expect } from 'vitest';
import {
  isXiaoyuzhouEpisodeUrl,
  parseXiaoyuzhouUrl,
  canonicalizeUrl,
  formatDuration,
  normalizeDate,
  parseEpisodeNumber,
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

describe('formatDuration', () => {
  it('formats minutes-only', () => {
    expect(formatDuration('PT614M')).toBe('10:14:00');
  });
  it('formats seconds-only', () => {
    expect(formatDuration('PT45S')).toBe('00:00:45');
  });
  it('formats hours+minutes+seconds', () => {
    expect(formatDuration('PT2H30M5S')).toBe('02:30:05');
  });
  it('formats sub-hour minutes', () => {
    expect(formatDuration('PT45M30S')).toBe('00:45:30');
  });
  it('returns empty for invalid input', () => {
    expect(formatDuration('')).toBe('');
    expect(formatDuration('not iso')).toBe('');
  });
});

describe('normalizeDate', () => {
  it('normalizes Chinese dot format', () => {
    expect(normalizeDate('2025.6.18')).toBe('2025-06-18');
    expect(normalizeDate('2025.12.12')).toBe('2025-12-12');
  });
  it('passes ISO date through', () => {
    expect(normalizeDate('2025-06-18')).toBe('2025-06-18');
  });
  it('returns empty for invalid', () => {
    expect(normalizeDate('')).toBe('');
    expect(normalizeDate('garbage')).toBe('');
  });
});

describe('parseEpisodeNumber', () => {
  it('extracts E-prefix number', () => {
    expect(parseEpisodeNumber('E112.这期节目献给每一位喜欢投资和求真的听友')).toBe('E112');
  });
  it('extracts EP-prefix number', () => {
    expect(parseEpisodeNumber('EP42. xxx')).toBe('EP42');
  });
  it('returns empty when no prefix', () => {
    expect(parseEpisodeNumber('随便一个标题')).toBe('');
  });
});
