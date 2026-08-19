# ScrapLLM

Browser extension that turns whatever is on screen into clean Markdown, ready to paste into an LLM. One click for a page, one for a highlighted fragment, one for a whole chat transcript.

Chrome and Firefox. Conversion happens entirely in your browser — no account, no telemetry, and page content is never sent anywhere. (The optional token counter fetches static tokenizer data from `tiktoken.pages.dev` once and caches it. **Research** is the one feature that talks to a third party: it sends your question to DuckDuckGo to find sources. Everything else is offline.)

---

## What it copies

| Action | What you get |
|--------|--------------|
| **Convert & Copy** | The page as Markdown — article body by default, full page on demand |
| **Copy Selection** | Only what you highlighted, prefixed with the line range and source. Code is detected and fenced with its language; prose keeps its links and lists |
| **Copy Chat** | An LLM conversation with roles and timestamps — the whole thread or just the last N exchanges |
| **Download Markdown** | The same output as a `.md` file |
| **Multi-tab** | Several selected tabs at once — merged into one file or zipped separately |
| **Research** | One question in, one Markdown file out: the extension searches the web, opens each source in a background tab, converts it, and downloads the merged document |

Site-aware extraction where the generic path loses the point:

- **Reddit** — the post plus its full comment tree (author, score, flair, nesting), read from Reddit's own JSON so collapsed replies survive.
- **X (Twitter)** — threads with replies, quoted posts and engagement counts; profiles and timelines as an index.
- **Chats** — ChatGPT, Claude, Gemini, Grok, Perplexity, DeepSeek, Copilot, Cursor, and self-hosted front-ends on a local port (Open WebUI, LibreChat, LobeChat, AnythingLLM, Jan). On ChatGPT and Claude the transcript comes from the site's own API and follows the branch you actually see, so messages you edited away stay out.

## Research

Type a question into the bar at the bottom of the popup and the extension does the reading for you: it searches DuckDuckGo, opens each accepted result in a muted background tab, runs the ordinary conversion on it, and downloads one Markdown file with front matter, a numbered source list and every captured page.

What it does *not* do, and why:

- **It is not a browsing agent.** One query, one round of results — it does not follow links, reformulate the question, or read the pages it downloads.
- **5, 8 or 12 sources per run**, and the number in the progress counter is how many sources survived filtering, not how many you asked for. DuckDuckGo returns ten results a page, so 12 is a ceiling rather than a promise.
- **It skips what it cannot read**, and says so. PDFs and other non-pages, login walls (LinkedIn, Facebook, Quora, Academia…), paywalled publishers (WSJ, FT, NYT, Medium…) and duplicate hosts are dropped before fetching, each with its reason, and every dropped or failed source is listed under `### Not fetched` in the document and in the popup.
- **Background tabs are never rendered**, so the lazy-load scroll pass is forced off for research: infinite feeds, virtualised timelines and sections that only load on scroll are captured as the server sent them. Every source carries a note saying so.
- **It uses your browser, so it uses your session.** Pages are fetched by a real tab with your cookies; a site that blocks or personalises for you will do the same here.
- **Budgets, not hangs.** 20 s for a page to become scriptable, 30 s for its conversion, 4 minutes for the whole run, three tabs at a time. Whatever is left over comes back as skipped rather than stalling.
- **Cancel closes every tab it opened**, keeps whatever was already captured, and a crashed or restarted browser has its leftover tabs cleaned up on the next start.

Search results are found by fetching DuckDuckGo's HTML endpoint (`html.duckduckgo.com`, falling back to `lite.duckduckgo.com`) — the only two hosts the feature adds to the extension's permissions. Rate limiting, a blank result page and changed markup are reported as distinct, specific errors rather than as an empty file.

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
- **Research** — how many sources one run tries to capture (5, 8 or 12); it lives on the research sheet itself
- **Token counter**, **debug logging**, **lazy-load auto-scroll**

## Project layout

```
extension/
├── manifest.json        Extension manifest (MV3; the build rewrites it for Firefox)
├── popup.html/js        Popup UI and settings
├── settings.js          Shared setting defaults, used by popup and background
├── styles.css           Design system: materials, typography, themes, a11y
├── motion.js            Springs, gestures, momentum, press feedback
├── content.js           Core extraction and Markdown conversion
├── selection.js         Highlighted-fragment excerpts (code vs prose, line range)
├── chat.js              LLM conversation export (site API + DOM fallback)
├── reddit.js            Reddit threads and listings
├── x.js                 X threads, profiles and timelines
├── multi-tab-utils.js   Multi-tab batching, worker pool, filenames, ZIP naming
├── search.js            Research: DuckDuckGo source discovery (background only)
├── research.js          Research: run engine, background tabs, merged document
├── token-counter.js     Token estimation
├── background.js        Keyboard shortcuts, context menus, multi-tab work, research port
├── icons/               Extension icons (16, 48, 128, 1024)
└── libs/                Readability, Turndown, JSZip, browser-polyfill
```

## Build

```bash
bash scripts/build.sh chrome | firefox | source | all
bash scripts/build.sh --version 2.3.0 all
```

Packages land in `dist/`.

## Credits and licence

ScrapLLM is a derivative of [LLMFeeder](https://github.com/jatinkrmalik/LLMFeeder) by Jatin K Malik, rebuilt with a new interface, gesture and motion system, and site-aware extractors for Reddit, X, chats and selections.

MIT — see [LICENSE](LICENSE), which keeps the original copyright alongside ours.
