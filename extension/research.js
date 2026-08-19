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

const ScrapLLMResearch = (function() {
  const RESEARCH_CONCURRENCY = 3;
  const PING_INTERVAL_MS = 250;
  const PAGE_LOAD_TIMEOUT_MS = 20000;
  const SETTLE_DELAY_MS = 400;
  const CONVERT_TIMEOUT_MS = 30000;
  const SEARCH_TIMEOUT_MS = 10000;
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

  let api = null;
  let store = null;
  let storeAnnounced = false;

  const listeners = new Set();

  // The live run, or null when idle. Everything the popup can see is derived
  // from this object plus `lastDocument`.
  let state = null;
  let lastDocument = null;   // { runId, filename, markdown, tokenCount, expiresAt }
  let lastSnapshot = idleSnapshot();

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
        thinNote: e.thinNote || null
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

  async function writePersisted(value) {
    if (!store) {
      memoryStore = value;
      return;
    }
    try {
      await store.set({ [STATE_KEY]: value });
    } catch (error) {
      console.error('Research state write failed:', error);
    }
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
  async function persistState(run, extra) {
    if (!run) return;
    const payload = Object.assign({
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
        thinNote: e.thinNote || null
      })),
      expiresAt: run.expiresAt,
      resultsTooLargeToPersist: run.resultsTooLargeToPersist
    }, extra || {});

    const previous = await readPersisted();
    if (previous && previous.document && !payload.document) {
      payload.document = previous.document;
    }
    await writePersisted(payload);
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

  // Resolves with { success, result } or { success: false, error }. Never
  // rejects: a parse failure is an escalation signal, not a run failure.
  async function convertFetchedHtml(payload) {
    let timeoutId = null;
    const timeout = new Promise(resolve => {
      timeoutId = setTimeout(
        () => resolve({ success: false, error: 'the parser did not answer within 5 s' }),
        PARSE_TIMEOUT_MS
      );
    });

    const work = (async () => {
      try {
        if (canParseLocally()) {
          return { success: true, result: ScrapLLMConvert.convertHtml(payload) };
        }
        if (!hasOffscreenApi()) {
          return {
            success: false,
            error: 'this browser exposes neither DOMParser nor an offscreen document'
          };
        }
        await ensureOffscreen();
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
    })();

    const outcome = await Promise.race([work, timeout]);
    if (timeoutId !== null) clearTimeout(timeoutId);
    return outcome;
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
    const limit = Math.min(Date.now() + PAGE_LOAD_TIMEOUT_MS, deadlineAt);

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

  function skipResult(source, message) {
    return {
      success: false,
      tab: { id: null, url: source.url, title: source.url },
      error: message,
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
  async function captureQuietly(source, entry, run) {
    const preflight = ScrapLLMQuietCapture.preflight(source.url, run.remoteSettings);
    if (preflight) {
      // Preflight can also refuse outright — a private address is not a page a
      // tab could capture any more safely than a fetch could.
      return preflight.decision === 'reject'
        ? { outcome: 'rejected', message: preflight.reason }
        : { outcome: 'render', reason: preflight.reason };
    }

    const response = await ScrapLLMQuietCapture.fetchSource(source.url, {
      signal: run.controller.signal
    });
    if (run.cancelled) return { outcome: 'rejected', message: CANCELLED_MESSAGE };

    const verdict = ScrapLLMQuietCapture.classifyResponse(response, source.url);
    if (verdict.decision === 'render') return { outcome: 'render', reason: verdict.reason };
    if (verdict.decision === 'reject') return { outcome: 'rejected', message: verdict.reason };

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
          reason: `Server-rendered text was only ${textLength} characters, so a tab was opened`
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

      const check = ScrapLLMQuietCapture.classifyExtraction(extraction);
      if (check.decision === 'render') return { outcome: 'render', reason: check.reason };

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
      // Both halves of the story: why the quiet path gave up, and why the tab
      // it escalated to failed as well.
      const reason = cancelled
        ? CANCELLED_MESSAGE
        : (escalationReason ? `${escalationReason}, and then: ${message}` : message);

      markEntry(entry, cancelled ? 'skipped' : 'error', reason);
      broadcast(false);

      return {
        success: false,
        tab: { id: tab ? tab.id : null, url: source.url, title: source.title || source.url },
        error: reason,
        path: 'rendered',
        pathReason: escalationReason || null,
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

  async function fetchOne(source, index, run) {
    const entry = run.entries[index];

    if (run.cancelled) {
      markEntry(entry, 'skipped', CANCELLED_MESSAGE);
      broadcast(false);
      return skipResult(source, CANCELLED_MESSAGE);
    }

    if (Date.now() > run.deadline) {
      markEntry(entry, 'skipped', BUDGET_MESSAGE);
      broadcast(false);
      return skipResult(source, BUDGET_MESSAGE);
    }

    // Both paths, not just the quiet one: a URL naming the user's own machine
    // or LAN is not captured at all, and opening it in a tab would perform the
    // same request with the user's session attached.
    const blocked = ScrapLLMQuietCapture.privateDestinationReason(source.url);
    if (blocked) {
      markEntry(entry, 'error', blocked);
      broadcast(false);
      return {
        success: false,
        tab: { id: null, url: source.url, title: source.title || source.url },
        error: blocked,
        notes: []
      };
    }

    markEntry(entry, 'fetching', 'Fetching');
    broadcast(false);

    let escalationReason = null;

    if (run.strategy === 'quiet') {
      let quiet;
      try {
        quiet = await captureQuietly(source, entry, run);
      } catch (error) {
        // The quiet path is not allowed to take a source down with it: an
        // unexpected failure here is an escalation, with its own reason.
        quiet = {
          outcome: 'render',
          reason: 'The quiet capture failed (' +
            ((error && error.message) || String(error)) + '), so a tab was opened'
        };
      }

      if (quiet.outcome === 'captured') return quiet.result;

      if (quiet.outcome === 'rejected') {
        const cancelled = run.cancelled || quiet.message === CANCELLED_MESSAGE;
        markEntry(entry, cancelled ? 'skipped' : 'error', quiet.message);
        entry.path = 'quiet';
        entry.pathReason = null;
        broadcast(false);
        return {
          success: false,
          tab: { id: null, url: source.url, title: source.title || source.url },
          error: quiet.message,
          path: 'quiet',
          pathReason: null,
          notes: []
        };
      }

      // Cancellation is checked again here, not only at the top of this
      // function: the quiet capture was awaiting a fetch or a parse while the
      // user pressed Cancel, and an escalation decided in that window would
      // open a tab *because* the run was being torn down.
      if (run.cancelled) {
        markEntry(entry, 'skipped', CANCELLED_MESSAGE);
        entry.path = 'quiet';
        broadcast(false);
        return skipResult(source, CANCELLED_MESSAGE);
      }

      escalationReason = quiet.reason;
      entry.pathReason = escalationReason;
      markEntry(entry, 'fetching', 'Opening a tab');
      broadcast(false);
    }

    entry.path = 'rendered';
    return await captureInTab(source, entry, run, escalationReason);
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
      if (result && result.success) {
        successes.push({ result, source });
      } else {
        failures.push({
          url: source.url,
          reason: (result && result.error) || 'Conversion failed'
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
    const searchTimer = setTimeout(() => run.controller.abort(), SEARCH_TIMEOUT_MS);
    try {
      search = await ScrapLLMSearch.findSources(run.query, {
        limit: run.sourceCount,
        signal: run.controller.signal
      });
    } catch (error) {
      clearTimeout(searchTimer);
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
    clearTimeout(searchTimer);

    run.engine = search.engine;
    run.degraded = search.degraded;
    run.rejected = search.rejected || [];

    if (!search.results.length) {
      run.phase = 'empty';
      broadcast(true);
      await persistState(run);
      return;
    }

    run.sources = search.results;
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

    const tooLarge = markdown.length > MAX_PERSIST_BYTES;
    run.resultsTooLargeToPersist = tooLarge;

    await persistState(run, tooLarge ? { document: null } : { document: lastDocument });
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

  async function getDocument(runId) {
    if (lastDocument && (!runId || lastDocument.runId === runId) &&
        Date.now() < lastDocument.expiresAt) {
      return {
        filename: lastDocument.filename,
        markdown: lastDocument.markdown,
        tokenCount: lastDocument.tokenCount
      };
    }

    const persisted = await readPersisted();
    const doc = persisted && persisted.document;
    if (doc && (!runId || doc.runId === runId) && Date.now() < doc.expiresAt) {
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
  async function recoverOrphans() {
    if (!api) return;
    if (state && (state.phase === 'searching' || state.phase === 'running')) return;

    // First, and before the state is even read: a crashed worker can leave the
    // offscreen parser open, an extension may only ever have one, and the run
    // state is exactly what a crash may have taken with it — when
    // storage.session is unavailable it lived in a module variable that died
    // with the worker. Closing a document that does not exist is already a
    // no-op inside closeOffscreen.
    await closeOffscreen();

    const persisted = await readPersisted();
    if (!persisted) return;

    const tabIds = persisted.openTabIds || [];
    for (const tabId of tabIds) {
      await removeTab(tabId);
    }

    lastSnapshot = Object.assign(idleSnapshot(), {
      runId: persisted.runId || null,
      phase: 'interrupted',
      query: persisted.query || '',
      entries: persisted.entries || [],
      total: (persisted.entries || []).length,
      resultsTooLargeToPersist: Boolean(persisted.resultsTooLargeToPersist),
      filename: persisted.document ? persisted.document.filename : null
    });

    if (persisted.document) {
      lastDocument = persisted.document;
      await writePersisted(Object.assign({}, persisted, {
        phase: 'interrupted',
        openTabIds: []
      }));
    } else {
      await clearPersisted();
    }

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
