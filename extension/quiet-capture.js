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

  // A ceiling on what one source may pull into the background. Time was already
  // capped; bytes were not, and the whole body is held as a string and then
  // structured-cloned to the parser, three sources at a time. No article comes
  // close to 5 MB, so this only ever catches a runaway or hostile response.
  const MAX_BYTES = 5 * 1024 * 1024;

  function tooLargeMessage(bytes) {
    const mb = (MAX_BYTES / (1024 * 1024)).toFixed(0);
    const seen = bytes ? ` (${bytes} bytes)` : '';
    return `Page was larger than ${mb} MB${seen}, so it was not captured`;
  }

  // A redirect to one of these is a wall the fetch cannot walk through but a
  // tab, carrying the user's own cookies, often can.
  const WALL_PATTERN = /(^|\.)consent\.|\/consent|cookie|gdpr|login|signin|accounts\./i;

  const PDF_MESSAGE = "PDFs open in the browser's viewer, where extensions cannot run";

  // A 403, 429 or 503 is often a bot check the user's own tab walks straight
  // through, so those escalate. 404 and 410 are the site saying the page is not
  // there — a tab renders the site's error page and the run would file that as
  // a capture. Same reasoning as the PDF: a rendering engine cannot help, so
  // this is a rejection with the status in it, not an escalation.
  const DEAD_STATUSES = [404, 410];

  function deadStatusMessage(status) {
    return `Server answered ${status}: the page is not there, and a tab cannot bring it back`;
  }

  // --------------------------------------------------------------------------
  // Walls: the failures that repeating cannot fix
  // --------------------------------------------------------------------------
  //
  // The ladder above this module (quiet fetch, tab, one delayed retry) exists
  // for pages that are *flaky*. A wall is not flaky: an active bot challenge,
  // a credential check that answers the same way every time, a subscription
  // gate, or bytes that are not a web page at all. Spending a tab and a retry
  // on one costs the run its budget and gives the user the same sentence three
  // times, so these are detected here and skipped at once, each with the
  // category it belongs to.

  // Vendor challenge pages, named by the markers only their interstitial
  // carries. Measured on live 403 bodies (retailmenot.com, telegramchannels.me
  // and pcmag.com all answered a background fetch with the same Cloudflare
  // interstitial: a 5.7 KB body, "Just a moment..." as its title, and
  // `cdn-cgi/challenge-platform` plus `__cf_chl` inside).
  const CHALLENGE_MARKERS = [
    { pattern: /cdn-cgi\/challenge-platform|__cf_chl|_cf_chl_opt|cf-browser-verification/i, vendor: 'Cloudflare' },
    { pattern: /challenges\.cloudflare\.com/i, vendor: 'Cloudflare' },
    { pattern: /captcha-delivery\.com|datadome/i, vendor: 'DataDome' },
    { pattern: /px-captcha|perimeterx|_pxhd|captcha\.px-cloud\.net/i, vendor: 'PerimeterX' },
    { pattern: /geo\.captcha-delivery|imperva|incapsula/i, vendor: 'Imperva' }
  ];

  // Generic CAPTCHA widgets. A contact form on a real article embeds these too,
  // so on their own they decide nothing: they count as a challenge only when
  // the response is also a short body or a non-2xx status, which is what an
  // interstitial actually is.
  const CAPTCHA_MARKERS =
    /(hcaptcha\.com\/1\/api\.js|www\.google\.com\/recaptcha\/api\.js|g-recaptcha|h-captcha)/i;
  const CHALLENGE_BODY_MAX_BYTES = 60000;

  // A gate whose answer does not change when it is asked again from the same
  // browser without a session.
  const REPEATED_BLOCK_STATUSES = [401, 403, 429];

  // A subscription gate. Unlike a login wall, the user's own session does not
  // open it — a tab renders the same offer page — so this never escalates.
  const PAYWALL_MARKERS =
    /(subscribe to (?:continue|read)|subscription required|to continue reading|this (?:article|content) is for subscribers|paywall|piano\.io|"isAccessibleForFree"\s*:\s*(?:"|)?false)/i;

  // A credential or consent gate. This one *can* open in the user's own tab,
  // so it is a wall only once the tab has already been spent on it.
  const LOGIN_WALL_MARKERS =
    /(type=["']password["']|sign in to (?:continue|view|read)|log ?in to (?:continue|view|read)|please (?:sign in|log ?in)|accept (?:all )?cookies|consent to (?:the use of )?cookies|manage your (?:cookie )?preferences)/i;

  function challengeVendor(html) {
    const body = String(html || '');
    for (const marker of CHALLENGE_MARKERS) {
      if (marker.pattern.test(body)) return marker.vendor;
    }
    return null;
  }

  // The verbatim reason this response is an active bot challenge, or null.
  function botChallengeReason(html, status) {
    const body = String(html || '');
    if (!body) return null;
    const vendor = challengeVendor(body);
    if (vendor) {
      return `Blocked by a ${vendor} bot challenge, which a background capture cannot answer`;
    }
    const corroborated = body.length <= CHALLENGE_BODY_MAX_BYTES ||
      (Number.isFinite(status) && (status < 200 || status > 299));
    if (corroborated && CAPTCHA_MARKERS.test(body)) {
      return 'Blocked by a CAPTCHA gate, which a background capture cannot answer';
    }
    return null;
  }

  function repeatedBlockMessage(status) {
    return `Server answered ${status} again after a retry: this site refuses automated access`;
  }

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
  // Destination guard
  // --------------------------------------------------------------------------
  //
  // A search result — or, more to the point, a redirect from one — can name the
  // user's own machine or LAN. With `*://*/*` granted, the background would
  // fetch it and the answer would land in the document the user pastes into an
  // LLM, and a GET with a side effect (a router's admin action) would simply
  // happen. Neither path is allowed to touch a non-public destination, so this
  // is a rejection, never an escalation: a tab cannot make such a URL safe.
  //
  // The limits, stated rather than hidden: `fetch` cannot expose intermediate
  // hops (`redirect: 'manual'` yields an opaque response), so a chain that
  // passes *through* a private host still performs that GET — only the
  // requested and the final URL are checked here. A public name that resolves
  // to a private address (DNS rebinding, or simply an A record pointing at
  // 10.x) also passes, because an extension never sees the resolved address.
  // Closing either would need declarativeNetRequest rules scoped to the run.
  const PRIVATE_HOST_SUFFIXES = ['.local', '.internal', '.home.arpa', '.localhost'];
  const PRIVATE_HOST_NAMES = ['localhost'];

  function isPrivateIPv4(host) {
    const parts = host.split('.');
    if (parts.length !== 4) return false;
    const nums = parts.map(part => (/^\d{1,3}$/.test(part) ? Number(part) : -1));
    if (nums.some(n => n < 0 || n > 255)) return false;
    const a = nums[0];
    const b = nums[1];
    if (a === 0 || a === 127 || a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
    if (a >= 224) return true;                         // multicast and reserved
    return false;
  }

  function isPrivateIPv6(host) {
    // URL.hostname keeps the brackets on an IPv6 literal.
    if (host[0] !== '[' || host[host.length - 1] !== ']') return false;
    const address = host.slice(1, -1).toLowerCase();
    if (address === '::1' || address === '::') return true;
    // An IPv4-mapped address (::ffff:127.0.0.1) inherits the IPv4 verdict.
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
    if (mapped) return isPrivateIPv4(mapped[1]);
    if (/^f[cd][0-9a-f]{2}:/.test(address)) return true; // fc00::/7 unique local
    if (/^fe[89ab][0-9a-f]:/.test(address)) return true; // fe80::/10 link local
    return false;
  }

  // The verbatim reason to refuse this URL, or null when it is public.
  function privateDestinationReason(url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (e) {
      return 'Refused: this URL could not be parsed';
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return `Refused: ${parsed.protocol} is not a web page address`;
    }
    const host = parsed.hostname.toLowerCase();
    if (!host) return 'Refused: this URL names no host';
    const isPrivate =
      PRIVATE_HOST_NAMES.includes(host) ||
      PRIVATE_HOST_SUFFIXES.some(suffix => host.endsWith(suffix)) ||
      host.indexOf('.') === -1 ||
      isPrivateIPv4(host) ||
      isPrivateIPv6(host);
    return isPrivate ? 'Refused: this URL points at a private address' : null;
  }

  // --------------------------------------------------------------------------
  // The fetch
  // --------------------------------------------------------------------------

  // Resolves — never rejects — with one of:
  //   { kind: 'html',         status, finalUrl, contentType, html }
  //   { kind: 'text',         status, finalUrl, contentType, text }
  //   { kind: 'nonHtml',      status, finalUrl, contentType }
  //   { kind: 'httpError',    status, finalUrl, contentType, html }
  //   { kind: 'blocked',      status, finalUrl, contentType, reason }
  //   { kind: 'tooLarge',     status, finalUrl, contentType, bytes }
  //   { kind: 'networkError', message }

  // Only these opening shapes count as markup when the server said nothing.
  function looksLikeHtml(text) {
    return /^\s*(<!doctype\s+html|<html[\s>]|<\?xml|<!--)/i.test(String(text).slice(0, 256));
  }

  // Reads the body with a byte ceiling. `content-length` short-circuits the
  // obvious case; a chunked or lying response is counted as it arrives and the
  // stream is cancelled the moment it goes over. Decoding is UTF-8 because
  // `Response.text()` decodes UTF-8 too, so nothing changes for a normal page.
  async function readCappedText(response, limit) {
    const cap = limit || MAX_BYTES;
    const declared = Number(response.headers && response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > cap) {
      return { tooLarge: true, bytes: declared };
    }

    const body = response.body;
    if (!body || typeof body.getReader !== 'function' || typeof TextDecoder === 'undefined') {
      // This response exposes no readable stream. The cap still holds, one body
      // late: those bytes are already in memory, but they go no further — not
      // to the parser, not to the document.
      const text = await response.text();
      if (text.length > cap) return { tooLarge: true, bytes: text.length };
      return { text };
    }

    const reader = body.getReader();
    const decoder = new TextDecoder('utf-8');
    let bytes = 0;
    let text = '';
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > cap) {
        try {
          await reader.cancel();
        } catch (e) {
          // The stream is being abandoned either way.
        }
        return { tooLarge: true, bytes };
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return { text };
  }

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
        // No cookies. Host access here means "read any site from the
        // background", and attaching the jar would turn that into reading the
        // user's logged-in copy of whatever a search result or its redirect
        // chain points at, into a document that is about to be pasted into an
        // LLM. A page that genuinely needs the session already has an answer in
        // this design: it comes back walled, thin or non-2xx and escalates to a
        // tab, where the session applies in the user's own window and the user
        // can see what happened.
        credentials: 'omit',
        signal: controller.signal
      });

      const contentType = parseContentType(response.headers && response.headers.get('content-type'));
      const finalUrl = response.url || url;

      // A redirect can leave the public web entirely. That request is spent by
      // the time we see it, but its body is not going into the document.
      const blocked = privateDestinationReason(finalUrl);
      if (blocked) {
        return { kind: 'blocked', status: response.status, finalUrl, contentType, reason: blocked };
      }

      if (contentType && !HTML_TYPES.includes(contentType)) {
        if (TEXT_TYPES.includes(contentType)) {
          const textBody = await readCappedText(response);
          if (textBody.tooLarge) {
            return {
              kind: 'tooLarge', status: response.status, finalUrl, contentType, bytes: textBody.bytes
            };
          }
          return {
            kind: 'text',
            status: response.status,
            finalUrl,
            contentType,
            text: textBody.text
          };
        }
        return { kind: 'nonHtml', status: response.status, finalUrl, contentType };
      }

      const body = await readCappedText(response);
      if (body.tooLarge) {
        return { kind: 'tooLarge', status: response.status, finalUrl, contentType, bytes: body.bytes };
      }
      const html = body.text;

      // The server did not say what it sent, so the bytes decide. Nothing is
      // fed to a parser on the strength of a guess.
      if (!contentType && !looksLikeHtml(html)) {
        return { kind: 'nonHtml', status: response.status, finalUrl, contentType: '' };
      }

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

    // Before anything else, and for both paths: a non-public destination is not
    // captured at all. A tab would perform the same GET, with the user's
    // session attached, so this is a rejection rather than an escalation.
    const blocked = privateDestinationReason(url);
    if (blocked) {
      return { decision: 'reject', reason: blocked, category: 'unusable' };
    }

    // The Reddit and X extractors read a live page (Reddit's JSON is fetched
    // same-origin with the user's session; X's timeline is virtualised), so a
    // fetched copy of the HTML would silently drop the discussion. Say so and
    // open a tab rather than return a post without its comments.
    if (config.redditMode !== false && /(^|\.)reddit\.com$/.test(host)) {
      return {
        decision: 'render',
        reason: "Reddit's comment tree needs the page's own session, so a tab was opened",
        category: null
      };
    }
    // The same host test x.js uses, so every URL its extractor would claim on a
    // live page escalates here: www.x.com, mobile.twitter.com and the bare
    // hosts all serve the same posts, and a fetched copy of any of them loses
    // the thread.
    if (config.xMode !== false && /(^|\.)(x\.com|twitter\.com)$/.test(host)) {
      return {
        decision: 'render',
        reason: 'X timelines are virtualised, so a tab was opened',
        category: null
      };
    }
    return null;
  }

  // Rules a–d: everything decidable from the response alone.
  //
  // Every verdict carries three things now: the `decision` the caller acts on,
  // the verbatim `reason`, and a `category` saying what kind of failure it was.
  // The category is what the ladder above reads: 'transient' earns the delayed
  // retry, 'wall' and 'unusable' never do.
  //
  // `context` is what this source has already been through:
  //   { seenStatuses: [403], attempt: 2 }
  function classifyResponse(result, requestedUrl, context) {
    const history = context || {};
    const seen = history.seenStatuses || [];

    if (!result) {
      return { decision: 'reject', reason: 'No response', category: 'unusable' };
    }

    if (result.kind === 'networkError') {
      // A blip, a reset, a DNS hiccup or the 10 s timeout. This is exactly the
      // failure a second attempt is for.
      return { decision: 'reject', reason: result.message, category: 'transient' };
    }

    if (result.kind === 'blocked') {
      return { decision: 'reject', reason: result.reason, category: 'unusable' };
    }

    if (result.kind === 'tooLarge') {
      return { decision: 'reject', reason: tooLargeMessage(result.bytes), category: 'unusable' };
    }

    if (result.kind === 'nonHtml') {
      if (result.contentType === 'application/pdf') {
        return { decision: 'reject', reason: PDF_MESSAGE, category: 'unusable' };
      }
      if (!result.contentType) {
        return {
          decision: 'reject',
          reason: 'Server did not say what it sent, and it does not open like a web page',
          category: 'unusable'
        };
      }
      return {
        decision: 'reject',
        reason: `Not a web page: ${result.contentType}`,
        category: 'unusable'
      };
    }

    if (result.kind === 'text') {
      if (DEAD_STATUSES.includes(result.status)) {
        return { decision: 'reject', reason: deadStatusMessage(result.status), category: 'unusable' };
      }
      if (result.status < 200 || result.status > 299) {
        return {
          decision: 'render',
          reason: `Server answered ${result.status}, so a tab was opened`,
          category: 'transient'
        };
      }
      return { decision: 'use', reason: null, category: null };
    }

    // An active bot challenge is a wall on any status: the interstitial is the
    // whole body, the run has nothing to capture from it, and the same request
    // a second later answers the same way.
    const challenge = botChallengeReason(result.html, result.status);
    if (challenge) {
      return { decision: 'reject', reason: challenge, category: 'wall' };
    }

    if (result.kind === 'httpError') {
      if (DEAD_STATUSES.includes(result.status)) {
        return { decision: 'reject', reason: deadStatusMessage(result.status), category: 'unusable' };
      }
      // A credential check answers a credential-less fetch the same way every
      // time. The first one still escalates — the user's own tab carries the
      // session this fetch deliberately does not — but once the same status has
      // come back twice, asking a third time is only spending the budget.
      if (REPEATED_BLOCK_STATUSES.includes(result.status) && seen.includes(result.status)) {
        return { decision: 'reject', reason: repeatedBlockMessage(result.status), category: 'wall' };
      }
      return {
        decision: 'render',
        reason: `Server answered ${result.status}, so a tab was opened`,
        category: 'transient'
      };
    }

    // A wall is a wall whether or not the host changed: /article redirecting to
    // /subscribe on the same site is the same event as a hop to an SSO domain,
    // and that page is usually well over the character floor, so no other rule
    // would catch it. The host half of the pattern is still tested against the
    // host, the path half against the path.
    const requestedHost = hostOf(requestedUrl);
    const finalHost = hostOf(result.finalUrl);
    if (result.finalUrl && requestedUrl && result.finalUrl !== requestedUrl && finalHost) {
      let path = '';
      try {
        const finalParsed = new URL(result.finalUrl);
        path = finalParsed.pathname + finalParsed.search;
      } catch (e) {
        path = '';
      }
      const hostChanged = requestedHost && requestedHost !== finalHost;
      if ((hostChanged && WALL_PATTERN.test(finalHost)) || WALL_PATTERN.test(path)) {
        const where = hostChanged ? finalHost : `${finalHost}${path}`;
        return {
          decision: 'render',
          reason: `Redirected to ${where}, so a tab was opened`,
          category: 'wall'
        };
      }
    }

    return { decision: 'use', reason: null, category: null };
  }

  // Rules e–f: what only the parsed document can answer.
  // `extraction` is what convert-core's convertHtml returns, or
  // { failed: true, error } when the parse threw.
  //
  // `context` carries the response the extraction came from —
  // { html, status, attempt } — because a page with nothing in it is a
  // different event depending on what the HTML around the nothing says.
  function classifyExtraction(extraction, context) {
    const history = context || {};
    const html = history.html || '';

    if (!extraction || extraction.failed) {
      const detail = (extraction && extraction.error) || 'unknown error';
      // A challenge page has no article for Readability to find, so the parse
      // failing is often the *first* thing that happens to it. Name the wall
      // rather than the parser.
      const challenge = botChallengeReason(html, history.status);
      if (challenge) {
        return { decision: 'reject', reason: challenge, category: 'wall' };
      }
      return {
        decision: 'render',
        reason: `Server-rendered HTML could not be converted (${detail}), so a tab was opened`,
        category: 'transient'
      };
    }

    if (extraction.emptyAppShell && extraction.bodyTextLength < MIN_BODY_TEXT_CHARS) {
      return {
        decision: 'render',
        reason: 'Page is rendered by JavaScript, so a tab was opened',
        category: 'transient'
      };
    }

    const textLength = extraction.textLength || 0;
    if (textLength < MIN_TEXT_CHARS) {
      // A subscription gate is not opened by a rendering engine: the tab shows
      // the same offer page, and the run files the offer as the article. It is
      // a wall on the first sight of it.
      if (PAYWALL_MARKERS.test(html)) {
        return {
          decision: 'reject',
          reason: 'Hard paywall: the page offered a subscription instead of the article',
          category: 'wall'
        };
      }
      // A login or consent gate *can* open in the user's own tab, which is
      // why the first one still escalates. Once the tab has been spent and the
      // page came back the same way, it is a wall and gets no retry.
      if (LOGIN_WALL_MARKERS.test(html)) {
        return (history.attempt || 1) > 1
          ? {
            decision: 'reject',
            reason: 'Login or consent wall: the page yielded no article, in a tab either',
            category: 'wall'
          }
          : {
            decision: 'render',
            reason: 'Page asked for a login or a consent choice, so a tab was opened',
            category: 'wall'
          };
      }
      return {
        decision: 'render',
        reason: `Server-rendered text was only ${textLength} characters, so a tab was opened`,
        category: 'transient'
      };
    }

    return { decision: 'use', reason: null, category: null };
  }

  return {
    FETCH_TIMEOUT_MS,
    MIN_TEXT_CHARS,
    MIN_BODY_TEXT_CHARS,
    MAX_BYTES,
    PDF_MESSAGE,
    DEAD_STATUSES,
    REPEATED_BLOCK_STATUSES,
    botChallengeReason,
    privateDestinationReason,
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
