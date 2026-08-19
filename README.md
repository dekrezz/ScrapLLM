# ScrapLLM

Browser extension that turns whatever is on screen into clean Markdown, ready to paste into an LLM. One click for a page, one for a highlighted fragment, one for a whole chat transcript.

Chrome and Firefox. Everything runs locally — no account, no server, no telemetry.

---

## What it copies

| Action | What you get |
|--------|--------------|
| **Convert & Copy** | The page as Markdown — article body by default, full page on demand |
| **Copy Selection** | Only what you highlighted, prefixed with the line range and source. Code is detected and fenced with its language; prose keeps its links and lists |
| **Copy Chat** | An LLM conversation with roles and timestamps — the whole thread or just the last N exchanges |
| **Download Markdown** | The same output as a `.md` file |
| **Multi-tab** | Several selected tabs at once — merged into one file or zipped separately |

Site-aware extraction where the generic path loses the point:

- **Reddit** — the post plus its full comment tree (author, score, flair, nesting), read from Reddit's own JSON so collapsed replies survive.
- **X (Twitter)** — threads with replies, quoted posts and engagement counts; profiles and timelines as an index.
- **Chats** — ChatGPT, Claude, Gemini, Grok, Perplexity, DeepSeek, Copilot, Cursor, and self-hosted front-ends on a local port (Open WebUI, LibreChat, LobeChat, AnythingLLM, Jan). On ChatGPT and Claude the transcript comes from the site's own API and follows the branch you actually see, so messages you edited away stay out.

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
- **Token counter**, **debug logging**, **lazy-load auto-scroll**

## Project layout

```
extension/
├── manifest.json     Extension manifest (MV3; the build rewrites it for Firefox)
├── popup.html/js     Popup UI and settings
├── styles.css        Design system: materials, typography, themes, a11y
├── motion.js         Springs, gestures, momentum, press feedback
├── content.js        Core extraction and Markdown conversion
├── selection.js      Highlighted-fragment excerpts (code vs prose, line range)
├── chat.js           LLM conversation export (site API + DOM fallback)
├── reddit.js         Reddit threads and listings
├── x.js              X threads, profiles and timelines
├── background.js     Keyboard shortcuts, context menus, multi-tab work
└── libs/             Readability, Turndown, JSZip, browser-polyfill
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
