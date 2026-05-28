import { describe, it, expect } from 'vitest';
import { parseHTML } from 'linkedom';
import {
  isXiaoyuzhouEpisodeUrl,
  parseXiaoyuzhouUrl,
  canonicalizeUrl,
  formatDuration,
  normalizeDate,
  parseEpisodeNumber,
  rewriteTimestamps,
  parseComments,
  buildCommentsHtml,
} from './xiaoyuzhou-extractor';
import type { XiaoyuzhouComment } from './xiaoyuzhou-extractor';

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

describe('rewriteTimestamps', () => {
  const audioUrl = 'https://media.example.com/x.m4a';

  it('adds href to timestamp anchors with data-timestamp', () => {
    const { document } = parseHTML(
      '<article><span><a class="timestamp" data-timestamp="14">00:14</a> 标题</span></article>'
    );
    const article = document.querySelector('article')!;
    rewriteTimestamps(article, audioUrl);
    const a = article.querySelector('a.timestamp')!;
    expect(a.getAttribute('href')).toBe(`${audioUrl}#t=14`);
    expect(a.textContent).toBe('00:14');
  });

  it('handles multiple timestamps', () => {
    const { document } = parseHTML(`<article>
      <a class="timestamp" data-timestamp="14">00:14</a>
      <a class="timestamp" data-timestamp="330">05:30</a>
      <a class="timestamp" data-timestamp="3600">01:00:00</a>
    </article>`);
    const article = document.querySelector('article')!;
    rewriteTimestamps(article, audioUrl);
    const anchors = Array.from(article.querySelectorAll('a.timestamp'));
    expect(anchors.map(a => a.getAttribute('href'))).toEqual([
      `${audioUrl}#t=14`,
      `${audioUrl}#t=330`,
      `${audioUrl}#t=3600`,
    ]);
  });

  it('skips anchors without data-timestamp', () => {
    const { document } = parseHTML(
      '<article><a class="timestamp">00:14</a></article>'
    );
    const article = document.querySelector('article')!;
    rewriteTimestamps(article, audioUrl);
    expect(article.querySelector('a.timestamp')!.getAttribute('href')).toBeNull();
  });

  it('skips when audioUrl empty', () => {
    const { document } = parseHTML(
      '<article><a class="timestamp" data-timestamp="14">00:14</a></article>'
    );
    const article = document.querySelector('article')!;
    rewriteTimestamps(article, '');
    expect(article.querySelector('a.timestamp')!.getAttribute('href')).toBeNull();
  });

  it('skips invalid data-timestamp values', () => {
    const { document } = parseHTML(
      '<article><a class="timestamp" data-timestamp="abc">x</a></article>'
    );
    const article = document.querySelector('article')!;
    rewriteTimestamps(article, audioUrl);
    expect(article.querySelector('a.timestamp')!.getAttribute('href')).toBeNull();
  });
});

describe('parseComments', () => {
  it('parses top-level comment with metadata', () => {
    const html = `<section>
      <div class="jsx-x comment">
        <div class="jsx-x info">
          <a class="jsx-x name">厚望</a>
          <div class="jsx-x pub-time">2025.12.12</div>
          <a class="jsx-x like"><div class="jsx-x count">25</div></a>
        </div>
        <div class="jsx-x pinned">置顶</div>
        <div class="jsx-x text-wrap">帮老南吆喝一声：望岳投资招聘</div>
      </div>
    </section>`;
    const { document } = parseHTML(html);
    const result = parseComments(document.querySelector('section')!);
    expect(result).toHaveLength(1);
    expect(result[0].user).toBe('厚望');
    expect(result[0].publishedAt).toBe('2025-12-12');
    expect(result[0].likeCount).toBe(25);
    expect(result[0].pinned).toBe(true);
    expect(result[0].body).toContain('帮老南吆喝');
  });

  it('parses nested replies', () => {
    const html = `<section>
      <div class="jsx-x comment">
        <div class="jsx-x info">
          <a class="name">吞不须</a>
          <div class="pub-time">2025.6.18</div>
          <a class="like"><div class="count">468</div></a>
        </div>
        <div class="text-wrap">你还卷</div>
        <div class="replies">
          <div class="jsx-x comment">
            <div class="jsx-x info">
              <a class="name">猫咪麻麻</a>
              <div class="pub-time">2025.6.18</div>
              <a class="like"><div class="count">10</div></a>
            </div>
            <div class="text-wrap">你也卷</div>
          </div>
        </div>
      </div>
    </section>`;
    const { document } = parseHTML(html);
    const result = parseComments(document.querySelector('section')!);
    expect(result).toHaveLength(1);
    expect(result[0].user).toBe('吞不须');
    expect(result[0].replies).toHaveLength(1);
    expect(result[0].replies[0].user).toBe('猫咪麻麻');
    expect(result[0].replies[0].body).toContain('你也卷');
  });

  it('handles missing fields gracefully', () => {
    const html = `<section><div class="comment"><div class="text-wrap">orphan</div></div></section>`;
    const { document } = parseHTML(html);
    const result = parseComments(document.querySelector('section')!);
    expect(result[0]).toMatchObject({
      user: '',
      publishedAt: '',
      likeCount: 0,
      pinned: false,
    });
  });

  it('returns empty for no comments', () => {
    const { document } = parseHTML('<section></section>');
    expect(parseComments(document.querySelector('section')!)).toEqual([]);
  });
});

describe('buildCommentsHtml', () => {
  it('generates h2 + blockquote', () => {
    const tree: XiaoyuzhouComment[] = [{
      user: '厚望', publishedAt: '2025-12-12', likeCount: 25, pinned: true,
      body: '帮老南吆喝一声', replies: []
    }];
    const html = buildCommentsHtml(tree);
    expect(html).toContain('<h2>评论</h2>');
    expect(html).toContain('<blockquote>');
    expect(html).toContain('📌 置顶');
    expect(html).toContain('<strong>📌 置顶 厚望</strong>');
    expect(html).toContain('2025-12-12');
    expect(html).toContain('👍 25');
    expect(html).toContain('帮老南吆喝一声');
  });

  it('renders nested blockquote for replies', () => {
    const tree: XiaoyuzhouComment[] = [{
      user: '吞不须', publishedAt: '2025-06-18', likeCount: 468, pinned: false,
      body: '你还卷',
      replies: [{
        user: '猫咪麻麻', publishedAt: '2025-06-18', likeCount: 10, pinned: false,
        body: '你也卷', replies: []
      }]
    }];
    const html = buildCommentsHtml(tree);
    // outer blockquote contains inner blockquote (nesting)
    expect(html).toMatch(/<blockquote>[\s\S]*<blockquote>[\s\S]*猫咪麻麻[\s\S]*<\/blockquote>[\s\S]*<\/blockquote>/);
  });

  it('returns empty when no comments', () => {
    expect(buildCommentsHtml([])).toBe('');
  });

  it('escapes HTML in body / username', () => {
    const tree: XiaoyuzhouComment[] = [{
      user: '<script>', publishedAt: '2025-01-01', likeCount: 0, pinned: false,
      body: 'a & b <i>', replies: []
    }];
    const html = buildCommentsHtml(tree);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp;');
  });
});
