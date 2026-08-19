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

## Adding a file to the extension

`manifest.json` (`content_scripts[0].js`, order matters — helpers before
`content.js`) **and** `scripts/build.sh`, which copies files explicitly in three
places (Chrome, Firefox, source).

## Browser differences

Chrome is MV3 with a service worker; the build script rewrites the manifest for
Firefox (MV2 background scripts, `browser_specific_settings`). Use the
`browserAPI` wrapper in the popup and `browserRuntime` in content scripts.
