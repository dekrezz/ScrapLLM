# ScrapLLM

Browser extension that turns whatever is on screen into clean Markdown, ready to paste into an LLM. One click for a page, one for a highlighted fragment, one for a whole chat transcript.

Chrome and Firefox. Conversion happens entirely in your browser — no account, no telemetry, and page content is never sent anywhere. (The optional token counter fetches static tokenizer data from `tiktoken.pages.dev` once and caches it. **Research** is the one feature that talks to a third party: it sends your question to DuckDuckGo to find sources, then reads each accepted source itself — without your cookies. Everything else is offline.)

---

## What it copies

| Action | What you get |
|--------|--------------|
| **Convert & Copy** | The page as Markdown — article body by default, full page on demand |
| **Copy Selection** | Only what you highlighted, prefixed with the line range and source. Code is detected and fenced with its language; prose keeps its links and lists |
| **Copy Chat** | An LLM conversation with roles and timestamps — the whole thread or just the last N exchanges |
| **Download Markdown** | The same output as a `.md` file |
| **Multi-tab** | Several selected tabs at once — merged into one file or zipped separately |
| **Research** | One question in, one Markdown file out: the extension searches the web, reads each source with no tab at all, converts it, and downloads the merged document |

Site-aware extraction where the generic path loses the point:

- **Reddit** — the post plus its full comment tree (author, score, flair), read from Reddit's own JSON so collapsed replies survive. Replies are addressed by their position in the tree — `[1]`, `[1.1]`, `[1.1.1]` — rather than by indentation, so a chain nine deep reads the same as a top-level comment instead of crawling down the right margin. Deleted comments are dropped entirely and their surviving replies move up into the slot, and Reddit's own promoted posts and comment-tree ads are removed on every path, including full-page copies.
- **X (Twitter)** — threads with replies, quoted posts and engagement counts; profiles and timelines as an index.
- **GitHub** — a repository page as the name, description and facts, then the README **as its original Markdown** and the complete file tree. Both come from GitHub's API rather than the page: the README on screen is HTML compiled from Markdown, so converting it back mangles nested lists and fenced code, and the file list on screen stops at the top directory. The tree is recursive, so `.github/workflows/` and everything else behind a closed folder is in it. Costs three of the 60 requests an hour GitHub grants a signed-out caller, and says so by name when they run out.
- **YouTube** — a video as its title, channel and facts, the description **in full** (the page clamps it to two lines behind "...more"), and the comment thread with likes, dates and replies. Comments are not in the document at all until you scroll to them, so they are read from the same endpoint the page uses, a page at a time up to your ceiling.
- **Discord** — the open channel as a transcript: authors, timestamps, reply context and attachment links, with the virtualised list scrolled upward for history. Read from the rendered page on purpose — Discord's API would be faster and reach further, but it needs your account token, which Discord treats as self-botting and bans for.
- **Telegram** — the open conversation as a transcript, on `web.telegram.org`. The four kinds are told apart and rendered as what they are: a **channel** (no authors, view counts, comment links), a **group** (author per message, restored on grouped messages), a **forum topic** (one topic, named in the heading), and a **private chat** (only the two sides). Message bodies go through Turndown, so a word linked to a URL stays a link instead of arriving as a bare word. Telegram's own **sponsored posts are dropped** — they are a separate component in the message list. On a Telegram page the popup replaces Convert & Copy with one button naming the target ("Copy Жалобы topic"), with a ceiling on the last N messages and an optional date range.
- **Chats** — ChatGPT, Claude, Gemini, Google AI Mode, Grok, Perplexity, DeepSeek, Copilot, Cursor, and self-hosted front-ends on a local port (Open WebUI, LibreChat, LobeChat, AnythingLLM, Jan). On ChatGPT and Claude the transcript comes from the site's own API and follows the branch you actually see, so messages you edited away stay out.

## Research

Type a question into the bar at the bottom of the popup and the extension does the reading for you: it searches DuckDuckGo, captures each accepted result, and downloads one Markdown file with front matter, a numbered source list and every captured page.

### Two capture paths

Most sources are captured **quietly** — no tab is created at any point. The page's HTML is fetched in the background and converted with the same Readability and Turndown code the content script runs, so the Markdown is the same one you would get from a tab. On a lot of pages it is better: post-hydration UI chrome is not in the served HTML, so there is less for Readability to keep.

That fetch is deliberately **credential-less**. A search result — or something in its redirect chain — should not be able to pull your logged-in copy of a page into a file you are about to paste into a model. It also refuses anything pointing at your own machine or LAN (`localhost`, `*.local`, private IP ranges), before the request and again after redirects, and it stops reading a body at 5 MB.

A source falls back to a **rendered** capture — one muted background tab, for that source only — when the quiet path hits something a browser is genuinely needed for: a bot check or other non-2xx status, a redirect onto a consent or login host or path, an empty JavaScript shell, a failed parse, or fewer than 500 characters of extracted text. Reddit and X escalate before the fetch, because their extractors need the live page. Some things escalate to nothing at all, because a tab could not help either: a PDF, a 404 or 410, a network failure, or a body the server never identified are refused by name instead.

Each source says which path it took — `host · rendered` on its row in the popup (quiet is the default, so it is not badged), in the screen-reader label, and in a `Note:` line in the document. The front matter counts both.

The quiet path needs read access to the sites it fetches. That is an **optional** permission, asked for from the Research button the first time you use it. Declining it is not a failure: the run falls back to a tab per source, which needs no permission, and says so once. What you lose is quiet, never capability.

### When a source resists

A source is not captured once and dropped if that fails. Each one gets a ladder: the quiet fetch, then a background tab when the fetched HTML cannot answer for the page, then **one** delayed retry of both — 3 s plus up to 2 s of jitter, so three sources that all met the same rate limiter do not come back together. There is no third pass, and a retry is only started when the delay plus a whole capture still fits in the run's 4 minutes; otherwise you get the failure you needed to read instead of a budget message. A source that only worked the second time says so, on its row and in the document, and one that failed twice carries both halves in one sentence: `<first failure>; the retry 3 s later failed too: <second failure>`.

What earns a retry is decided by what went wrong, not by chance:

| | Example | Retried |
|---|---|---|
| **Transient** | network failure, timeout, 5xx, an unrendered shell, a tab that never became scriptable | yes |
| **Wall** | an active bot challenge, a repeated 401/403/429, a hard paywall, a login or consent gate that yielded nothing in a tab either | no |
| **Unusable** | a PDF or other non-HTML type, a 404 or 410, a private address, a body over 5 MB | no |

A wall reads as **skipped**, not as an error — the page did not fail to be captured, it refused to be — so the popup draws it as a muted dash and the result card counts the kinds apart ("2 failed, 1 skipped, 1 dropped by the filter") instead of calling everything a failure. Cancelling therefore leaves you with a list of skips rather than a column of red.

Bot checks are recognised by the markers only a challenge page carries (Cloudflare, DataDome, PerimeterX, Imperva); a plain hCaptcha or reCAPTCHA script counts only when the response backs it up — a body under 60 KB or a non-2xx status — so an article with a captcha on its contact form is still an article. This is measured: fetching three unrelated sites in the background returned the same 5.7 KB "Just a moment..." interstitial with no article in it. The first 401/403/429 still gets its tab, because your own session is there and this fetch's is not; a second one of the same status gets nothing.

### The junk filter

Every capture is scored as Markdown — the same artefact on both paths — so a page is judged by what would actually reach the model. The signals are ad-and-promo phrase density, calls to action, link-text share and links per 100 words, affiliate-shaped targets, repeated lines, how little of the page is written in paragraphs, thin content, heading-to-substance ratio, and overlap with your question. A page is dropped at 100 points and no single signal reaches that on its own, so a rejection always rests on at least two independent measurements. Near-duplicates are caught by comparing 6-word shingles (Jaccard 0.75).

Two things it deliberately does *not* treat as spam: **a short page** (thinness tops out at 35 points — a 60-word release note is exactly the source a run wants) and **a price** (money is not measured at all; only promotional phrasing is, so a pricing page and a hardware review survive).

The thresholds are calibrated on real pages captured through the extension's own path: 10 affiliate, coupon and paid-signal landings against 14 genuine ones (MDN, Wikipedia, the Rust book, CPython and SQLite release notes, tokio's tutorial, curl's changelog, Proton's pricing page, TechRadar's VPN deals). Every spam page that converted at all was rejected, at 100–135; the highest-scoring genuine page reached 70 (curl's changelog: 136k words, 53% link text) and the next 55. The duplicate line sits in a gap just as wide — the one mirrored pair scored 0.937, every other pair under 0.02, including two encyclopedia articles on the same subject. The filter is one switch in Settings, on by default, because the thresholds are measurements and not preferences.

### Replacements

Discovery keeps what it ranked but did not need. Whenever a source ends without a capture — skipped at a wall, dropped by the filter, or failed after its retry — the next reserve is promoted and captured in its place, until the reserves run out or there is not enough of the run's budget left to capture anything with. A promoted row is appended to the list, marked "replacement", and the progress bar re-targets to the true ratio so bar and count cannot disagree. Nothing is hidden: the source it replaced keeps its verbatim reason in `### Not fetched`, and the front matter states whether the filter was on, how many pages it dropped and how many replacements were pulled in.

What it does *not* do, and why:

- **It is not a browsing agent.** One query, one round of results — it does not follow links, reformulate the question, or read the pages it downloads.
- **5, 8 or 12 sources per run**, and the number in the progress counter is how many sources survived filtering, not how many you asked for. DuckDuckGo returns ten results a page, so 12 is a ceiling rather than a promise.
- **It skips what it cannot read**, and says so. PDFs and other non-pages, login walls (LinkedIn, Facebook, Quora, Academia…), paywalled publishers (WSJ, FT, NYT, Medium…) and duplicate hosts are dropped before fetching, each with its reason, and every dropped or failed source is listed under `### Not fetched` in the document and in the popup.
- **Nothing is scrolled.** The quiet path has no page to scroll and a background tab is never rendered, so the lazy-load pass is forced off for research: infinite feeds, virtualised timelines and sections that only load on scroll are captured as the server sent them. Every source carries a note saying so.
- **A quiet capture is not your session.** No cookies are sent, so a personalised or member-only page comes back walled or thin — and escalates to a tab, where your own session applies in your own window.
- **A thin capture says it is thin.** Above the 500-character floor but under 1500, the text is kept *and* labelled, on the row and in the document. A short capture is never passed off as the whole page.
- **Budgets, not hangs.** 10 s for a fetch, 20 s for a page to become scriptable, 30 s for its conversion, 4 minutes for the whole run, three sources at a time. Whatever is left over comes back as skipped rather than stalling.
- **Cancel opens no tabs.** It stops the run, closes any tab it had opened, and keeps whatever was already captured; a crashed or restarted browser has its leftover tabs cleaned up on the next start.

Search results are found by fetching DuckDuckGo's HTML endpoint (`html.duckduckgo.com`, falling back to `lite.duckduckgo.com`) — the only two hosts the feature adds as *required* permissions; the quiet path's site access is optional and requested at run time. Rate limiting, a blank result page and changed markup are reported as distinct, specific errors rather than as an empty file.

## Interface

- Spring-driven, interruptible motion — panels can be grabbed and thrown mid-flight, notifications swipe away.
- Press feedback lands on pointer-down, not on release.
- Translucent chrome, system typography with size-specific tracking, light and dark themes.
- Honours `prefers-reduced-motion`, `prefers-reduced-transparency` and `prefers-contrast`.

## Install

**From source (development):**

```bash
git clone https://github.com/dekrezz/ScrapLLM.git
cd ScrapLLM
bash scripts/build.sh all          # or: make chrome / make firefox
```

*Chrome:* `chrome://extensions` → Developer mode → Load unpacked → the extracted `dist/ScrapLLM-Chrome-*.zip`.

*Firefox:* `about:debugging#/runtime/this-firefox` → Load Temporary Add-on → `manifest.json` from the extracted Firefox package. Release Firefox only installs signed add-ons permanently; for a permanent unsigned install use Developer Edition, Nightly or ESR with `xpinstall.signatures.required=false`.

## Shortcuts

| Action | Default |
|--------|---------|
| Open ScrapLLM | `Alt+Shift+L` |
| Convert & copy | `Alt+Shift+M` |
| Download Markdown | `Alt+Shift+D` |
| Download tabs as ZIP | `Alt+Shift+Z` |

Rebind them at `chrome://extensions/shortcuts` or in Firefox's add-on manager.

## Settings

- **Content scope** — main article, full page, or selection
- **Formatting** — tables, images, links, page title, metadata template
- **Reddit** — comment sort and a cap on comments per thread
- **X** — replies on/off and a cap on posts
- **Chat** — how many exchanges to copy (defaults to the last 10, not the whole thread)
- **Research** — how many sources one run tries to capture (5, 8 or 12), on the research sheet itself
- **Quality filter** — *Drop low-value sources and replace them* (on by default): scores every captured page, drops affiliate and coupon spam, paid-signal landings and copies of a page already captured, and promotes the next search result in place of each drop
- **Capture** — *Quiet* (the default: read sources without a tab, falling back to one only where a page needs it) or *Always render*, which opens a background tab for every source
- **Token counter**, **debug logging**, **lazy-load auto-scroll**

## Project layout

```
extension/
├── manifest.json        Extension manifest (MV3; the build rewrites it for Firefox)
├── popup.html/js        Popup UI and settings
├── settings.js          Shared setting defaults, used by popup and background
├── styles.css           Design system: materials, typography, themes, a11y
├── motion.js            Springs, gestures, momentum, press feedback
├── content.js           Live-page extraction: selection, chat, lazy-load scroll
├── convert-core.js       Document → Markdown, shared by content script, worker and offscreen
├── selection.js         Highlighted-fragment excerpts (code vs prose, line range)
├── chat.js              LLM conversation export (site API + DOM fallback)
├── reddit.js            Reddit threads and listings
├── x.js                 X threads, profiles and timelines
├── multi-tab-utils.js   Multi-tab batching, worker pool, filenames, ZIP naming
├── search.js            Research: DuckDuckGo source discovery (background only)
├── quiet-capture.js      Research: credential-less fetch, guards, escalation signals
├── research.js          Research: run engine, capture paths, merged document
├── source-quality.js     Research: the junk and duplicate filter (pure, background only)
├── token-counter.js     Token estimation
├── background.js        Keyboard shortcuts, context menus, multi-tab work, research port
├── offscreen.html/js     Chrome only: the DOM the MV3 worker does not have
├── icons/               Extension icons (16, 48, 128, 1024)
└── libs/                Readability, Turndown, JSZip, browser-polyfill
```

## Build

```bash
bash scripts/build.sh chrome | firefox | source | all
bash scripts/build.sh --version 2.3.0 all
```

Packages land in `dist/`.

## Licence

MIT — see [LICENSE](LICENSE).
