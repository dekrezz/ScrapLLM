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

On a page that holds a conversation the popup hides the page-conversion key and
Download switches to the chat scope: a virtualised transcript converted as a page
is whichever messages happened to be rendered, which is a slice of the middle
dressed up as a document. The page conversion stays one click away in the chat
action's menu, because chat detection can be wrong and the page is sometimes what
the user wants — and when it runs there, the output carries a note saying only the
rendered messages were captured.

**`chat.js`** — the Claude request matters as much as the parsing: with
`rendering_mode=raw` the API returns no `content` array at all, and the flat
`text` it falls back to has already had thinking folded into the answer and every
tool block replaced by "This block is not supported on your current device yet".
The export therefore asks for
`?tree=True&rendering_mode=messages&render_all_tools=true` and renders the blocks
in their own order — one message can hold several text blocks, thinking before
*and* after the answer, and several tool round-trips. Reasoning goes into a
`<details>` disclosure the way the site hides it, a tool call becomes its
on-screen label plus its `display_content` code block, search results become a
list of sources, and a shell result shows its `stdout` rather than the JSON
envelope around it. `tree=True` is not optional: without it that test
conversation lost 31 of 429 messages.

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

Google's AI Mode is handled by its own extractor rather than the role heuristic:
it has no per-turn elements and its class names are build hashes, but two things
are stable — the question is the URL's q parameter and the answer is Google's own
result column, `data-container-id="main-col"`. It lives on `/search`, the same
path as an ordinary result page, so the registry entry carries a `query` guard
(`udm=50`) alongside the path test; without it every Google search would offer to
copy a conversation. Citation chips are icon-only links, so they are dropped
before conversion — otherwise every second sentence ends in an empty link.

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

### The ladder, the walls and the junk filter

A source is no longer captured once and dropped if that fails. `research.js`
runs a ladder, per source, with its own attempt budget:

1. the quiet fetch,
2. a background tab, when the fetched HTML cannot answer for the page,
3. one delayed retry of both, jittered (`RETRY_BASE_DELAY_MS` +
   0–`RETRY_JITTER_MS`, so three workers that all met the same rate limiter do
   not come back together),
4. giving up, with both halves of the story in one sentence: `<first failure>;
   the retry 3 s later failed too: <second failure>`.

`MAX_ATTEMPTS_PER_SOURCE` is 2 and there is no third pass. The run's own
4-minute budget is never extended for persistence: a retry is only started when
the delay *plus* a whole capture still fits (`RETRY_MIN_REMAINING_MS`), so a
slow tail comes back as the failure the user needed to read rather than as the
budget message. A source that only worked the second time says so, in the
document and on the row, because the first failure is part of what that capture
is.

Which failures earn the retry is not a guess — every verdict from
`quiet-capture.js` now carries a `category` next to its `decision` and its
verbatim `reason`:

| Category | Meaning | Retried? |
|----------|---------|----------|
| `transient` | network failure, timeout, 5xx, an unrendered page, a tab that never became scriptable | yes |
| `wall` | an active bot challenge, a repeated 401/403/429, a hard paywall, a login or consent wall that yielded nothing in a tab either | no |
| `unusable` | a private destination, a PDF or other non-HTML type, a body over `MAX_BYTES`, a 404/410 | no |
| `junk` / `duplicate` | the quality gate dropped it | no |

A `wall` row reads as `skipped` rather than `error`: the page did not fail to
be captured, it refused to be, which is the same kind of event as a page the
quality gate drops. `unusable` keeps `error`, because a PDF or a private
address is a source the run could never have used. The popup draws the two
differently — a muted dash for a skip, the red exclamation only for a genuine
failure — off `entry.category`, and the result card counts them apart
("2 failed, 1 skipped, 1 dropped by the filter") instead of calling every
non-success a failure. Cancelling a run therefore repaints the list as skips,
which is what the user just asked for, not as a column of errors.

The wall detectors extend the signals that were already measured rather than
duplicating them. `botChallengeReason` matches the vendor markers a challenge
page carries and nothing else does (`cdn-cgi/challenge-platform`, `__cf_chl`,
`challenges.cloudflare.com`, `captcha-delivery.com`/DataDome, `px-captcha`,
Imperva/Incapsula); a *generic* hCaptcha or reCAPTCHA script counts only when
the response corroborates it — a body under 60 KB or a non-2xx status — because
a real article with a reCAPTCHA on its contact form is a page, not a gate. This
is measured, not assumed: fetching `retailmenot.com`, `telegramchannels.me` and
`pcmag.com` from the background returned the same 5.7 KB Cloudflare
interstitial, titled "Just a moment...", with no article in it at all — the
kind of page the old rules would have handed a tab and then filed as a thin
capture.

The 401/403/429 rule is deliberately split: the *first* one still escalates,
because the user's own tab carries the session this fetch does not; a *repeat*
of the same status is a wall and gets no third request (`seenStatuses` is what
the source has already been answered with, and the current response is added to
it *after* the classification has run — recording it first made every first
block look like a repeat of itself, so no tab was ever opened). A hard paywall is a wall on first sight — the tab renders
the same offer page — while a login or consent gate is given its one tab and is
called a wall only once that tab has been spent (`attempt > 1`).

`source-quality.js` is the junk filter: pure, background-only, Markdown in,
verdict out. It scores the *captured Markdown*, which is the same artefact on
both paths, so a page is judged by what the run would actually hand to the
model. The signals are ad-and-promo phrase density, call-to-action density,
link-text share and links per 100 words, affiliate-shaped link targets,
repeated-line share, how much of the page is written in paragraphs at all,
thin content, heading-to-substance ratio, and overlap with the user's query.
Points accumulate and a page is dropped at `JUNK_SCORE_THRESHOLD` (100); no
single signal reaches it except a paid-signal/VIP-channel pitch seen twice, so
a rejection always rests on at least two independent measurements. That tier is
reserved for phrases that name the sale themselves (`vip channel`,
`premium signals`, `guaranteed profit`, `win rate of 92%`). Naming a chat
channel is *not* one of them: "signal channel" is how every Go article writes
`make(chan os.Signal)`, and a newspaper, an encyclopedia and a platform help
page all say "Telegram channel" or "WhatsApp group" in earnest. Those count
only when a monetisation cue — a price, a tier, a promised return — is written
within 120 characters of them, and even two of them plus the thinness score
stay under the threshold, so such a page still needs a second, unrelated
signal. Near
duplicates are caught with 6-word shingles hashed FNV-1a and compared by
Jaccard against everything already kept in the run.

Two non-signals, stated because they are what a naive filter gets wrong: **a
short page is not spam** (thinness tops out at 35 points, well under the
threshold — a 60-word release note is exactly the source a run wants), and **a
price is not spam** (money is not measured at all; promotional *phrasing* is,
so a pricing page and a hardware review survive).

The thresholds were calibrated on real pages, captured through the extension's
own Readability + Turndown path: 10 live affiliate/coupon and paid-signal
landings against 14 live genuine pages (MDN, Wikipedia, the Rust book, CPython
and SQLite release notes, PostgreSQL's announcement, tokio's tutorial, curl's
changelog, Proton's pricing page, TechRadar's VPN deals page). Every one of the
8 spam pages that converted at all was rejected (scores 100–135); the other two
never converted, because they *were* the Cloudflare interstitial the wall
classifier now names. No genuine page was rejected: the highest scored 70
(curl's changelog — 136k words, 53% link text) and the next 55 (Proton's
pricing page). The duplicate threshold sits in an equally wide gap: the only
mirror pair in the corpus scored 0.937 and every other pair scored under 0.02,
including two encyclopedia articles on the same subject.

Discovery keeps what it ranked but did not need: `filterAndRank` returns
`reserves` alongside `results`, and the engine promotes one whenever a source
ends without a capture — skipped at a wall, dropped as junk, or failed after
its retry — until the reserve pool is empty or there is not enough budget left
to capture anything with (`REPLACEMENT_MIN_REMAINING_MS`). That is why
`MultiTabUtils.runPool` compares its cursor against the *live* length of the
item list and parks an idle worker on a promise woken by the next worker to
finish, instead of returning: the queue can grow while the pool runs, and the
wait must not need a timer.

Nothing disappears. A drop, a skip and a failed retry all keep their verbatim
reason, and all three land in the run state (with `category`, `attempts` and
`replacement` on the row) and in the document's `### Not fetched` block. The
front matter states whether the filter was on, how many pages it dropped, and
how many replacements were pulled in.

`researchJunkFilter` (default on) is the whole control surface for the gate:
one setting, not a knob per threshold, because the thresholds are measurements
rather than preferences.

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
what has to be closed in that case. It runs once, behind a promise `start()`
waits on: recovery is a sequence of awaits, and a run created in the middle of
them used to have its own record read, cleared and reported as interrupted. It
also re-checks the live run after every await and never touches a record whose
`runId` is the run in progress. Only a run that was still `searching` or
`running` comes back as `interrupted`; a stored `done` or `cancelled` is
restored as itself, with its counts recomputed from the entries, because the
document is still in storage for the rest of `RESULT_RETENTION_MS` and the
error block offers no way back to it.

| Constant | Value |
|----------|-------|
| `RESEARCH_CONCURRENCY` | 3 (the multi-tab path keeps 4) |
| `PING_INTERVAL_MS` / `PAGE_LOAD_TIMEOUT_MS` | 250 / 20000 |
| `SETTLE_DELAY_MS` / `CONVERT_TIMEOUT_MS` | 400 / 30000 |
| `REQUEST_TIMEOUT_MS` (search.js) / `TOTAL_BUDGET_MS` | 10000 / 240000 |
| `FETCH_TIMEOUT_MS` / `PARSE_TIMEOUT_MS` | 10000 / 5000 |
| `MIN_TEXT_CHARS` / `QUIET_THIN_CHARS` | 500 / 1500 |
| `MAX_BYTES` (one fetched body) | 5242880 |
| `PROGRESS_THROTTLE_MS` / `RESULT_RETENTION_MS` | 250 / 600000 |
| `MAX_PERSIST_BYTES` | 5242880 |
| `MAX_ATTEMPTS_PER_SOURCE` | 2 (one pass, one delayed retry) |
| `RETRY_BASE_DELAY_MS` / `RETRY_JITTER_MS` | 3000 / 2000 |
| `RETRY_MIN_REMAINING_MS` / `REPLACEMENT_MIN_REMAINING_MS` | 40000 / 45000 |
| `JUNK_SCORE_THRESHOLD` / `DUPLICATE_JACCARD` (source-quality.js) | 100 / 0.75 |

`PARSE_TIMEOUT_MS` times the parse, not the wait for one. The offscreen
document is a single JS thread and its `convertHtml` is synchronous, so the
three concurrent sources are dispatched through a queue in `research.js` and
each one's 5 s starts when the thread is actually free; the next parse waits for
the send itself rather than for the timeout, because a parse this side has given
up on still holds that thread. Opening the document — which also loads
readability.js, turndown.js and convert-core.js on the first capture — is not
charged to any page's parse budget; it has the run's.

`waitForScriptable` clamps its 20 s to the run's deadline, and says which limit
ran out: past the deadline the source ends with the budget message and category
`budget`, not with "Page did not become scriptable within 20 s". `captureInTab`
re-checks the deadline before it creates the tab, so no window opens for a
capture the run has no time to finish.

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

Discovery is bounded per request, never per run: `search.js` gives each endpoint
attempt its own 10 s `AbortController`. There is deliberately no timer on
`run.controller` — that signal belongs to the whole run and the quiet captures
share it, so a run-level search timeout did not stop discovery, it aborted every
capture in flight and put the browser's own "The user aborted a request." in the
sheet. `run.controller` is aborted by `cancel()` and by nothing else.

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
concurrency, cancellation bookkeeping, the budget, orphan recovery, the retry
ladder, the wall and replacement bookkeeping and the document builder.
`tests/source-quality.test.js` scores the junk filter against the calibration
corpus and pins the duplicate threshold. Write them, never run them.

Run state lives in `storage.session` when the browser has it (Chrome, Firefox
115+) and in a module variable otherwise; either way `recoverOrphans()` runs at
module evaluation and closes tabs a crashed or restarted worker left behind.

Persistence is serialised: `persistState` queues behind the write before it and
builds its payload *after* the read it needs, because the record carries
`openTabIds` and two workers opening a tab each would otherwise interleave and
land the older set last — leaving a tab that orphan recovery can never find. A
document is carried forward from the previous record only when its `runId` is
the run being persisted, and an explicit `document: null` is distinguished from
an absent key, so dropping an over-sized document cannot write the *previous*
run's document back under the current run's id. The size guard measures UTF-8
bytes (`TextEncoder`), not characters, and a store that refuses the write says
so: `persistState` resolves false and the run is marked as not retained rather
than reported as a clean result over nothing.

The `scrapllm-research` port is accepted only from this extension's own pages
(`port.sender.id === runtime.id` and no `sender.tab`), and `getDocument`
requires the run id it belongs to — the merged document holds pages captured
with the user's session, so it is never handed to a caller that cannot name the
run.

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
   Capture is taken on `pointerdown`, not once the gesture engages: a surface
   that is already animating slides out from under the finger, and without
   capture the moves that would engage the drag land on whatever is now under
   the pointer — which is exactly the case a closing sheet has to survive.
4. **Chrome is a material** — translucent layers with content passing under, and
   a scroll-edge mask instead of divider lines. Never two light translucent
   layers on top of each other: while the run sheet is up the bar is the solid
   one (`#mainView.research-open .research-bar`), so the boundary between the
   task surface and the field that raised it stays visible. The source list's
   mask is driven from its scroll position, so each edge fades only while there
   is content past it.
5. **The blur belongs to the enter and the exit.** The sheet's `filter` is a
   spring-driven materialisation; a drag turns it off and leaves it off until
   the surface rests, because content under the finger must stay itself (and a
   full-surface filter re-rasterises the sheet on every pointermove).
6. **Escape dismisses, it never destroys.** Escape closes the sheet whether or
   not a run is going — dismissing by drag already leaves the run alive, so the
   keyboard form of the gesture cannot instead cancel four minutes of work.
   Cancelling stays on the Cancel button, which is on screen in that state.
7. **Rows are keyed by what they show.** The source list reconciles on
   `entry.url`: the engine can promote a reserve mid-run, and rebuilding the
   list on the new count restarted every spinner and threw away every row's
   arrival spring. A promoted row is appended, animated in like the others and
   marked "replacement", and the progress bar re-targets to the true ratio when
   the denominator changes so bar and count cannot disagree.

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

Chrome is MV3 with a service worker; the build script rewrites the same MV3
manifest for Firefox — `background.scripts` (an event page, which is where
`convert-core.js` parses research pages), `browser_specific_settings`, and the
`offscreen` permission stripped, since Firefox has no offscreen API and needs
none. Use the
`browserAPI` wrapper in the popup and `browserRuntime` in content scripts.
