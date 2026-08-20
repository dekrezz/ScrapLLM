// Unit tests for extension/source-quality.js — the junk filter.
//
// The module is pure: Markdown in, a verdict and a fingerprint out. Every
// threshold in it was calibrated on real pages (10 live coupon/affiliate and
// paid-signal landings against 14 live genuine pages, captured through the
// extension's own Readability + Turndown path), so the fixtures here are
// shaped like what that measurement produced: the spam side reaches the
// threshold on two independent signals, and the genuine side — including a
// short page and a page full of prices — stays well under it.

const path = require('path');

const QUALITY_PATH = path.join(__dirname, '../extension/source-quality.js');

function loadQuality() {
  jest.resetModules();
  delete global.ScrapLLMSourceQuality;
  require(QUALITY_PATH);
  return global.ScrapLLMSourceQuality;
}

// A plain article: paragraphs, a few citations, no selling.
function article(paragraphs = 12) {
  const body = [];
  for (let i = 0; i < paragraphs; i++) {
    body.push(
      `The scheduler assigns each task to a worker thread and records the handoff, ` +
      `which is what makes the ordering observable in paragraph ${i}. ` +
      `A queue that never blocks still has to answer for the work it dropped, and ` +
      `the runtime reports that separately from the work it completed.`
    );
  }
  return body.join('\n\n');
}

// A coupon farm: promotional phrasing everywhere and monetised outbound links.
function couponSpam(blocks = 8) {
  const body = [];
  for (let i = 0; i < blocks; i++) {
    body.push(
      `Use code SAVE${i} for an exclusive deal. This discount code is a limited-time offer ` +
      `with free shipping and a money-back guarantee. We may earn a commission.`
    );
    body.push(
      `[View deal](https://shop.example.com/go/item-${i}?tag=aff-1) ` +
      `[Shop now](https://shop.example.com/out/item-${i}?ref=aff-2) ` +
      `[Check the latest price](https://shop.example.com/goto/item-${i}?aff=3)`
    );
  }
  return body.join('\n\n');
}

describe('ScrapLLMSourceQuality.assess', () => {
  let quality;

  beforeEach(() => {
    quality = loadQuality();
  });

  it('keeps an ordinary article', () => {
    const verdict = quality.assess({
      markdown: article(),
      query: 'scheduler worker thread ordering',
      url: 'https://example.com/scheduler'
    });

    expect(verdict.verdict).toBe('keep');
    expect(verdict.reason).toBeNull();
    expect(verdict.score).toBeLessThan(quality.JUNK_SCORE_THRESHOLD);
  });

  it('rejects a coupon farm and says which two measurements decided it', () => {
    const verdict = quality.assess({
      markdown: couponSpam(),
      query: 'best vpn deal coupon code discount',
      url: 'https://deals.example.com/vpn'
    });

    expect(verdict.verdict).toBe('reject');
    expect(verdict.category).toBe('junk');
    expect(verdict.reason).toMatch(/^Dropped as low-value: /);
    expect(verdict.reason).toContain('promotional phrases per 1000 words');
    expect(verdict.score).toBeGreaterThanOrEqual(quality.JUNK_SCORE_THRESHOLD);
  });

  it('rejects a paid-signal landing on the pitch alone', () => {
    const markdown =
      'Join our VIP channel for premium signals with a win rate of 92%.\n\n' +
      'Our Telegram channel posts private signals every day and guaranteed profit ' +
      'for members who join now.';

    const verdict = quality.assess({
      markdown,
      query: 'free forex signals telegram channel',
      url: 'https://signals.example.com/vip'
    });

    expect(verdict.verdict).toBe('reject');
    expect(verdict.reason).toContain('paid-signal or VIP-channel pitches');
  });

  it('does not treat a merely short page as junk', () => {
    // 60 words of a genuine release note: thin, on topic, nothing for sale.
    const markdown =
      'SQLite 3.46.0 fixes a query planner regression that could return the wrong ' +
      'rows for a LEFT JOIN with a subquery in the ON clause. The fix restores the ' +
      'pre-3.45 plan for that shape and adds a regression test. Applications that ' +
      'never used that shape are unaffected and need no change.';

    const verdict = quality.assess({
      markdown,
      query: 'sqlite 3.46 release notes left join',
      url: 'https://sqlite.org/releaselog/3_46_0.html'
    });

    expect(verdict.verdict).toBe('keep');
    // Thinness contributes, but it can never reach the threshold on its own.
    expect(verdict.score).toBeLessThan(quality.JUNK_SCORE_THRESHOLD);
  });

  it('does not treat a page that names prices as junk', () => {
    const markdown = [
      'The Plus plan is $9.99 per month, or $71.88 billed yearly, and covers ten devices.',
      'The Unlimited plan is $12.99 per month and adds the secure storage tier.',
      article(6),
      'Both plans include the same network; the difference is the device count and the storage.'
    ].join('\n\n');

    const verdict = quality.assess({
      markdown,
      query: 'proton vpn pricing plans devices',
      url: 'https://protonvpn.com/pricing'
    });

    expect(verdict.verdict).toBe('keep');
  });

  it('never rejects when the gate is fed an empty document as a duplicate', () => {
    // An empty fingerprint must not match another empty one: two failed
    // captures are not the same page.
    const empty = quality.fingerprint('');
    expect(empty).toEqual([]);
    expect(quality.similarity(empty, empty)).toBe(0);
  });
});

describe('ScrapLLMSourceQuality near-duplicate detection', () => {
  let quality;

  beforeEach(() => {
    quality = loadQuality();
  });

  it('recognises a mirror of a page already captured and names the host it came from', () => {
    const original = article(14);
    const mirror = 'Republished with permission.\n\n' + original;

    const first = quality.assess({ markdown: original, query: 'scheduler', url: 'https://a.example/x' });
    expect(first.verdict).toBe('keep');

    const second = quality.assess({
      markdown: mirror,
      query: 'scheduler',
      url: 'https://b.example/x',
      previous: [{ host: 'a.example', url: 'https://a.example/x', fingerprint: first.fingerprint }]
    });

    expect(second.verdict).toBe('reject');
    expect(second.category).toBe('duplicate');
    expect(second.reason).toContain('a.example');
  });

  it('leaves two independent pages on the same topic alone', () => {
    const one = article(12);
    const two = article(12)
      .replace(/scheduler/g, 'dispatcher')
      .replace(/worker thread/g, 'coroutine')
      .replace(/queue/g, 'channel');

    const first = quality.assess({ markdown: one, query: 'scheduler', url: 'https://a.example/x' });
    const second = quality.assess({
      markdown: two,
      query: 'scheduler',
      url: 'https://b.example/y',
      previous: [{ host: 'a.example', url: 'https://a.example/x', fingerprint: first.fingerprint }]
    });

    expect(quality.similarity(first.fingerprint, second.fingerprint))
      .toBeLessThan(quality.DUPLICATE_JACCARD);
    expect(second.verdict).toBe('keep');
  });
});

describe('ScrapLLMSourceQuality.measure', () => {
  let quality;

  beforeEach(() => {
    quality = loadQuality();
  });

  it('counts link text as prose but link targets as links, and spots affiliate shapes', () => {
    const stats = quality.measure(
      'Read [the specification](https://spec.example.org/tr/thing) and then ' +
      '[buy it here](https://shop.example.com/go/x?tag=aff-9).',
      { url: 'https://example.com/post', query: 'specification' }
    );

    expect(stats.linkCount).toBe(2);
    expect(stats.affiliateLinks).toBe(1);
    expect(stats.outboundLinks).toBe(2);
    expect(stats.queryOverlap).toBe(1);
  });

  it('ignores fenced code when it measures prose', () => {
    const withCode = 'Intro paragraph.\n\n```\nclick here buy now use code SAVE\n```\n\nOutro paragraph.';
    const stats = quality.measure(withCode, { url: 'https://example.com/post', query: 'intro' });

    expect(stats.promoPer1000).toBe(0);
    expect(stats.ctaPer1000).toBe(0);
  });
});
