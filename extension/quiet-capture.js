// ScrapLLM Quiet Capture
// The decision table for capturing a research source without opening a tab:
// fetch the server-rendered HTML in the background, and decide from the answer
// whether a real rendering engine would have done better.
//
// Pure and background-only: it does not touch tabs, storage or messaging, and
// every decision it returns carries the verbatim reason the user will read.
// The parsing itself happens elsewhere (an offscreen document on Chrome, the
// MV2 background page on Firefox) because a service worker has no DOM.

const ScrapLLMQuietCapture = (function() {
  'use strict';

  // A page that has not answered in 10 s is not worth a 20 s tab either.
  const FETCH_TIMEOUT_MS = 10000;

  // Guards, not preferences. Measured over 30 real pages: every junk, blocked
  // or app-shell page yielded at most 98 characters of Readability text (or no
  // article at all), while the weakest genuine article yielded 1385. 500 sits
  // five times above the worst junk and well below the weakest real page.
  const MIN_TEXT_CHARS = 500;
  const MIN_BODY_TEXT_CHARS = 200;

  // A redirect to one of these is a wall the fetch cannot walk through but a
  // tab, carrying the user's own cookies, often can.
  const WALL_PATTERN = /(^|\.)consent\.|\/consent|cookie|gdpr|login|signin|accounts\./i;

  const PDF_MESSAGE = "PDFs open in the browser's viewer, where extensions cannot run";

  const TEXT_TYPES = ['text/plain', 'text/markdown', 'text/x-markdown'];
  const HTML_TYPES = ['text/html', 'application/xhtml+xml'];

  function parseContentType(header) {
    if (!header) return '';
    return String(header).split(';')[0].trim().toLowerCase();
  }

  function hostOf(url) {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch (e) {
      return '';
    }
  }

  // --------------------------------------------------------------------------
  // The fetch
  // --------------------------------------------------------------------------

  // Resolves — never rejects — with one of:
  //   { kind: 'html',         status, finalUrl, contentType, html }
  //   { kind: 'text',         status, finalUrl, contentType, text }
  //   { kind: 'nonHtml',      status, finalUrl, contentType }
  //   { kind: 'httpError',    status, finalUrl, contentType, html }
  //   { kind: 'networkError', message }
  async function fetchSource(url, options) {
    const opts = options || {};
    const timeoutMs = opts.timeoutMs || FETCH_TIMEOUT_MS;
    const fetchImpl = opts.fetch || (typeof fetch === 'function' ? fetch : null);
    if (!fetchImpl) {
      return { kind: 'networkError', message: 'This browser exposed no fetch to the background' };
    }

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    let unlisten = null;
    if (opts.signal) {
      if (opts.signal.aborted) {
        clearTimeout(timer);
        return { kind: 'networkError', message: 'Cancelled by user' };
      }
      const onAbort = () => controller.abort();
      opts.signal.addEventListener('abort', onAbort);
      unlisten = () => opts.signal.removeEventListener('abort', onAbort);
    }

    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        redirect: 'follow',
        // The user's session is what makes a paywalled or consent-walled page
        // readable. SameSite=Lax cookies still will not travel on a background
        // request — that is exactly what the thin-extraction rule catches.
        credentials: 'include',
        signal: controller.signal
      });

      const contentType = parseContentType(response.headers && response.headers.get('content-type'));
      const finalUrl = response.url || url;

      if (contentType && !HTML_TYPES.includes(contentType)) {
        if (TEXT_TYPES.includes(contentType)) {
          return {
            kind: 'text',
            status: response.status,
            finalUrl,
            contentType,
            text: await response.text()
          };
        }
        return { kind: 'nonHtml', status: response.status, finalUrl, contentType };
      }

      const html = await response.text();
      if (response.status < 200 || response.status > 299) {
        return { kind: 'httpError', status: response.status, finalUrl, contentType, html };
      }
      return { kind: 'html', status: response.status, finalUrl, contentType, html };
    } catch (error) {
      const message = (error && error.message) || String(error);
      if (timedOut) {
        return { kind: 'networkError', message: 'The server did not answer within 10 s' };
      }
      return { kind: 'networkError', message };
    } finally {
      clearTimeout(timer);
      if (unlisten) unlisten();
    }
  }

  // --------------------------------------------------------------------------
  // The decision table
  // --------------------------------------------------------------------------

  // Checks that can be made before a single byte is fetched. Returns null when
  // there is nothing to say.
  function preflight(url, settings) {
    const host = hostOf(url);
    const config = settings || {};

    // The Reddit and X extractors read a live page (Reddit's JSON is fetched
    // same-origin with the user's session; X's timeline is virtualised), so a
    // fetched copy of the HTML would silently drop the discussion. Say so and
    // open a tab rather than return a post without its comments.
    if (config.redditMode !== false && /(^|\.)reddit\.com$/.test(host)) {
      return { decision: 'render', reason: "Reddit's comment tree needs the page's own session, so a tab was opened" };
    }
    if (config.xMode !== false && /^(x|twitter)\.com$/.test(host)) {
      return { decision: 'render', reason: 'X timelines are virtualised, so a tab was opened' };
    }
    return null;
  }

  // Rules a–d: everything decidable from the response alone.
  function classifyResponse(result, requestedUrl) {
    if (!result) {
      return { decision: 'reject', reason: 'No response' };
    }

    if (result.kind === 'networkError') {
      return { decision: 'reject', reason: result.message };
    }

    if (result.kind === 'nonHtml') {
      if (result.contentType === 'application/pdf') {
        return { decision: 'reject', reason: PDF_MESSAGE };
      }
      return { decision: 'reject', reason: `Not a web page: ${result.contentType}` };
    }

    if (result.kind === 'text') {
      if (result.status < 200 || result.status > 299) {
        return { decision: 'render', reason: `Server answered ${result.status}, so a tab was opened` };
      }
      return { decision: 'use', reason: null };
    }

    if (result.kind === 'httpError') {
      return { decision: 'render', reason: `Server answered ${result.status}, so a tab was opened` };
    }

    const requestedHost = hostOf(requestedUrl);
    const finalHost = hostOf(result.finalUrl);
    if (requestedHost && finalHost && requestedHost !== finalHost) {
      let path = '';
      try {
        path = new URL(result.finalUrl).pathname;
      } catch (e) {
        path = '';
      }
      if (WALL_PATTERN.test(finalHost) || WALL_PATTERN.test(path)) {
        return { decision: 'render', reason: `Redirected to ${finalHost}, so a tab was opened` };
      }
    }

    return { decision: 'use', reason: null };
  }

  // Rules e–f: what only the parsed document can answer.
  // `extraction` is what convert-core's convertHtml returns, or
  // { failed: true, error } when the parse threw.
  function classifyExtraction(extraction) {
    if (!extraction || extraction.failed) {
      const detail = (extraction && extraction.error) || 'unknown error';
      return {
        decision: 'render',
        reason: `Server-rendered HTML could not be converted (${detail}), so a tab was opened`
      };
    }

    if (extraction.emptyAppShell && extraction.bodyTextLength < MIN_BODY_TEXT_CHARS) {
      return {
        decision: 'render',
        reason: 'Page is rendered by JavaScript, so a tab was opened'
      };
    }

    const textLength = extraction.textLength || 0;
    if (textLength < MIN_TEXT_CHARS) {
      return {
        decision: 'render',
        reason: `Server-rendered text was only ${textLength} characters, so a tab was opened`
      };
    }

    return { decision: 'use', reason: null };
  }

  return {
    FETCH_TIMEOUT_MS,
    MIN_TEXT_CHARS,
    MIN_BODY_TEXT_CHARS,
    PDF_MESSAGE,
    fetchSource,
    preflight,
    classifyResponse,
    classifyExtraction
  };
})();

// Background contexts only.
if (typeof self !== 'undefined') {
  self.ScrapLLMQuietCapture = ScrapLLMQuietCapture;
}
