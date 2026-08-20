// ScrapLLM Source Quality
// The junk filter: given the Markdown a source was captured as, decide whether
// it is worth putting in front of a model at all.
//
// Pure and background-only — no fetch, no tabs, no storage, no messaging — so
// every threshold in it is testable on a fixture, and every verdict carries the
// verbatim sentence the user reads in the sheet and in the document.
//
// The measurements are made on the *captured Markdown*, which is the same
// artefact on both capture paths, so a page is judged by what the run would
// actually hand to the model rather than by the HTML it happened to arrive in.
//
// Two things this deliberately does not treat as junk on their own:
//
//   * a short page. Brevity is not spam; a 300-word changelog entry or a
//     release note is exactly the source a run wants. Thinness contributes
//     points but cannot reach the threshold by itself.
//   * a price. A review, a pricing page and a hardware comparison all name
//     money, and counting "$" would reject the honest half of every shopping
//     query. Money is not a signal here at all; promotional *phrasing* is.

const ScrapLLMSourceQuality = (function() {
  'use strict';

  // A page has to earn this many points to be called junk, and no single
  // signal is worth that much: a rejection always rests on at least two
  // independent measurements.
  const JUNK_SCORE_THRESHOLD = 100;

  // Two captures whose 6-word shingles overlap this much are the same article.
  // Measured on real mirrors: a syndicated copy of the same wire story scores
  // 0.86-0.98, while two independent articles on one topic stay under 0.25.
  const DUPLICATE_JACCARD = 0.75;
  const SHINGLE_SIZE = 6;

  // Below this the page cannot be an article, whatever else it is. Used only
  // as a contributing signal.
  const THIN_WORDS = 220;
  const VERY_THIN_WORDS = 90;

  // Promotional phrasing. Not "this page mentions a product" and not "this page
  // names a price" — these are the sentences a page writes when selling is the
  // reason it exists.
  const PROMO_PATTERNS = [
    /\baffiliate links?\b/g,
    /\bwe (?:may )?earn (?:a )?commissions?\b/g,
    /\bcommissions? (?:from|on) (?:qualifying )?purchases\b/g,
    /\b(?:coupon|promo|discount|voucher) codes?\b/g,
    /\buse code\b/g,
    /\bcashback\b/g,
    /\breferral (?:code|link)\b/g,
    /\bbest price(?:s)? (?:online|today|guaranteed)\b/g,
    /\blimited[- ]time offer\b/g,
    /\bexclusive (?:offer|deal|bonus)\b/g,
    /\bdeal of the (?:day|week)\b/g,
    /\bsponsored (?:post|content|by)\b/g,
    /\bsave up to \d+ ?%/g,
    /\b\d+ ?% off\b/g,
    /\bfree (?:shipping|trial|bonus)\b/g,
    /\bmoney[- ]back guarantee\b/g,
    /\brisk[- ]free\b/g,
    /\bshop (?:now|the sale)\b/g,
    /\bbuy (?:now|it now|on amazon)\b/g,
    /\bcheck (?:the )?(?:latest )?price\b/g,
    /\bview (?:deal|price)\b/g
  ];

  // The imperative half: what the page wants the reader to do instead of read.
  const CTA_PATTERNS = [
    /\bclick here\b/g,
    /\bsign up (?:now|today|free)\b/g,
    /\bjoin (?:now|today|us now)\b/g,
    /\bsubscribe (?:now|today)\b/g,
    /\bregister (?:now|today)\b/g,
    /\bdownload (?:now|the app)\b/g,
    /\border now\b/g,
    /\bget started (?:now|today|for free)\b/g,
    /\bstart your free trial\b/g,
    /\bbook a demo\b/g,
    /\bcontact us today\b/g,
    /\bclaim your\b/g,
    /\bdon'?t miss out\b/g,
    /\bact now\b/g,
    /\blearn more\b/g,
    /\bread more\b/g
  ];

  // Paid-signal and "VIP channel" landings. These are unambiguous enough that
  // two of them decide the page on their own — no honest article about, say,
  // trading strategy phrases itself as a membership pitch twice.
  const SIGNAL_SELLING_PATTERNS = [
    /\bvip (?:channel|group|membership|signals?)\b/g,
    /\b(?:premium|paid|private) signals?\b/g,
    /\bsignals? (?:channel|group|provider)\b/g,
    /\bjoin (?:our|my|the) telegram\b/g,
    /\btelegram channel\b/g,
    /\bwhatsapp group\b/g,
    /\bguaranteed (?:profit|returns?|winnings?)\b/g,
    /\bdouble your (?:money|investment|deposit)\b/g,
    /\b\d+ ?% (?:daily|weekly|monthly) (?:profit|returns?|roi)\b/g,
    /\bcopy trading (?:signals|room)\b/g,
    /\binsider (?:picks|tips)\b/g,
    /\bwin(?:ning)? rate of \d+ ?%/g
  ];

  // Link targets shaped like monetised outbound clicks rather than citations.
  const AFFILIATE_TARGET =
    /([?&](?:tag|aff|affid|aff_id|ref|refid|utm_campaign|clickid|irclickid|awc)=)|(\/(?:go|out|goto|recommends|deals?|redirect)\/)/i;

  // --------------------------------------------------------------------------
  // Text measurement
  // --------------------------------------------------------------------------

  const LINK_RE = /\[([^\]]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)/g;
  const FENCE_RE = /```[\s\S]*?(?:```|$)/g;

  function countMatches(text, patterns) {
    let hits = 0;
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      const found = text.match(pattern);
      if (found) hits += found.length;
    }
    return hits;
  }

  function wordsOf(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return [];
    return trimmed.split(/\s+/).filter(Boolean);
  }

  function hostOf(url) {
    try {
      return new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
    } catch (e) {
      return '';
    }
  }

  const QUERY_STOP_WORDS = new Set([
    'the', 'and', 'for', 'with', 'that', 'this', 'from', 'what', 'when',
    'which', 'while', 'into', 'about', 'your', 'their', 'have', 'has',
    'does', 'how', 'why', 'are', 'was', 'were', 'been', 'best', 'like',
    'you', 'can', 'will', 'its', 'not', 'but', 'any', 'all'
  ]);

  function queryTerms(query) {
    return Array.from(new Set(
      String(query || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, ' ')
        .split(/\s+/)
        .filter(word => word.length >= 3 && !QUERY_STOP_WORDS.has(word))
    ));
  }

  // Everything the scorer needs, measured once.
  function measure(markdown, options) {
    const opts = options || {};
    const raw = String(markdown || '');
    const withoutCode = raw.replace(FENCE_RE, ' ');

    const sourceHost = hostOf(opts.url);
    let linkCount = 0;
    let linkTextWords = 0;
    let affiliateLinks = 0;
    let outboundLinks = 0;

    LINK_RE.lastIndex = 0;
    let match;
    while ((match = LINK_RE.exec(withoutCode)) !== null) {
      linkCount++;
      linkTextWords += wordsOf(match[1]).length;
      const target = match[2] || '';
      if (AFFILIATE_TARGET.test(target)) affiliateLinks++;
      const targetHost = hostOf(target);
      if (targetHost && sourceHost && targetHost !== sourceHost) outboundLinks++;
    }

    // Link text stays in the prose (it is text the reader reads); the target
    // and the Markdown punctuation do not.
    const plain = withoutCode
      .replace(LINK_RE, '$1')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/[#>*_`|~]/g, ' ')
      .replace(/\s+/g, ' ');

    const lower = plain.toLowerCase();
    const words = wordsOf(plain);
    const wordCount = words.length;
    const per1000 = wordCount > 0 ? 1000 / wordCount : 0;

    const lines = withoutCode.split('\n').map(line => line.trim()).filter(Boolean);
    const headings = lines.filter(line => /^#{1,6}\s/.test(line)).length;

    const seenLines = new Set();
    let duplicateLines = 0;
    let substantialWords = 0;
    lines.forEach(line => {
      const normalized = line.toLowerCase().replace(/\s+/g, ' ');
      if (seenLines.has(normalized)) duplicateLines++;
      else seenLines.add(normalized);
      const lineWords = wordsOf(line.replace(LINK_RE, '$1').replace(/[#>*_`|~]/g, ' ')).length;
      // A paragraph, as opposed to a nav item, a caption or a list stub.
      if (lineWords >= 20) substantialWords += lineWords;
    });

    const terms = queryTerms(opts.query);
    const matchedTerms = terms.filter(term => lower.includes(term));

    return {
      wordCount,
      linkCount,
      linkTextWords,
      affiliateLinks,
      outboundLinks,
      headings,
      duplicateLineShare: lines.length ? duplicateLines / lines.length : 0,
      substantialWordShare: wordCount ? substantialWords / wordCount : 0,
      linkTextShare: wordCount ? linkTextWords / wordCount : 0,
      linksPer100Words: wordCount ? (linkCount * 100) / wordCount : 0,
      promoPer1000: countMatches(lower, PROMO_PATTERNS) * per1000,
      ctaPer1000: countMatches(lower, CTA_PATTERNS) * per1000,
      signalSellingHits: countMatches(lower, SIGNAL_SELLING_PATTERNS),
      queryTermCount: terms.length,
      queryTermsMatched: matchedTerms.length,
      queryOverlap: terms.length ? matchedTerms.length / terms.length : 1
    };
  }

  // --------------------------------------------------------------------------
  // Near-duplicate detection
  // --------------------------------------------------------------------------

  // A 32-bit FNV-1a hash of each 6-word shingle. Storing hashes rather than the
  // shingles themselves keeps a whole run's fingerprints small enough to hold
  // in memory next to the documents they describe.
  function hashShingle(text) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
    }
    return hash;
  }

  function fingerprint(markdown) {
    const plain = String(markdown || '')
      .replace(FENCE_RE, ' ')
      .replace(LINK_RE, '$1')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ');
    const words = wordsOf(plain);
    const shingles = new Set();
    for (let i = 0; i + SHINGLE_SIZE <= words.length; i++) {
      shingles.add(hashShingle(words.slice(i, i + SHINGLE_SIZE).join(' ')));
    }
    return Array.from(shingles);
  }

  function similarity(a, b) {
    if (!a || !b || !a.length || !b.length) return 0;
    const setA = new Set(a);
    let shared = 0;
    for (const value of b) {
      if (setA.has(value)) shared++;
    }
    const union = setA.size + b.length - shared;
    return union > 0 ? shared / union : 0;
  }

  // --------------------------------------------------------------------------
  // Scoring
  // --------------------------------------------------------------------------

  // Each entry is one measured reason with its own weight and its own sentence.
  // Nothing here is worth JUNK_SCORE_THRESHOLD on its own except the paid-signal
  // pitch, which is not ambiguous.
  function scoreSignals(stats) {
    const reasons = [];
    const add = (points, text) => reasons.push({ points, text });

    if (stats.signalSellingHits >= 2) {
      add(100, `${stats.signalSellingHits} paid-signal or VIP-channel pitches`);
    } else if (stats.signalSellingHits === 1) {
      add(30, 'a paid-signal or VIP-channel pitch');
    }

    const promo = stats.promoPer1000;
    if (promo >= 10) add(70, `${promo.toFixed(1)} promotional phrases per 1000 words`);
    else if (promo >= 6) add(50, `${promo.toFixed(1)} promotional phrases per 1000 words`);
    else if (promo >= 3) add(30, `${promo.toFixed(1)} promotional phrases per 1000 words`);
    else if (promo >= 1.5) add(12, `${promo.toFixed(1)} promotional phrases per 1000 words`);

    const cta = stats.ctaPer1000;
    if (cta >= 6) add(30, `${cta.toFixed(1)} calls to action per 1000 words`);
    else if (cta >= 3) add(15, `${cta.toFixed(1)} calls to action per 1000 words`);

    if (stats.linkTextShare >= 0.5) {
      add(45, `${Math.round(stats.linkTextShare * 100)}% of the text is link text`);
    } else if (stats.linkTextShare >= 0.35) {
      add(25, `${Math.round(stats.linkTextShare * 100)}% of the text is link text`);
    } else if (stats.linkTextShare >= 0.25) {
      add(10, `${Math.round(stats.linkTextShare * 100)}% of the text is link text`);
    }

    if (stats.linksPer100Words >= 12) {
      add(20, `${stats.linksPer100Words.toFixed(1)} links per 100 words`);
    }

    if (stats.affiliateLinks >= 10) add(40, `${stats.affiliateLinks} affiliate-shaped links`);
    else if (stats.affiliateLinks >= 5) add(25, `${stats.affiliateLinks} affiliate-shaped links`);
    else if (stats.affiliateLinks >= 3) add(10, `${stats.affiliateLinks} affiliate-shaped links`);

    if (stats.duplicateLineShare >= 0.3) {
      add(20, `${Math.round(stats.duplicateLineShare * 100)}% of the lines are repeats`);
    }

    // Boilerplate share, from the other side: how little of the page is written
    // in paragraphs at all.
    if (stats.wordCount >= 120 && stats.substantialWordShare < 0.2) {
      add(25, 'almost none of the page is written in paragraphs');
    } else if (stats.wordCount >= 120 && stats.substantialWordShare < 0.4) {
      add(10, `only ${Math.round(stats.substantialWordShare * 100)}% of the page is written in paragraphs`);
    }

    // Thin, and thin alone can never reject a page: a short but genuine note is
    // a legitimate source and this tops out well under the threshold.
    if (stats.wordCount < VERY_THIN_WORDS) add(35, `only ${stats.wordCount} words of content`);
    else if (stats.wordCount < THIN_WORDS) add(20, `only ${stats.wordCount} words of content`);

    if (stats.headings >= 6 && stats.wordCount / stats.headings < 35) {
      add(15, `${stats.headings} headings with almost nothing under them`);
    }

    if (stats.queryTermCount > 0) {
      if (stats.queryTermsMatched === 0) add(30, 'none of the question\'s terms appear on the page');
      else if (stats.queryOverlap < 0.25) {
        add(10, `only ${stats.queryTermsMatched} of ${stats.queryTermCount} question terms appear on the page`);
      }
    }

    return reasons;
  }

  // Assess one captured source.
  //
  //   { markdown, query, url, previous: [{ host, url, fingerprint }] }
  //
  // Resolves to { verdict: 'keep' | 'reject', reason, score, stats, fingerprint }.
  // `reason` is the verbatim sentence for the sheet and the document, and is
  // null when the page is kept.
  function assess(input) {
    const options = input || {};
    const stats = measure(options.markdown, options);
    const print = fingerprint(options.markdown);

    for (const earlier of options.previous || []) {
      const overlap = similarity(earlier.fingerprint, print);
      if (overlap >= DUPLICATE_JACCARD) {
        return {
          verdict: 'reject',
          category: 'duplicate',
          reason: `Dropped as a near-duplicate: ${Math.round(overlap * 100)}% of this page also appears in the source already captured from ${earlier.host || earlier.url}`,
          score: 0,
          stats,
          fingerprint: print
        };
      }
    }

    const reasons = scoreSignals(stats).sort((a, b) => b.points - a.points);
    const score = reasons.reduce((sum, item) => sum + item.points, 0);

    if (score < JUNK_SCORE_THRESHOLD) {
      return { verdict: 'keep', category: null, reason: null, score, stats, fingerprint: print };
    }

    // The two heaviest measurements, in the user's words. A rejection that says
    // "score 120" tells the reader nothing about the page.
    const spoken = reasons.slice(0, 2).map(item => item.text).join(' and ');
    return {
      verdict: 'reject',
      category: 'junk',
      reason: `Dropped as low-value: ${spoken}`,
      score,
      stats,
      fingerprint: print
    };
  }

  return {
    JUNK_SCORE_THRESHOLD,
    DUPLICATE_JACCARD,
    THIN_WORDS,
    assess,
    measure,
    fingerprint,
    similarity,
    queryTerms
  };
})();

// Background contexts only.
if (typeof self !== 'undefined') {
  self.ScrapLLMSourceQuality = ScrapLLMSourceQuality;
}
