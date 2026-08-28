// ScrapLLM Research Engine
// Owns a research run end to end: drives ScrapLLMSearch for discovery, captures
// every accepted source, merges everything into one document, and reports
// progress over the `scrapllm-research` port.
//
// A source is captured on one of two paths:
//
//   quiet    — the HTML is fetched from the background and converted with the
//              same Readability + Turndown code the content script runs. No tab
//              exists at any point. This is the default because it is also the
//              better capture on most pages: post-hydration UI chrome is not
//              there to pollute the article.
//   rendered — the source is opened in a muted background tab and the content
//              script is asked for Markdown, exactly as before. This is what a
//              page gets when the fetched HTML cannot answer for it: a bot
//              check, a redirect to a consent wall, an empty app shell, or an
//              extraction too thin to be the real page.
//
// The escalation is per source: one page needing a tab does not put the others
// in one, and every escalation carries the reason it happened into the popup
// row and into the document.
//
// Background context only. Depends on ScrapLLMSearch, ScrapLLMQuietCapture and
// MultiTabUtils, all resolved at init() time rather than at evaluation time.

var ScrapLLMResearch = typeof ScrapLLMResearch !== 'undefined' ? ScrapLLMResearch : (function() {
  const RESEARCH_CONCURRENCY = 3;
  const PING_INTERVAL_MS = 250;
  const PAGE_LOAD_TIMEOUT_MS = 20000;
  const SETTLE_DELAY_MS = 400;
  const CONVERT_TIMEOUT_MS = 30000;
  const PARSE_TIMEOUT_MS = 5000;
  const TOTAL_BUDGET_MS = 240000;
  const PROGRESS_THROTTLE_MS = 250;
  const RESULT_RETENTION_MS = 600000;
  const MAX_PERSIST_BYTES = 5242880;
  const STATE_KEY = 'scrapllm.researchRun';
  const QUERY_SLUG_MAX = 40;

  const MIN_SOURCES = 5;
  const MAX_SOURCES = 12;

  const OFFSCREEN_URL = 'offscreen.html';
  const OFFSCREEN_TARGET = 'scrapllm-offscreen';
  const OFFSCREEN_REASON = 'DOM_PARSER';
  const OFFSCREEN_JUSTIFICATION =
    'Parse fetched research pages into Markdown without opening a tab';

  // Above the 500-character floor that decides "this is not the page at all",
  // but still short enough that the reader deserves to be told the fetched HTML
  // may not be the whole story.
  const QUIET_THIN_CHARS = 1500;

  const LAZY_LOAD_NOTE =
    'Scroll pass skipped: background tabs are not rendered, so lazy-loaded sections cannot be triggered';
  const X_NOTE =
    'X timelines are virtualised; a background tab captures only the server-rendered portion';
  const QUIET_NOTE =
    'Captured from the server-rendered HTML; no tab was opened';
  const NO_HOST_ACCESS_NOTE =
    'Without site access, every source is opened in a background tab';
  const CANCELLED_MESSAGE = 'Cancelled by user';
  const BUDGET_MESSAGE = 'Skipped: the run exceeded the 4-minute budget';

  // The ladder, and its budget. A source gets one full pass (quiet fetch, then
  // a tab if the fetch cannot answer for the page) and, when that pass failed
  // for a reason a second attempt could plausibly fix, exactly one more pass a
  // few seconds later. Two passes, never more: persistence is for a blip, and
  // the run's own 4-minute budget belongs to every other source as much as to
  // this one.
  const MAX_ATTEMPTS_PER_SOURCE = 2;
  // Jittered so three workers that all met the same rate limiter do not come
  // back at the same instant and meet it again together.
  const RETRY_BASE_DELAY_MS = 3000;
  const RETRY_JITTER_MS = 2000;
  // A retry that cannot finish is worse than no retry: it spends the delay and
  // then reports the budget instead of the failure the user needed to read.
  const RETRY_MIN_REMAINING_MS = 40000;
  // A replacement is a whole capture, so it needs more room than a retry.
  const REPLACEMENT_MIN_REMAINING_MS = 45000;

  let api = null;
  let store = null;
  let storeAnnounced = false;

  const listeners = new Set();

  // The live run, or null when idle. Everything the popup can see is derived
  // from this object plus `lastDocument`.
  let state = null;
  let lastDocument = null;   // { runId, filename, markdown, tokenCount, expiresAt }
  let lastSnapshot = idleSnapshot();
  // Orphan recovery is asynchronous and runs at module evaluation. `start()`
  // waits on it, so a run created while it was mid-await can no longer have its
  // own record read, cleared and reported as interrupted.
  let recoveryPromise = null;

  let throttleTimer = null;
  let throttlePending = false;

  // --------------------------------------------------------------------------
  // Small helpers
  // --------------------------------------------------------------------------

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function clampSourceCount(count) {
    const value = Math.round(Number(count));
    if (!Number.isFinite(value)) return 8;
    return Math.min(MAX_SOURCES, Math.max(MIN_SOURCES, value));
  }

  function formatTokenNote(tokenCount) {
    if (!tokenCount) return '0 tok';
    if (tokenCount < 1000) return `${tokenCount} tok`;
    return `${(tokenCount / 1000).toFixed(1)}k tok`;
  }

  function idleSnapshot() {
    return {
      runId: null,
      phase: 'idle',
      query: '',
      engine: null,
      degraded: null,
      captureNote: null,
      total: 0,
      completed: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      startedAt: 0,
      deadline: 0,
      tokenCount: 0,
      filename: null,
      quiet: 0,
      rendered: 0,
      dropped: 0,
      replacements: 0,
      reservesLeft: 0,
      resultsTooLargeToPersist: false,
      error: null,
      entries: [],
      rejected: []
    };
  }

  // --------------------------------------------------------------------------
  // Progress broadcasting
  // --------------------------------------------------------------------------

  function buildSnapshot() {
    if (!state) return lastSnapshot;

    const entries = state.entries;
    const succeeded = entries.filter(e => e.status === 'ok').length;
    const failed = entries.filter(e => e.status === 'error').length;
    const skipped = entries.filter(e => e.status === 'skipped').length;

    return {
      runId: state.runId,
      phase: state.phase,
      query: state.query,
      engine: state.engine,
      degraded: state.degraded,
      captureNote: state.captureNote || null,
      total: entries.length,
      completed: succeeded + failed + skipped,
      succeeded,
      failed,
      skipped,
      startedAt: state.startedAt,
      deadline: state.deadline,
      tokenCount: entries.reduce((sum, e) => sum + (e.tokenCount || 0), 0),
      filename: state.filename,
      // Successes only, because that is what the popup's sentence and the
      // document's front matter both break down: a source that failed was
      // captured on neither path, and counting it made "4 of 6 sources
      // (3 without a tab, 3 rendered in one)" add up to the wrong number.
      quiet: entries.filter(e => e.status === 'ok' && e.path === 'quiet').length,
      rendered: entries.filter(e => e.status === 'ok' && e.path === 'rendered').length,
      // Dropped by the quality gate rather than by a failure to fetch, and how
      // many candidates are still in reserve behind them.
      dropped: entries.filter(e => e.category === 'junk' || e.category === 'duplicate').length,
      replacements: entries.filter(e => e.replacement).length,
      reservesLeft: state.reserves ? state.reserves.length : 0,
      resultsTooLargeToPersist: state.resultsTooLargeToPersist,
      error: state.error,
      entries: entries.map(e => ({
        url: e.url,
        host: e.host,
        title: e.title,
        status: e.status,
        note: e.note,
        tokenCount: e.tokenCount || 0,
        notes: e.notes || [],
        // How this source was captured, and why it was not captured quietly.
        // The popup shows both; nothing about the path is inferred there.
        path: e.path || null,
        pathReason: e.pathReason || null,
        // A kept-but-thin quiet capture. The row says so too, so a 600
        // character page cannot read like a whole article in the sheet.
        thinNote: e.thinNote || null,
        // What kind of failure this was ('transient', 'wall', 'unusable',
        // 'junk', 'duplicate'), how many passes it took, and whether this row
        // is itself a replacement pulled in for a dropped source. The popup
        // shows the reason verbatim either way; the category is what lets it
        // group "blocked" apart from "failed".
        category: e.category || null,
        attempts: e.attempts || 0,
        replacement: Boolean(e.replacement)
      })),
      rejected: state.rejected
    };
  }

  function emit(snapshot) {
    lastSnapshot = snapshot;
    listeners.forEach(listener => {
      try {
        listener(snapshot);
      } catch (error) {
        console.error('Research progress listener failed:', error);
      }
    });
  }

  // Throttled during a run; `flush` is used on every phase change and at the
  // end so the popup never misses a terminal state.
  function broadcast(flush) {
    if (flush) {
      if (throttleTimer) {
        clearTimeout(throttleTimer);
        throttleTimer = null;
      }
      throttlePending = false;
      emit(buildSnapshot());
      return;
    }

    if (throttleTimer) {
      throttlePending = true;
      return;
    }

    emit(buildSnapshot());
    throttleTimer = setTimeout(() => {
      throttleTimer = null;
      if (throttlePending) {
        throttlePending = false;
        broadcast(false);
      }
    }, PROGRESS_THROTTLE_MS);
  }

  // --------------------------------------------------------------------------
  // Persistence
  // --------------------------------------------------------------------------

  let memoryStore = null; // stand-in when storage.session is unavailable

  function announceStore() {
    if (storeAnnounced) return;
    storeAnnounced = true;
    console.info(
      store
        ? 'ScrapLLM research: using storage.session for run state.'
        : 'ScrapLLM research: storage.session unavailable, keeping run state in memory only.'
    );
  }

  async function readPersisted() {
    if (!store) return memoryStore;
    try {
      const data = await store.get(STATE_KEY);
      return (data && data[STATE_KEY]) || null;
    } catch (error) {
      console.error('Research state read failed:', error);
      return null;
    }
  }

  // Throws on failure. A write that only logs and returns lets the popup show a
  // finished run whose document is in no store at all — the worker then
  // restarts and the file is gone with nothing having said so.
  async function writePersisted(value) {
    if (!store) {
      memoryStore = value;
      return;
    }
    await store.set({ [STATE_KEY]: value });
  }

  async function clearPersisted() {
    memoryStore = null;
    if (!store) return;
    try {
      await store.remove(STATE_KEY);
    } catch (error) {
      console.error('Research state clear failed:', error);
    }
  }

  // Always takes the run it is persisting. It used to read the module-level
  // `state`, which is only the *current* run: a worker still finishing an
  // earlier run would have written that run's tabs into the new run's record,
  // and orphan recovery would then never close them.
  //
  // It is also one write at a time, and its payload is built *after* the read
  // that precedes it: two workers opening a tab each used to snapshot
  // `openTabIds`, interleave over the await and land the older set last, which
  // left a tab orphan recovery could never find.
  let persistChain = Promise.resolve();

  function persistState(run, extra) {
    if (!run) return Promise.resolve(true);
    const next = persistChain.then(() => persistOnce(run, extra));
    persistChain = next.then(() => {}, () => {});
    return next;
  }

  // Resolves true when the state is in the store, false when the store refused
  // it. Never rejects: persistence is bookkeeping, and a run that produced a
  // document must not be turned into an error by a storage quota.
  async function persistOnce(run, extra) {
    const previous = await readPersisted();
    const payload = buildPersistPayload(run);

    // An absent `document` key means "carry whatever is there forward"; an
    // explicit `document: null` means "this run has no document to keep". They
    // used to be the same value, so dropping an over-sized document wrote the
    // *previous* run's document back under this run's id, and a recovered run
    // then showed the earlier run's filename.
    const explicitDocument = extra && Object.prototype.hasOwnProperty.call(extra, 'document');
    Object.assign(payload, extra || {});
    if (!explicitDocument && previous && previous.document &&
        previous.document.runId === run.runId) {
      payload.document = previous.document;
    }

    try {
      await writePersisted(payload);
      return true;
    } catch (error) {
      console.error('Research state write failed:', error);
      return false;
    }
  }

  function buildPersistPayload(run) {
    return {
      runId: run.runId,
      phase: run.phase,
      query: run.query,
      openTabIds: Array.from(run.openTabIds),
      entries: run.entries.map(e => ({
        url: e.url,
        host: e.host,
        title: e.title,
        status: e.status,
        note: e.note,
        tokenCount: e.tokenCount || 0,
        notes: e.notes || [],
        path: e.path || null,
        pathReason: e.pathReason || null,
        thinNote: e.thinNote || null,
        // Carried too, so a recovered run's rows read the way they read before
        // the worker died: a wall is still a skip, not an error.
        category: e.category || null,
        attempts: e.attempts || 0,
        replacement: Boolean(e.replacement)
      })),
      expiresAt: run.expiresAt,
      resultsTooLargeToPersist: run.resultsTooLargeToPersist
    };
  }

  // --------------------------------------------------------------------------
  // The parsing host
  // --------------------------------------------------------------------------
  //
  // Firefox MV2 runs the background in a real hidden page, so DOMParser,
  // Readability and Turndown are all right here. A Chrome MV3 service worker
  // has none of them, so the same conversion runs in an offscreen document —
  // one for the whole run, created on the first quiet capture and closed when
  // the run ends. The branch is on capability, never on a browser name.

  let offscreenPromise = null;

  function canParseLocally() {
    return typeof DOMParser !== 'undefined' && typeof ScrapLLMConvert !== 'undefined';
  }

  function hasOffscreenApi() {
    return !!(api && api.offscreen && typeof api.offscreen.createDocument === 'function');
  }

  async function offscreenExists() {
    if (!api.runtime || typeof api.runtime.getContexts !== 'function') return false;
    try {
      const contexts = await api.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
      return Array.isArray(contexts) && contexts.length > 0;
    } catch (error) {
      // getContexts is Chrome 116+. Older Chrome falls through to createDocument
      // and recovers from its "only a single offscreen document" rejection.
      return false;
    }
  }

  // Single-flight: three concurrent sources hit this at once, and an extension
  // may only ever have one offscreen document open.
  function ensureOffscreen() {
    if (!offscreenPromise) {
      offscreenPromise = (async () => {
        if (await offscreenExists()) return;
        try {
          await api.offscreen.createDocument({
            url: OFFSCREEN_URL,
            reasons: [OFFSCREEN_REASON],
            justification: OFFSCREEN_JUSTIFICATION
          });
        } catch (error) {
          const message = (error && error.message) || String(error);
          // Another caller won the race, or a previous run left one behind.
          if (!/single offscreen document|already exists/i.test(message)) {
            offscreenPromise = null;
            throw new Error('Could not open the offscreen parser: ' + message);
          }
        }
      })();
    }
    return offscreenPromise;
  }

  async function closeOffscreen() {
    offscreenPromise = null;
    if (!hasOffscreenApi() || typeof api.offscreen.closeDocument !== 'function') return;
    try {
      await api.offscreen.closeDocument();
    } catch (error) {
      const message = (error && error.message) || String(error);
      if (!/no.*offscreen document/i.test(message)) {
        console.warn('Could not close the offscreen parser:', message);
      }
    }
  }

  // One parse at a time. The offscreen document is a single JS thread and its
  // convertHtml is synchronous, so three workers sending at once do not parse
  // in parallel — they queue inside it, and the last one's 5 s budget is spent
  // waiting for the first two. Serialising the dispatch here means the budget
  // measures the parse rather than the queue.
  let parseChain = Promise.resolve();

  // Resolves with { success, result } or { success: false, error }. Never
  // rejects: a parse failure is an escalation signal, not a run failure.
  async function convertFetchedHtml(payload) {
    if (canParseLocally()) {
      try {
        return { success: true, result: ScrapLLMConvert.convertHtml(payload) };
      } catch (error) {
        return { success: false, error: (error && error.message) || String(error) };
      }
    }

    if (!hasOffscreenApi()) {
      return {
        success: false,
        error: 'this browser exposes neither DOMParser nor an offscreen document'
      };
    }

    // Opening the parser is not parsing: the first capture of a run also loads
    // readability.js, turndown.js and convert-core.js into a document that does
    // not exist yet, and charging that to the page's parse budget failed a page
    // that had parsed perfectly. It has the run's own budget instead.
    try {
      await ensureOffscreen();
    } catch (error) {
      return { success: false, error: (error && error.message) || String(error) };
    }

    return dispatchParse(payload);
  }

  // Never rejects, for the same reason convertFetchedHtml does not.
  async function sendToParser(payload) {
    try {
      const response = await api.runtime.sendMessage({
        target: OFFSCREEN_TARGET,
        action: 'convertHtml',
        html: payload.html,
        url: payload.url,
        title: payload.title,
        settings: payload.settings
      });
      if (!response) return { success: false, error: 'the parser did not answer' };
      if (!response.success) return { success: false, error: response.error || 'the parser failed' };
      return { success: true, result: response.result };
    } catch (error) {
      return { success: false, error: (error && error.message) || String(error) };
    }
  }

  function dispatchParse(payload) {
    const send = parseChain.then(() => sendToParser(payload));
    // The next parse waits for the send itself, never for the timeout: a parse
    // this side has given up on still holds the offscreen thread, and starting
    // the next one's clock while that is true would fail it for a reason that
    // is not about it.
    parseChain = send.then(() => {}, () => {});

    let timeoutId = null;
    const timeout = new Promise(resolve => {
      timeoutId = setTimeout(
        () => resolve({ success: false, error: 'the parser did not answer within 5 s' }),
        PARSE_TIMEOUT_MS
      );
    });

    return Promise.race([send, timeout]).then(outcome => {
      if (timeoutId !== null) clearTimeout(timeoutId);
      return outcome;
    });
  }

  // A token count from the one shared estimator in convert-core, wherever that
  // code happens to live in this browser. text/plain and text/markdown sources
  // skip the converter entirely, and a second formula here would put a number
  // in the front matter that does not match the sources it sums.
  async function estimateTokensFor(markdown) {
    if (!markdown) return 0;
    if (canParseLocally()) return ScrapLLMConvert.estimateTokens(markdown);
    if (!hasOffscreenApi()) {
      throw new Error('this browser exposes neither DOMParser nor an offscreen document');
    }
    await ensureOffscreen();
    const response = await api.runtime.sendMessage({
      target: OFFSCREEN_TARGET,
      action: 'estimateTokens',
      markdown
    });
    if (!response || !response.success) {
      throw new Error((response && response.error) || 'the parser did not answer');
    }
    return response.tokenCount;
  }

  // --------------------------------------------------------------------------
  // Tab plumbing
  // --------------------------------------------------------------------------

  async function createTab(url, windowId) {
    const props = { url, active: false };
    if (windowId !== undefined && windowId !== null) props.windowId = windowId;

    try {
      return await api.tabs.create(props);
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      // A window closed between discovery and fetch: retry in whatever window
      // the browser picks rather than failing the source.
      if (/no such window|invalid window/i.test(message) && props.windowId !== undefined) {
        try {
          return await api.tabs.create({ url, active: false });
        } catch (retryError) {
          throw new Error('Could not open a tab for this URL: ' +
            (retryError.message || String(retryError)));
        }
      }
      throw new Error('Could not open a tab for this URL: ' + message);
    }
  }

  async function removeTab(tabId) {
    try {
      await api.tabs.remove(tabId);
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      if (!/no tab with id/i.test(message)) {
        console.warn('Could not close research tab', tabId, message);
      }
    }
  }

  // Wait for the declaratively injected content script to answer. The load
  // event is deliberately not used: a script-heavy page can answer a ping long
  // before `complete`, and a stalled subresource can hold `complete` forever.
  // The run is passed in rather than read from the module: a tab belonging to
  // an earlier run must watch *that* run's cancelled flag, not the flag of
  // whichever run happens to be current.
  async function waitForScriptable(run, tabId, url, deadlineAt) {
    const pageLimit = Date.now() + PAGE_LOAD_TIMEOUT_MS;
    const limit = Math.min(pageLimit, deadlineAt);

    while (Date.now() < limit) {
      if (run && run.cancelled) throw new Error(CANCELLED_MESSAGE);

      try {
        const response = await api.tabs.sendMessage(tabId, { action: 'ping' });
        if (response && response.success) return;
      } catch (e) {
        // Not scriptable yet, or the tab is gone — the tabs.get below tells
        // those two apart.
      }

      try {
        await api.tabs.get(tabId);
      } catch (e) {
        throw new Error('Tab was closed before conversion could start');
      }

      await sleep(PING_INTERVAL_MS);
    }

    // Which limit ran out decides what happened. When the run's own budget is
    // what stopped the wait, the page was never given its 20 s, and calling it
    // a page that would not load is a sentence the run cannot stand behind.
    if (deadlineAt < pageLimit) throw new Error(BUDGET_MESSAGE);

    let message = 'Page did not become scriptable within 20 s';
    try {
      if (/\.pdf$/i.test(new URL(url).pathname)) {
        message += " — PDFs open in the browser's viewer, where extensions cannot run";
      }
    } catch (e) {
      // Unparsable URL: the generic message stands.
    }
    throw new Error(message);
  }

  // --------------------------------------------------------------------------
  // Per-source pipeline
  // --------------------------------------------------------------------------

  function notesForSource(source) {
    const notes = [LAZY_LOAD_NOTE];
    // Same host test as x.js and the quiet preflight: mobile.twitter.com is an
    // X timeline too, and the note about virtualisation applies to it as well.
    if (/(^|\.)(x\.com|twitter\.com)$/.test(source.host || '')) {
      notes.push(X_NOTE);
    }
    return notes;
  }

  function markEntry(entry, status, note) {
    entry.status = status;
    entry.note = note;
  }

  function skipResult(source, message, category) {
    return {
      success: false,
      tab: { id: null, url: source.url, title: source.url },
      error: message,
      category: category || null,
      notes: []
    };
  }

  // --------------------------------------------------------------------------
  // The quiet path
  // --------------------------------------------------------------------------

  // Resolves with:
  //   { outcome: 'captured', result }  the source is done, no tab was involved
  //   { outcome: 'rejected', message } no tab could help either — fail loudly
  //   { outcome: 'render', reason }    hand this source to the tab path
  async function captureQuietly(source, entry, run, history) {
    const attempts = history || { seenStatuses: [], attempt: 1 };
    const preflight = ScrapLLMQuietCapture.preflight(source.url, run.remoteSettings);
    if (preflight) {
      // Preflight can also refuse outright — a private address is not a page a
      // tab could capture any more safely than a fetch could.
      return preflight.decision === 'reject'
        ? { outcome: 'rejected', message: preflight.reason, category: preflight.category || 'unusable' }
        : { outcome: 'render', reason: preflight.reason, category: preflight.category || null };
    }

    const response = await ScrapLLMQuietCapture.fetchSource(source.url, {
      signal: run.controller.signal
    });
    if (run.cancelled) {
      return { outcome: 'rejected', message: CANCELLED_MESSAGE, category: 'cancelled' };
    }
    // Classified against what came *before* this response: the ladder's whole
    // point is that the first 401/403/429 escalates to a tab (the user's own
    // session may walk straight through it) and only a repeat is a wall. If the
    // current status were recorded first, every first block would look like a
    // repeat of itself.
    const verdict = ScrapLLMQuietCapture.classifyResponse(response, source.url, attempts);

    // Now it is history: the next attempt on this source sees it.
    if (response && Number.isFinite(response.status)) {
      attempts.seenStatuses.push(response.status);
    }

    if (verdict.decision === 'render') {
      return { outcome: 'render', reason: verdict.reason, category: verdict.category };
    }
    if (verdict.decision === 'reject') {
      return { outcome: 'rejected', message: verdict.reason, category: verdict.category };
    }

    const finalUrl = response.finalUrl || source.url;
    let markdown;
    let title = source.title;
    let tokenCount = 0;
    let textLength = 0;

    if (response.kind === 'text') {
      // text/plain and text/markdown are already the document. Readability has
      // nothing to add and would only throw the body away.
      markdown = response.text;
      textLength = response.text.trim().length;
      // The same estimator every other capture uses, so one plaintext source
      // cannot make the document's own token total disagree with itself.
      tokenCount = await estimateTokensFor(markdown);
      if (textLength < ScrapLLMQuietCapture.MIN_TEXT_CHARS) {
        return {
          outcome: 'render',
          reason: `Server-rendered text was only ${textLength} characters, so a tab was opened`,
          category: 'transient'
        };
      }
    } else {
      const converted = await convertFetchedHtml({
        html: response.html,
        url: finalUrl,
        title: source.title,
        settings: run.remoteSettings
      });
      const extraction = converted.success
        ? converted.result
        : { failed: true, error: converted.error };

      const check = ScrapLLMQuietCapture.classifyExtraction(extraction, {
        html: response.html,
        status: response.status,
        attempt: attempts.attempt || 1
      });
      if (check.decision === 'render') {
        return { outcome: 'render', reason: check.reason, category: check.category };
      }
      if (check.decision === 'reject') {
        return { outcome: 'rejected', message: check.reason, category: check.category };
      }

      markdown = extraction.markdown;
      title = extraction.title || source.title;
      tokenCount = extraction.tokenCount || 0;
      textLength = extraction.textLength || 0;
    }

    const notes = [QUIET_NOTE];
    // Requirement of rule 3: a thin capture is never passed off as a whole
    // page. It is above the floor, so it is kept — and it says how thin it is,
    // in the document *and* on the row, because the sheet is what the user
    // reads before deciding the run went fine.
    let thinNote = null;
    if (textLength < QUIET_THIN_CHARS) {
      thinNote =
        `Only ${textLength} characters of article text were in the server-rendered HTML, ` +
        'so this page may carry more content behind JavaScript';
      notes.push(thinNote);
    }

    entry.title = title;
    entry.tokenCount = tokenCount;
    entry.notes = notes;
    entry.path = 'quiet';
    entry.pathReason = null;
    entry.thinNote = thinNote;
    markEntry(
      entry,
      'ok',
      `${formatTokenNote(tokenCount)} · quiet${thinNote ? ' · thin' : ''}`
    );
    broadcast(false);

    return {
      outcome: 'captured',
      result: {
        success: true,
        tab: { id: null, url: finalUrl, title },
        fetchedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
        markdown,
        tokenCount,
        notes,
        path: 'quiet',
        pathReason: null,
        source: {
          host: source.host,
          snippet: source.snippet,
          engineRank: source.engineRank
        }
      }
    };
  }

  // --------------------------------------------------------------------------
  // The rendered path (unchanged: one muted background tab, per source)
  // --------------------------------------------------------------------------

  async function captureInTab(source, entry, run, escalationReason) {
    let tab = null;
    try {
      // Checked again here, not only at the top of fetchOne: a source can wait
      // in the pool for minutes, and a tab opened past the deadline is a window
      // the user watches appear for a capture the run has no time to finish.
      if (Date.now() > run.deadline) throw new Error(BUDGET_MESSAGE);

      tab = await createTab(source.url, run.windowId);

      run.openTabIds.add(tab.id);
      await persistState(run);

      try {
        await api.tabs.update(tab.id, { muted: true });
      } catch (error) {
        console.warn('Could not mute research tab', tab.id, error && error.message);
      }

      await waitForScriptable(run, tab.id, source.url, run.deadline);
      await sleep(SETTLE_DELAY_MS);

      let timeoutId = null;
      const conversion = await Promise.race([
        MultiTabUtils.convertTabToMarkdown(tab.id, run.remoteSettings, api),
        new Promise(resolve => {
          timeoutId = setTimeout(
            () => resolve({ success: false, error: 'Conversion did not answer within 30 s' }),
            CONVERT_TIMEOUT_MS
          );
        })
      ]);
      if (timeoutId !== null) clearTimeout(timeoutId);

      if (!conversion.success) {
        throw new Error(conversion.error || 'Conversion failed');
      }

      let finalUrl = source.url;
      let finalTitle = source.title;
      try {
        const info = await api.tabs.get(tab.id);
        if (info) {
          finalUrl = info.url || finalUrl;
          finalTitle = info.title || finalTitle;
        }
      } catch (e) {
        // Best effort only: the search result's own title and URL stand in.
      }

      const notes = notesForSource(source);
      if (escalationReason) notes.unshift(escalationReason);

      entry.title = finalTitle;
      entry.tokenCount = conversion.tokenCount || 0;
      entry.notes = notes;
      markEntry(entry, 'ok', `${formatTokenNote(conversion.tokenCount || 0)} · tab`);
      broadcast(false);

      return {
        success: true,
        tab: { id: tab.id, url: finalUrl, title: finalTitle },
        fetchedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
        markdown: conversion.markdown,
        tokenCount: conversion.tokenCount || 0,
        notes,
        path: 'rendered',
        pathReason: escalationReason || null,
        source: {
          host: source.host,
          snippet: source.snippet,
          engineRank: source.engineRank
        }
      };
    } catch (error) {
      const message = (error && error.message) || String(error);
      const cancelled = run.cancelled || message === CANCELLED_MESSAGE;
      // The run running out of time is not a failure of this page, and there is
      // nothing inside it to retry either.
      const outOfBudget = !cancelled && message === BUDGET_MESSAGE;
      // Both halves of the story: why the quiet path gave up, and why the tab
      // it escalated to failed as well.
      const reason = cancelled
        ? CANCELLED_MESSAGE
        : (escalationReason && !outOfBudget ? `${escalationReason}, and then: ${message}` : message);

      // A tab that timed out, was closed under us or never answered is the
      // transient half of the ladder: this is exactly the failure a second
      // pass a few seconds later can come back from.
      entry.category = cancelled ? 'cancelled' : (outOfBudget ? 'budget' : 'transient');
      markEntry(entry, (cancelled || outOfBudget) ? 'skipped' : 'error', reason);
      broadcast(false);

      return {
        success: false,
        tab: { id: tab ? tab.id : null, url: source.url, title: source.title || source.url },
        error: reason,
        path: 'rendered',
        pathReason: escalationReason || null,
        category: entry.category,
        notes: []
      };
    } finally {
      if (tab) {
        await removeTab(tab.id);
        run.openTabIds.delete(tab.id);
        await persistState(run);
      }
    }
  }

  // --------------------------------------------------------------------------
  // Per-source pipeline
  // --------------------------------------------------------------------------

  // One full pass over one source: the quiet fetch, and the tab it escalates to
  // when the fetched HTML cannot answer for the page. Resolves with the same
  // result shape the pool collects, and never throws.
  async function attemptCapture(source, entry, run, history) {
    let escalationReason = null;

    if (run.strategy === 'quiet') {
      let quiet;
      try {
        quiet = await captureQuietly(source, entry, run, history);
      } catch (error) {
        // The quiet path is not allowed to take a source down with it: an
        // unexpected failure here is an escalation, with its own reason.
        quiet = {
          outcome: 'render',
          category: 'transient',
          reason: 'The quiet capture failed (' +
            ((error && error.message) || String(error)) + '), so a tab was opened'
        };
      }

      if (quiet.outcome === 'captured') return quiet.result;

      if (quiet.outcome === 'rejected') {
        const cancelled = run.cancelled || quiet.message === CANCELLED_MESSAGE;
        entry.path = 'quiet';
        entry.pathReason = null;
        entry.category = cancelled ? 'cancelled' : (quiet.category || 'unusable');
        // A wall was not a failure to capture, it was a refusal to be
        // captured, and the row says so: 'skipped', like the sources the
        // quality gate drops, rather than 'error'.
        const walled = entry.category === 'wall';
        markEntry(entry, (cancelled || walled) ? 'skipped' : 'error', quiet.message);
        broadcast(false);
        return {
          success: false,
          tab: { id: null, url: source.url, title: source.title || source.url },
          error: quiet.message,
          path: 'quiet',
          pathReason: null,
          category: entry.category,
          notes: []
        };
      }

      // Cancellation is checked again here, not only at the top of fetchOne:
      // the quiet capture was awaiting a fetch or a parse while the user
      // pressed Cancel, and an escalation decided in that window would open a
      // tab *because* the run was being torn down.
      if (run.cancelled) {
        markEntry(entry, 'skipped', CANCELLED_MESSAGE);
        entry.path = 'quiet';
        entry.category = 'cancelled';
        broadcast(false);
        return skipResult(source, CANCELLED_MESSAGE, 'cancelled');
      }

      escalationReason = quiet.reason;
      entry.pathReason = escalationReason;
      entry.category = quiet.category || null;
      markEntry(entry, 'fetching', 'Opening a tab');
      broadcast(false);
    }

    entry.path = 'rendered';
    return await captureInTab(source, entry, run, escalationReason);
  }

  // --------------------------------------------------------------------------
  // The ladder
  // --------------------------------------------------------------------------

  // Which failures are worth a second pass. A wall is not one of them, and
  // neither is a body that can never be a web page: those already said what
  // they were, and repeating them spends the run's budget to print the same
  // sentence twice. Everything transient — a reset connection, a 10 s timeout,
  // a 5xx, a page that would not render in the tab in time — earns the retry.
  function retryableCategory(category) {
    return category === 'transient' || category === null || category === undefined;
  }

  function retryDelay() {
    return RETRY_BASE_DELAY_MS + Math.floor(Math.random() * RETRY_JITTER_MS);
  }

  // --------------------------------------------------------------------------
  // The quality gate
  // --------------------------------------------------------------------------

  // A capture that succeeded technically still has to be worth reading. The
  // scorer sees the Markdown the run would hand to the model — the same
  // artefact on both paths — plus the fingerprints of everything already kept,
  // so a syndicated copy of a page already in the document is caught too.
  function applyQualityGate(result, source, entry, run) {
    if (!run.junkFilter || !result || !result.success) return result;
    if (typeof ScrapLLMSourceQuality === 'undefined') return result;

    const verdict = ScrapLLMSourceQuality.assess({
      markdown: result.markdown,
      query: run.query,
      url: result.tab.url || source.url,
      previous: run.accepted
    });

    if (verdict.verdict === 'keep') {
      // Registered only on the way through, so a rejected page cannot become
      // the thing later pages are compared against.
      run.accepted.push({
        host: source.host,
        url: result.tab.url || source.url,
        fingerprint: verdict.fingerprint
      });
      return result;
    }

    entry.category = verdict.category;
    entry.tokenCount = 0;
    entry.notes = [];
    entry.thinNote = null;
    markEntry(entry, 'skipped', verdict.reason);
    broadcast(false);

    return {
      success: false,
      tab: { id: null, url: result.tab.url || source.url, title: result.tab.title || source.title },
      error: verdict.reason,
      path: result.path,
      pathReason: result.pathReason || null,
      category: verdict.category,
      notes: []
    };
  }

  // --------------------------------------------------------------------------
  // Replacement
  // --------------------------------------------------------------------------

  // A dropped source does not shrink the result. Discovery keeps the candidates
  // it ranked but did not need, and one of them is promoted whenever a source
  // ends without a capture — until the pool is empty or there is no longer
  // enough of the run's budget to capture anything with.
  function queueReplacement(run) {
    if (run.cancelled) return null;
    if (!run.reserves || run.reserves.length === 0) return null;
    if (Date.now() > run.deadline - REPLACEMENT_MIN_REMAINING_MS) return null;

    // How many sources could still become a capture: everything queued minus
    // everything that has already ended without one.
    const lost = run.entries.filter(e => e.status === 'error' || e.status === 'skipped').length;
    if (run.entries.length - lost >= run.targetCount) return null;

    const next = run.reserves.shift();
    run.sources.push(next);
    run.entries.push({
      url: next.url,
      host: next.host,
      title: next.title,
      status: 'pending',
      note: 'Queued in place of a dropped source',
      tokenCount: 0,
      notes: [],
      replacement: true
    });
    broadcast(false);
    return next;
  }

  // --------------------------------------------------------------------------
  // Per-source pipeline
  // --------------------------------------------------------------------------

  async function fetchOne(source, index, run) {
    const entry = run.entries[index];

    if (run.cancelled) {
      markEntry(entry, 'skipped', CANCELLED_MESSAGE);
      entry.category = 'cancelled';
      broadcast(false);
      return skipResult(source, CANCELLED_MESSAGE, 'cancelled');
    }

    if (Date.now() > run.deadline) {
      markEntry(entry, 'skipped', BUDGET_MESSAGE);
      entry.category = 'budget';
      broadcast(false);
      return skipResult(source, BUDGET_MESSAGE, 'budget');
    }

    // Both paths, not just the quiet one: a URL naming the user's own machine
    // or LAN is not captured at all, and opening it in a tab would perform the
    // same request with the user's session attached.
    const blocked = ScrapLLMQuietCapture.privateDestinationReason(source.url);
    if (blocked) {
      markEntry(entry, 'error', blocked);
      entry.category = 'unusable';
      broadcast(false);
      queueReplacement(run);
      return {
        success: false,
        tab: { id: null, url: source.url, title: source.title || source.url },
        error: blocked,
        category: 'unusable',
        notes: []
      };
    }

    const history = { seenStatuses: [], attempt: 1 };
    let result = null;
    // The delay the run actually waited, so the sentence the user reads names
    // it rather than the constant it was built from — the wait is jittered, and
    // "3 s" was a number no run ever used.
    let waited = 0;
    let retryWithheld = false;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_SOURCE; attempt++) {
      history.attempt = attempt;
      markEntry(entry, 'fetching', attempt === 1 ? 'Fetching' : 'Fetching again');
      entry.attempts = attempt;
      broadcast(false);

      const outcome = applyQualityGate(
        await attemptCapture(source, entry, run, history),
        source, entry, run
      );

      if (outcome && outcome.success) {
        // A source that only worked the second time says so, in the document
        // and on the row: the first failure is part of what this capture is.
        if (result) {
          const note = `First attempt failed (${result.error}); this is the retry`;
          outcome.notes = (outcome.notes || []).concat(note);
          entry.notes = outcome.notes;
          entry.category = 'recovered';
          broadcast(false);
        }
        return outcome;
      }

      // Keep the first pass's sentence: it says what actually happened, and the
      // retry's own failure is appended to it rather than replacing it.
      result = result
        ? Object.assign({}, outcome, {
          error: `${result.error}; the retry ${
            Math.round(waited / 1000)} s later failed too: ${outcome.error}`
        })
        : outcome;

      const category = (outcome && outcome.category) || null;
      const last = attempt === MAX_ATTEMPTS_PER_SOURCE;
      if (last || run.cancelled || !retryableCategory(category)) break;

      const delay = retryDelay();
      // A retry has to fit: the delay plus a whole capture, inside what is left
      // of the run. Otherwise the source ends now, with the reason it failed —
      // and with the fact that the second attempt this failure had earned was
      // never made, because otherwise it reads exactly like one that was.
      if (Date.now() + delay > run.deadline - RETRY_MIN_REMAINING_MS) {
        retryWithheld = true;
        break;
      }

      markEntry(entry, 'fetching', `Retrying in ${Math.round(delay / 1000)} s`);
      broadcast(false);
      waited = delay;
      await sleep(delay);
      if (run.cancelled || Date.now() > run.deadline) break;
    }

    // Whatever it was, the reason stands and the run pulls the next candidate
    // so the user still gets the number of sources they asked for.
    if (result) {
      if (retryWithheld) {
        result = Object.assign({}, result, {
          error: `${result.error}; no retry was attempted: the run had under ${
            Math.round(RETRY_MIN_REMAINING_MS / 1000)} s left`
        });
      }
      const finalStatus = (entry.status === 'error' || entry.status === 'skipped')
        ? entry.status
        : 'error';
      markEntry(entry, finalStatus, result.error);
      broadcast(false);
      queueReplacement(run);
    }
    return result;
  }

  // --------------------------------------------------------------------------
  // Document builder
  // --------------------------------------------------------------------------

  // A source's title comes from the page it was fetched from, and a hostile or
  // merely sloppy page can put a newline, a bracket or a whole '## 3. …' line
  // in it. The document is written to be read by a model, where a forged header
  // or a forged 'Source:' line is a claim about provenance — so titles are
  // flattened to one line, their Markdown punctuation escaped, and their length
  // bounded before they are interpolated anywhere.
  function safeTitle(title, fallback) {
    const flat = String(title == null ? '' : title).replace(/\s+/g, ' ').trim();
    const text = flat || String(fallback || '');
    return text.replace(/([\\[\]`*_])/g, '\\$1').slice(0, 200);
  }

  // A URL may legally contain parentheses, and one closing bracket is enough to
  // end a Markdown link early and let the rest of the string pose as document
  // text. The angle-bracket form plus percent-encoding of the characters that
  // could close it removes the question.
  function safeLinkTarget(url) {
    // Encoded by hand: encodeURIComponent leaves ( and ) alone, and those are
    // exactly the two characters that would end the link early.
    return '<' + String(url == null ? '' : url)
      .replace(/[\s<>()\\]/g, ch => '%' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')) +
      '>';
  }

  // Reasons and raw URLs land in list items, where a newline would break out of
  // the item and start document-level text.
  function safeInline(text) {
    return String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  }

  function buildFilename(query) {
    const slug = MultiTabUtils.sanitizeFilename(query).slice(0, QUERY_SLUG_MAX) || query;
    return `scrapllm-research-${slug}-${MultiTabUtils.getDateString()}.md`;
  }

  function buildDocument(run, results) {
    const successes = [];
    const failures = [];

    results.forEach((result, index) => {
      const source = run.sources[index];
      if (!source) return;
      if (result && result.success) {
        successes.push({ result, source });
      } else {
        failures.push({
          url: source.url,
          reason: (result && result.error) || 'Conversion failed',
          category: (result && result.category) || null
        });
      }
    });

    const tokenCount = successes.reduce((sum, item) => sum + (item.result.tokenCount || 0), 0);

    const quietCount = successes.filter(item => item.result.path === 'quiet').length;
    const renderedCount = successes.length - quietCount;

    const frontMatter = [
      '---',
      `Research: ${run.query}`,
      `Date: ${MultiTabUtils.getDateString()}`,
      `Engine: ${run.engine || 'duckduckgo-html'}`,
      `Sources: ${successes.length} of ${run.sources.length} fetched`,
      // How each source arrived is part of what the document is: a quietly
      // fetched page is the server's HTML, a rendered one is what a browser
      // made of it.
      `Capture: ${quietCount} fetched without a tab, ${renderedCount} rendered in a background tab`,
      `Tokens: ~${tokenCount} (o200k_base estimate)`
    ];
    // What the gate did is part of the document: a reader who sees six sources
    // where eight were asked for should not have to guess whether two pages
    // were unreachable or two were spam.
    const droppedForQuality = failures.filter(
      failure => failure.category === 'junk' || failure.category === 'duplicate'
    ).length;
    const replacements = run.entries.filter(entry => entry.replacement).length;
    frontMatter.push(`Quality filter: ${run.junkFilter ? 'on' : 'off'}${
      droppedForQuality ? `, ${droppedForQuality} page(s) dropped by it` : ''}`);
    if (replacements) {
      frontMatter.push(`Replacements: ${replacements} further candidate(s) were pulled in for dropped sources`);
    }
    if (run.captureNote) frontMatter.push(`Capture note: ${run.captureNote}`);
    if (run.degraded) frontMatter.push(`Notes: ${run.degraded}`);
    frontMatter.push('---');

    const sourceList = ['## Sources'];
    successes.forEach((item, index) => {
      const title = safeTitle(item.result.tab.title || item.source.title, item.result.tab.url);
      sourceList.push(
        `${index + 1}. [${title}](${safeLinkTarget(item.result.tab.url)}) — ${safeInline(item.source.host)}`
      );
    });
    if (successes.length === 0) {
      sourceList.push('_No source could be captured._');
    }

    // Nothing is quietly dropped: a source that failed and a candidate that was
    // filtered out both show up here, with the reason they carried.
    if (failures.length > 0 || run.rejected.length > 0) {
      sourceList.push('');
      sourceList.push('### Not fetched');
      sourceList.push('');
      failures.forEach(failure => {
        sourceList.push(`- ${safeInline(failure.url)} — ${safeInline(failure.reason)}`);
      });
      run.rejected.forEach(candidate => {
        sourceList.push(
          `- ${safeInline(candidate.url)} — ${safeInline(candidate.reason)} (skipped before fetching)`
        );
      });
    }

    const sections = successes.map((item, index) => {
      const title = safeTitle(item.result.tab.title || item.source.title, item.result.tab.url);
      const header = [
        `## ${index + 1}. ${title}`,
        `Source: ${safeInline(item.result.tab.url)}`,
        `Fetched: ${item.result.fetchedAt}`,
        `Captured: ${item.result.path === 'quiet'
          ? 'server-rendered HTML, no tab'
          : 'rendered in a background tab'}`
      ];
      (item.result.notes || []).forEach(note => header.push(`Note: ${safeInline(note)}`));
      return header.join('\n') + '\n\n' + item.result.markdown;
    });

    // Front matter and the source list open the file; the section separator is
    // the same '\n\n---\n\n' the multi-tab merge already uses.
    const head = frontMatter.join('\n') + '\n\n' + sourceList.join('\n');
    const markdown = sections.length
      ? head + '\n\n---\n\n' + sections.join('\n\n---\n\n')
      : head;

    return { markdown, tokenCount };
  }

  // --------------------------------------------------------------------------
  // Run lifecycle
  // --------------------------------------------------------------------------

  // The same pattern the popup asks for. The popup's `hostAccess` flag says
  // what the user answered; this says what the browser actually holds, and the
  // background trusts the second one before it fetches anything.
  const RESEARCH_ORIGINS = { origins: ['*://*/*'] };

  async function hasHostAccess() {
    if (!api.permissions || typeof api.permissions.contains !== 'function') {
      // Nothing to check the claim against. The popup's answer stands, and a
      // fetch that turns out not to be permitted fails loudly, per source.
      return true;
    }
    try {
      return await api.permissions.contains(RESEARCH_ORIGINS);
    } catch (error) {
      console.warn('Could not verify research site access:', (error && error.message) || error);
      return true;
    }
  }

  async function currentWindowId() {
    try {
      const tabs = await api.tabs.query({ active: true, currentWindow: true });
      if (tabs && tabs.length) return tabs[0].windowId;
    } catch (e) {
      // No window to anchor to; tabs.create will pick one.
    }
    return undefined;
  }

  async function start(request) {
    if (!api) throw new Error('Research engine is not initialised.');
    if (state && state.phase === 'running') {
      throw new Error('A research run is already in progress.');
    }
    if (state && state.phase === 'searching') {
      throw new Error('A research run is already in progress.');
    }

    const query = String((request && request.query) || '').trim();
    if (!query) throw new Error('Enter a question to research.');

    // Orphan recovery closes tabs and rewrites the stored record. It is started
    // at module evaluation and is full of awaits, so a run created while it was
    // in flight used to have its own record cleared underneath it. Wait it out
    // first; it is bookkeeping, so a failure in it does not fail the run.
    if (recoveryPromise) {
      try {
        await recoveryPromise;
      } catch (error) {
        console.error('Research orphan recovery failed:', error);
      }
    }

    const sourceCount = clampSourceCount(request && request.sourceCount);
    const settings = Object.assign({}, (request && request.settings) || {});
    // Neither path renders anything: a background tab is not painted, and the
    // quiet path has no tab at all. A scroll pass would spend the budget and
    // change nothing, so it is forced off and reported on every source.
    settings.triggerLazyLoading = false;
    // A research source is not a selection and not a conversation. The popup
    // sends whatever scope the user has saved, and `selection` would make every
    // capture throw "No text is selected" — on both paths, so a whole run would
    // cost eight fetches plus eight tabs and produce nothing.
    if (settings.contentScope !== 'fullPage') {
      settings.contentScope = 'mainContent';
    }

    // Quiet by default. Two things can send a whole run down the tab path: the
    // user asking for it, and the browser not granting the site access a
    // background fetch needs. Both say so once, at run level.
    // Absent means "no proof of access", not "assume access": only the popup
    // can ask for the host permission, so only the popup can report it — but
    // the flag is a claim, and the background checks it against the permission
    // the browser actually holds before fetching anything on its strength.
    const claimedAccess = !!(request && request.hostAccess === true);
    const grantedAccess = claimedAccess ? await hasHostAccess() : false;
    const hostAccess = claimedAccess && grantedAccess;
    const wantsRender = settings.researchCapture === 'render';
    let strategy = 'quiet';
    let captureNote = null;
    if (wantsRender) {
      strategy = 'render';
      captureNote = 'Every source was opened in a background tab because "Always render" is on';
    } else if (!hostAccess) {
      strategy = 'render';
      // Why there is no site access is not always "you declined": the popup
      // reports what it saw, and a granted-but-absent permission is a third
      // answer again. Whichever it is, it is said in the user's words, once.
      captureNote = claimedAccess
        ? 'The browser granted site access but does not report holding it, so every source was opened in a background tab'
        : ((request && request.hostAccessNote) || NO_HOST_ACCESS_NOTE);
    }

    const now = Date.now();
    const run = {
      runId: `research-${now}-${Math.random().toString(36).slice(2, 8)}`,
      phase: 'searching',
      query,
      sourceCount,
      remoteSettings: settings,
      strategy,
      captureNote,
      engine: null,
      degraded: null,
      error: null,
      filename: null,
      startedAt: now,
      deadline: now + TOTAL_BUDGET_MS,
      expiresAt: now + TOTAL_BUDGET_MS + RESULT_RETENTION_MS,
      entries: [],
      sources: [],
      rejected: [],
      // Candidates discovery ranked but did not need, and the number of
      // sources the run is trying to deliver. One reserve is promoted every
      // time a source ends without a capture.
      reserves: [],
      targetCount: sourceCount,
      // Fingerprints of everything kept so far, so a mirror of a page already
      // in the document is recognised as one.
      accepted: [],
      // One switch for the whole quality gate, on unless the user turned it
      // off. There is deliberately no knob per threshold: the thresholds are
      // measurements, not preferences.
      junkFilter: settings.researchJunkFilter !== false,
      openTabIds: new Set(),
      cancelled: false,
      resultsTooLargeToPersist: false,
      controller: new AbortController(),
      windowId: undefined
    };

    state = run;
    lastDocument = null;
    broadcast(true);
    await persistState(run);

    // Deliberately not awaited: `start` returns the run id immediately so the
    // popup can render, and progress arrives over the port.
    execute(run).catch(async error => {
      run.phase = 'error';
      run.error = (error && error.message) || String(error);
      await closeOffscreen();
      broadcast(true);
      await persistState(run);
    });

    return run.runId;
  }

  async function execute(run) {
    run.windowId = await currentWindowId();

    let search;
    // No run-level search timer. `run.controller` is the whole run's abort
    // signal — the quiet captures share it — so a timer on it would not have
    // stopped discovery, it would have killed every capture still in flight,
    // and the raw AbortError would have reached the sheet as "The user aborted
    // a request." Discovery is already bounded where the request is made:
    // search.js gives each endpoint attempt its own 10 s AbortController, and
    // the run's own 4-minute budget caps the rest. `run.controller` is aborted
    // by `cancel()` and by nothing else.
    try {
      search = await ScrapLLMSearch.findSources(run.query, {
        limit: run.sourceCount,
        signal: run.controller.signal
      });
    } catch (error) {
      if (run.cancelled) {
        run.phase = 'cancelled';
        broadcast(true);
        await persistState(run);
        return;
      }
      run.phase = 'error';
      run.error = (error && error.message) || String(error);
      broadcast(true);
      await persistState(run);
      return;
    }

    run.engine = search.engine;
    run.degraded = search.degraded;
    run.rejected = search.rejected || [];
    run.reserves = search.reserves || [];

    if (!search.results.length) {
      run.phase = 'empty';
      broadcast(true);
      await persistState(run);
      return;
    }

    run.sources = search.results.slice();
    // What discovery could actually offer, which is what the run promises to
    // deliver: asking for 8 and finding 6 does not make the run owe 8.
    run.targetCount = search.results.length;
    run.entries = search.results.map(source => ({
      url: source.url,
      host: source.host,
      title: source.title,
      status: 'pending',
      note: 'Queued',
      tokenCount: 0,
      notes: []
    }));
    run.phase = 'running';
    broadcast(true);
    await persistState(run);

    const results = await MultiTabUtils.runPool(
      run.sources,
      RESEARCH_CONCURRENCY,
      (source, index) => fetchOne(source, index, run)
    );

    await closeOffscreen();

    const { markdown, tokenCount } = buildDocument(run, results);
    const filename = buildFilename(run.query);

    run.filename = filename;
    run.phase = run.cancelled ? 'cancelled' : 'done';

    lastDocument = {
      runId: run.runId,
      filename,
      markdown,
      tokenCount,
      expiresAt: Date.now() + RESULT_RETENTION_MS
    };
    run.expiresAt = lastDocument.expiresAt;

    // Bytes, not characters: the store holds UTF-8, and a run over CJK pages is
    // roughly three bytes per character — 4 M characters passed a 5 MiB
    // character check and then blew the quota on write.
    const tooLarge = new TextEncoder().encode(markdown).length > MAX_PERSIST_BYTES;
    run.resultsTooLargeToPersist = tooLarge;

    const persisted = await persistState(run, tooLarge ? { document: null } : { document: lastDocument });

    // The store refused the write anyway. The document is only in this worker's
    // memory now, which is exactly what the popup's warning is for, so say it
    // rather than showing a clean result over nothing.
    if (!persisted && !tooLarge) {
      run.resultsTooLargeToPersist = true;
      await persistState(run, { document: null });
    }

    broadcast(true);
  }

  function cancel(runId) {
    if (!state || (runId && state.runId !== runId)) return;
    if (state.phase !== 'searching' && state.phase !== 'running') return;

    // Captured once: everything below belongs to *this* run, whatever the
    // module's current run becomes while the teardown is still in flight.
    const run = state;
    run.cancelled = true;
    try {
      run.controller.abort();
    } catch (e) {
      // An already-aborted controller is fine.
    }

    // The offscreen parser is deliberately left alone. Tearing it down here
    // rejects the parses already in flight, and a rejected parse is an
    // escalation signal — cancelling would have opened a burst of tabs on a
    // feature whose whole promise is that there are none. `execute` closes it
    // once the pool has drained, which is a moment later and after the
    // cancelled sources have already given up.

    // Removing a tab rejects its pending sendMessage, which is what actually
    // stops an in-flight conversion.
    Array.from(run.openTabIds).forEach(tabId => {
      removeTab(tabId).then(() => run.openTabIds.delete(tabId));
    });

    broadcast(true);
  }

  function getSnapshot() {
    return state ? buildSnapshot() : lastSnapshot;
  }

  // The run id is required and has to match. The document holds pages captured
  // with the user's session; handing it to a caller that cannot name the run it
  // belongs to was a way to read the last run without having started one.
  async function getDocument(runId) {
    if (!runId) return null;

    if (lastDocument && lastDocument.runId === runId &&
        Date.now() < lastDocument.expiresAt) {
      return {
        filename: lastDocument.filename,
        markdown: lastDocument.markdown,
        tokenCount: lastDocument.tokenCount
      };
    }

    const persisted = await readPersisted();
    const doc = persisted && persisted.document;
    if (doc && doc.runId === runId && Date.now() < doc.expiresAt) {
      return {
        filename: doc.filename,
        markdown: doc.markdown,
        tokenCount: doc.tokenCount
      };
    }

    return null;
  }

  function onProgress(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  // A service-worker restart (or a browser crash) leaves research tabs open
  // with nobody to close them. Runs at module evaluation.
  function recoverOrphans() {
    if (!recoveryPromise) recoveryPromise = runRecovery();
    return recoveryPromise;
  }

  // True while a run owns the engine: recovery must not touch anything then,
  // and it has to ask again after every await, because a `start` can land in
  // between two of them.
  function runIsLive() {
    return Boolean(state && (state.phase === 'searching' || state.phase === 'running'));
  }

  // What a stored record becomes when the worker comes back to it. Only a run
  // that was still going when the worker died was interrupted; a run that had
  // finished is still finished, and saying otherwise threw away a document the
  // popup could still hand over.
  function recoveredPhase(phase) {
    if (phase === 'done' || phase === 'cancelled' || phase === 'error' || phase === 'empty') {
      return phase;
    }
    return 'interrupted';
  }

  // The counters buildSnapshot would have produced, from the entries the record
  // kept — a restored `done` run has to show the same "6 of 8 sources" it did
  // before the restart, not a result card full of zeroes.
  function snapshotFromPersisted(persisted, phase) {
    const entries = persisted.entries || [];
    const succeeded = entries.filter(e => e.status === 'ok').length;
    const failed = entries.filter(e => e.status === 'error').length;
    const skipped = entries.filter(e => e.status === 'skipped').length;

    return Object.assign(idleSnapshot(), {
      runId: persisted.runId || null,
      phase,
      query: persisted.query || '',
      total: entries.length,
      completed: succeeded + failed + skipped,
      succeeded,
      failed,
      skipped,
      tokenCount: entries.reduce((sum, e) => sum + (e.tokenCount || 0), 0),
      quiet: entries.filter(e => e.status === 'ok' && e.path === 'quiet').length,
      rendered: entries.filter(e => e.status === 'ok' && e.path === 'rendered').length,
      dropped: entries.filter(e => e.category === 'junk' || e.category === 'duplicate').length,
      replacements: entries.filter(e => e.replacement).length,
      entries,
      resultsTooLargeToPersist: Boolean(persisted.resultsTooLargeToPersist),
      filename: persisted.document ? persisted.document.filename : null
    });
  }

  async function runRecovery() {
    if (!api) return;
    if (runIsLive()) return;

    // First, and before the state is even read: a crashed worker can leave the
    // offscreen parser open, an extension may only ever have one, and the run
    // state is exactly what a crash may have taken with it — when
    // storage.session is unavailable it lived in a module variable that died
    // with the worker. Closing a document that does not exist is already a
    // no-op inside closeOffscreen.
    await closeOffscreen();
    if (runIsLive()) return;

    const persisted = await readPersisted();
    if (!persisted) return;
    // A run that started while the awaits above were in flight owns this
    // record. Closing its tabs, clearing it or calling it interrupted would
    // destroy a run that is working perfectly.
    if (runIsLive() || (state && state.runId === persisted.runId)) return;

    const tabIds = persisted.openTabIds || [];
    for (const tabId of tabIds) {
      await removeTab(tabId);
      if (state && state.runId === persisted.runId) return;
    }
    if (runIsLive()) return;

    const phase = recoveredPhase(persisted.phase);
    lastSnapshot = snapshotFromPersisted(persisted, phase);

    if (persisted.document) {
      lastDocument = persisted.document;
      try {
        await writePersisted(Object.assign({}, persisted, {
          phase,
          openTabIds: []
        }));
      } catch (error) {
        // The tabs are already closed and the document is already in memory;
        // a refused write here only costs the record after another restart.
        console.error('Research state write failed:', error);
      }
    } else {
      await clearPersisted();
    }

    if (runIsLive()) return;
    emit(lastSnapshot);
  }

  function init(browserAPI) {
    api = browserAPI;
    store = (browserAPI.storage && browserAPI.storage.session) || null;
    announceStore();
  }

  return {
    init,
    start,
    cancel,
    getSnapshot,
    getDocument,
    onProgress,
    recoverOrphans
  };
})();

// Background contexts only.
if (typeof self !== 'undefined') {
  self.ScrapLLMResearch = ScrapLLMResearch;
}
