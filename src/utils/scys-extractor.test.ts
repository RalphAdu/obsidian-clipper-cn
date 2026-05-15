import { describe, it, expect } from 'vitest';
import { isScysCourseUrl, parseScysUrl } from './scys-extractor';

describe('isScysCourseUrl', () => {
  it('matches scys course detail URL with chapterId', () => {
    expect(isScysCourseUrl('https://scys.com/course/detail/172?chapterId=11408')).toBe(true);
  });
  it('rejects scys course URL without chapterId', () => {
    expect(isScysCourseUrl('https://scys.com/course/detail/172')).toBe(false);
  });
  it('rejects other scys paths', () => {
    expect(isScysCourseUrl('https://scys.com/AI')).toBe(false);
    expect(isScysCourseUrl('https://scys.com/search/user/center')).toBe(false);
  });
  it('rejects non-scys hosts', () => {
    expect(isScysCourseUrl('https://example.com/course/detail/172?chapterId=11408')).toBe(false);
  });
  it('rejects malformed URL', () => {
    expect(isScysCourseUrl('not a url')).toBe(false);
  });
});

describe('parseScysUrl', () => {
  it('extracts courseId and chapterId', () => {
    expect(parseScysUrl('https://scys.com/course/detail/172?chapterId=11408'))
      .toEqual({ courseId: 172, chapterId: 11408 });
  });
  it('returns null for invalid URL', () => {
    expect(parseScysUrl('https://scys.com/course/detail/172')).toBeNull();
  });
});
