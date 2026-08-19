# ScrapLLM — contributor and agent guide

Everything an agent (or a person) needs to change this extension safely: how it is put together, what to run to prove a change works, and the rules that are not negotiable.

## Hard rules

1. **Never run tests.** No jest, vitest, or any other runner, not one file. Build, type-check and lint instead — they are seconds, not minutes, and they prove the same things about a change of this kind.
2. **No AI attribution in commits.** No `Co-Authored-By` trailers, no "generated with" footers.
3. **No silent fallbacks.** If an extraction path fails, say so with a specific message; do not quietly degrade to a worse result without telling the user.
4. **Commit message format** (enforced by a hook): area on line one (`Frontend`, `Backend`, `Docs`), blank line, `Changes:`, blank line, then bullets stating the user-visible result.

## What to run

```bash
node --check extension/<file>.js                 # syntax
npx eslint@8 --no-eslintrc --env browser,es2022 \
  --parser-options ecmaVersion:2022 extension/*.js
bash scripts/build.sh all                        # packaging, all three targets
jq empty extension/manifest.json                 # manifest validity
```

For UI work, load the built package and look at it. The popup can also be opened
directly as `file://…/extension/popup.html` with a stubbed `chrome` API for
quick visual checks.

## Architecture

```
popup.js  ──messages──▶  content.js  ──▶  extractor (selection / chat / reddit / x / generic)
   │                          │
   │                          └──▶ Turndown ──▶ Markdown ──▶ clipboard / file
   └── browser.storage.sync (settings, shared with background.js)
```

`content.js` owns `convertToMarkdown(settings)`. It dispatches on `contentScope`
and on the page itself, in this order:

| Condition | Handler |
|-----------|---------|
| `contentScope: 'chat'` | `ScrapLLMChat.convert()` — see `chat.js` |
| `contentScope: 'selection'` | `ScrapLLMSelection.convert()` — see `selection.js` |
| Reddit URL and `redditMode` | `ScrapLLMReddit.convert()` |
| X URL and `xMode` | `ScrapLLMX.convert()` |
| otherwise | Readability (main content) / full page / selection |

Extractors return `{ markdown, articleData }`, or `null` to mean "nothing here,
fall through to the generic path". Anything else throws with a message the popup
shows verbatim.

### Message actions

| Action | Direction | Purpose |
|--------|-----------|---------|
| `convertToMarkdown` | popup/background → content | Run a conversion |
| `getSelectionInfo` | popup → content | Is there a selection? (drives the Copy Selection button) |
| `getChatInfo` | popup → content | Is this a conversation? (drives the Copy Chat button) |
| `getDebugLogs`, `copyToClipboard`, `downloadMarkdown`, `downloadFile`, `showNotification` | popup → content | Utilities |
| `scrapllm-research` (port) | popup ⇄ background | Long-lived research channel: `start`, `cancel`, `sync`, `getDocument` up; `snapshot`, `accepted`, `document`, `error` down. Also keeps the MV3 worker alive for the run. |

### Extractors

**`selection.js`** — a highlighted fragment becomes a cited excerpt. Structure
wins over heuristics: a highlighter's markup (`pre`, `.highlight`, `language-*`,
`hljs-*`, `data-lang`) is authoritative; only when the DOM is silent does the
scored text heuristic decide code vs prose. Code is emitted verbatim in a fence
(dedented, fence length adapted to inner backticks) because Turndown escapes the
punctuation that makes code readable. Output starts with
`> Lines A to B of code|text from [host/path](url)`.

**`chat.js`** — a conversation is a tree, not a list: editing a message
mid-thread grows a sibling branch and the old one stays in the database. Both
API paths (`claude.ai` via `chat_conversations?tree=True`, `chatgpt.com` via
`/backend-api/conversation/<id>` with the session bearer token) walk parents up
from the active leaf, so the export matches what the user sees. Everything else
is read from the DOM: known layouts first, then role markers (author-role
attributes, then class/testid/aria hints). Off the known hosts detection is
deliberately conservative — four or more turns *and* explicit role markers on
most of them — so a comment thread does not light the button up.
`chatExchangeLimit` defaults to 10 exchanges, not 'all'.

**`reddit.js`** — the post plus its comment tree from Reddit's own JSON, fetched
same-origin (no extra host permission, and the user's session applies). Falls
back to scraping `shreddit-*` or old.reddit markup when the JSON endpoint
answers with the bot check.

**`x.js`** — threads, profiles and timelines. Signed-out x.com serves a
server-rendered page with schema.org microdata and no `data-testid`; the
extractor reads that, with the logged-in app's selectors as per-field fallbacks.

### Research

One question in, one Markdown file out. Two stages, both in the background:

1. **Discovery** — `search.js` fetches DuckDuckGo's `html.duckduckgo.com/html/`
   endpoint (falling back to `lite.duckduckgo.com/lite/`) and parses the reply
   with string and regex work on the raw text. There is no `DOMParser` in a
   service worker, and an offscreen document was rejected for the same reason it
   would not help: the markup we need is plain enough to match, while a parsed
   document pins its base URI to the extension and still runs no page JS. The
   module is pure — no tabs, no storage, no messaging — so it is testable on
   fixtures alone. Candidates are filtered (non-pages, login walls, paywalls,
   duplicate hosts and URLs), scored, and cut to the requested count; every
   dropped candidate keeps the reason it was dropped.
2. **Capture** — `research.js` captures each accepted source on one of two
   paths, per source:

   * **quiet** (the default) — `quiet-capture.js` fetches the source's HTML
     from the background and `convert-core.js` converts it with the same
     Readability + Turndown code the content script runs. No tab is created at
     any point. This is not a compromise: on most pages the server-rendered
     HTML is the *better* capture, because post-hydration UI chrome is not
     there for Readability to keep.
   * **rendered** — the source is opened in one muted background tab, polled
     with `ping` until the declaratively injected content script answers, then
     asked for Markdown through the ordinary `convertToMarkdown` action. No new
     content-script action exists, and the research path never calls
     `ensureContentScriptLoaded`.

   The background fetch is **credential-less** (`credentials: 'omit'`). Host
   access here means "read any site from the background", and attaching the
   cookie jar would turn that into reading the user's logged-in copy of
   whatever a result — or its redirect chain — points at, into a document that
   is about to be pasted into an LLM. A page that genuinely needs the session
   is not lost: it comes back walled, thin or non-2xx and escalates to a tab,
   where the session applies in the user's own window and the user can see it.

   Two guards sit around the fetch, and both are **rejections** rather than
   escalations, because a tab would perform the same request:

   * **Destination** — `privateDestinationReason` refuses `localhost`,
     `*.local`, `*.internal`, `*.home.arpa`, a hostname with no dot, any
     non-`http(s)` scheme, and IP literals in 0/8, 10/8, 127/8, 169.254/16,
     172.16/12, 192.168/16, 100.64/10, 224/4, `::1`, `::`, fc00::/7 and
     fe80::/10 (including IPv4-mapped forms). It runs on the requested URL for
     **both** paths, and again on the final URL after redirects. What it cannot
     see is stated in the code rather than implied: `fetch` never exposes
     intermediate hops (`redirect: 'manual'` yields an opaque response), so a
     chain passing *through* a private host still performs that GET, and a
     public name resolving to a private address (DNS rebinding, or an A record
     pointing at 10.x) passes. Closing either needs declarativeNetRequest rules
     scoped to the run.
   * **Size** — `MAX_BYTES` (5 MiB). `content-length` short-circuits the
     obvious case; otherwise the body is read through the stream reader with a
     running byte count and cancelled the moment it goes over. The 10 s timeout
     bounded time, never bytes, and the whole body is held as a string and then
     structured-cloned to the parser, three sources at a time.

   A source escalates from quiet to rendered on exactly these signals, in this
   order, each carrying its own verbatim reason: a network failure, an unusable
   content type, or a 404/410 is a **rejection** (a tab cannot help a PDF, it
   cannot conjure a page the site says is not there — it would only capture the
   site's error page and file it as a source — and the tab path's own habit of
   capturing Chrome's TLS interstitial as an article is worse than saying
   "certificate has expired"); a body the server never named as anything and
   that does not open like markup is a rejection too, because a parser should
   not be handed bytes on a guess; any other non-2xx status, a redirect onto a
   consent/login **host or path** (a same-site hop to `/login` or `/subscribe`
   is the same event as a hop to an SSO domain, and such a page is well over
   the character floor, so nothing else would catch it), an empty
   `#root`/`#__next`/`app-root` shell, a parse that
   failed, or fewer than 500 characters of Readability text is a **render**. The
   split inside non-2xx is the point: a 403, 429 or 503 is usually a bot check
   the user's own tab walks straight through, while 404 and 410 are final.
   Reddit and X escalate before the fetch, because their extractors need the
   live page (on every host form they claim: `x.com`, `twitter.com` and any
   subdomain of either, and any subdomain of `reddit.com`). `MIN_TEXT_CHARS` is
   a guard, not a preference: over 30 measured pages the worst junk page
   yielded 98 characters and the weakest genuine article 1385. Above the floor
   but under 1500 characters the capture is kept *and* says how thin it was —
   in the document, and on the row, which ends `· thin` and carries the full
   sentence in its hover text and `aria-label`. The sheet is what the user
   reads before deciding the run went fine, so the caveat cannot live only in
   the saved file.

   Cancelling opens no tabs. `cancel()` aborts the run's controller and closes
   its tabs, and deliberately leaves the offscreen parser alone — tearing it
   down rejects the parses already in flight, a rejected parse is an escalation
   signal, and the escalation would have opened a burst of tabs at the exact
   moment the user asked for none. `execute()` closes it a moment later, once
   the pool has drained. `fetchOne` re-checks `run.cancelled` between the quiet
   capture and the tab, for the same reason.

   The parsing needs a DOM. Chrome MV3 has none in the worker, so it uses one
   offscreen document (`offscreen.html`, reason `DOM_PARSER`) for the whole run,
   created lazily and closed on every exit path including orphan recovery.
   Firefox's background is a real page and parses in place. The branch is
   `typeof DOMParser !== 'undefined'`, never a browser name.

   The fetch needs host access, which is requested as an **optional** host
   permission from the Research button's click handler — both browsers only
   honour `permissions.request` inside a user gesture, and the result hosts are
   unknown until discovery has run, so a per-host request afterwards is
   impossible. Denial is not a failure: the run falls back to a tab per source,
   which needs no host permission, and says so once at run level. "No access"
   is not one answer, so it is not reported as one: a decline, a browser with
   no optional-origin API (`optional_host_permissions` is Firefox 116+, and the
   package's `strict_min_version` is 109), and a `request` that threw each
   carry their own sentence from the popup into the run's capture note. The
   engine does not simply believe the flag either — it re-checks with
   `permissions.contains` before choosing the quiet path, so a stale or forged
   flag cannot make the background attempt fetches it is not allowed to make.
   The grant is not released when the run ends: auto-revoking would re-prompt
   on every run, and a permanent grant with a visible control to hand it back
   is a settings-level change, not part of this path.

   `researchCapture` (`'quiet'` / `'render'`) lets the user force the tab path.
   Its control is a radio pair in the Settings view, with the other
   preferences — it is a preference, not a per-run choice, so it does not sit
   in the run sheet next to the source count.

Brave Search was rejected as a fallback (rate limited after a handful of
queries, build-hashed class names) and the Google News RSS recency booster was
rejected because its links only resolve inside a real tab. Recency is `&df=d` on
DuckDuckGo instead.

Research always forces `triggerLazyLoading: false` — a background tab is never
rendered and the quiet path has no tab at all, so a scroll pass would spend the
budget and change nothing. It also forces `contentScope` to `mainContent`
unless the user saved `fullPage`: a research source is neither a selection nor
a conversation, and a saved `selection` scope would make every capture throw
"No text is selected", on both paths, so a whole run would cost eight fetches
plus eight tabs and produce nothing. Every rendered source says so, in its row in the
popup and in a `Note:` line in the document; every quiet source says it was
captured from the server-rendered HTML instead. X hosts carry a second note
about virtualised timelines. Each entry carries `path` (`quiet` / `rendered`)
and `pathReason` into the snapshot, the popup row and the document, and the
document's front matter counts both. In the row only a `rendered` source is
marked, as `host · rendered` on the host line: quiet is what the run already
promised, so marking every row would be decoration rather than information.
The mark is spring-driven (`PRESETS.snappy`) out of the host it belongs to,
cross-fades instead under `prefers-reduced-motion`, and the row's `aria-label`
names the path either way.

The document is written to be read by a model, so a source cannot be allowed to
write structure into it. Titles come from the fetched page's own `<title>`: they
are flattened to one line, their Markdown punctuation escaped and their length
bounded before they reach a `## N.` header or a link text, link targets are
emitted in the `<…>` form with the characters that could close them
percent-encoded, and every reason, note and raw URL in `### Not fetched` is
flattened the same way. A body is not fenced — Readability output legitimately
contains headings and rules, so fencing would change every real capture to buy
nothing the section numbering does not already give.

Token counts always come from `ScrapLLMConvert.estimateTokens`, including for a
`text/plain` or `text/markdown` source that skips the converter entirely; the
Chrome worker has no `ScrapLLMConvert`, so it asks the offscreen document
(`estimateTokens` action). A second formula would put a number in the front
matter that disagrees with the sources it sums.

Per-source code is passed its own `run` and never reads the module-level
`state`: `persistState(run, extra)` and `waitForScriptable(run, …)` take it as
an argument, and `cancel()` captures it once. `state` is only the *current* run,
and a worker still finishing an earlier one would otherwise write that run's
tabs into the new run's record — where orphan recovery would never find them.
`recoverOrphans()` closes the offscreen document *before* it reads the persisted
state, because when `storage.session` is unavailable that state lived in a
module variable that died with the worker, and the orphaned document is exactly
what has to be closed in that case.

| Constant | Value |
|----------|-------|
| `RESEARCH_CONCURRENCY` | 3 (the multi-tab path keeps 4) |
| `PING_INTERVAL_MS` / `PAGE_LOAD_TIMEOUT_MS` | 250 / 20000 |
| `SETTLE_DELAY_MS` / `CONVERT_TIMEOUT_MS` | 400 / 30000 |
| `SEARCH_TIMEOUT_MS` / `TOTAL_BUDGET_MS` | 10000 / 240000 |
| `FETCH_TIMEOUT_MS` / `PARSE_TIMEOUT_MS` | 10000 / 5000 |
| `MIN_TEXT_CHARS` / `QUIET_THIN_CHARS` | 500 / 1500 |
| `MAX_BYTES` (one fetched body) | 5242880 |
| `PROGRESS_THROTTLE_MS` / `RESULT_RETENTION_MS` | 250 / 600000 |
| `MAX_PERSIST_BYTES` | 5242880 |

Every constant above is a guard, not a preference. 20 s of ping polling is what
separates "the page is slow" from "nothing will ever run here" (a PDF in the
browser's viewer, an interstitial, a tab that was closed under us) — the load
event is not used at all, because a script-heavy page answers a ping long before
`complete` and a stalled subresource can hold `complete` forever. 30 s caps a
content script that accepted the message and never replied. 4 minutes caps the
run itself, so a slow tail comes back as `skipped` rather than as a popup that
never finishes; three concurrent tabs is what keeps a run from behaving like a
crawler on the user's own machine and network. Each limit produces its own
verbatim message, and every one of them lands in the popup row *and* in the
document's `### Not fetched` block.

Discovery failures are classified rather than flattened, in this order: a
zero-result marker is an empty answer, not an error; an anomaly banner is
throttling and never triggers the fallback (it is IP-level, so the sibling
endpoint would fail the same way); a 200 with no parsable blocks and no marker
is markup drift and says so. A half-filled result set is never returned as a
success.

Host permissions: `https://html.duckduckgo.com/*` and
`https://lite.duckduckgo.com/*` are required (discovery). The quiet path's
`*://*/*` is **optional** and requested at run time; the tab path needs none, so
declining costs visibility, never capability. Chrome also declares the
`offscreen` permission, which the build strips from the Firefox manifest.

The popup talks to the engine over one long-lived port, `scrapllm-research`,
opened on `DOMContentLoaded`. There is no `runtime.sendMessage` path: the popup
needs a stream, and an open port is also what keeps the MV3 worker alive for the
length of a run.

| Direction | Message |
|-----------|---------|
| popup → background | `start {query, sourceCount, settings, hostAccess, hostAccessNote}`, `cancel {runId}`, `sync {}`, `getDocument {runId}` |
| background → popup | `snapshot {snapshot}` (throttled to 250 ms, always flushed on a phase change), plus `accepted`, `document` and `error` replies |

The snapshot is the whole UI state — phase, counts, per-source rows with their
status and note, and the rejected candidates. Markdown never travels in a
snapshot; the popup asks for the document once, at the end.

`convert-core.js` owns the document-to-Markdown path and is loaded in three
contexts: as a content script (before `content.js`), in Chrome's offscreen
document, and in Firefox's background page. It never reads `window.location` or
`document.title` — the caller passes the *source's* URL and title, because in
the background contexts the ambient document is the extension's own page. A
`<base href>` is injected into fetched HTML before Readability runs, so relative
links resolve against the source site rather than `chrome-extension://`.
Selection, chat and the live scroll pass stay in `content.js`: they need a
rendered page.

`multi-tab-utils.js` owns the two pieces both paths share: `runPool` (index
cursor, dense results, the handler must resolve rather than reject) and
`convertTabToMarkdown`. The multi-tab path keeps its 4-way concurrency,
research passes 3; neither has its own copy of the loop.

Tests live in `tests/research.test.js`: fixture-driven parsing and filtering for
`search.js`, and a fake `browserAPI` plus jest fake timers for the engine —
concurrency, cancellation bookkeeping, the budget, orphan recovery and the
document builder. Write them, never run them.

Run state lives in `storage.session` when the browser has it (Chrome, Firefox
115+) and in a module variable otherwise; either way `recoverOrphans()` runs at
module evaluation and closes tabs a crashed or restarted worker left behind.

### Motion and interface

`motion.js` owns every value the user can touch. Rules:

1. **Springs, never CSS transitions, for anything gesture-driven.** A transition
   cannot be grabbed and reversed mid-flight; a spring re-targets from its live
   value and carries velocity. CSS transitions are allowed only for colour,
   opacity, shadow and the press scale.
2. **Feedback on pointer-down.** `Motion.pressable()` adds `.is-pressed` on
   `pointerdown`, drops it when the pointer leaves (with ~10px of slop).
3. **Gestures track 1:1, then hand off velocity.** `Motion.draggable()` gives
   pointer capture and a release velocity; `Motion.project()` picks the landing
   target from where the flick is going; `Motion.rubberband()` resists at edges.
4. **Chrome is a material** — translucent layers with content passing under, and
   a scroll-edge mask instead of divider lines.

| Export | Purpose |
|--------|---------|
| `new Spring(value, {damping, response, onUpdate, onRest})` | `damping` 1.0 = no overshoot, `response` = seconds to approach |
| `spring.to(target, {velocity})` / `spring.set(value)` | Re-target mid-flight / write directly during a drag |
| `PRESETS` | `move` (1.0/0.4), `sheet` (0.8/0.3), `rotate` (0.8/0.4), `snappy` (1.0/0.28) |
| `project`, `rubberband`, `draggable`, `pressable`, `prefersReducedMotion` | Momentum, boundaries, gestures, press state, accessibility |

`styles.css` answers `prefers-reduced-motion` (cross-fades, no travel),
`prefers-reduced-transparency` (frosted-solid surfaces) and
`prefers-contrast: more` (near-opaque, bordered). Type uses the platform font
with size-specific tracking and rem spacing, so the user's text-size setting
grows the layout.

## Adding a setting

1. Default in `extension/settings.js` (shared by popup and background).
2. Control in `popup.html`.
3. Plumbing in `popup.js`: element handle, `loadSettings`, `saveSettings`,
   `getCurrentSettings`, the two inline conversion payloads, and a change listener.
4. Read it in `content.js` or the relevant extractor.

Worked example — `researchSourceCount` (default `8`, allowed 5 / 8 / 12): the
default sits in `settings.js`, the segmented control lives in the research
sheet in `popup.html`, `popup.js` carries the element handle plus `loadSettings`,
`saveSettings`, `getCurrentSettings` and a change listener, and it is consumed
only by `research.js` through the `start` payload — research is a background
concern, so no extractor reads it. `research.js` re-clamps to 5..12 whatever
the popup sends.

## Adding a file to the extension

`manifest.json` (`content_scripts[0].js`, order matters — helpers before
`content.js`) **and** `scripts/build.sh`, which copies files explicitly in three
places (Chrome, Firefox, source).

A background-only file is not a content script: add it to the `importScripts`
call at the top of `background.js` (Chrome) and to the `background.scripts`
array in the build script's Firefox jq program, in load order. `search.js`,
`quiet-capture.js` and `research.js` are the examples.

A file that belongs to only one browser goes in that browser's `cp` block
alone: `offscreen.html` and `offscreen.js` ship to Chrome and to the source
package, never to Firefox, which has no offscreen API and needs none. A file
that both a content script and the background use — `convert-core.js` — goes in
`content_scripts[0].js`, in Firefox's `background.scripts`, in the offscreen
page's `<script>` list, and in all three `cp` blocks.

## Browser differences

Chrome is MV3 with a service worker; the build script rewrites the manifest for
Firefox (MV2 background scripts, `browser_specific_settings`). Use the
`browserAPI` wrapper in the popup and `browserRuntime` in content scripts.
