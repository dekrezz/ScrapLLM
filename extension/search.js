// ScrapLLM Search Client
// Source discovery for the research feature. Runs in the background context
// only (service worker in Chrome, background page in Firefox) and is therefore
// DOM-free: no DOMParser, no document, no XMLHttpRequest. DuckDuckGo's HTML
// endpoints are parsed with string/regex work on `await response.text()`.
//
// Pure module: no tabs, no storage, no messaging, no persisted state.

const ScrapLLMSearch = (function() {
  const HTML_ENDPOINT = 'https://html.duckduckgo.com/html/';
  const LITE_ENDPOINT = 'https://lite.duckduckgo.com/lite/';
  const REQUEST_TIMEOUT_MS = 10000;
  const QUERY_MAX_CHARS = 300;
  const MIN_LIMIT = 5;
  const MAX_LIMIT = 12;
  const COMFORTABLE_SOURCE_COUNT = 5;

  const ERROR_UNREACHABLE = 'Could not reach DuckDuckGo. Check your connection.';
  const ERROR_RATE_LIMITED = 'DuckDuckGo is rate limiting this device. Try again in a minute.';
  const ERROR_MARKUP_DRIFT =
    'Search endpoint markup changed — the DuckDuckGo parser found no results in a 200 response.';

  // Hosts that answer an extension fetch with a wall rather than an article.
  const LOGIN_WALL_HOSTS = [
    'facebook.com', 'instagram.com', 'linkedin.com', 'quora.com',
    'scribd.com', 'coursehero.com', 'chegg.com', 'academia.edu',
    'researchgate.net'
  ];
  const PAYWALL_HOSTS = [
    'wsj.com', 'ft.com', 'bloomberg.com', 'economist.com', 'nytimes.com',
    'thetimes.co.uk', 'seekingalpha.com', 'medium.com'
  ];
  const TRUSTED_HOSTS = [
    'wikipedia.org', 'developer.mozilla.org', 'arxiv.org', 'github.com',
    'stackoverflow.com'
  ];

  const NON_PAGE_EXTENSIONS =
    /\.(pdf|docx?|xlsx?|pptx?|zip|rar|7z|tar|gz|mp[34]|avi|mov|webm|jpe?g|png|gif|svg|webp|epub|csv)(\?|#|$)/i;
  const PAYWALL_SNIPPET = /sign in to continue|subscribe to read|create a free account/i;
  const LOW_VALUE_PATH = /\/tag\/|\/category\/|\/search\?|\/page\/\d/;
  const TIME_SENSITIVE =
    /\b(today|yesterday|latest|last (24 hours|day|week)|right now|current|breaking|this (week|month)|202\d)\b/i;

  const TRACKING_PARAMS = /^(utm_.*|fbclid|gclid|ref|rut)$/i;

  const STOP_WORDS = new Set([
    'the', 'and', 'for', 'with', 'that', 'this', 'from', 'what', 'when',
    'which', 'while', 'into', 'about', 'your', 'their', 'have', 'has',
    'does', 'how', 'why', 'are', 'was', 'were', 'been', 'best', 'like'
  ]);

  // Hosts already used by an earlier research run in this background-script
  // lifetime. Deliberately in-memory only: the point is variety within a
  // session, not a permanent blocklist.
  const seenHosts = new Set();

  // --------------------------------------------------------------------------
  // Text helpers
  // --------------------------------------------------------------------------

  const NAMED_ENTITIES = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&#x27;': "'",
    '&apos;': "'",
    '&nbsp;': ' '
  };

  // A malformed entity is text, not a crash: anything outside the Unicode range
  // (or a surrogate half) is left exactly as it was written.
  function fromCodePoint(code, fallback) {
    if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return fallback;
    if (code >= 0xd800 && code <= 0xdfff) return fallback;
    try {
      return String.fromCodePoint(code);
    } catch (e) {
      return fallback;
    }
  }

  function decodeEntities(text) {
    if (!text) return '';
    return text
      .replace(/&(?:amp|lt|gt|quot|#39|#x27|apos|nbsp);/gi, (match) => {
        return NAMED_ENTITIES[match.toLowerCase()] !== undefined
          ? NAMED_ENTITIES[match.toLowerCase()]
          : match;
      })
      .replace(/&#x([0-9a-f]+);/gi, (match, hex) => fromCodePoint(parseInt(hex, 16), match))
      .replace(/&#(\d+);/g, (match, dec) => fromCodePoint(parseInt(dec, 10), match));
  }

  function cleanText(html) {
    if (!html) return '';
    return decodeEntities(String(html).replace(/<[^>]*>/g, ' '))
      .replace(/\s+/g, ' ')
      .trim();
  }

  function normalizeQuery(query) {
    return String(query || '').trim().replace(/\s+/g, ' ').slice(0, QUERY_MAX_CHARS);
  }

  function clampLimit(limit) {
    const value = Math.round(Number(limit));
    if (!Number.isFinite(value)) return 8;
    return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, value));
  }

  function isTimeSensitive(query) {
    return TIME_SENSITIVE.test(String(query || ''));
  }

  function stripWww(hostname) {
    return String(hostname || '').replace(/^www\./i, '').toLowerCase();
  }

  function hostMatches(host, list) {
    return list.some(entry => host === entry || host.endsWith('.' + entry));
  }

  // --------------------------------------------------------------------------
  // URL handling
  // --------------------------------------------------------------------------

  // DuckDuckGo wraps outbound links as /l/?uddg=<encoded>. Unwrap it; accept a
  // bare absolute http(s) href; otherwise the candidate is unusable.
  function unwrapHref(rawHref) {
    if (!rawHref) return null;
    const href = String(rawHref).replace(/&amp;/g, '&');
    const wrapped = href.match(/[?&]uddg=([^&]+)/);
    if (wrapped) {
      try {
        const decoded = decodeURIComponent(wrapped[1]);
        if (/^https?:\/\//i.test(decoded)) return decoded;
      } catch (e) {
        return null;
      }
      return null;
    }
    if (/^https?:\/\//i.test(href)) return href;
    return null;
  }

  function stripTrackingParams(url) {
    const toDelete = [];
    url.searchParams.forEach((value, key) => {
      if (TRACKING_PARAMS.test(key)) toDelete.push(key);
    });
    toDelete.forEach(key => url.searchParams.delete(key));
    return url;
  }

  // Key used for duplicate detection: tracking params gone, trailing slash and
  // hash dropped, host lower-cased without www.
  function normalizedKey(url) {
    const clone = new URL(url.href);
    stripTrackingParams(clone);
    clone.hash = '';
    const path = clone.pathname.replace(/\/+$/, '');
    return stripWww(clone.hostname) + path + (clone.search || '');
  }

  // --------------------------------------------------------------------------
  // Parsing
  // --------------------------------------------------------------------------

  function extractAttribute(tag, name) {
    const match = tag.match(new RegExp(name + '\\s*=\\s*("([^"]*)"|\'([^\']*)\')', 'i'));
    if (!match) return null;
    return match[2] !== undefined ? match[2] : match[3];
  }

  function parseDdgHtml(html) {
    const source = String(html || '');
    const zeroMarker = /result--no-result/.test(source);

    // Blocks start at a result container div; slicing on the opening tag keeps
    // the parse independent of the class order inside the attribute.
    const blockStarts = [];
    const blockRegex = /<div[^>]*class=["'][^"']*\bresults_links\b[^"']*["'][^>]*>/gi;
    let match;
    while ((match = blockRegex.exec(source)) !== null) {
      blockStarts.push(match.index);
    }

    const results = [];
    for (let i = 0; i < blockStarts.length; i++) {
      const block = source.slice(
        blockStarts[i],
        i + 1 < blockStarts.length ? blockStarts[i + 1] : source.length
      );

      if (/result--ad|result--sponsored|badge--ad/.test(block)) continue;

      const anchorMatch = block.match(/<a[^>]*class=["'][^"']*\bresult__a\b[^"']*["'][^>]*>([\s\S]*?)<\/a>/i);
      if (!anchorMatch) continue;

      const anchorTag = anchorMatch[0].slice(0, anchorMatch[0].indexOf('>') + 1);
      const url = unwrapHref(extractAttribute(anchorTag, 'href'));
      if (!url) continue;

      const title = cleanText(anchorMatch[1]);
      const snippetMatch = block.match(
        /<[a-z]+[^>]*class=["'][^"']*\bresult__snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/[a-z]+>/i
      );

      results.push({
        url,
        title,
        snippet: snippetMatch ? cleanText(snippetMatch[1]) : '',
        engineRank: results.length + 1
      });
    }

    return { results, zeroMarker };
  }

  function parseDdgLite(html) {
    const source = String(html || '');
    const zeroMarker = /no-results__container|no-results__message/.test(source);

    const links = [];
    const linkRegex = /<a[^>]*class=("[^"]*\bresult-link\b[^"]*"|'[^']*\bresult-link\b[^']*')[^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = linkRegex.exec(source)) !== null) {
      const tag = match[0].slice(0, match[0].indexOf('>') + 1);
      links.push({
        url: unwrapHref(extractAttribute(tag, 'href')),
        title: cleanText(match[2])
      });
    }

    const snippets = [];
    const snippetRegex =
      /<td[^>]*class=("[^"]*\bresult-snippet\b[^"]*"|'[^']*\bresult-snippet\b[^']*')[^>]*>([\s\S]*?)<\/td>/gi;
    while ((match = snippetRegex.exec(source)) !== null) {
      snippets.push(cleanText(match[2]));
    }

    const results = [];
    links.forEach((link, index) => {
      if (!link.url) return;
      results.push({
        url: link.url,
        title: link.title,
        snippet: snippets[index] || '',
        engineRank: results.length + 1
      });
    });

    return { results, zeroMarker };
  }

  // --------------------------------------------------------------------------
  // Filtering and ranking
  // --------------------------------------------------------------------------

  function queryContentWords(query) {
    return String(query || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(word => word.length >= 4 && !STOP_WORDS.has(word));
  }

  function scoreCandidate(candidate, url, host, contentWords) {
    let score = 20 - candidate.engineRank;

    const trusted = hostMatches(host, TRUSTED_HOSTS) ||
      host.endsWith('.gov') || host.endsWith('.edu') || host.endsWith('.ac.uk') ||
      host.startsWith('docs.');
    if (trusted) score += 6;

    if (contentWords.length) {
      const haystack = (candidate.snippet || '').toLowerCase();
      const hits = new Set();
      contentWords.forEach(word => {
        if (haystack.includes(word)) hits.add(word);
      });
      if (hits.size >= 2) score += 4;
    }

    const depth = url.pathname.split('/').filter(Boolean).length;
    if (depth >= 2 && !url.search) score += 3;

    if (LOW_VALUE_PATH.test(url.pathname + url.search)) score -= 5;
    if (seenHosts.has(host)) score -= 4;

    return score;
  }

  function filterAndRank(candidates, limit, query) {
    const max = clampLimit(limit);
    const contentWords = queryContentWords(query);
    const rejected = [];
    const kept = [];
    const keptHosts = new Set();
    const keptKeys = new Set();

    for (const candidate of candidates || []) {
      let url;
      try {
        url = new URL(candidate.url);
      } catch (e) {
        rejected.push({ url: candidate.url, host: '', reason: 'Unsupported scheme' });
        continue;
      }

      const host = stripWww(url.hostname);

      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        rejected.push({ url: url.href, host, reason: 'Unsupported scheme' });
        continue;
      }
      if (NON_PAGE_EXTENSIONS.test(url.pathname + url.search)) {
        rejected.push({ url: url.href, host, reason: 'Not a web page' });
        continue;
      }

      const isSinglePost = (host === 'x.com' || host === 'twitter.com') &&
        /\/status\/\d+/.test(url.pathname);
      if (hostMatches(host, LOGIN_WALL_HOSTS) ||
          /(^|\.)pinterest\./.test(host) ||
          ((host === 'x.com' || host === 'twitter.com') && !isSinglePost)) {
        rejected.push({ url: url.href, host, reason: 'Login wall' });
        continue;
      }
      if (hostMatches(host, PAYWALL_HOSTS)) {
        rejected.push({ url: url.href, host, reason: 'Paywalled' });
        continue;
      }
      if (PAYWALL_SNIPPET.test((candidate.title || '') + ' ' + (candidate.snippet || ''))) {
        rejected.push({ url: url.href, host, reason: 'Paywall notice in snippet' });
        continue;
      }
      // The URL key is tested first, and it has to be: two spellings of the
      // same page share a host, so testing the host first reported every
      // repeat of one link as a different page on the same site.
      const key = normalizedKey(url);
      if (keptKeys.has(key)) {
        rejected.push({ url: url.href, host, reason: 'Duplicate URL' });
        continue;
      }

      if (keptHosts.has(host)) {
        rejected.push({ url: url.href, host, reason: 'Duplicate host' });
        continue;
      }

      stripTrackingParams(url);
      keptHosts.add(host);
      keptKeys.add(key);
      kept.push({
        url: url.href,
        host,
        title: candidate.title || url.href,
        snippet: candidate.snippet || '',
        engineRank: candidate.engineRank,
        score: scoreCandidate(candidate, url, host, contentWords)
      });
    }

    kept.sort((a, b) => (b.score - a.score) || (a.engineRank - b.engineRank));
    // Never pad, never overflow: the run fetches `max` and keeps the surplus as
    // `reserves`. The engine pulls from it when a source is skipped at a wall or
    // dropped as junk, so a dropped source does not shrink the result. Nothing
    // here fetches the surplus; it is only offered.
    const results = kept.slice(0, max);
    const reserves = kept.slice(max);

    return { results, reserves, rejected };
  }

  // --------------------------------------------------------------------------
  // Fetching
  // --------------------------------------------------------------------------

  async function fetchText(url, signal) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', onAbort);
    }

    try {
      const response = await fetch(url, {
        method: 'GET',
        credentials: 'omit',
        redirect: 'follow',
        signal: controller.signal
      });
      const text = await response.text();
      return { status: response.status, text };
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  function buildUrl(endpoint, query, recency, includeRegion) {
    let url = endpoint + '?q=' + encodeURIComponent(query);
    if (includeRegion) url += '&kl=wt-wt';
    if (recency) url += '&df=d';
    return url;
  }

  // One endpoint attempt. Returns a classification the caller acts on, so the
  // fallback decision stays in one place.
  //   { outcome: 'results'|'zero'|'drift'|'unreachable', parsed }
  async function attemptEndpoint(endpoint, query, recency, signal) {
    const isLite = endpoint === LITE_ENDPOINT;
    let response;
    try {
      response = await fetchText(buildUrl(endpoint, query, recency, !isLite), signal);
    } catch (error) {
      if (signal && signal.aborted) throw error;
      return { outcome: 'unreachable', parsed: null };
    }

    if (response.status !== 200) {
      return { outcome: 'unreachable', parsed: null };
    }

    const parsed = isLite ? parseDdgLite(response.text) : parseDdgHtml(response.text);

    if (parsed.zeroMarker) return { outcome: 'zero', parsed };
    if (parsed.results.length > 0) return { outcome: 'results', parsed };

    // Zero blocks: an anomaly banner means the IP is throttled, and retrying
    // the sibling endpoint from the same IP cannot help.
    if (/anomaly|unusual traffic|please try again later/i.test(response.text)) {
      throw new Error(ERROR_RATE_LIMITED);
    }

    return { outcome: 'drift', parsed };
  }

  async function findSources(query, options) {
    const opts = options || {};
    const signal = opts.signal;
    const limit = clampLimit(opts.limit === undefined ? 8 : opts.limit);
    const normalizedQuery = normalizeQuery(query);

    if (!normalizedQuery) {
      throw new Error('Enter a question to research.');
    }

    const recency = isTimeSensitive(normalizedQuery);
    let engine = 'duckduckgo-html';
    let degraded = null;

    let attempt = await attemptEndpoint(HTML_ENDPOINT, normalizedQuery, recency, signal);

    if (attempt.outcome === 'unreachable' || attempt.outcome === 'drift') {
      const primaryOutcome = attempt.outcome;
      const fallback = await attemptEndpoint(LITE_ENDPOINT, normalizedQuery, recency, signal);

      if (fallback.outcome === 'unreachable') {
        throw new Error(primaryOutcome === 'drift' ? ERROR_MARKUP_DRIFT : ERROR_UNREACHABLE);
      }
      if (fallback.outcome === 'drift') {
        throw new Error(ERROR_MARKUP_DRIFT);
      }

      engine = 'duckduckgo-lite';
      degraded = primaryOutcome === 'drift'
        ? 'html endpoint returned no parsable results, used the lite endpoint'
        : 'html endpoint unavailable, used the lite endpoint';
      attempt = fallback;
    }

    if (attempt.outcome === 'zero') {
      return {
        results: [],
        reserves: [],
        engine,
        usedRecency: recency,
        rejected: [],
        degraded: null
      };
    }

    const { results, reserves, rejected } = filterAndRank(attempt.parsed.results, limit, normalizedQuery);

    if (attempt.parsed.results.length > 0 && results.length < COMFORTABLE_SOURCE_COUNT) {
      // Appended, never assigned: a thin result set does not stop being the
      // lite endpoint's result set, and overwriting hid the endpoint failure
      // from the sheet and from the document's Notes line.
      const thin = `only ${results.length} usable sources after filtering`;
      degraded = degraded ? `${degraded}; ${thin}` : thin;
    }

    results.forEach(entry => seenHosts.add(entry.host));

    return {
      results,
      reserves,
      engine,
      usedRecency: recency,
      rejected,
      degraded
    };
  }

  return {
    findSources,
    isTimeSensitive,
    parseDdgHtml,
    parseDdgLite,
    filterAndRank
  };
})();

// Background contexts only: the service worker exposes `self`, the Firefox
// background page exposes it too. This file is never a content script.
if (typeof self !== 'undefined') {
  self.ScrapLLMSearch = ScrapLLMSearch;
}
