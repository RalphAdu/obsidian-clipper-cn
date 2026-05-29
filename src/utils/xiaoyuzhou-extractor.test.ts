import { describe, it, expect, beforeAll } from 'vitest';
import { parseHTML } from 'linkedom';
import * as fs from 'fs';
import * as path from 'path';
import {
  isXiaoyuzhouEpisodeUrl,
  parseXiaoyuzhouUrl,
  canonicalizeUrl,
  formatDuration,
  normalizeDate,
  parseEpisodeNumber,
  rewriteTimestamps,
  unwrapAnchorImages,
  parseComments,
  buildCommentsHtml,
  extractXiaoyuzhouStructuredContent,
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

describe('unwrapAnchorImages', () => {
  it('unwraps <a><img></a> into bare <img>', () => {
    const { document } = parseHTML(
      '<article><a href="" class="subscribe"><img src="https://x/y.svg" alt="面基"/></a></article>'
    );
    const article = document.querySelector('article')!;
    unwrapAnchorImages(article);
    expect(article.querySelector('a')).toBeNull();
    const img = article.querySelector('img')!;
    expect(img.getAttribute('src')).toBe('https://x/y.svg');
    expect(img.getAttribute('alt')).toBe('面基');
  });

  it('leaves anchors with text or other children untouched', () => {
    const { document } = parseHTML(
      '<article><a href="https://e.com">text</a><a href="https://e.com"><img src="x.png"/><span>x</span></a></article>'
    );
    const article = document.querySelector('article')!;
    unwrapAnchorImages(article);
    expect(article.querySelectorAll('a')).toHaveLength(2);
  });

  it('leaves timestamp anchors untouched (rewriteTimestamps already added href; they have no img children)', () => {
    const { document } = parseHTML(
      '<article><a class="timestamp" href="audio#t=14">00:14</a> 标题</article>'
    );
    const article = document.querySelector('article')!;
    unwrapAnchorImages(article);
    expect(article.querySelector('a.timestamp')).not.toBeNull();
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
      replyPreviews: [],
      totalReplyCount: 0,
    });
  });

  it('extracts text from .text-wrap > .text (excludes .replies inline preview)', () => {
    // 真实小宇宙 DOM: .text-wrap > .text + .text-wrap > .replies
    // body 应该只含 .text 内容，不含 .replies 拼接
    const html = `<section>
      <div class="comment">
        <div class="info">
          <a class="name">厚望</a>
          <div class="pub-time">2025.12.12</div>
          <a class="like"><div class="count">25</div></a>
        </div>
        <div class="text-wrap">
          <div class="text">
            <div class="pinned"><span class="pinned-text">置顶</span></div>
            <span>帮老南吆喝一声：</span>
            <span>简历投递邮箱：nantian@hilltop-inv.com</span>
          </div>
          <div class="replies">
            <div class="reply"><span class="reply-author">闫槿:</span>哪个城市啊</div>
            <div class="reply"><span class="reply-author">orzanol:</span>您好，还能发一下ppt吗，感谢！</div>
            <a class="replies-count">共37条回复</a>
          </div>
        </div>
      </div>
    </section>`;
    const { document } = parseHTML(html);
    const result = parseComments(document.querySelector('section')!);
    expect(result).toHaveLength(1);
    const c = result[0];
    expect(c.user).toBe('厚望');
    expect(c.pinned).toBe(true);
    // body has comment text (no "置顶" tag, no reply preview)
    expect(c.body).toContain('帮老南吆喝');
    expect(c.body).toContain('nantian@hilltop-inv.com');
    expect(c.body).not.toContain('置顶'); // .pinned stripped
    expect(c.body).not.toContain('闫槿'); // reply preview NOT in body
    expect(c.body).not.toContain('orzanol');
    expect(c.body).not.toContain('共37条回复');
    // Reply previews extracted separately
    expect(c.replyPreviews).toHaveLength(2);
    expect(c.replyPreviews[0]).toEqual({ user: '闫槿', content: '哪个城市啊' });
    expect(c.replyPreviews[1]).toEqual({ user: 'orzanol', content: '您好，还能发一下ppt吗，感谢！' });
    // Total count from .replies-count "共37条回复"
    expect(c.totalReplyCount).toBe(37);
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
      body: '帮老南吆喝一声', replyPreviews: [], totalReplyCount: 0, replies: []
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

  it('renders nested blockquote for legacy nested replies', () => {
    const tree: XiaoyuzhouComment[] = [{
      user: '吞不须', publishedAt: '2025-06-18', likeCount: 468, pinned: false,
      body: '你还卷', replyPreviews: [], totalReplyCount: 0,
      replies: [{
        user: '猫咪麻麻', publishedAt: '2025-06-18', likeCount: 10, pinned: false,
        body: '你也卷', replyPreviews: [], totalReplyCount: 0, replies: []
      }]
    }];
    const html = buildCommentsHtml(tree);
    // outer blockquote contains inner blockquote (nesting)
    expect(html).toMatch(/<blockquote>[\s\S]*<blockquote>[\s\S]*猫咪麻麻[\s\S]*<\/blockquote>[\s\S]*<\/blockquote>/);
  });

  it('renders reply previews as separate paragraphs in nested blockquote', () => {
    const tree: XiaoyuzhouComment[] = [{
      user: '厚望', publishedAt: '2025-12-12', likeCount: 25, pinned: true,
      body: '帮老南吆喝一声',
      replyPreviews: [
        { user: '闫槿', content: '哪个城市啊' },
        { user: 'orzanol', content: '您好，还能发一下ppt吗，感谢！' },
      ],
      totalReplyCount: 37,
      replies: []
    }];
    const html = buildCommentsHtml(tree);
    // Reply previews are separate <p> not inline with body
    expect(html).toContain('<strong>闫槿</strong>: 哪个城市啊');
    expect(html).toContain('<strong>orzanol</strong>: 您好，还能发一下ppt吗，感谢！');
    // Visibility note for hidden replies
    expect(html).toContain('共 37 条回复（剩 35 条仅小宇宙 APP 可见）');
    // Body should NOT contain reply preview inline (the bug we fixed)
    const bodyPara = html.match(/<p>帮老南吆喝一声<\/p>/);
    expect(bodyPara).not.toBeNull();
    // Body paragraph should NOT have 闫槿 or orzanol mixed in same <p>
    // (anchor with [^<]* so it can't cross tag boundaries)
    expect(html).not.toMatch(/<p>帮老南吆喝一声[^<]*闫槿/);
  });

  it('omits visibility note when all replies visible', () => {
    const tree: XiaoyuzhouComment[] = [{
      user: 'A', publishedAt: '2025-01-01', likeCount: 1, pinned: false, body: 'x',
      replyPreviews: [{ user: 'B', content: 'y' }],
      totalReplyCount: 1, replies: []
    }];
    const html = buildCommentsHtml(tree);
    expect(html).not.toContain('仅小宇宙 APP 可见');
  });

  it('omits reply block entirely when no replies', () => {
    const tree: XiaoyuzhouComment[] = [{
      user: 'A', publishedAt: '2025-01-01', likeCount: 0, pinned: false, body: 'x',
      replyPreviews: [], totalReplyCount: 0, replies: []
    }];
    const html = buildCommentsHtml(tree);
    // Outer blockquote present, but no inner blockquote (replies block)
    expect(html).toContain('<blockquote>');
    expect(html).not.toContain('<blockquote><blockquote>');
    // Replies block uses nested <blockquote>, so a single comment with no replies
    // should produce exactly one <blockquote> open tag
    expect((html.match(/<blockquote>/g) || []).length).toBe(1);
  });

  it('returns empty when no comments', () => {
    expect(buildCommentsHtml([])).toBe('');
  });

  it('escapes HTML in body / username / reply user', () => {
    const tree: XiaoyuzhouComment[] = [{
      user: '<script>', publishedAt: '2025-01-01', likeCount: 0, pinned: false,
      body: 'a & b <i>',
      replyPreviews: [{ user: '<bad>', content: '<x>' }],
      totalReplyCount: 1, replies: []
    }];
    const html = buildCommentsHtml(tree);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp;');
    expect(html).toContain('&lt;bad&gt;');
    expect(html).toContain('&lt;x&gt;');
  });
});

// ---------------------------------------------------------------------------
// Integration tests with real fixture
// ---------------------------------------------------------------------------

const fixturePath = path.join(__dirname, 'fixtures/xiaoyuzhou-episode-6850d2ed.html');

describe('extractXiaoyuzhouStructuredContent (integration with fixture)', () => {
  let doc: Document;
  beforeAll(() => {
    const html = fs.readFileSync(fixturePath, 'utf-8');
    doc = parseHTML(html).document as unknown as Document;
    Object.defineProperty(doc, 'URL', { value: 'https://www.xiaoyuzhoufm.com/episode/6850d2ed4abe6e29cb814160', configurable: true });
  });

  it('extracts title with E112 prefix preserved', async () => {
    const result = await extractXiaoyuzhouStructuredContent(doc);
    expect(result.title).toMatch(/^E112\./);
    expect(result.title).toContain('喜欢投资和求真的听友');
  });

  it('extracts podcast metadata', async () => {
    const result = await extractXiaoyuzhouStructuredContent(doc);
    expect(result.podcast).toBe('面基');
    expect(result.author).toBe('面基');
    expect(result.episodeNumber).toBe('E112');
    expect(result.podcastUrl).toMatch(/^https:\/\/www\.xiaoyuzhoufm\.com\/podcast\//);
  });

  it('extracts audio URL and duration', async () => {
    const result = await extractXiaoyuzhouStructuredContent(doc);
    expect(result.audioUrl).toMatch(/^https:\/\/media\.xyzcdn\.net\/.+\.m4a$/);
    expect(result.duration).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it('canonicalizes source URL (strip query)', async () => {
    const result = await extractXiaoyuzhouStructuredContent(doc);
    expect(result.source).toBe('https://www.xiaoyuzhoufm.com/episode/6850d2ed4abe6e29cb814160');
  });

  it('description truncated to 200 chars', async () => {
    const result = await extractXiaoyuzhouStructuredContent(doc);
    expect(result.description.length).toBeLessThanOrEqual(200);
    expect(result.description.length).toBeGreaterThan(0);
  });

  it('site is 小宇宙', async () => {
    const result = await extractXiaoyuzhouStructuredContent(doc);
    expect(result.site).toBe('小宇宙');
  });

  it('content contains audio embed + article + comments h2', async () => {
    const result = await extractXiaoyuzhouStructuredContent(doc);
    expect(result.content).toContain('<img src="https://media.xyzcdn.net');
    expect(result.content).toContain('<h2>评论</h2>');
    expect(result.content).toContain('<blockquote>');
  });

  it('article timestamps rewritten with href', async () => {
    const result = await extractXiaoyuzhouStructuredContent(doc);
    // structuredHtml 中 timestamp anchor 现在应有 href=audio#t=...
    expect(result.content).toMatch(/<a[^>]+href="https:\/\/media\.xyzcdn\.net\/[^"]+#t=\d+"[^>]*class="[^"]*timestamp/);
  });

  it('wordCount > 0', async () => {
    const result = await extractXiaoyuzhouStructuredContent(doc);
    expect(result.wordCount).toBeGreaterThan(100);
  });

  it('reply preview + totalReplyCount visibility note injected', async () => {
    const result = await extractXiaoyuzhouStructuredContent(doc);
    // 第一条置顶评论是 厚望，含 37 条总回复，2 条 inline preview (闫槿/orzanol)
    // body 段落不应含 reply preview 拼接
    expect(result.content).not.toMatch(/<p>[^<]*nantian@hilltop-inv\.com[^<]*闫槿[^<]*<\/p>/);
    // reply preview 单独段落
    expect(result.content).toMatch(/<strong>闫槿<\/strong>: 哪个城市啊/);
    expect(result.content).toMatch(/<strong>orzanol<\/strong>: 您好，还能发一下ppt吗，感谢！/);
    // 可见性标注
    expect(result.content).toMatch(/共 37 条回复（剩 35 条仅小宇宙 APP 可见）/);
  });
});

describe('extractXiaoyuzhouStructuredContent error paths', () => {
  it('throws when JSON-LD missing', async () => {
    const { document } = parseHTML('<html><body></body></html>');
    Object.defineProperty(document, 'URL', { value: 'https://www.xiaoyuzhoufm.com/episode/x', configurable: true });
    await expect(extractXiaoyuzhouStructuredContent(document as unknown as Document)).rejects.toThrow(/JSON-LD/i);
  });
});
