// ScrapLLM Research Engine
// Owns a research run end to end: drives ScrapLLMSearch for discovery, opens
// one background tab per accepted source, waits for the existing content script
// to become scriptable, asks it for Markdown through the ordinary
// `convertToMarkdown` action, merges everything into one document, and reports
// progress over the `scrapllm-research` port.
//
// Background context only. Depends on ScrapLLMSearch and MultiTabUtils, both
// resolved at init() time rather than at evaluation time.

const ScrapLLMResearch = (function() {
  const RESEARCH_CONCURRENCY = 3;
  const PING_INTERVAL_MS = 250;
  const PAGE_LOAD_TIMEOUT_MS = 20000;
  const SETTLE_DELAY_MS = 400;
  const CONVERT_TIMEOUT_MS = 30000;
  const SEARCH_TIMEOUT_MS = 10000;
  const TOTAL_BUDGET_MS = 240000;
  const PROGRESS_THROTTLE_MS = 250;
  const RESULT_RETENTION_MS = 600000;
  const MAX_PERSIST_BYTES = 5242880;
  const STATE_KEY = 'scrapllm.researchRun';
  const QUERY_SLUG_MAX = 40;

  const MIN_SOURCES = 5;
  const MAX_SOURCES = 12;

  const LAZY_LOAD_NOTE =
    'Scroll pass skipped: background tabs are not rendered, so lazy-loaded sections cannot be triggered';
  const X_NOTE =
    'X timelines are virtualised; a background tab captures only the server-rendered portion';
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
      total: 0,
      completed: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      startedAt: 0,
      deadline: 0,
      tokenCount: 0,
      filename: null,
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
      total: entries.length,
      completed: succeeded + failed + skipped,
      succeeded,
      failed,
      skipped,
      startedAt: state.startedAt,
      deadline: state.deadline,
      tokenCount: entries.reduce((sum, e) => sum + (e.tokenCount || 0), 0),
      filename: state.filename,
      resultsTooLargeToPersist: state.resultsTooLargeToPersist,
      error: state.error,
      entries: entries.map(e => ({
        url: e.url,
        host: e.host,
        title: e.title,
        status: e.status,
        note: e.note,
        tokenCount: e.tokenCount || 0,
        notes: e.notes || []
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

  async function persistState(extra) {
    if (!state) return;
    const payload = Object.assign({
      runId: state.runId,
      phase: state.phase,
      query: state.query,
      openTabIds: Array.from(state.openTabIds),
      entries: state.entries.map(e => ({
        url: e.url,
        host: e.host,
        title: e.title,
        status: e.status,
        note: e.note,
        tokenCount: e.tokenCount || 0,
        notes: e.notes || []
      })),
      expiresAt: state.expiresAt,
      resultsTooLargeToPersist: state.resultsTooLargeToPersist
    }, extra || {});

    const previous = await readPersisted();
    if (previous && previous.document && !payload.document) {
      payload.document = previous.document;
    }
    await writePersisted(payload);
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
  async function waitForScriptable(tabId, url, deadlineAt) {
    const limit = Math.min(Date.now() + PAGE_LOAD_TIMEOUT_MS, deadlineAt);

    while (Date.now() < limit) {
      if (state && state.cancelled) throw new Error(CANCELLED_MESSAGE);

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
    if (source.host === 'x.com' || source.host === 'twitter.com') {
      notes.push(X_NOTE);
    }
    return notes;
  }

  function markEntry(entry, status, note) {
    entry.status = status;
    entry.note = note;
  }

  async function fetchOne(source, index, run) {
    const entry = run.entries[index];

    if (run.cancelled) {
      markEntry(entry, 'skipped', CANCELLED_MESSAGE);
      broadcast(false);
      return {
        success: false,
        tab: { id: null, url: source.url, title: source.url },
        error: CANCELLED_MESSAGE,
        notes: []
      };
    }

    if (Date.now() > run.deadline) {
      markEntry(entry, 'skipped', BUDGET_MESSAGE);
      broadcast(false);
      return {
        success: false,
        tab: { id: null, url: source.url, title: source.url },
        error: BUDGET_MESSAGE,
        notes: []
      };
    }

    markEntry(entry, 'fetching', 'Fetching');
    broadcast(false);

    let tab = null;
    try {
      tab = await createTab(source.url, run.windowId);

      run.openTabIds.add(tab.id);
      await persistState();

      try {
        await api.tabs.update(tab.id, { muted: true });
      } catch (error) {
        console.warn('Could not mute research tab', tab.id, error && error.message);
      }

      await waitForScriptable(tab.id, source.url, run.deadline);
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
      entry.title = finalTitle;
      entry.tokenCount = conversion.tokenCount || 0;
      entry.notes = notes;
      markEntry(entry, 'ok', formatTokenNote(conversion.tokenCount || 0));
      broadcast(false);

      return {
        success: true,
        tab: { id: tab.id, url: finalUrl, title: finalTitle },
        fetchedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
        markdown: conversion.markdown,
        tokenCount: conversion.tokenCount || 0,
        notes,
        source: {
          host: source.host,
          snippet: source.snippet,
          engineRank: source.engineRank
        }
      };
    } catch (error) {
      const message = (error && error.message) || String(error);
      const cancelled = run.cancelled || message === CANCELLED_MESSAGE;
      const reason = cancelled ? CANCELLED_MESSAGE : message;

      markEntry(entry, cancelled ? 'skipped' : 'error', reason);
      broadcast(false);

      return {
        success: false,
        tab: { id: tab ? tab.id : null, url: source.url, title: source.title || source.url },
        error: reason,
        notes: []
      };
    } finally {
      if (tab) {
        await removeTab(tab.id);
        run.openTabIds.delete(tab.id);
        await persistState();
      }
    }
  }

  // --------------------------------------------------------------------------
  // Document builder
  // --------------------------------------------------------------------------

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

    const frontMatter = [
      '---',
      `Research: ${run.query}`,
      `Date: ${MultiTabUtils.getDateString()}`,
      `Engine: ${run.engine || 'duckduckgo-html'}`,
      `Sources: ${successes.length} of ${run.sources.length} fetched`,
      `Tokens: ~${tokenCount} (o200k_base estimate)`
    ];
    if (run.degraded) frontMatter.push(`Notes: ${run.degraded}`);
    frontMatter.push('---');

    const sourceList = ['## Sources'];
    successes.forEach((item, index) => {
      const title = item.result.tab.title || item.source.title || item.result.tab.url;
      sourceList.push(`${index + 1}. [${title}](${item.result.tab.url}) — ${item.source.host}`);
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
        sourceList.push(`- ${failure.url} — ${failure.reason}`);
      });
      run.rejected.forEach(candidate => {
        sourceList.push(`- ${candidate.url} — ${candidate.reason} (skipped before fetching)`);
      });
    }

    const sections = successes.map((item, index) => {
      const title = item.result.tab.title || item.source.title || item.result.tab.url;
      const header = [
        `## ${index + 1}. ${title}`,
        `Source: ${item.result.tab.url}`,
        `Fetched: ${item.result.fetchedAt}`
      ];
      (item.result.notes || []).forEach(note => header.push(`Note: ${note}`));
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
    // Background tabs are never rendered, so a scroll pass would spend the
    // budget and change nothing. Forced off, and reported on every source.
    settings.triggerLazyLoading = false;

    const now = Date.now();
    const run = {
      runId: `research-${now}-${Math.random().toString(36).slice(2, 8)}`,
      phase: 'searching',
      query,
      sourceCount,
      remoteSettings: settings,
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
    await persistState();

    // Deliberately not awaited: `start` returns the run id immediately so the
    // popup can render, and progress arrives over the port.
    execute(run).catch(async error => {
      run.phase = 'error';
      run.error = (error && error.message) || String(error);
      broadcast(true);
      await persistState();
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
        await persistState();
        return;
      }
      run.phase = 'error';
      run.error = (error && error.message) || String(error);
      broadcast(true);
      await persistState();
      return;
    }
    clearTimeout(searchTimer);

    run.engine = search.engine;
    run.degraded = search.degraded;
    run.rejected = search.rejected || [];

    if (!search.results.length) {
      run.phase = 'empty';
      broadcast(true);
      await persistState();
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
    await persistState();

    const results = await MultiTabUtils.runPool(
      run.sources,
      RESEARCH_CONCURRENCY,
      (source, index) => fetchOne(source, index, run)
    );

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

    await persistState(tooLarge ? { document: null } : { document: lastDocument });
    broadcast(true);
  }

  function cancel(runId) {
    if (!state || (runId && state.runId !== runId)) return;
    if (state.phase !== 'searching' && state.phase !== 'running') return;

    state.cancelled = true;
    try {
      state.controller.abort();
    } catch (e) {
      // An already-aborted controller is fine.
    }

    // Removing a tab rejects its pending sendMessage, which is what actually
    // stops an in-flight conversion.
    Array.from(state.openTabIds).forEach(tabId => {
      removeTab(tabId).then(() => {
        if (state) state.openTabIds.delete(tabId);
      });
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
