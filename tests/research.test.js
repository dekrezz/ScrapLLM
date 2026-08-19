// Unit tests for the research feature: extension/search.js (discovery, pure)
// and extension/research.js (the run engine).
//
// Both files are background-only IIFEs that publish themselves on `self`, so
// each test loads a fresh copy with jest.resetModules() and reads the module
// off the global. The engine talks to a fake browserAPI and a stubbed
// ScrapLLMSearch; the real MultiTabUtils (runPool, convertTabToMarkdown,
// filename helpers) is loaded so the pool and the filenames are exercised for
// real.

const path = require('path');

const SEARCH_PATH = path.join(__dirname, '../extension/search.js');
const MULTITAB_PATH = path.join(__dirname, '../extension/multi-tab-utils.js');
const RESEARCH_PATH = path.join(__dirname, '../extension/research.js');
const SETTINGS_PATH = path.join(__dirname, '../extension/settings.js');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// DuckDuckGo wraps every outbound link and appends its own tracking parameter.
function ddgRedirect(target) {
  return '//duckduckgo.com/l/?uddg=' + encodeURIComponent(target) + '&amp;rut=0123456789abcdef';
}

function htmlResultBlock(index, { ad = false } = {}) {
  const target = `https://example${index}.com/guides/topic-${index}`;
  const classes = `result results_links results_links_deep web-result${ad ? ' result--ad' : ''}`;
  return `
<div class="${classes}">
  <div class="links_main links_deep result__body">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="${ddgRedirect(target)}">Result ${index} &amp; friends</a>
    </h2>
    <a class="result__snippet" href="${ddgRedirect(target)}">Snippet for result ${index}</a>
  </div>
</div>`;
}

function ddgHtmlFixture(count, options = {}) {
  const blocks = [];
  if (options.leadingAd) blocks.push(htmlResultBlock(0, { ad: true }));
  for (let i = 1; i <= count; i++) blocks.push(htmlResultBlock(i));
  return `<html><body><div id="links" class="results">${blocks.join('\n')}</div></body></html>`;
}

function liteResultRows(index) {
  const target = `https://example${index}.com/guides/topic-${index}`;
  return `
  <tr><td><a rel='nofollow' class='result-link' href='${ddgRedirect(target)}'>Result ${index} &amp; friends</a></td></tr>
  <tr><td class='result-snippet'>Snippet for result ${index}</td></tr>
  <tr><td class='result-url'>example${index}.com</td></tr>`;
}

function ddgLiteFixture(count) {
  const rows = [];
  for (let i = 1; i <= count; i++) rows.push(liteResultRows(i));
  return `<html><body><table>${rows.join('\n')}</table></body></html>`;
}

const ZERO_RESULT_HTML =
  '<html><body><div class="no-results result--no-result">No results.</div></body></html>';
const DRIFT_HTML = '<html><body><main>Nothing we recognise here.</main></body></html>';
const ANOMALY_HTML =
  '<html><body><p>If this error persists, please let us know: unusual traffic detected — anomaly.</p></body></html>';

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

function loadSearch() {
  jest.resetModules();
  delete global.ScrapLLMSearch;
  require(SEARCH_PATH);
  return global.ScrapLLMSearch;
}

function mockFetchSequence(pages) {
  const calls = [];
  global.fetch = jest.fn(async (url) => {
    calls.push(url);
    const page = pages[Math.min(calls.length - 1, pages.length - 1)];
    return {
      status: page.status === undefined ? 200 : page.status,
      text: async () => page.body || ''
    };
  });
  return calls;
}

// ---------------------------------------------------------------------------
// search.js — parsing
// ---------------------------------------------------------------------------

describe('ScrapLLMSearch parsing', () => {
  let Search;

  beforeEach(() => {
    Search = loadSearch();
  });

  afterEach(() => {
    delete global.fetch;
  });

  it('parses the html endpoint, unwraps uddg links and decodes entities', () => {
    const { results, zeroMarker } = Search.parseDdgHtml(ddgHtmlFixture(10));

    expect(zeroMarker).toBe(false);
    expect(results).toHaveLength(10);
    expect(results[0]).toEqual({
      url: 'https://example1.com/guides/topic-1',
      title: 'Result 1 & friends',
      snippet: 'Snippet for result 1',
      engineRank: 1
    });
    expect(results[9].engineRank).toBe(10);
    expect(results.every(r => r.url.startsWith('https://example'))).toBe(true);
  });

  it('skips sponsored blocks so the ranks stay contiguous', () => {
    const { results } = Search.parseDdgHtml(ddgHtmlFixture(3, { leadingAd: true }));

    expect(results).toHaveLength(3);
    expect(results.map(r => r.engineRank)).toEqual([1, 2, 3]);
    expect(results[0].url).toBe('https://example1.com/guides/topic-1');
  });

  it('parses the lite endpoint and pairs each snippet with its own link', () => {
    const { results, zeroMarker } = Search.parseDdgLite(ddgLiteFixture(10));

    expect(zeroMarker).toBe(false);
    expect(results).toHaveLength(10);
    expect(results[4]).toEqual({
      url: 'https://example5.com/guides/topic-5',
      title: 'Result 5 & friends',
      snippet: 'Snippet for result 5',
      engineRank: 5
    });
  });

  it('recognises the zero-result markers on both endpoints', () => {
    expect(Search.parseDdgHtml(ZERO_RESULT_HTML).zeroMarker).toBe(true);
    expect(Search.parseDdgHtml(ZERO_RESULT_HTML).results).toEqual([]);
    expect(
      Search.parseDdgLite('<div class="no-results__container">nope</div>').zeroMarker
    ).toBe(true);
  });

  it('flags time-sensitive queries only on the documented triggers', () => {
    expect(Search.isTimeSensitive('what happened today')).toBe(true);
    expect(Search.isTimeSensitive('latest spring release')).toBe(true);
    expect(Search.isTimeSensitive('rust ownership rules')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// search.js — response classification
// ---------------------------------------------------------------------------

describe('ScrapLLMSearch.findSources classification', () => {
  let Search;

  beforeEach(() => {
    Search = loadSearch();
  });

  afterEach(() => {
    delete global.fetch;
  });

  it('returns an empty result set for a genuine zero-result page, without throwing', async () => {
    const calls = mockFetchSequence([{ body: ZERO_RESULT_HTML }]);

    const result = await Search.findSources('an unsearchable phrase', { limit: 8 });

    expect(result.results).toEqual([]);
    expect(result.rejected).toEqual([]);
    expect(result.degraded).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('throws the markup-drift message when both endpoints answer 200 with nothing parsable', async () => {
    const calls = mockFetchSequence([{ body: DRIFT_HTML }, { body: DRIFT_HTML }]);

    await expect(Search.findSources('spring animations', { limit: 8 }))
      .rejects.toThrow('Search endpoint markup changed');

    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('lite.duckduckgo.com');
  });

  it('falls back to the lite endpoint and reports the degradation', async () => {
    const calls = mockFetchSequence([
      { status: 503, body: '' },
      { body: ddgLiteFixture(6) }
    ]);

    const result = await Search.findSources('spring animations', { limit: 5 });

    expect(calls).toHaveLength(2);
    expect(result.engine).toBe('duckduckgo-lite');
    expect(result.degraded).toBe('html endpoint unavailable, used the lite endpoint');
    expect(result.results).toHaveLength(5);
  });

  it('throws the rate-limit message on an anomaly page and does not try the lite endpoint', async () => {
    const calls = mockFetchSequence([{ body: ANOMALY_HTML }]);

    await expect(Search.findSources('spring animations', { limit: 8 }))
      .rejects.toThrow('DuckDuckGo is rate limiting this device. Try again in a minute.');

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('html.duckduckgo.com');
  });

  it('appends the recency parameter only for a time-sensitive query', async () => {
    mockFetchSequence([{ body: ddgHtmlFixture(6) }]);
    const recent = await Search.findSources('latest safari release', { limit: 5 });
    expect(global.fetch.mock.calls[0][0]).toContain('&df=d');
    expect(recent.usedRecency).toBe(true);

    Search = loadSearch();
    mockFetchSequence([{ body: ddgHtmlFixture(6) }]);
    const evergreen = await Search.findSources('rust ownership rules', { limit: 5 });
    expect(global.fetch.mock.calls[0][0]).not.toContain('&df=d');
    expect(evergreen.usedRecency).toBe(false);
  });

  it('clamps the requested limit to 5..12', async () => {
    mockFetchSequence([{ body: ddgHtmlFixture(20) }]);
    const many = await Search.findSources('spring animations', { limit: 99 });
    expect(many.results).toHaveLength(12);

    Search = loadSearch();
    mockFetchSequence([{ body: ddgHtmlFixture(20) }]);
    const few = await Search.findSources('spring animations', { limit: 1 });
    expect(few.results).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// search.js — filtering, ranking, deduplication
// ---------------------------------------------------------------------------

describe('ScrapLLMSearch.filterAndRank', () => {
  let Search;

  beforeEach(() => {
    Search = loadSearch();
  });

  function candidate(url, extra = {}) {
    return Object.assign(
      { url, title: 'Some title', snippet: 'Some snippet', engineRank: 1 },
      extra
    );
  }

  it('drops non-pages, paywalls and login walls, each with its own reason', () => {
    const { results, rejected } = Search.filterAndRank([
      candidate('https://example.com/report.pdf', { engineRank: 1 }),
      candidate('https://www.wsj.com/articles/markets', { engineRank: 2 }),
      candidate('https://www.linkedin.com/in/someone', { engineRank: 3 }),
      candidate('ftp://files.example.org/thing', { engineRank: 4 }),
      candidate('https://blog.example.net/a/b', { engineRank: 5 })
    ], 8);

    expect(results.map(r => r.host)).toEqual(['blog.example.net']);
    expect(rejected).toEqual([
      { url: 'https://example.com/report.pdf', host: 'example.com', reason: 'Not a web page' },
      { url: 'https://www.wsj.com/articles/markets', host: 'wsj.com', reason: 'Paywalled' },
      { url: 'https://www.linkedin.com/in/someone', host: 'linkedin.com', reason: 'Login wall' },
      { url: 'ftp://files.example.org/thing', host: 'files.example.org', reason: 'Unsupported scheme' }
    ]);
  });

  it('drops a paywall notice found in the snippet', () => {
    const { results, rejected } = Search.filterAndRank([
      candidate('https://news.example.com/story', { snippet: 'Subscribe to read the rest.' })
    ], 8);

    expect(results).toEqual([]);
    expect(rejected[0].reason).toBe('Paywall notice in snippet');
  });

  it('keeps a single X post but rejects an X timeline', () => {
    const { results, rejected } = Search.filterAndRank([
      candidate('https://x.com/someone/status/1234567890', { engineRank: 1 }),
      candidate('https://twitter.com/someone', { engineRank: 2 })
    ], 8);

    expect(results.map(r => r.url)).toEqual(['https://x.com/someone/status/1234567890']);
    expect(rejected).toEqual([
      { url: 'https://twitter.com/someone', host: 'twitter.com', reason: 'Login wall' }
    ]);
  });

  it('keeps one URL per host and strips tracking parameters from what it keeps', () => {
    const { results, rejected } = Search.filterAndRank([
      candidate('https://example.com/a/b?utm_source=ddg&id=7', { engineRank: 1 }),
      candidate('https://www.example.com/a/b/', { engineRank: 2 }),
      candidate('https://other.example.org/c/d', { engineRank: 3 })
    ], 8);

    expect(results.map(r => r.url)).toEqual([
      'https://example.com/a/b?id=7',
      'https://other.example.org/c/d'
    ]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBe('Duplicate host');
  });

  it('ranks a trusted host above a better-placed ordinary result', () => {
    const { results } = Search.filterAndRank([
      candidate('https://blog.example.net/a/b', { engineRank: 1 }),
      candidate('https://developer.mozilla.org/en-US/docs/Web/CSS', { engineRank: 3 })
    ], 8);

    expect(results.map(r => r.host)).toEqual(['developer.mozilla.org', 'blog.example.net']);
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  it('penalises listing pages so an article outranks a tag index', () => {
    const { results } = Search.filterAndRank([
      candidate('https://a.example.com/tag/springs', { engineRank: 1 }),
      candidate('https://b.example.com/2026/springs-explained', { engineRank: 2 })
    ], 8);

    expect(results[0].host).toBe('b.example.com');
  });

  it('returns fewer than the limit rather than padding with rejected candidates', () => {
    const { results } = Search.filterAndRank([
      candidate('https://example.com/a.pdf', { engineRank: 1 }),
      candidate('https://good.example.net/a/b', { engineRank: 2 })
    ], 8);

    expect(results).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Settings resolution
// ---------------------------------------------------------------------------

describe('research settings', () => {
  it('defaults researchSourceCount to 8 in the shared defaults', async () => {
    jest.resetModules();
    require(SETTINGS_PATH);
    const captured = {};
    const browserAPI = {
      storage: { sync: { get: async (defaults) => Object.assign(captured, defaults) } }
    };

    const settings = await global.SettingsUtils.getUserSettings(browserAPI);

    expect(captured.researchSourceCount).toBe(8);
    expect(settings.researchSourceCount).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// research.js — the run engine
// ---------------------------------------------------------------------------

describe('ScrapLLMResearch run engine', () => {
  const TERMINAL = ['done', 'cancelled', 'error', 'empty', 'interrupted'];

  function source(index, extra = {}) {
    const host = `example${index}.com`;
    return Object.assign({
      url: `https://${host}/guides/topic-${index}`,
      host,
      title: `Result ${index}`,
      snippet: `Snippet ${index}`,
      engineRank: index,
      score: 20 - index
    }, extra);
  }

  // A browserAPI that behaves the way the engine assumes: creating a tab makes
  // it scriptable, removing one rejects whatever message is in flight against
  // it, and asking for a tab that is gone throws.
  function makeApi(options = {}) {
    const state = {
      created: [],
      live: new Map(),
      removed: [],
      maxLive: 0,
      nextId: 100,
      pendingConversions: new Map()
    };

    const api = {
      tabs: {
        query: async () => [{ id: 1, windowId: 7 }],
        create: async ({ url }) => {
          const tab = { id: state.nextId++, url, title: `Page title for ${url}` };
          state.created.push({ id: tab.id, url });
          state.live.set(tab.id, tab);
          state.maxLive = Math.max(state.maxLive, state.live.size);
          return tab;
        },
        get: async (tabId) => {
          if (!state.live.has(tabId)) throw new Error(`No tab with id: ${tabId}`);
          return state.live.get(tabId);
        },
        remove: async (tabId) => {
          state.removed.push(tabId);
          const existed = state.live.delete(tabId);
          const resolve = state.pendingConversions.get(tabId);
          if (resolve) {
            state.pendingConversions.delete(tabId);
            resolve({
              success: false,
              error: 'The message port closed before a response was received.'
            });
          }
          if (!existed) throw new Error(`No tab with id: ${tabId}`);
        },
        update: async () => {},
        sendMessage: async (tabId, message) => {
          if (!state.live.has(tabId)) throw new Error('Could not establish connection.');
          if (message.action === 'ping') {
            const tab = state.live.get(tabId);
            if (options.neverScriptable && options.neverScriptable(tab.url)) return {};
            return { success: true };
          }
          throw new Error(`unexpected action ${message.action}`);
        }
      },
      storage: options.storage || {}
    };

    return { api, state };
  }

  function sessionStore() {
    const data = {};
    return {
      data,
      get: async (key) => (key in data ? { [key]: data[key] } : {}),
      set: async (values) => Object.assign(data, values),
      remove: async (key) => { delete data[key]; }
    };
  }

  // Loads a fresh engine with the real MultiTabUtils and a stubbed search.
  function loadEngine({ searchResult, searchError, convert }) {
    jest.resetModules();
    delete global.ScrapLLMResearch;
    require(MULTITAB_PATH);

    const findSources = jest.fn(async () => {
      if (searchError) throw searchError;
      return searchResult;
    });
    global.ScrapLLMSearch = { findSources };

    require(RESEARCH_PATH);

    const convertSpy = jest.fn(convert);
    global.MultiTabUtils.convertTabToMarkdown = convertSpy;

    return { engine: global.ScrapLLMResearch, findSources, convertSpy };
  }

  // Fake timers keep the 20 s and 4 min budgets instant; every wait in the
  // engine is a setTimeout, so stepping the clock drives the whole run.
  async function advanceUntil(predicate, { step = 250, maxSteps = 600 } = {}) {
    for (let i = 0; i < maxSteps; i++) {
      if (predicate()) return;
      await jest.advanceTimersByTimeAsync(step);
    }
    throw new Error('the run never reached the expected state');
  }

  function waitForRun(engine) {
    return advanceUntil(() => TERMINAL.includes(engine.getSnapshot().phase));
  }

  function okConversion(markdown, tokenCount) {
    return { success: true, markdown, tokenCount, metadata: {} };
  }

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    delete global.ScrapLLMSearch;
  });

  it('clamps the source count and forces lazy loading off for every remote tab', async () => {
    const { api } = makeApi();
    const { engine, findSources, convertSpy } = loadEngine({
      searchResult: { results: [source(1)], engine: 'duckduckgo-html', usedRecency: false, rejected: [], degraded: null },
      convert: async () => okConversion('# One', 10)
    });

    engine.init(api);
    await engine.start({
      query: 'spring animations',
      sourceCount: 99,
      settings: { triggerLazyLoading: true, contentScope: 'mainContent' }
    });
    await waitForRun(engine);

    expect(findSources.mock.calls[0][1].limit).toBe(12);
    expect(convertSpy.mock.calls[0][1]).toMatchObject({
      triggerLazyLoading: false,
      contentScope: 'mainContent'
    });
  });

  it('refuses a second run while one is live', async () => {
    const { api } = makeApi();
    const { engine } = loadEngine({
      searchResult: { results: [source(1)], engine: 'duckduckgo-html', usedRecency: false, rejected: [], degraded: null },
      convert: async () => okConversion('# One', 10)
    });

    engine.init(api);
    await engine.start({ query: 'first', sourceCount: 5, settings: {} });

    await expect(engine.start({ query: 'second', sourceCount: 5, settings: {} }))
      .rejects.toThrow('A research run is already in progress.');

    await waitForRun(engine);
  });

  it('ends in the empty phase when the search returns nothing', async () => {
    const { api, state } = makeApi();
    const { engine } = loadEngine({
      searchResult: { results: [], engine: 'duckduckgo-html', usedRecency: false, rejected: [], degraded: null },
      convert: async () => okConversion('unused', 0)
    });

    engine.init(api);
    await engine.start({ query: 'nothing at all', sourceCount: 5, settings: {} });
    await waitForRun(engine);

    expect(engine.getSnapshot().phase).toBe('empty');
    expect(state.created).toHaveLength(0);
  });

  it('surfaces a search failure verbatim in the error phase', async () => {
    const { api } = makeApi();
    const { engine } = loadEngine({
      searchError: new Error('DuckDuckGo is rate limiting this device. Try again in a minute.'),
      convert: async () => okConversion('unused', 0)
    });

    engine.init(api);
    await engine.start({ query: 'anything', sourceCount: 5, settings: {} });
    await waitForRun(engine);

    const snapshot = engine.getSnapshot();
    expect(snapshot.phase).toBe('error');
    expect(snapshot.error).toBe('DuckDuckGo is rate limiting this device. Try again in a minute.');
  });

  it('records a source that never becomes scriptable, closes its tab once, and finishes the run', async () => {
    const stuck = source(2).url;
    const { api, state } = makeApi({ neverScriptable: (url) => url === stuck });
    const { engine } = loadEngine({
      searchResult: {
        results: [source(1), source(2), source(3)],
        engine: 'duckduckgo-html',
        usedRecency: false,
        rejected: [],
        degraded: null
      },
      convert: async (tabId) => okConversion(`# Body ${tabId}`, 100)
    });

    engine.init(api);
    await engine.start({ query: 'spring animations', sourceCount: 5, settings: {} });
    await waitForRun(engine);

    const snapshot = engine.getSnapshot();
    expect(snapshot.phase).toBe('done');
    expect(snapshot.succeeded).toBe(2);
    expect(snapshot.failed).toBe(1);

    const failed = snapshot.entries.find(entry => entry.url === stuck);
    expect(failed.status).toBe('error');
    expect(failed.note).toBe('Page did not become scriptable within 20 s');

    const stuckTab = state.created.find(tab => tab.url === stuck);
    expect(state.removed.filter(id => id === stuckTab.id)).toHaveLength(1);
    expect(state.live.size).toBe(0);
  });

  it('never opens more than three tabs at once', async () => {
    const results = [1, 2, 3, 4, 5, 6].map(i => source(i));
    const { api, state } = makeApi();
    const { engine } = loadEngine({
      searchResult: { results, engine: 'duckduckgo-html', usedRecency: false, rejected: [], degraded: null },
      convert: async (tabId) => okConversion(`# Body ${tabId}`, 50)
    });

    engine.init(api);
    await engine.start({ query: 'spring animations', sourceCount: 12, settings: {} });
    await waitForRun(engine);

    expect(state.maxLive).toBeLessThanOrEqual(3);
    expect(state.created).toHaveLength(6);
    expect(engine.getSnapshot().succeeded).toBe(6);
  });

  it('cancels cleanly: open tabs are closed, nothing new is opened, earlier successes survive', async () => {
    const results = [1, 2, 3, 4, 5].map(i => source(i));
    const fast = source(1).url;
    const { api, state } = makeApi();
    const { engine } = loadEngine({
      searchResult: { results, engine: 'duckduckgo-html', usedRecency: false, rejected: [], degraded: null },
      convert: (tabId) => {
        const tab = state.live.get(tabId);
        if (tab && tab.url === fast) {
          return Promise.resolve(okConversion('# Captured before the cancel', 120));
        }
        // Hangs until its tab is removed, which is how a real conversion dies.
        return new Promise(resolve => state.pendingConversions.set(tabId, resolve));
      }
    });

    engine.init(api);
    const runId = await engine.start({ query: 'spring animations', sourceCount: 5, settings: {} });

    await advanceUntil(() => engine.getSnapshot().succeeded === 1);
    const createdAtCancel = state.created.length;
    const liveAtCancel = Array.from(state.live.keys());

    engine.cancel(runId);
    await waitForRun(engine);

    const snapshot = engine.getSnapshot();
    expect(snapshot.phase).toBe('cancelled');
    expect(snapshot.succeeded).toBe(1);
    expect(state.created).toHaveLength(createdAtCancel);
    liveAtCancel.forEach(tabId => expect(state.removed).toContain(tabId));
    expect(state.live.size).toBe(0);

    const cancelledEntries = snapshot.entries.filter(entry => entry.status === 'skipped');
    expect(cancelledEntries.length).toBeGreaterThan(0);
    expect(cancelledEntries.every(entry => entry.note === 'Cancelled by user')).toBe(true);

    const doc = await engine.getDocument(runId);
    expect(doc.markdown).toContain('# Captured before the cancel');
    expect(doc.markdown).toContain('Cancelled by user');
  });

  it('skips the remaining sources when the run exceeds its budget', async () => {
    const results = [1, 2, 3, 4].map(i => source(i));
    const { api } = makeApi();
    let firstConversion = true;
    const { engine } = loadEngine({
      searchResult: { results, engine: 'duckduckgo-html', usedRecency: false, rejected: [], degraded: null },
      convert: async (tabId) => {
        if (firstConversion) {
          firstConversion = false;
          // Simulate a page that stalled long enough to eat the whole budget.
          jest.setSystemTime(Date.now() + 250000);
        }
        return okConversion(`# Body ${tabId}`, 40);
      }
    });

    engine.init(api);
    const runId = await engine.start({ query: 'spring animations', sourceCount: 5, settings: {} });
    await waitForRun(engine);

    const snapshot = engine.getSnapshot();
    expect(snapshot.skipped).toBeGreaterThanOrEqual(1);
    const skipped = snapshot.entries.find(entry => entry.status === 'skipped');
    expect(skipped.note).toBe('Skipped: the run exceeded the 4-minute budget');

    const doc = await engine.getDocument(runId);
    expect(doc.markdown).toContain('### Not fetched');
    expect(doc.markdown).toContain(`- ${skipped.url} — Skipped: the run exceeded the 4-minute budget`);
  });

  it('closes orphaned tabs after a restart and reports the interrupted phase', async () => {
    const store = sessionStore();
    store.data['scrapllm.researchRun'] = {
      runId: 'research-old',
      phase: 'running',
      query: 'spring animations',
      openTabIds: [11, 12],
      entries: [{ url: 'https://example1.com/a', host: 'example1.com', title: 'A', status: 'fetching', note: 'Fetching', tokenCount: 0, notes: [] }],
      expiresAt: Date.now() + 600000,
      resultsTooLargeToPersist: false
    };

    const { api, state } = makeApi({ storage: { session: store } });
    const { engine } = loadEngine({
      searchResult: { results: [], engine: 'duckduckgo-html', usedRecency: false, rejected: [], degraded: null },
      convert: async () => okConversion('unused', 0)
    });

    engine.init(api);
    await engine.recoverOrphans();

    expect(state.removed).toEqual([11, 12]);
    const snapshot = engine.getSnapshot();
    expect(snapshot.phase).toBe('interrupted');
    expect(snapshot.query).toBe('spring animations');
    expect(snapshot.total).toBe(1);
  });

  it('reports run results as gone once nothing is stored for the run', async () => {
    const { api } = makeApi();
    const { engine } = loadEngine({
      searchResult: { results: [], engine: 'duckduckgo-html', usedRecency: false, rejected: [], degraded: null },
      convert: async () => okConversion('unused', 0)
    });

    engine.init(api);

    await expect(engine.getDocument('research-missing')).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// research.js — the merged document
// ---------------------------------------------------------------------------

describe('ScrapLLMResearch document builder', () => {
  const TERMINAL = ['done', 'cancelled', 'error', 'empty', 'interrupted'];

  function source(index, extra = {}) {
    const host = `example${index}.com`;
    return Object.assign({
      url: `https://${host}/guides/topic-${index}`,
      host,
      title: `Result ${index}`,
      snippet: `Snippet ${index}`,
      engineRank: index,
      score: 20 - index
    }, extra);
  }

  function makeApi() {
    const state = { live: new Map(), nextId: 100 };
    return {
      state,
      api: {
        tabs: {
          query: async () => [{ id: 1, windowId: 7 }],
          create: async ({ url }) => {
            const tab = { id: state.nextId++, url, title: `Page title for ${url}` };
            state.live.set(tab.id, tab);
            return tab;
          },
          get: async (tabId) => {
            if (!state.live.has(tabId)) throw new Error(`No tab with id: ${tabId}`);
            return state.live.get(tabId);
          },
          remove: async (tabId) => { state.live.delete(tabId); },
          update: async () => {},
          sendMessage: async (tabId, message) => {
            if (!state.live.has(tabId)) throw new Error('Could not establish connection.');
            if (message.action === 'ping') return { success: true };
            throw new Error('unexpected action');
          }
        },
        storage: {}
      }
    };
  }

  async function runOnce({ query, results, rejected = [], degraded = null, convert }) {
    jest.resetModules();
    delete global.ScrapLLMResearch;
    require(MULTITAB_PATH);
    global.ScrapLLMSearch = {
      findSources: async () => ({
        results,
        engine: 'duckduckgo-html',
        usedRecency: false,
        rejected,
        degraded
      })
    };
    require(RESEARCH_PATH);

    const { api, state } = makeApi();
    global.MultiTabUtils.convertTabToMarkdown = jest.fn(async (tabId) => convert(state.live.get(tabId)));

    const engine = global.ScrapLLMResearch;
    engine.init(api);
    const runId = await engine.start({ query, sourceCount: 8, settings: {} });

    for (let i = 0; i < 600; i++) {
      if (TERMINAL.includes(engine.getSnapshot().phase)) break;
      await jest.advanceTimersByTimeAsync(250);
    }

    const doc = await engine.getDocument(runId);
    return { engine, doc, snapshot: engine.getSnapshot() };
  }

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    delete global.ScrapLLMSearch;
  });

  it('writes front matter, a numbered source list, the not-fetched block and the section separator', async () => {
    const { doc, snapshot } = await runOnce({
      query: 'apple spring animations',
      results: [source(1), source(2), source(3)],
      rejected: [{ url: 'https://wsj.com/b', host: 'wsj.com', reason: 'Paywalled' }],
      degraded: 'only 3 usable sources after filtering',
      convert: async (tab) => {
        if (tab.url.includes('topic-2')) {
          return { success: false, error: 'Conversion did not answer within 30 s' };
        }
        return { success: true, markdown: `Body of ${tab.url}`, tokenCount: 1200, metadata: {} };
      }
    });

    expect(snapshot.phase).toBe('done');
    expect(doc.tokenCount).toBe(2400);

    expect(doc.markdown).toContain('---\nResearch: apple spring animations\n');
    expect(doc.markdown).toContain('Engine: duckduckgo-html');
    expect(doc.markdown).toContain('Sources: 2 of 3 fetched');
    expect(doc.markdown).toContain('Tokens: ~2400 (o200k_base estimate)');
    expect(doc.markdown).toContain('Notes: only 3 usable sources after filtering');

    expect(doc.markdown).toContain('## Sources');
    expect(doc.markdown).toContain('1. [Page title for https://example1.com/guides/topic-1](https://example1.com/guides/topic-1) — example1.com');
    expect(doc.markdown).toContain('2. [Page title for https://example3.com/guides/topic-3](https://example3.com/guides/topic-3) — example3.com');

    expect(doc.markdown).toContain('### Not fetched');
    expect(doc.markdown).toContain('- https://example2.com/guides/topic-2 — Conversion did not answer within 30 s');
    expect(doc.markdown).toContain('- https://wsj.com/b — Paywalled (skipped before fetching)');

    expect(doc.markdown).toContain('\n\n---\n\n## 1. ');
    expect(doc.markdown).toContain('## 2. ');
    expect(doc.markdown).not.toContain('## 3. ');
    expect(doc.markdown).toContain('Body of https://example1.com/guides/topic-1');
  });

  it('attaches the lazy-loading note to every source and the X note to X sources', async () => {
    const { doc, snapshot } = await runOnce({
      query: 'x thread on springs',
      results: [
        source(1),
        source(2, { url: 'https://x.com/someone/status/42', host: 'x.com' })
      ],
      convert: async (tab) => ({ success: true, markdown: `Body of ${tab.url}`, tokenCount: 10, metadata: {} })
    });

    const lazyNote = 'Note: Scroll pass skipped: background tabs are not rendered, so lazy-loaded sections cannot be triggered';
    expect(doc.markdown.match(new RegExp(lazyNote.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))).toHaveLength(2);
    expect(doc.markdown).toContain('Note: X timelines are virtualised; a background tab captures only the server-rendered portion');

    const xEntry = snapshot.entries.find(entry => entry.host === 'x.com');
    expect(xEntry.notes).toHaveLength(2);
  });

  it('omits the not-fetched block when nothing failed and nothing was rejected', async () => {
    const { doc } = await runOnce({
      query: 'spring animations',
      results: [source(1), source(2)],
      convert: async (tab) => ({ success: true, markdown: `Body of ${tab.url}`, tokenCount: 5, metadata: {} })
    });

    expect(doc.markdown).not.toContain('### Not fetched');
  });

  it('caps the filename slug at 40 characters', async () => {
    const { doc } = await runOnce({
      query: 'how do apple style spring animations actually work in a browser',
      results: [source(1)],
      convert: async (tab) => ({ success: true, markdown: `Body of ${tab.url}`, tokenCount: 5, metadata: {} })
    });

    const match = doc.filename.match(/^scrapllm-research-(.+)-(\d{4}-\d{2}-\d{2})\.md$/);
    expect(match).not.toBeNull();
    expect(match[1]).toBe('how_do_apple_style_spring_animations_act');
    expect(match[1]).toHaveLength(40);
  });
});
