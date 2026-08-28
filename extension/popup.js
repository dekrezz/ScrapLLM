// ScrapLLM Popup Script
const MAX_FILENAME_LENGTH = 100;

// Create a proper browserAPI wrapper for the popup
const browserAPI = (function () {
  // Check if we're in Firefox (browser is defined) or Chrome (chrome is defined)
  const isBrowser = typeof browser !== "undefined";
  const isChrome = typeof chrome !== "undefined";

  // Base object
  const api = {};

  if (isBrowser) {
    // Firefox already has promise-based APIs
    api.tabs = browser.tabs;
    api.runtime = browser.runtime;
    api.storage = browser.storage;
    api.commands = browser.commands;
    api.permissions = browser.permissions;
  } else if (isChrome) {
    // Chrome APIs
    api.tabs = {
      query: function (queryInfo) {
        return new Promise((resolve, reject) => {
          chrome.tabs.query(queryInfo, (tabs) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message || 'Unknown error'));
            } else {
              resolve(tabs);
            }
          });
        });
      },
      sendMessage: function (tabId, message) {
        return new Promise((resolve, reject) => {
          chrome.tabs.sendMessage(tabId, message, (response) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message || 'Unknown error'));
            } else {
              resolve(response);
            }
          });
        });
      },
    };

    api.runtime = chrome.runtime;

    // Optional host access for the quiet research path. The request has to sit
    // inside a user gesture, which is why it lives in the popup and not in the
    // background.
    api.permissions = chrome.permissions && {
      contains: (p) => new Promise((resolve) => chrome.permissions.contains(p, (r) => {
        void chrome.runtime.lastError;
        resolve(r === true);
      })),
      request: (p) => new Promise((resolve) => chrome.permissions.request(p, (r) => {
        void chrome.runtime.lastError;
        resolve(r === true);
      }))
    };

    // Both areas go through the same promise wrapper: `sync` carries the
    // settings, `local` the marker that says a finished run has already
    // downloaded itself.
    const promiseArea = (area) => ({
      get: function (keys) {
        return new Promise((resolve, reject) => {
          area.get(keys, (result) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message || 'Unknown error'));
            } else {
              resolve(result);
            }
          });
        });
      },
      set: function (items) {
        return new Promise((resolve, reject) => {
          area.set(items, () => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message || 'Unknown error'));
            } else {
              resolve();
            }
          });
        });
      },
    });

    api.storage = {
      sync: promiseArea(chrome.storage.sync),
      local: promiseArea(chrome.storage.local),
    };

    api.commands = chrome.commands;
  }

  return api;
})();

// DOM elements - Main view
const convertBtn = document.getElementById("convertBtn");
const convertSplit = document.getElementById("convertSplit");
const convertMenuBtn = document.getElementById("convertMenuBtn");
const convertMenu = document.getElementById("convertMenu");
const convertOverrideBtn = document.getElementById("convertOverrideBtn");
const convertOverrideLabel = convertOverrideBtn ? convertOverrideBtn.querySelector(".override-label") : null;
const copySelectionBtn = document.getElementById("copySelectionBtn");
const chatAction = document.getElementById("chatAction");
const telegramAction = document.getElementById("telegramAction");
const copyTelegramBtn = document.getElementById("copyTelegramBtn");
const telegramBtnText = document.getElementById("telegramBtnText");
const telegramSegments = document.getElementById("telegramSegments");
const telegramPeriods = document.getElementById("telegramPeriods");
const telegramCustomDates = document.getElementById("telegramCustomDates");
const telegramDateFromInput = document.getElementById("telegramDateFrom");
const telegramDateToInput = document.getElementById("telegramDateTo");
const telegramDateClearBtn = document.getElementById("telegramDateClear");
const aboutVersionEl = document.getElementById("aboutVersion");
const aboutBuildEl = document.getElementById("aboutBuild");
const copyChatBtn = document.getElementById("copyChatBtn");
const chatLimitBtn = document.getElementById("chatLimitBtn");
const chatLimitMenu = document.getElementById("chatLimitMenu");
const chatPageFallbackBtn = document.getElementById("chatPageFallbackBtn");
let chatExchangeLimitValue = "10";
const downloadBtn = document.getElementById("downloadBtn");
const statusIndicator = document.getElementById("statusIndicator");

// DOM elements - Multi-tab mode
const singleTabActions = document.getElementById("singleTabActions");
const multiTabActions = document.getElementById("multiTabActions");
const selectedTabCount = document.getElementById("selectedTabCount");
const copyAllBtn = document.getElementById("copyAllBtn");
const downloadMergedBtn = document.getElementById("downloadMergedBtn");
const downloadZipBtn = document.getElementById("downloadZipBtn");

// DOM elements - Views
const mainView = document.getElementById("mainView");
const settingsView = document.getElementById("settingsView");
const openSettingsBtn = document.getElementById("openSettingsBtn");
const backToMainBtn = document.getElementById("backToMainBtn");

// DOM elements - Theme
const lightThemeBtn = document.getElementById("lightThemeBtn");
const darkThemeBtn = document.getElementById("darkThemeBtn");
const bodyTag = document.querySelector("body");

// DOM elements - Settings
const popupShortcut = document.getElementById("popupShortcut");
const quickConvertShortcut = document.getElementById("quickConvertShortcut");
const downloadShortcut = document.getElementById("downloadShortcut");

const THEME_KEY = "scrapllm-theme";
const THEMES = { DARK: "dark", LIGHT: "light" };

// Get all settings elements
const contentScopeRadios = document.querySelectorAll('input[name="contentScope"]');
const preserveTablesCheckbox = document.getElementById("preserveTables");
const includeImagesCheckbox = document.getElementById("includeImages");
const includeTitleCheckbox = document.getElementById("includeTitle");
const includeLinksCheckbox = document.getElementById("includeLinks");
const includeMetadataCheckbox = document.getElementById("includeMetadata");
const metadataFormatTextarea = document.getElementById("metadataFormat");
const metadataFormatContainer = document.getElementById("metadataFormatContainer");
const resetMetadataFormatBtn = document.getElementById("resetMetadataFormat");
const debugModeCheckbox = document.getElementById("debugMode");
const copyLogsBtn = document.getElementById("copyLogsBtn");
const triggerLazyLoadingCheckbox = document.getElementById("triggerLazyLoading");
const redditModeCheckbox = document.getElementById("redditMode");
const redditCommentSortSelect = document.getElementById("redditCommentSort");
const redditMaxCommentsSelect = document.getElementById("redditMaxComments");
const xModeCheckbox = document.getElementById("xMode");
const xIncludeRepliesCheckbox = document.getElementById("xIncludeReplies");
const xMaxPostsSelect = document.getElementById("xMaxPosts");
const githubModeCheckbox = document.getElementById("githubMode");
const githubIncludeReadmeCheckbox = document.getElementById("githubIncludeReadme");
const githubIncludeTreeCheckbox = document.getElementById("githubIncludeTree");
const githubMaxTreeEntriesSelect = document.getElementById("githubMaxTreeEntries");
const youtubeModeCheckbox = document.getElementById("youtubeMode");
const youtubeIncludeDescriptionCheckbox = document.getElementById("youtubeIncludeDescription");
const youtubeIncludeCommentsCheckbox = document.getElementById("youtubeIncludeComments");
const youtubeMaxCommentsSelect = document.getElementById("youtubeMaxComments");
const discordModeCheckbox = document.getElementById("discordMode");
const discordMaxMessagesSelect = document.getElementById("discordMaxMessages");

// Token Counter DOM elements
const tokenCounter = document.getElementById("tokenCounter");
const tokenCountValue = document.getElementById("tokenCountValue");
const showTokenCountCheckbox = document.getElementById("showTokenCount");


// Current token count for display
let currentTokenCount = 0;

// Default token counter settings
const DEFAULT_TOKEN_SETTINGS = {
  showTokenCount: true,
  // The threshold that decides clipboard versus file. 8k was a 2023 number and
  // would send almost every real page to a download; 128k is what the models
  // people paste into actually take, so the file route is reserved for the
  // documents that genuinely will not fit.
  tokenContextLimit: 128000
};

// ---------------------------------------------------------------------------
// FLUID NAVIGATION
// ---------------------------------------------------------------------------
// The settings panel is a surface the user can push, not a slide that plays.
// One spring owns a single 0..1 progress value; the pointer writes to it
// directly while a finger is down and hands its release velocity to the spring
// afterwards, so a half-open panel can be grabbed, reversed or thrown at any
// moment without waiting for anything to finish.

const Motion = window.ScrapLLMMotion;
const NAV_EDGE_DIM = 400; // popup width in px; the travel distance of the pan

const navSpring = new Motion.Spring(0, {
  damping: Motion.PRESETS.move.damping,
  response: Motion.PRESETS.move.response,
  onUpdate: (progress) => renderNav(progress)
});

function renderNav(progress) {
  // Settings slides in from the right; main is pushed back and dimmed so the
  // hierarchy between the two layers stays readable while they travel.
  settingsView.style.transform = `translate3d(${(1 - progress) * 100}%, 0, 0)`;
  mainView.style.transform = `translate3d(${progress * -28}%, 0, 0)`;
  mainView.style.opacity = String(1 - progress * 0.4);

  // Reduced motion: the panel doesn't travel (motion.js lands the spring
  // immediately), so the state change is carried by a short cross-fade
  // instead of a jump cut.
  if (Motion.prefersReducedMotion()) {
    settingsView.style.opacity = progress > 0.5 ? "1" : "0";
    mainView.style.opacity = progress > 0.5 ? "0" : "1";
  } else {
    settingsView.style.opacity = "1";
  }

  const settingsShown = progress > 0.01;
  settingsView.setAttribute("aria-hidden", settingsShown ? "false" : "true");
  mainView.setAttribute("aria-hidden", progress > 0.99 ? "true" : "false");
  settingsView.classList.toggle("active", progress > 0.5);
  mainView.classList.toggle("slide-out", progress > 0.5);
}

function showSettingsView() {
  navSpring.to(1, Motion.PRESETS.move);
  // Focus the exit before the panel lands: the user must never be trapped.
  backToMainBtn.focus({ preventScroll: true });
}

function showMainView() {
  navSpring.to(0, Motion.PRESETS.move);
  openSettingsBtn.focus({ preventScroll: true });
}

// Both directions travel the same axis, and either can be driven by hand:
// drag left anywhere on the main view to reveal settings, drag right on the
// settings view to put it back.
function initNavGestures() {
  const settleNav = (progress, velocityPxPerSecond) => {
    // Where the flick is going, not where the finger stopped.
    const projectedPx = progress * NAV_EDGE_DIM + Motion.project(velocityPxPerSecond);
    const projected = projectedPx / NAV_EDGE_DIM;
    // Velocity sign wins over position whenever the gesture had real intent.
    const decisive = Math.abs(velocityPxPerSecond) > 120;
    const target = decisive
      ? (velocityPxPerSecond > 0 ? 1 : 0)
      : (projected > 0.5 ? 1 : 0);

    navSpring.to(target, {
      damping: Motion.PRESETS.sheet.damping,
      response: Motion.PRESETS.sheet.response,
      // Continue at exactly the speed the finger left, so there is no seam
      // between dragging and animating.
      velocity: velocityPxPerSecond / NAV_EDGE_DIM
    });
  };

  const track = (startProgress, deltaPx) => {
    // Raw 1:1 tracking inside the range, progressive resistance outside it.
    let progress = startProgress + deltaPx / NAV_EDGE_DIM;
    if (progress > 1) {
      progress = 1 + Motion.rubberband(progress - 1, 1);
    } else if (progress < 0) {
      progress = Motion.rubberband(progress, 1);
    }
    navSpring.set(progress);
  };

  let startProgress = 0;

  Motion.draggable(settingsView, {
    axis: "x",
    canStart: (event) => navSpring.value > 0.5 && !event.target.closest("textarea, select, input"),
    onStart: () => { startProgress = navSpring.value; },
    // Dragging right (positive delta) closes, so the progress delta is negated.
    onMove: ({ delta }) => track(startProgress, -delta),
    onEnd: ({ delta, velocity, cancelled }) => {
      if (cancelled) { navSpring.to(startProgress, Motion.PRESETS.move); return; }
      track(startProgress, -delta);
      settleNav(navSpring.value, -velocity);
    }
  });

  Motion.draggable(mainView, {
    axis: "x",
    canStart: (event) => navSpring.value < 0.5 &&
      !event.target.closest("button, a, input, select, textarea") &&
      !event.target.closest(".research-sheet, .research-bar"),
    onStart: () => { startProgress = navSpring.value; },
    onMove: ({ delta }) => track(startProgress, -delta),
    onEnd: ({ delta, velocity, cancelled }) => {
      if (cancelled) { navSpring.to(startProgress, Motion.PRESETS.move); return; }
      track(startProgress, -delta);
      settleNav(navSpring.value, -velocity);
    }
  });
}

// Theme management
function setTheme(theme, options) {
  const isDark = theme === THEMES.DARK;
  bodyTag.classList.toggle("dark-theme", isDark);
  bodyTag.classList.toggle("light-theme", !isDark);

  // Update theme buttons
  lightThemeBtn.classList.toggle("active", !isDark);
  darkThemeBtn.classList.toggle("active", isDark);

  // Following the system is a state of its own, not a third theme: the class
  // says which one is showing, storage says whether the user ever chose. Saving
  // on a system-driven change would silently pin the theme at whatever the OS
  // happened to be the first time the popup opened.
  if (!options || options.remember !== false) localStorage.setItem(THEME_KEY, theme);
}

function initTheme() {
  const userThemePreference = localStorage.getItem(THEME_KEY);
  if (userThemePreference === THEMES.DARK || userThemePreference === THEMES.LIGHT) {
    setTheme(userThemePreference);
    return;
  }

  // Nobody has chosen, so follow the browser. Defaulting to light meant a
  // white popup opening over a dark browser, every time.
  const query = window.matchMedia("(prefers-color-scheme: dark)");
  const apply = () => setTheme(query.matches ? THEMES.DARK : THEMES.LIGHT, { remember: false });
  apply();

  // Keep following it while the popup is open — the OS can flip at sunset.
  if (typeof query.addEventListener === "function") {
    query.addEventListener("change", () => {
      if (!localStorage.getItem(THEME_KEY)) apply();
    });
  }
}

/**
 * Update token counter display
 * @param {number} count - Token count
 * @param {number} limit - Context limit
 */
function updateTokenDisplay(count, limit) {
  currentTokenCount = count;

  // The count is the whole display: a number and its unit. Nothing warns about
  // the budget, because nothing needs to — going over it changes where the
  // result is delivered, not whether the user gets one.
  tokenCountValue.textContent = count.toLocaleString();

  // Show/hide the counter
  if (showTokenCountCheckbox.checked) {
    tokenCounter.classList.remove('hidden');
  } else {
    tokenCounter.classList.add('hidden');
  }

}

/**
 * Hide token counter display
 */
function hideTokenDisplay() {
  tokenCounter.classList.add('hidden');
}

// Show proper keyboard shortcuts based on OS
function updateShortcutDisplay() {
  // Detect OS
  const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;
  const modifier = isMac ? "⌥⇧" : "Alt+Shift+";

  // Shortcuts are listed in Settings only; the action buttons no longer carry
  // badges, so there is nothing to fill in on the main view.
  popupShortcut.textContent = `${modifier}L`;
  quickConvertShortcut.textContent = `${modifier}M`;
  if (downloadShortcut) {
    downloadShortcut.textContent = `${modifier}D`;
  }

  // Detect browser - check for Firefox-specific APIs
  // browser-polyfill defines 'browser' in Chrome too, so we need a different check
  const isFirefox = navigator.userAgent.toLowerCase().includes("firefox");

  // Update shortcut customization link
  const shortcutLink = document.getElementById("shortcutLink");
  if (shortcutLink) {
    const shortcutPage = isFirefox ? "about:addons" : "chrome://extensions/shortcuts";
    shortcutLink.textContent = shortcutPage;

    // Handle click to open the shortcuts page
    shortcutLink.addEventListener("click", (e) => {
      e.preventDefault();
      if (isFirefox) {
        browser.tabs.create({ url: "about:addons" });
      } else {
        chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
      }
    });
  }

}

// Offer the selection action only when there is a selection to act on: a
// button that is present but inert teaches people to ignore it.
async function initSelectionAction() {
  try {
    const tabs = await browserAPI.tabs.query({ active: true, currentWindow: true });
    if (!tabs || tabs.length === 0) return;

    const response = await browserAPI.tabs.sendMessage(tabs[0].id, { action: "getSelectionInfo" });
    const info = response && response.success ? response.info : null;
    if (!info || !info.hasSelection) return;

    // The kind and line range end up in the copied text itself, so the button
    // stays a plain label.
    copySelectionBtn.classList.remove("hidden");
  } catch (error) {
    // Restricted pages (store, about:, PDF viewer) have no content script.
    // Staying silent is the correct outcome, not an error to report.
  }
}

// Set once the popup knows this page holds a conversation: the page-conversion
// key is hidden and Download follows the chat, not the rendered slice.
let chatPageFallback = false;

// Chat exchange picker. A native <select> renders as the OS control — wrong
// arrow, wrong focus ring, wrong colours inside a dark key — so the segment is
// a caret button with the same materialising menu as the convert split button.
const chatLimitSpring = new Motion.Spring(0, {
  damping: Motion.PRESETS.snappy.damping,
  response: Motion.PRESETS.snappy.response,
  onUpdate: (value) => {
    const eased = Motion.clamp(value, 0, 1.05);
    chatLimitMenu.style.transform =
      `translate3d(0, ${(1 - eased) * -6}px, 0) scale(${0.9 + eased * 0.1})`;
    chatLimitMenu.style.opacity = String(Motion.clamp(eased * 1.4, 0, 1));
    chatLimitMenu.style.filter = eased > 0.99 ? "none" : `blur(${(1 - eased) * 6}px)`;
  },
  onRest: (spring) => {
    if (spring.value <= 0.001) chatLimitMenu.classList.add("hidden");
  }
});

function isChatLimitMenuOpen() {
  return !chatLimitMenu.classList.contains("hidden") && chatLimitSpring.target > 0.5;
}

function openChatLimitMenu() {
  chatLimitMenu.classList.remove("hidden");
  chatLimitBtn.setAttribute("aria-expanded", "true");
  chatLimitSpring.to(1, Motion.PRESETS.snappy);
}

function closeChatLimitMenu() {
  chatLimitBtn.setAttribute("aria-expanded", "false");
  if (chatLimitMenu.classList.contains("hidden")) return;
  chatLimitSpring.to(0, Motion.PRESETS.snappy);
}

function setChatExchangeLimit(value, options) {
  chatExchangeLimitValue = value;
  chatLimitMenu.querySelectorAll(".split-btn-menu-item").forEach((item) => {
    const selected = item.dataset.value === value;
    item.classList.toggle("is-selected", selected);
    item.setAttribute("aria-checked", selected ? "true" : "false");
  });
  if (!options || options.persist !== false) saveSettings();
}

// Offer the chat action only where there is a conversation to copy: LLM
// front-ends, including self-hosted ones on a local port.
async function initChatAction() {
  try {
    const tabs = await browserAPI.tabs.query({ active: true, currentWindow: true });
    if (!tabs || tabs.length === 0) return;

    const response = await askPage(tabs[0].id, { action: "getChatInfo" });
    const info = response && response.success ? response.info : null;
    if (!info || !info.isChat) return;

    chatAction.classList.remove("hidden");

    // A chat transcript is virtualised: converting the page captures whichever
    // messages happen to be rendered, which is a slice of the middle dressed up
    // as a document. So on a chat the page conversion steps off the front row —
    // it stays one click away inside this action's menu, because a chat
    // detection can be wrong and the page is sometimes what the user wants.
    convertSplit.classList.add("hidden");
    chatPageFallback = true;
  } catch (error) {
    // No content script on this page (store, about:, PDF viewer).
  }
}

// Ask the page a question, and if nothing answers, put the content script there
// and ask again. Two situations look identical from here and both end in
// silence: no content script at all (the tab predates the extension), and one
// from an older build that has never heard of this message. Re-injecting fixes
// both, and is safe because every content-script file guards its own
// declaration against being evaluated twice.
async function askPage(tabId, message) {
  try {
    const response = await browserAPI.tabs.sendMessage(tabId, message);
    if (response) return response;
  } catch (error) {
    // Falls through to the injection below.
  }
  try {
    const manifest = browserAPI.runtime.getManifest();
    const entry = (manifest.content_scripts || [])[0];
    if (!entry || !browserAPI.scripting) return null;
    await browserAPI.scripting.executeScript({ target: { tabId }, files: entry.js });
    return await browserAPI.tabs.sendMessage(tabId, message);
  } catch (error) {
    return null;
  }
}

// The version alone cannot answer "did my reload actually take?" — a rebuilt
// package usually carries the same version. So the build id is hashed from the
// files the browser actually loaded: it moves whenever a single byte of the
// code does, and stays put when nothing did.
async function computeBuildId() {
  const manifest = browserAPI.runtime.getManifest();
  const entry = (manifest.content_scripts || [])[0];
  const files = (entry && entry.js ? entry.js.slice() : []).concat(['popup.js', 'popup.html', 'styles.css']);
  const chunks = [];
  for (const file of files) {
    try {
      const response = await fetch(browserAPI.runtime.getURL(file));
      chunks.push(await response.text());
    } catch (error) {
      chunks.push('missing:' + file);
    }
  }
  const bytes = new TextEncoder().encode(chunks.join('|'));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .slice(0, 5)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// A period is a shorthand for the from/to pair the extractor actually takes:
// "7d" is simply today minus six days, resolved here so the extractor keeps one
// way of being told what to include.
// The year is noise in a chat you are reading now, so the field takes "DD.MM"
// and the year is inferred: this year, unless that would put the date in the
// future, in which case it is last year. Storage keeps the full date, because
// that is what the extractor compares against.
function displayFromStored(stored) {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(stored || '').trim());
  return parts ? `${parts[3]}.${parts[2]}` : '';
}

function storedFromDisplay(display) {
  const parts = /^(\d{1,2})[.\/-](\d{1,2})$/.exec(String(display || '').trim());
  if (!parts) return '';
  const day = Number(parts[1]);
  const month = Number(parts[2]);
  if (day < 1 || day > 31 || month < 1 || month > 12) return '';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let candidate = new Date(today.getFullYear(), month - 1, day);
  if (candidate > today) candidate = new Date(today.getFullYear() - 1, month - 1, day);
  return localDateString(candidate);
}

function localDateString(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function setTelegramPeriod(period, options) {
  telegramPeriods.querySelectorAll(".telegram-segment").forEach((segment) => {
    const selected = segment.dataset.period === period;
    segment.classList.toggle("is-selected", selected);
    segment.setAttribute("aria-checked", selected ? "true" : "false");
  });
  telegramCustomDates.classList.toggle("hidden", period !== "custom");

  if (period === "all") {
    telegramDateFromInput.value = "";
    telegramDateToInput.value = "";
  } else if (period !== "custom") {
    const days = Number(period);
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    from.setDate(from.getDate() - (days - 1));
    telegramDateFromInput.value = displayFromStored(localDateString(from));
    telegramDateToInput.value = "";
  }
  if (!options || options.persist !== false) saveSettings();
}

// Which segment matches the stored pair, so reopening the popup shows the
// period the user actually left it on.
function periodFromDates(from, to) {
  // `from` and `to` here are stored values, not what the fields show.
  if (!from && !to) return "all";
  if (to) return "custom";
  for (const days of [1, 7, 30]) {
    const candidate = new Date();
    candidate.setHours(0, 0, 0, 0);
    candidate.setDate(candidate.getDate() - (days - 1));
    if (localDateString(candidate) === from) return String(days);
  }
  return "custom";
}

async function initAbout() {
  try {
    const manifest = browserAPI.runtime.getManifest();
    aboutVersionEl.textContent = manifest.version;
    aboutBuildEl.textContent = await computeBuildId();
  } catch (error) {
    aboutBuildEl.textContent = 'unavailable';
  }
}

let telegramMaxMessagesValue = "200";

function setTelegramLimit(value, options) {
  const offered = Array.from(telegramSegments.querySelectorAll(".telegram-segment"))
    .map((segment) => segment.dataset.value);
  // A value saved before the steps changed — "all", say — would leave every
  // segment unselected and the copy running on a number nothing shows.
  telegramMaxMessagesValue = offered.includes(String(value)) ? String(value) : "50";
  telegramSegments.querySelectorAll(".telegram-segment").forEach((segment) => {
    const selected = segment.dataset.value === telegramMaxMessagesValue;
    segment.classList.toggle("is-selected", selected);
    segment.setAttribute("aria-checked", selected ? "true" : "false");
  });
  if (!options || options.persist !== false) saveSettings();
}

// What the button says. "Convert & Copy" is silent about which of four
// documents you would get, so the label names the target: the topic on a forum,
// the person in a private chat, the channel or group otherwise.
function telegramButtonLabel(info) {
  const kindWord = info.kind === "topic" ? "topic"
    : info.kind === "channel" ? "channel"
    : info.kind === "group" ? "group"
    : "chat";
  const name = (info.kind === "topic" && info.topicName) ? info.topicName : info.title;
  const trimmed = (name || "Telegram").length > 22 ? (name || "").slice(0, 21) + "…" : (name || "Telegram");
  return `Copy ${trimmed} ${kindWord}`;
}

// Offer the Telegram action only on an open conversation, and take the page
// conversion off the front row while it is up: on a virtualised message list
// "the page" is whichever messages happen to be painted, dressed up as a
// document.
async function initTelegramAction() {
  try {
    const tabs = await browserAPI.tabs.query({ active: true, currentWindow: true });
    if (!tabs || tabs.length === 0) return;

    const response = await askPage(tabs[0].id, { action: "getTelegramInfo" });
    const info = response && response.success ? response.info : null;
    if (!info || !info.isTelegram) return;

    telegramBtnText.textContent = telegramButtonLabel(info);
    copyTelegramBtn.title = `Copy this Telegram ${info.kind === "private" ? "chat" : info.kind} as Markdown`;
    telegramAction.classList.remove("hidden");
    convertSplit.classList.add("hidden");
    chatPageFallback = true;
  } catch (error) {
    // No content script on this page.
  }
}

// Load user settings
async function loadSettings() {
  try {
    const data = await SettingsUtils.getUserSettings(browserAPI);

    // Also get token settings
    const tokenSettings = await browserAPI.storage.sync.get({
      showTokenCount: DEFAULT_TOKEN_SETTINGS.showTokenCount,
      tokenContextLimit: DEFAULT_TOKEN_SETTINGS.tokenContextLimit,
    });

    // Apply settings to UI
    document.querySelector(`input[name="contentScope"][value="${data.contentScope}"]`).checked = true;
    preserveTablesCheckbox.checked = data.preserveTables;
    includeImagesCheckbox.checked = data.includeImages;
    includeTitleCheckbox.checked = data.includeTitle;
    includeLinksCheckbox.checked = data.includeLinks !== false;
    includeMetadataCheckbox.checked = data.includeMetadata;
    metadataFormatTextarea.value = data.metadataFormat;
    debugModeCheckbox.checked = data.debugMode;
    triggerLazyLoadingCheckbox.checked = data.triggerLazyLoading === true;
    redditModeCheckbox.checked = data.redditMode !== false;
    redditCommentSortSelect.value = data.redditCommentSort;
    redditMaxCommentsSelect.value = String(data.redditMaxComments);
    setChatExchangeLimit(String(data.chatExchangeLimit), { persist: false });
    xModeCheckbox.checked = data.xMode !== false;
    xIncludeRepliesCheckbox.checked = data.xIncludeReplies !== false;
    xMaxPostsSelect.value = String(data.xMaxPosts);
    githubModeCheckbox.checked = data.githubMode !== false;
    githubIncludeReadmeCheckbox.checked = data.githubIncludeReadme !== false;
    githubIncludeTreeCheckbox.checked = data.githubIncludeTree !== false;
    githubMaxTreeEntriesSelect.value = String(data.githubMaxTreeEntries);
    setTelegramLimit(String(data.telegramMaxMessages ?? "200"), { persist: false });
    telegramDateFromInput.value = displayFromStored(data.telegramDateFrom);
    telegramDateToInput.value = displayFromStored(data.telegramDateTo);
    setTelegramPeriod(periodFromDates(data.telegramDateFrom || "", data.telegramDateTo || ""), { persist: false });
    youtubeModeCheckbox.checked = data.youtubeMode !== false;
    youtubeIncludeDescriptionCheckbox.checked = data.youtubeIncludeDescription !== false;
    youtubeIncludeCommentsCheckbox.checked = data.youtubeIncludeComments !== false;
    youtubeMaxCommentsSelect.value = String(data.youtubeMaxComments);
    discordModeCheckbox.checked = data.discordMode !== false;
    discordMaxMessagesSelect.value = String(data.discordMaxMessages);
    setResearchSourceCount(data.researchSourceCount, { persist: false });
    setResearchCapture(data.researchCapture, { persist: false });
    researchJunkFilterCheckbox.checked = data.researchJunkFilter !== false;
    showTokenCountCheckbox.checked = tokenSettings.showTokenCount;

    // Show/hide metadata format container based on checkbox state
    updateMetadataFormatVisibility(data.includeMetadata);

    // Show/hide debug logs button based on debug mode
    updateDebugModeVisibility();
  } catch (error) {
    console.error("Error loading settings:", error);
    statusIndicator.textContent = "Error loading settings";
    statusIndicator.classList.add("error");
  }
}

// Save user settings
async function saveSettings() {
  try {
    const contentScope = document.querySelector('input[name="contentScope"]:checked').value;
    const preserveTables = preserveTablesCheckbox.checked;
    const includeImages = includeImagesCheckbox.checked;
    const includeTitle = includeTitleCheckbox.checked;
    const includeLinks = includeLinksCheckbox.checked;
    const includeMetadata = includeMetadataCheckbox.checked;
    const metadataFormat = metadataFormatTextarea.value;
    const debugMode = debugModeCheckbox.checked;
    const triggerLazyLoading = triggerLazyLoadingCheckbox.checked;
    const redditMode = redditModeCheckbox.checked;
    const redditCommentSort = redditCommentSortSelect.value;
    const redditMaxComments = redditMaxCommentsSelect.value;
    const chatExchangeLimit = chatExchangeLimitValue;
    const xMode = xModeCheckbox.checked;
    const xIncludeReplies = xIncludeRepliesCheckbox.checked;
    const xMaxPosts = xMaxPostsSelect.value;
    const githubMode = githubModeCheckbox.checked;
    const githubIncludeReadme = githubIncludeReadmeCheckbox.checked;
    const githubIncludeTree = githubIncludeTreeCheckbox.checked;
    const githubMaxTreeEntries = githubMaxTreeEntriesSelect.value;
    const telegramMaxMessages = telegramMaxMessagesValue;
    const telegramDateFrom = storedFromDisplay(telegramDateFromInput.value);
    const telegramDateTo = storedFromDisplay(telegramDateToInput.value);
    const youtubeMode = youtubeModeCheckbox.checked;
    const youtubeIncludeDescription = youtubeIncludeDescriptionCheckbox.checked;
    const youtubeIncludeComments = youtubeIncludeCommentsCheckbox.checked;
    const youtubeMaxComments = youtubeMaxCommentsSelect.value;
    const discordMode = discordModeCheckbox.checked;
    const discordMaxMessages = discordMaxMessagesSelect.value;
    const researchSourceCount = researchSourceCountValue;
    const researchCapture = researchCaptureValue;
    const researchJunkFilter = researchJunkFilterCheckbox.checked;
    const showTokenCount = showTokenCountCheckbox.checked;
    const tokenContextLimit = DEFAULT_TOKEN_SETTINGS.tokenContextLimit;

    await browserAPI.storage.sync.set({
      contentScope,
      preserveTables,
      includeImages,
      includeTitle,
      includeLinks,
      includeMetadata,
      metadataFormat,
      debugMode,
      triggerLazyLoading,
      redditMode,
      redditCommentSort,
      redditMaxComments,
      chatExchangeLimit,
      xMode,
      xIncludeReplies,
      xMaxPosts,
      githubMode,
      githubIncludeReadme,
      githubIncludeTree,
      githubMaxTreeEntries,
      telegramMaxMessages,
      telegramDateFrom,
      telegramDateTo,
      youtubeMode,
      youtubeIncludeDescription,
      youtubeIncludeComments,
      youtubeMaxComments,
      discordMode,
      discordMaxMessages,
      researchSourceCount,
      researchCapture,
      researchJunkFilter,
      showTokenCount,
      tokenContextLimit,
    });
  } catch (error) {
    console.error("Error saving settings:", error);
  }
}

// Update metadata format container visibility
function updateMetadataFormatVisibility(isVisible) {
  if (isVisible) {
    metadataFormatContainer.classList.remove("hidden");
  } else {
    metadataFormatContainer.classList.add("hidden");
  }
}

// Copy debug logs from content script
async function copyLogs() {
  const btn = copyLogsBtn;
  const originalText = btn.querySelector('.btn-text').textContent;

  try {
    const tabs = await browserAPI.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!tabs || tabs.length === 0) {
      statusIndicator.textContent = "No active tab";
      statusIndicator.className = "status error";
      return;
    }

    const response = await browserAPI.tabs.sendMessage(tabs[0].id, {
      action: "getDebugLogs",
    });

    if (response.success && response.logs) {
      await navigator.clipboard.writeText(response.logs);

      // Update button text temporarily to show feedback
      btn.querySelector('.btn-text').textContent = "Copied!";
      btn.classList.add('success');

      setTimeout(() => {
        btn.querySelector('.btn-text').textContent = originalText;
        btn.classList.remove('success');
      }, 2000);
    } else {
      statusIndicator.textContent = "No logs to copy";
      statusIndicator.className = "status error";
      setTimeout(() => {
        statusIndicator.textContent = "";
        statusIndicator.className = "status";
      }, 2000);
    }
  } catch (error) {
    statusIndicator.textContent = "Error: " + error.message;
    statusIndicator.className = "status error";
    setTimeout(() => {
      statusIndicator.textContent = "";
      statusIndicator.className = "status";
    }, 2000);
  }
}

// Toggle copy logs button visibility based on debug mode
function updateDebugModeVisibility() {
  const debugEnabled = debugModeCheckbox.checked;
  if (debugEnabled) {
    copyLogsBtn.style.display = '';
  } else {
    copyLogsBtn.style.display = 'none';
  }
}

// Multi-tab functionality

// Detect highlighted tabs and update UI
async function detectSelectedTabsAndUpdateUI() {
  // Start with single-tab mode as default (immediate render)
  showSingleTabUI();

  try {
    const validTabs = await MultiTabUtils.getHighlightedTabs(browserAPI);

    if (validTabs.length > 1) {
      // Multi-tab mode - switch to multi-tab UI
      showMultiTabUI(validTabs.length);
      return validTabs;
    } else {
      // Single-tab mode (already showing)
      return null;
    }
  } catch (error) {
    console.error('Error detecting tabs:', error);
    // Already showing single-tab UI, just return
    return null;
  }
}

function showMultiTabUI(count) {
  singleTabActions.classList.add('hidden');
  multiTabActions.classList.remove('hidden');
  selectedTabCount.textContent = count;
  // Merging the selected tabs and researching the web are different tasks;
  // offering both at once would be offering neither clearly.
  researchBar.classList.add('hidden');
}

function showSingleTabUI() {
  singleTabActions.classList.remove('hidden');
  multiTabActions.classList.add('hidden');
  researchBar.classList.remove('hidden');
}

// Progress callback for status updates
function updateStatus(message) {
  statusIndicator.textContent = message;
  statusIndicator.className = "status processing";
}

// Get current settings from UI
function getCurrentSettings() {
  return {
    contentScope: document.querySelector('input[name="contentScope"]:checked').value,
    preserveTables: preserveTablesCheckbox.checked,
    includeImages: includeImagesCheckbox.checked,
    includeTitle: includeTitleCheckbox.checked,
    includeLinks: includeLinksCheckbox.checked,
    includeMetadata: includeMetadataCheckbox.checked,
    metadataFormat: metadataFormatTextarea.value,
    debugMode: debugModeCheckbox.checked,
    triggerLazyLoading: triggerLazyLoadingCheckbox.checked,
    redditMode: redditModeCheckbox.checked,
    redditCommentSort: redditCommentSortSelect.value,
    redditMaxComments: redditMaxCommentsSelect.value,
    chatExchangeLimit: chatExchangeLimitValue,
    xMode: xModeCheckbox.checked,
    xIncludeReplies: xIncludeRepliesCheckbox.checked,
    xMaxPosts: xMaxPostsSelect.value,
    githubMode: githubModeCheckbox.checked,
    githubIncludeReadme: githubIncludeReadmeCheckbox.checked,
    githubIncludeTree: githubIncludeTreeCheckbox.checked,
    githubMaxTreeEntries: githubMaxTreeEntriesSelect.value,
    telegramMaxMessages: telegramMaxMessagesValue,
    telegramDateFrom: storedFromDisplay(telegramDateFromInput.value),
    telegramDateTo: storedFromDisplay(telegramDateToInput.value),
    youtubeMode: youtubeModeCheckbox.checked,
    youtubeIncludeDescription: youtubeIncludeDescriptionCheckbox.checked,
    youtubeIncludeComments: youtubeIncludeCommentsCheckbox.checked,
    youtubeMaxComments: youtubeMaxCommentsSelect.value,
    discordMode: discordModeCheckbox.checked,
    discordMaxMessages: discordMaxMessagesSelect.value,
    researchCapture: researchCaptureValue,
    researchJunkFilter: researchJunkFilterCheckbox.checked,
  };
}

// Check if user confirms large tab operation
// Returns true to proceed, false to cancel
function confirmLargeTabCount(tabs) {
    if (MultiTabUtils.shouldWarnAboutLargeTabCount(tabs.length)) {
        return confirm(MultiTabUtils.getLargeTabCountWarning(tabs.length));
    }
    return true; // Proceed if below threshold
}

// Shared helper for multi-tab actions (copy, download merged, download ZIP)
async function processMultiTabAction(actionFn) {
  statusIndicator.textContent = "Converting...";
  statusIndicator.className = "status processing";

  try {
    const tabs = await detectSelectedTabsAndUpdateUI();
    if (!tabs || tabs.length < 2) {
      throw new Error('Please select multiple tabs');
    }

    if (!confirmLargeTabCount(tabs)) {
      statusIndicator.textContent = "Operation cancelled";
      statusIndicator.className = "status";
      return;
    }

    const settings = getCurrentSettings();
    const results = await MultiTabUtils.processMultipleTabs(tabs, settings, browserAPI, updateStatus);

    const { prefix, suffix } = await actionFn(results);

    let totalTokenCount = 0;
    results.forEach(result => {
      if (result.success && result.tokenCount) {
        totalTokenCount += result.tokenCount;
      }
    });

    const { message } = MultiTabUtils.getResultsSummary(results);

    statusIndicator.textContent = `${prefix || ''}${message}${suffix}`;
    statusIndicator.className = "status success";

    if (totalTokenCount > 0) {
      const contextLimit = DEFAULT_TOKEN_SETTINGS.tokenContextLimit;
      updateTokenDisplay(totalTokenCount, contextLimit);
    }

    await saveSettings();
  } catch (error) {
    console.error('Multi-tab action error:', error);
    statusIndicator.textContent = `Error: ${error.message}`;
    statusIndicator.className = "status error";
    hideTokenDisplay();
  }
}

// Copy All button handler
async function copyAllTabs() {
  await processMultiTabAction(async (results) => {
    const merged = MultiTabUtils.mergeMarkdownResults(results);
    await navigator.clipboard.writeText(merged);
    return { suffix: " copied to clipboard" };
  });
}

// Download Merged button handler
async function downloadMergedFile() {
  await processMultiTabAction(async (results) => {
    const merged = MultiTabUtils.mergeMarkdownResults(results);
    const filename = `scrapllm-merged-${MultiTabUtils.getDateString()}`;
    downloadMarkdownFile(filename, merged);
    return { suffix: " downloaded" };
  });
}

// Download ZIP button handler
async function downloadZipArchive() {
  await processMultiTabAction(async (results) => {
    statusIndicator.textContent = "Creating ZIP archive...";
    const { blob, filename } = await MultiTabUtils.createZipArchive(results);
    downloadFile(filename, blob, 'application/zip');
    return { prefix: "ZIP with ", suffix: " downloaded" };
  });
}

// Convert current page to Markdown
async function convertToMarkdown(scopeOverride) {
  statusIndicator.textContent = "Converting...";
  statusIndicator.className = "status processing";

  try {
    // Get current tab
    const tabs = await browserAPI.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!tabs || tabs.length === 0) {
      throw new Error("No active tab found");
    }

    // Get current settings (scopeOverride bypasses the saved contentScope for one conversion)
    const contentScope = scopeOverride || document.querySelector('input[name="contentScope"]:checked').value;
    const preserveTables = preserveTablesCheckbox.checked;
    const includeImages = includeImagesCheckbox.checked;
    const includeTitle = includeTitleCheckbox.checked;
    const includeLinks = includeLinksCheckbox.checked;
    const includeMetadata = includeMetadataCheckbox.checked;
    const metadataFormat = metadataFormatTextarea.value;
    const debugMode = debugModeCheckbox.checked;
    const triggerLazyLoading = triggerLazyLoadingCheckbox.checked;
    const redditMode = redditModeCheckbox.checked;
    const redditCommentSort = redditCommentSortSelect.value;
    const redditMaxComments = redditMaxCommentsSelect.value;
    const chatExchangeLimit = chatExchangeLimitValue;
    const xMode = xModeCheckbox.checked;
    const xIncludeReplies = xIncludeRepliesCheckbox.checked;
    const xMaxPosts = xMaxPostsSelect.value;
    const githubMode = githubModeCheckbox.checked;
    const githubIncludeReadme = githubIncludeReadmeCheckbox.checked;
    const githubIncludeTree = githubIncludeTreeCheckbox.checked;
    const githubMaxTreeEntries = githubMaxTreeEntriesSelect.value;
    const telegramMaxMessages = telegramMaxMessagesValue;
    const telegramDateFrom = storedFromDisplay(telegramDateFromInput.value);
    const telegramDateTo = storedFromDisplay(telegramDateToInput.value);
    const youtubeMode = youtubeModeCheckbox.checked;
    const youtubeIncludeDescription = youtubeIncludeDescriptionCheckbox.checked;
    const youtubeIncludeComments = youtubeIncludeCommentsCheckbox.checked;
    const youtubeMaxComments = youtubeMaxCommentsSelect.value;
    const discordMode = discordModeCheckbox.checked;
    const discordMaxMessages = discordMaxMessagesSelect.value;

    // Send message to content script
    const response = await browserAPI.tabs.sendMessage(tabs[0].id, {
      action: "convertToMarkdown",
      settings: {
        contentScope,
        preserveTables,
        includeImages,
        includeTitle,
        includeLinks,
        includeMetadata,
        metadataFormat,
        debugMode,
        triggerLazyLoading,
        redditMode,
        redditCommentSort,
        redditMaxComments,
        chatExchangeLimit,
        xMode,
        xIncludeReplies,
        xMaxPosts,
        githubMode,
        githubIncludeReadme,
        githubIncludeTree,
        githubMaxTreeEntries,
        telegramMaxMessages,
        telegramDateFrom,
        telegramDateTo,
        youtubeMode,
        youtubeIncludeDescription,
        youtubeIncludeComments,
        youtubeMaxComments,
        discordMode,
        discordMaxMessages,
      },
    });

    if (!response.success) {
      throw new Error(response.error || "Unknown error");
    }

    // Use token count from content script response for consistency
    let tokenCount = response.tokenCount || 0;

    // Fallback to TokenCounter if needed (shouldn't happen)
    if (tokenCount === 0 && typeof TokenCounter !== 'undefined') {
      try {
        tokenCount = await TokenCounter.count(response.markdown);
      } catch (tokenError) {
        console.error("Token counting error:", tokenError);
      }
    }

    // Past the context limit the clipboard is the wrong destination: pasting
    // a document that cannot fit is a dead end, and a warning telling the user
    // so leaves them holding it. Hand over a file instead — the result is
    // delivered either way, and the route is the only thing that changes.
    const contextLimit = DEFAULT_TOKEN_SETTINGS.tokenContextLimit;
    if (tokenCount > contextLimit) {
      const filename = await generateFileNameFromPageTitle();
      downloadMarkdownFile(filename, response.markdown);
      statusIndicator.textContent = "Too large to paste — downloaded instead";
      statusIndicator.className = "status success";
    } else {
      await navigator.clipboard.writeText(response.markdown);
      statusIndicator.textContent = "Copied to clipboard!";
      statusIndicator.className = "status success";
    }

    // Update token display
    updateTokenDisplay(tokenCount, contextLimit);

    // Save settings
    await saveSettings();

  } catch (error) {
    console.error("Conversion error:", error);
    const errorMessage = error.message || error.toString() || "Failed to convert page";
    statusIndicator.textContent = `Error: ${errorMessage}`;
    statusIndicator.className = "status error";
    hideTokenDisplay();
  }
}

// Download markdown file
async function downloadMarkdown() {
  statusIndicator.textContent = "Converting...";
  statusIndicator.className = "status processing";

  try {
    // Get current tab
    const tabs = await browserAPI.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!tabs || tabs.length === 0) {
      throw new Error("No active tab found");
    }

    // Get current settings. On a chat the download follows the same rule the
    // buttons do: a file full of half a transcript is the same mistake as a
    // clipboard full of one.
    const contentScope = chatPageFallback
      ? "chat"
      : document.querySelector('input[name="contentScope"]:checked').value;
    const preserveTables = preserveTablesCheckbox.checked;
    const includeImages = includeImagesCheckbox.checked;
    const includeTitle = includeTitleCheckbox.checked;
    const includeLinks = includeLinksCheckbox.checked;
    const includeMetadata = includeMetadataCheckbox.checked;
    const metadataFormat = metadataFormatTextarea.value;
    const debugMode = debugModeCheckbox.checked;
    const triggerLazyLoading = triggerLazyLoadingCheckbox.checked;
    const redditMode = redditModeCheckbox.checked;
    const redditCommentSort = redditCommentSortSelect.value;
    const redditMaxComments = redditMaxCommentsSelect.value;
    const chatExchangeLimit = chatExchangeLimitValue;
    const xMode = xModeCheckbox.checked;
    const xIncludeReplies = xIncludeRepliesCheckbox.checked;
    const xMaxPosts = xMaxPostsSelect.value;
    const githubMode = githubModeCheckbox.checked;
    const githubIncludeReadme = githubIncludeReadmeCheckbox.checked;
    const githubIncludeTree = githubIncludeTreeCheckbox.checked;
    const githubMaxTreeEntries = githubMaxTreeEntriesSelect.value;
    const telegramMaxMessages = telegramMaxMessagesValue;
    const telegramDateFrom = storedFromDisplay(telegramDateFromInput.value);
    const telegramDateTo = storedFromDisplay(telegramDateToInput.value);
    const youtubeMode = youtubeModeCheckbox.checked;
    const youtubeIncludeDescription = youtubeIncludeDescriptionCheckbox.checked;
    const youtubeIncludeComments = youtubeIncludeCommentsCheckbox.checked;
    const youtubeMaxComments = youtubeMaxCommentsSelect.value;
    const discordMode = discordModeCheckbox.checked;
    const discordMaxMessages = discordMaxMessagesSelect.value;

    // Send message to content script
    const response = await browserAPI.tabs.sendMessage(tabs[0].id, {
      action: "convertToMarkdown",
      settings: {
        contentScope,
        preserveTables,
        includeImages,
        includeTitle,
        includeLinks,
        includeMetadata,
        metadataFormat,
        debugMode,
        triggerLazyLoading,
        redditMode,
        redditCommentSort,
        redditMaxComments,
        chatExchangeLimit,
        xMode,
        xIncludeReplies,
        xMaxPosts,
        githubMode,
        githubIncludeReadme,
        githubIncludeTree,
        githubMaxTreeEntries,
        telegramMaxMessages,
        telegramDateFrom,
        telegramDateTo,
        youtubeMode,
        youtubeIncludeDescription,
        youtubeIncludeComments,
        youtubeMaxComments,
        discordMode,
        discordMaxMessages,
      },
    });

    if (!response.success) {
      throw new Error(response.error || "Unknown error");
    }

    // Use token count from content script response for consistency
    let tokenCount = response.tokenCount || 0;

    // Fallback to TokenCounter if needed (shouldn't happen)
    if (tokenCount === 0 && typeof TokenCounter !== 'undefined') {
      try {
        tokenCount = await TokenCounter.count(response.markdown);
      } catch (tokenError) {
        console.error("Token counting error:", tokenError);
      }
    }

    // Download the file
    const filename = await generateFileNameFromPageTitle();
    downloadMarkdownFile(filename, response.markdown);

    // Update UI
    statusIndicator.textContent = "Downloaded!";
    statusIndicator.className = "status success";

    // Update token display
    const contextLimit = DEFAULT_TOKEN_SETTINGS.tokenContextLimit;
    updateTokenDisplay(tokenCount, contextLimit);

    // Save settings
    await saveSettings();

  } catch (error) {
    console.error("Download error:", error);
    const errorMessage = error.message || error.toString() || "Failed to download";
    statusIndicator.textContent = `Error: ${errorMessage}`;
    statusIndicator.className = "status error";
    hideTokenDisplay();
  }
}

// Convert split-button menu helpers
function updateConvertSplitVisibility() {
  const checked = document.querySelector('input[name="contentScope"]:checked');
  const scope = checked ? checked.value : "mainContent";

  // Caret offers the opposite of the saved scope. Selection scope has no useful inverse.
  if (scope === "mainContent") {
    convertSplit.classList.remove("no-menu");
    convertOverrideLabel.textContent = "Copy full page";
    convertOverrideBtn.title = "Override the Main-content-only setting and copy the full page this once";
    convertOverrideBtn.dataset.scope = "fullPage";
  } else if (scope === "fullPage") {
    convertSplit.classList.remove("no-menu");
    convertOverrideLabel.textContent = "Copy main content only";
    convertOverrideBtn.title = "Override the Full-page setting and copy main content only this once";
    convertOverrideBtn.dataset.scope = "mainContent";
  } else {
    convertSplit.classList.add("no-menu");
    closeConvertMenu();
  }
}

// The menu is a material arriving, not an element fading: blur, scale and
// offset resolve together out of the caret that opened it, and dismissal
// retraces the same path so the spatial relationship stays obvious.
const menuSpring = new Motion.Spring(0, {
  damping: Motion.PRESETS.snappy.damping,
  response: Motion.PRESETS.snappy.response,
  onUpdate: (value) => {
    const eased = Motion.clamp(value, 0, 1.05);
    convertMenu.style.transform =
      `translate3d(0, ${(1 - eased) * 6}px, 0) scale(${0.9 + eased * 0.1})`;
    convertMenu.style.opacity = String(Motion.clamp(eased * 1.4, 0, 1));
    convertMenu.style.filter = eased > 0.99 ? "none" : `blur(${(1 - eased) * 6}px)`;
    caretSpring.to(eased > 0.5 ? 1 : 0, Motion.PRESETS.snappy);
  },
  onRest: (spring) => {
    if (spring.value <= 0.001) convertMenu.classList.add("hidden");
  }
});

const caretSpring = new Motion.Spring(0, {
  damping: Motion.PRESETS.rotate.damping,
  response: Motion.PRESETS.rotate.response,
  onUpdate: (value) => {
    const caret = convertMenuBtn.querySelector(".caret-icon");
    if (caret) caret.style.transform = `rotate(${value * 180}deg)`;
  }
});

function isConvertMenuOpen() {
  return !convertMenu.classList.contains("hidden") && menuSpring.target > 0.5;
}

function openConvertMenu() {
  convertMenu.classList.remove("hidden");
  convertMenuBtn.setAttribute("aria-expanded", "true");
  menuSpring.to(1, Motion.PRESETS.snappy);
  convertOverrideBtn.focus();
}

function closeConvertMenu() {
  convertMenuBtn.setAttribute("aria-expanded", "false");
  if (convertMenu.classList.contains("hidden")) return;
  menuSpring.to(0, Motion.PRESETS.snappy);
}

function toggleConvertMenu() {
  if (isConvertMenuOpen()) {
    closeConvertMenu();
  } else {
    openConvertMenu();
  }
}

// Event Listeners
document.addEventListener("DOMContentLoaded", async () => {
  // Feedback on pointer-down, gestures available from the first frame.
  Motion.pressable(
    document,
    "button, a.icon-btn, .setting-option, .split-btn-menu-item"
  );
  initNavGestures();
  renderNav(0);

  initTheme();
  updateShortcutDisplay();
  initResearch();
  await loadSettings();
  initSelectionAction();
  initChatAction();
  initTelegramAction();
  initAbout();

  // Detect multi-tab selection (non-blocking, runs in background)
  // UI defaults to single-tab mode, then switches if multiple tabs detected
  detectSelectedTabsAndUpdateUI().catch(error => {
    console.error('Error detecting multi-tab selection:', error);
  });

  // Single-tab button clicks
  convertBtn.addEventListener("click", () => {
    closeConvertMenu();
    convertToMarkdown();
  });
  copySelectionBtn.addEventListener("click", () => convertToMarkdown("selection"));
  copyChatBtn.addEventListener("click", () => convertToMarkdown("chat"));

  copyTelegramBtn.addEventListener("click", () => convertToMarkdown());

  telegramSegments.querySelectorAll(".telegram-segment").forEach((segment) => {
    segment.addEventListener("click", () => setTelegramLimit(segment.dataset.value));
  });

  telegramPeriods.querySelectorAll(".telegram-segment").forEach((segment) => {
    segment.addEventListener("click", () => setTelegramPeriod(segment.dataset.period));
  });

  [telegramDateFromInput, telegramDateToInput].forEach((input) => {
    input.addEventListener("change", () => saveSettings());
  });

  telegramDateClearBtn.addEventListener("click", () => {
    telegramDateFromInput.value = "";
    telegramDateToInput.value = "";
    saveSettings();
  });
  chatPageFallbackBtn.addEventListener("click", () => {
    closeChatLimitMenu();
    convertToMarkdown();
  });
  chatLimitBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (isChatLimitMenuOpen()) {
      closeChatLimitMenu();
    } else {
      openChatLimitMenu();
    }
  });

  chatLimitMenu.querySelectorAll(".split-btn-menu-item").forEach((item) => {
    item.addEventListener("click", () => {
      setChatExchangeLimit(item.dataset.value);
      closeChatLimitMenu();
      chatLimitBtn.focus();
    });
  });
  downloadBtn.addEventListener("click", downloadMarkdown);

  // Convert split-button menu (override contentScope for one-shot full-page copy)
  updateConvertSplitVisibility();
  contentScopeRadios.forEach((radio) => {
    radio.addEventListener("change", updateConvertSplitVisibility);
  });

  convertMenuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleConvertMenu();
  });

  convertOverrideBtn.addEventListener("click", () => {
    const override = convertOverrideBtn.dataset.scope || "fullPage";
    closeConvertMenu();
    convertToMarkdown(override);
  });

  document.addEventListener("click", (e) => {
    if (isConvertMenuOpen() && !convertSplit.contains(e.target)) {
      closeConvertMenu();
    }
    if (isChatLimitMenuOpen() && !chatAction.contains(e.target)) {
      closeChatLimitMenu();
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isConvertMenuOpen()) {
      closeConvertMenu();
      convertMenuBtn.focus();
    }
    if (e.key === "Escape" && isChatLimitMenuOpen()) {
      closeChatLimitMenu();
      chatLimitBtn.focus();
    }
  });

  // Close the menu when focus leaves the split-button container (e.g. user tabs away)
  convertSplit.addEventListener("focusout", (e) => {
    if (!convertSplit.contains(e.relatedTarget)) {
      closeConvertMenu();
    }
  });

  // Multi-tab button clicks
  copyAllBtn.addEventListener("click", copyAllTabs);
  downloadMergedBtn.addEventListener("click", downloadMergedFile);
  downloadZipBtn.addEventListener("click", downloadZipArchive);

  // View navigation
  openSettingsBtn.addEventListener("click", showSettingsView);
  backToMainBtn.addEventListener("click", showMainView);

  // Theme buttons
  lightThemeBtn.addEventListener("click", () => setTheme(THEMES.LIGHT));
  darkThemeBtn.addEventListener("click", () => setTheme(THEMES.DARK));

  // Save settings when changed
  contentScopeRadios.forEach((radio) => {
    radio.addEventListener("change", saveSettings);
  });

  preserveTablesCheckbox.addEventListener("change", saveSettings);
  includeImagesCheckbox.addEventListener("change", saveSettings);
  includeTitleCheckbox.addEventListener("change", saveSettings);
  includeLinksCheckbox.addEventListener("change", saveSettings);
  debugModeCheckbox.addEventListener("change", () => {
    updateDebugModeVisibility();
    saveSettings();
  });
  triggerLazyLoadingCheckbox.addEventListener("change", saveSettings);
  redditModeCheckbox.addEventListener("change", saveSettings);
  redditCommentSortSelect.addEventListener("change", saveSettings);
  redditMaxCommentsSelect.addEventListener("change", saveSettings);
  xModeCheckbox.addEventListener("change", saveSettings);
  xIncludeRepliesCheckbox.addEventListener("change", saveSettings);
  xMaxPostsSelect.addEventListener("change", saveSettings);
  researchCaptureRadios.forEach((radio) => {
    radio.addEventListener("change", () => setResearchCapture(radio.value));
  });
  researchJunkFilterCheckbox.addEventListener("change", saveSettings);

  // Metadata format settings
  includeMetadataCheckbox.addEventListener("change", () => {
    updateMetadataFormatVisibility(includeMetadataCheckbox.checked);
    saveSettings();
  });

  metadataFormatTextarea.addEventListener("input", saveSettings);

  resetMetadataFormatBtn.addEventListener("click", () => {
    metadataFormatTextarea.value = SettingsUtils.DEFAULT_METADATA_FORMAT;
    saveSettings();
  });

  // Copy logs button
  copyLogsBtn.addEventListener("click", copyLogs);

  // Token counter settings
  showTokenCountCheckbox.addEventListener("change", () => {
    saveSettings();
    // Toggle visibility immediately
    if (showTokenCountCheckbox.checked && currentTokenCount > 0) {
      const contextLimit = DEFAULT_TOKEN_SETTINGS.tokenContextLimit;
      updateTokenDisplay(currentTokenCount, contextLimit);
    } else {
      hideTokenDisplay();
    }
  });

  // Initialize token counter
  if (typeof TokenCounter !== 'undefined') {
    TokenCounter.init().then(() => {
      console.log("TokenCounter initialized");
    }).catch(err => {
      console.error("Failed to initialize TokenCounter:", err);
    });
  }

  // Review banner buttons
});

// ---------------------------------------------------------------------------
// RESEARCH
// ---------------------------------------------------------------------------
// The run lives in background.js; this is only its face. The popup opens a
// long-lived port, renders whatever snapshot arrives and sends four kinds of
// message back — so closing the window never interrupts the work, and
// reopening it re-attaches to the run already in flight.

const researchScrim = document.getElementById("researchScrim");
const researchBar = document.getElementById("researchBar");
const researchInput = document.getElementById("researchInput");
const researchBarNote = document.getElementById("researchBarNote");
const researchGoBtn = document.getElementById("researchGoBtn");
const researchSheet = document.getElementById("researchSheet");
const researchSheetTitle = document.getElementById("researchSheetTitle");
const researchCount = document.getElementById("researchCount");
const researchPlan = document.getElementById("researchPlan");
const researchSegments = document.getElementById("researchSegments");
const researchSegmentIndicator = researchSegments.querySelector(".segment-indicator");
const researchStartBtn = document.getElementById("researchStartBtn");
const researchRun = document.getElementById("researchRun");
const researchPhase = researchRun.querySelector(".research-phase");
const researchTrack = document.getElementById("researchTrack");
const researchFill = researchRun.querySelector(".research-fill");
const researchSources = document.getElementById("researchSources");
const researchCancelBtn = document.getElementById("researchCancelBtn");
const researchResult = document.getElementById("researchResult");
const researchResultNote = researchResult.querySelector(".research-result-note");
const researchFile = document.getElementById("researchFile");
const researchTokens = document.getElementById("researchTokens");
const researchSourcesMeta = document.getElementById("researchSourcesMeta");
const researchFailedToggle = document.getElementById("researchFailedToggle");
const researchFailedList = document.getElementById("researchFailedList");
const researchCopyBtn = document.getElementById("researchCopyBtn");
const researchAgainBtn = document.getElementById("researchAgainBtn");
const researchError = document.getElementById("researchError");
const researchErrorText = document.getElementById("researchErrorText");
const researchRetryBtn = document.getElementById("researchRetryBtn");
const researchEditBtn = document.getElementById("researchEditBtn");
const researchSummary = document.getElementById("researchSummary");
const researchAlert = document.getElementById("researchAlert");
const centerSection = document.querySelector(".center-section");
// The sheet may not cover the header — the way out of the research task runs
// through it — and the header is as tall as the user's text size makes it, so
// the ceiling is measured off this element rather than guessed as a constant.
const mainHeader = mainView.querySelector(".header");

const RESEARCH_PORT_NAME = "scrapllm-research";
const researchCaptureRadios = document.querySelectorAll('input[name="researchCapture"]');
const researchJunkFilterCheckbox = document.getElementById("researchJunkFilter");
const RESEARCH_SOURCE_COUNTS = [5, 8, 12];
const RESEARCH_CAPTURE_MODES = ["quiet", "render"];
// The quiet path fetches each source from the background, which needs access to
// whatever hosts the search turns up. They are unknown until discovery has run,
// and a permission request must sit inside a user gesture — so the broad
// pattern is asked for once, on the button press, and declined means "render".
const RESEARCH_ORIGINS = { origins: ["*://*/*"] };
const SUMMARY_INTERVAL_MS = 1000;

let researchSourceCountValue = 8;
let researchCaptureValue = "quiet";
let researchPort = null;
let researchSnapshot = null;
let researchDeliveredRunId = null;
let researchLocalError = null;
let sheetTravel = 320;
// Daylight between the header's bottom edge and the top of the sheet.
const SHEET_HEADER_GAP = 8;
// A finished run downloads itself once. The marker outlives this window,
// because the background keeps the run in `done` for ten minutes and hands the
// same snapshot to every popup opened in that window.
const RESEARCH_DELIVERED_KEY = "researchDeliveredRunId";
let renderedRunKey = "";
// The denominator the progress fill was last scaled against.
let progressTotal = 0;
let lastSummaryAt = 0;
let lastSummaryText = "";
const documentRequests = [];
// One record per source row: the node and the springs that belong to it, kept
// across snapshots so a row is updated rather than rebuilt.
const sourceRows = new Map();

function prefersReducedTransparency() {
  return typeof matchMedia === "function" &&
         matchMedia("(prefers-reduced-transparency: reduce)").matches;
}

// Springs -------------------------------------------------------------------
// The sheet is a material arriving: it travels, scales and resolves out of a
// blur together, so it reads as a surface rather than an opacity fade. Bounce
// belongs here and nowhere else in this feature — this is the surface a
// gesture can throw.

// Reduced motion keeps the spring and spends it on opacity alone: the spring
// is what makes the surface interruptible, and a CSS transition on an element
// that is about to be display:none never gets a frame to run in. Critically
// damped, because an opacity that overshoots is a flicker.
function sheetTransition(extra) {
  const base = Motion.prefersReducedMotion()
    ? { damping: Motion.PRESETS.move.damping, response: 0.22, force: true }
    : { damping: Motion.PRESETS.sheet.damping, response: Motion.PRESETS.sheet.response };
  return Object.assign(base, extra || {});
}

function blockTransition() {
  return Motion.prefersReducedMotion()
    ? { damping: Motion.PRESETS.move.damping, response: 0.2, force: true }
    : { damping: Motion.PRESETS.snappy.damping, response: Motion.PRESETS.snappy.response };
}

// True from the moment a finger takes the sheet until the surface next comes to
// rest: the blur is suspended for that whole stretch.
let sheetHeld = false;

const sheetSpring = new Motion.Spring(0, {
  damping: Motion.PRESETS.sheet.damping,
  response: Motion.PRESETS.sheet.response,
  onUpdate: (value) => renderSheet(value),
  onRest: (spring) => {
    // will-change is a promise about the next few frames, not a property: it
    // is set when the surface is about to move and dropped once it rests.
    researchSheet.style.willChange = "";
    sheetHeld = false;
    if (spring.value <= 0.001) {
      researchSheet.classList.add("hidden");
      researchScrim.classList.add("hidden");
      researchSheet.setAttribute("aria-hidden", "true");
      researchInput.setAttribute("aria-expanded", "false");
      mainView.classList.remove("research-open");
      centerSection.inert = false;
      centerSection.setAttribute("aria-hidden", "false");
    }
  }
});

function renderSheet(value) {
  const reduced = Motion.prefersReducedMotion();
  const flat = reduced || prefersReducedTransparency();
  const shown = Motion.clamp(value, 0, 1);

  researchSheet.style.transform = reduced
    ? "none"
    : `translate3d(0, ${(1 - value) * sheetTravel}px, 0) scale(${0.96 + value * 0.04})`;
  // The blur is how the surface materialises and dissolves — it belongs to the
  // enter and the exit. Under the finger the content has to stay itself and
  // track 1:1, so a drag turns it off (and keeps it off until the surface
  // rests, because switching it back on at release is a visible pop). A
  // full-surface filter also re-rasterises the sheet and its backdrop-filter
  // subtree on every pointermove, which the drag cannot afford.
  researchSheet.style.filter = flat || sheetHeld || value > 0.99
    ? "none"
    : `blur(${(1 - value) * 8}px)`;
  // The same spring, spent on the cross-fade when travel is unwelcome.
  researchSheet.style.opacity = reduced ? String(shown) : "1";
  researchScrim.style.opacity = String(shown);
}

// Progress never overshoots past a count that has not happened yet, so this
// one is critically damped and only ever re-targeted upward within a run.
const progressSpring = new Motion.Spring(0, {
  damping: Motion.PRESETS.move.damping,
  response: Motion.PRESETS.move.response,
  onUpdate: (value) => {
    researchFill.style.transform = `scaleX(${Motion.clamp(value, 0, 1)})`;
  }
});

const goSpring = new Motion.Spring(0, {
  damping: Motion.PRESETS.snappy.damping,
  response: Motion.PRESETS.snappy.response,
  onUpdate: (value) => {
    // Published as a custom property, never as an inline transform: an inline
    // transform outranks the stylesheet, and the pressed state of this button
    // is a scale rule — writing the arrival scale here would leave the control
    // that starts the whole feature with no press feedback at all.
    researchGoBtn.style.setProperty(
      "--go-scale",
      Motion.prefersReducedMotion() ? "1" : String(0.6 + value * 0.4)
    );
    researchGoBtn.style.opacity = String(Motion.clamp(value, 0, 1));
    researchGoBtn.style.pointerEvents = value > 0.5 ? "" : "none";
  }
});

// The blocks cross in the same frame — the outgoing one leaves while the
// incoming one arrives — and the outgoing one leaves the layout flow as it
// goes, so the sheet is sized by the block that is arriving. The height it
// travels to is sprung (below), because a bottom-anchored surface that changes
// height moves its top edge, and a hundred pixels in one frame is a teleport.
function makeBlockSpring(element) {
  return new Motion.Spring(0, {
    damping: Motion.PRESETS.snappy.damping,
    response: Motion.PRESETS.snappy.response,
    onUpdate: (value) => {
      const reduced = Motion.prefersReducedMotion();
      // Under reduced motion the two blocks cross-fade one-to-one; with travel
      // available the incoming block leads, so it is legible before it lands.
      element.style.opacity = String(Motion.clamp(reduced ? value : value * 1.4, 0, 1));
      element.style.transform = reduced ? "none" : `scale(${0.96 + value * 0.04})`;
      element.style.filter = reduced || value > 0.99 ? "none" : `blur(${(1 - value) * 6}px)`;
    },
    onRest: (spring) => {
      element.style.willChange = "";
      if (spring.value <= 0.001) {
        element.classList.add("hidden");
        element.classList.remove("is-leaving");
        element.style.top = "";
      }
    }
  });
}

const blockSprings = {
  plan: makeBlockSpring(researchPlan),
  run: makeBlockSpring(researchRun),
  result: makeBlockSpring(researchResult),
  error: makeBlockSpring(researchError)
};

const RESEARCH_BLOCKS = {
  plan: researchPlan,
  run: researchRun,
  result: researchResult,
  error: researchError
};

// The sheet is anchored to the bottom edge, so its height is the position of
// its top edge. It travels between states instead of cutting.
const sheetHeightSpring = new Motion.Spring(0, {
  damping: Motion.PRESETS.move.damping,
  response: Motion.PRESETS.move.response,
  onUpdate: (value) => { researchSheet.style.height = `${value}px`; },
  // Released back to the content once it has arrived: a state that grows a row
  // later should still be able to size itself.
  onRest: () => { researchSheet.style.height = ""; }
});

function showBlock(name) {
  const onScreen = sheetSpring.value > 0.5 && !researchSheet.classList.contains("hidden");
  const from = onScreen ? researchSheet.offsetHeight : 0;

  // Every leaving block is pinned where it already is, before the incoming one
  // is revealed: pinned first, or the reveal moves it before it is measured.
  Object.keys(blockSprings).forEach((key) => {
    if (key === name) return;
    const spring = blockSprings[key];
    if (spring.target <= 0) return;
    const element = RESEARCH_BLOCKS[key];
    element.style.top = `${element.offsetTop - researchSheet.clientTop}px`;
    element.classList.add("is-leaving");
    element.style.willChange = "transform, opacity, filter";
    spring.to(0, blockTransition());
  });

  const incoming = RESEARCH_BLOCKS[name];
  incoming.classList.remove("hidden");
  incoming.classList.remove("is-leaving");
  incoming.style.top = "";
  incoming.style.willChange = "transform, opacity, filter";
  blockSprings[name].to(1, blockTransition());

  if (!from) return;
  researchSheet.style.height = "";
  const to = researchSheet.offsetHeight;
  if (!to || to === from) return;
  sheetHeightSpring.set(from);
  researchSheet.style.height = `${from}px`;
  sheetHeightSpring.to(to, Motion.PRESETS.move);
}

// Sheet presentation --------------------------------------------------------

function isSheetOpen() {
  return sheetSpring.target > 0.5;
}

// The room the sheet may take, measured rather than assumed: it stops below
// the header, so the settings button — the only way into the settings view —
// stays reachable, and two translucent surfaces never stack on each other.
function measureSheetBounds() {
  const room = mainView.getBoundingClientRect().bottom -
               mainHeader.getBoundingClientRect().bottom - SHEET_HEADER_GAP;
  if (room > 0) researchSheet.style.maxHeight = `${room}px`;
}

// The travel is the sheet's own height, and that height belongs to the state
// it is showing — so it is re-measured whenever the surface resizes, not once
// per open. A stale travel leaves a strip of sheet on screen at rest and sends
// a drag-dismissal to the wrong place.
function measureSheetTravel() {
  const height = researchSheet.offsetHeight;
  if (!height) return;
  sheetTravel = height;
  renderSheet(sheetSpring.value);
}

function openSheet(options) {
  const opts = options || {};
  researchSheet.classList.remove("hidden");
  researchScrim.classList.remove("hidden");
  researchSheet.setAttribute("aria-hidden", "false");
  researchInput.setAttribute("aria-expanded", "true");
  mainView.classList.add("research-open");
  centerSection.inert = true;
  centerSection.setAttribute("aria-hidden", "true");
  measureSheetBounds();
  measureSheetTravel();
  // The segments have no layout while the sheet is hidden, so the selection
  // pill takes its place the moment the surface has one.
  syncSegmentIndicator({ immediate: true });
  researchSheet.style.willChange = "transform, filter";
  if (opts.immediate) {
    sheetSpring.set(1);
    renderSheet(1);
  } else {
    sheetSpring.to(1, sheetTransition());
  }
}

function closeSheet() {
  if (!isSheetOpen()) return;
  researchSheet.style.willChange = "transform, filter";
  sheetSpring.to(0, sheetTransition());
  // The field raised the sheet, so the field gets the focus back.
  researchInput.focus({ preventScroll: true });
}

function initSheetGesture() {
  let startProgress = 1;

  Motion.draggable(researchSheet, {
    axis: "y",
    threshold: 10,
    // Gated on the live value, never on the target: a sheet the user grabs
    // while it is animating closed is still on screen and still theirs. The
    // drag then continues from that presentation value, so nothing jumps.
    canStart: (event) => sheetSpring.value > 0.02 &&
      !event.target.closest("button, input, .research-sources, .research-failed-list"),
    onStart: () => {
      startProgress = sheetSpring.value;
      sheetHeld = true;
      researchSheet.style.willChange = "transform";
      researchSheet.style.filter = "none";
    },
    onMove: ({ delta }) => trackSheet(startProgress, delta),
    onEnd: ({ delta, velocity, cancelled }) => {
      if (cancelled) { sheetSpring.to(startProgress, Motion.PRESETS.move); return; }
      trackSheet(startProgress, delta);
      settleSheet(sheetSpring.value, velocity);
    }
  });
}

function trackSheet(startProgress, deltaPx) {
  // Dragging down (positive delta) pushes the sheet away.
  let progress = startProgress - deltaPx / sheetTravel;
  if (progress > 1) progress = 1 + Motion.rubberband(progress - 1, 1);
  if (progress < 0) progress = 0;
  sheetSpring.set(progress);
  renderSheet(progress);
}

function settleSheet(progress, velocityPxPerSecond) {
  const projectedPx = progress * sheetTravel - Motion.project(velocityPxPerSecond);
  const projected = projectedPx / sheetTravel;
  const decisive = Math.abs(velocityPxPerSecond) > 120;
  const target = decisive ? (velocityPxPerSecond > 0 ? 0 : 1) : (projected > 0.5 ? 1 : 0);

  sheetSpring.to(target, sheetTransition({
    velocity: -velocityPxPerSecond / sheetTravel
  }));
  if (target === 0) researchInput.focus({ preventScroll: true });
}

// Source count --------------------------------------------------------------

function setResearchSourceCount(value, options) {
  const count = RESEARCH_SOURCE_COUNTS.includes(Number(value)) ? Number(value) : 8;
  researchSourceCountValue = count;
  researchSegments.querySelectorAll(".segment-btn").forEach((btn) => {
    const selected = Number(btn.dataset.value) === count;
    btn.classList.toggle("is-selected", selected);
    btn.setAttribute("aria-checked", selected ? "true" : "false");
    btn.tabIndex = selected ? 0 : -1;
  });
  syncSegmentIndicator();
  if (!options || options.persist !== false) saveSettings();
}

// The capture mode is a preference, not a per-run choice, so it lives in
// Settings with the other radio groups rather than in the run sheet.
function setResearchCapture(value, options) {
  const mode = RESEARCH_CAPTURE_MODES.includes(String(value)) ? String(value) : "quiet";
  researchCaptureValue = mode;
  researchCaptureRadios.forEach((radio) => {
    radio.checked = radio.value === mode;
  });
  if (!options || options.persist !== false) saveSettings();
}

// One pill, moved between the segments by two springs — position and width
// are independent, so they never desync — instead of a background that
// disappears from one button and reappears on another.
const segmentXSpring = new Motion.Spring(0, {
  damping: Motion.PRESETS.snappy.damping,
  response: Motion.PRESETS.snappy.response,
  onUpdate: (value) => {
    researchSegmentIndicator.style.transform = `translate3d(${value}px, 0, 0)`;
  },
  onRest: () => { researchSegmentIndicator.style.willChange = ""; }
});

const segmentWidthSpring = new Motion.Spring(0, {
  damping: Motion.PRESETS.snappy.damping,
  response: Motion.PRESETS.snappy.response,
  onUpdate: (value) => {
    researchSegmentIndicator.style.width = `${value}px`;
  }
});

function syncSegmentIndicator(options) {
  const opts = options || {};
  const selected = researchSegments.querySelector(".segment-btn.is-selected");
  // No layout yet: the sheet is still hidden, and openSheet syncs on arrival.
  if (!selected || !selected.offsetWidth) return;
  const x = selected.offsetLeft;
  const width = selected.offsetWidth;

  if (opts.immediate) {
    segmentXSpring.set(x);
    segmentWidthSpring.set(width);
    return;
  }
  researchSegmentIndicator.style.willChange = "transform, width";
  segmentXSpring.to(x, Motion.PRESETS.snappy);
  segmentWidthSpring.to(width, Motion.PRESETS.snappy);
}

function initSegmentedControl() {
  const buttons = Array.from(researchSegments.querySelectorAll(".segment-btn"));

  buttons.forEach((btn) => {
    btn.addEventListener("click", () => setResearchSourceCount(btn.dataset.value));
  });

  researchSegments.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const index = buttons.findIndex((btn) => Number(btn.dataset.value) === researchSourceCountValue);
    const step = event.key === "ArrowRight" ? 1 : -1;
    const next = buttons[(index + step + buttons.length) % buttons.length];
    setResearchSourceCount(next.dataset.value);
    next.focus();
  });
}

// Port ----------------------------------------------------------------------

function connectResearchPort() {
  if (!browserAPI.runtime || typeof browserAPI.runtime.connect !== "function") {
    throw new Error("This browser did not expose runtime.connect, so research cannot report progress.");
  }
  const port = browserAPI.runtime.connect({ name: RESEARCH_PORT_NAME });

  port.onMessage.addListener((message) => {
    if (!message || !message.type) return;

    if (message.type === "snapshot") {
      researchLocalError = null;
      renderResearch(message.snapshot);
      return;
    }

    if (message.type === "document") {
      const pending = documentRequests.shift();
      if (pending) pending.resolve(message);
      return;
    }

    if (message.type === "error") {
      const pending = documentRequests.shift();
      if (pending) {
        pending.reject(new Error(message.message));
        return;
      }
      // A start that was refused: the message is shown verbatim, never reworded.
      researchLocalError = message.message;
      showResearchError(message.message);
    }
  });

  return port;
}

function requestResearchDocument(runId) {
  return new Promise((resolve, reject) => {
    documentRequests.push({ resolve, reject });
    researchPort.postMessage({ type: "getDocument", runId });
  });
}

// Rendering -----------------------------------------------------------------

const PHASE_TITLES = {
  idle: "Research",
  searching: "Researching",
  running: "Researching",
  done: "Downloaded",
  cancelled: "Cancelled",
  error: "Research failed",
  empty: "Research failed",
  interrupted: "Research failed"
};

const SHEET_STATES = {
  idle: "plan",
  searching: "run",
  running: "run",
  done: "done",
  cancelled: "cancelled",
  error: "error",
  empty: "error",
  interrupted: "error"
};

function renderResearch(snapshot) {
  const previous = researchSnapshot;
  researchSnapshot = snapshot;
  const phase = snapshot.phase;
  const live = phase === "searching" || phase === "running";

  researchSheetTitle.textContent = PHASE_TITLES[phase] || "Research";
  researchSheet.dataset.state = SHEET_STATES[phase] || "plan";
  // The counter belongs to the run: once it is over, the result card carries
  // the numbers and a stale "3 / 8" beside it would be a lie.
  researchCount.hidden = !live;

  if (live && !isSheetOpen() && (!previous || previous.phase === "idle")) {
    // A run started elsewhere (or the popup reopened): present the sheet in
    // its current state rather than animating a history the window missed.
    researchInput.value = snapshot.query;
    openSheet({ immediate: true });
  }

  if (live) {
    researchInput.readOnly = true;
    if (!researchInput.value) researchInput.value = snapshot.query;
    renderRun(snapshot);
    showBlock("run");
  } else {
    researchInput.readOnly = false;
  }

  if (phase === "done" || phase === "cancelled") {
    renderResult(snapshot);
    showBlock("result");
  }

  if (phase === "error" || phase === "empty" || phase === "interrupted") {
    showResearchError(researchErrorMessage(snapshot));
  }

  if (phase === "idle" && !researchLocalError) {
    showBlock("plan");
  }

  updateResearchBar(snapshot);
  announceResearch(snapshot);
  deliverResearchDocument(snapshot, previous).catch((error) => {
    showResearchError(error.message, { present: isSheetOpen() });
  });
  moveResearchFocus(snapshot, previous);
}

function researchErrorMessage(snapshot) {
  if (snapshot.phase === "empty") return "No sources found for that query.";
  if (snapshot.phase === "interrupted") {
    return "The run was interrupted — the browser restarted before it finished.";
  }
  return snapshot.error || "The run failed.";
}

function renderRun(snapshot) {
  const total = snapshot.total;
  const searching = snapshot.phase === "searching" || total === 0;

  researchPhase.textContent = searching
    ? "Finding sources…"
    : (snapshot.degraded || `Reading ${total} ${total === 1 ? "source" : "sources"}.`);
  researchPhase.classList.toggle("research-degraded", !searching && !!snapshot.degraded);

  researchCount.hidden = searching;
  researchCount.textContent = `${snapshot.completed} / ${total}`;

  // Discovery has no denominator, so it gets no determinate progress: an empty
  // bar and an indeterminate progressbar, never a bar that moves for show.
  if (searching) {
    // Indeterminate is the absence of a value, not a range collapsed to a
    // point: an aria-valuemax of 0 is read out as "0 percent" by some screen
    // readers, which is the opposite of what discovery is doing.
    researchTrack.removeAttribute("aria-valuenow");
    researchTrack.removeAttribute("aria-valuemax");
    researchTrack.setAttribute("aria-valuetext", "Finding sources");
    progressSpring.set(0);
    researchFill.style.transform = "scaleX(0)";
  } else {
    researchTrack.setAttribute("aria-valuenow", String(snapshot.completed));
    researchTrack.setAttribute("aria-valuemax", String(total));
    researchTrack.setAttribute("aria-valuetext", `${snapshot.completed} of ${total} sources fetched`);
    const value = total > 0 ? snapshot.completed / total : 0;
    // The fill only ever grows *within* one denominator. When the engine
    // promotes a reserve the denominator itself grows, and holding the old
    // fraction would leave the bar claiming more progress than the count beside
    // it — so a changed total re-targets the bar to the truth, in either
    // direction, and the monotonic rule resumes from there.
    const grew = total !== progressTotal;
    progressTotal = total;
    if (grew || value > progressSpring.target) progressSpring.to(value, Motion.PRESETS.move);
  }

  renderSourceRows(snapshot);
}

const ROW_STATES = {
  pending: "queued",
  fetching: "fetching",
  ok: "done",
  error: "failed",
  skipped: "skipped"
};

// A page that refused to be captured, one the quality gate dropped and one the
// user cancelled did not fail: nothing about them says the run went wrong, so
// they read as skipped — a muted dash — rather than as red errors. `unusable`
// and `transient` keep the error glyph: a PDF, a private address and a page
// that would not load are sources the run tried and could not use.
const SKIPPED_CATEGORIES = new Set(["wall", "junk", "duplicate", "cancelled", "budget"]);

function rowState(entry) {
  const state = ROW_STATES[entry.status] || "queued";
  if (state !== "failed" && state !== "skipped") return state;
  if (SKIPPED_CATEGORIES.has(entry.category)) return "skipped";
  if (entry.category === "unusable" || entry.category === "transient") return "failed";
  return state;
}

function createSourceRow() {
  const row = document.createElement("li");
  row.className = "source-row";
  row.setAttribute("role", "listitem");

  const glyph = document.createElement("span");
  glyph.className = "source-glyph";
  glyph.setAttribute("aria-hidden", "true");

  const text = document.createElement("span");
  text.className = "source-text";
  const title = document.createElement("span");
  title.className = "source-title";
  const host = document.createElement("span");
  host.className = "source-host";
  // The capture path is a property of the source, so it sits on the host
  // line rather than in the status column. Only a source that needed a
  // rendering engine says so: marking the common case on every row would
  // be decoration, and the quiet path is what the run already promised.
  const path = document.createElement("span");
  path.className = "source-path";
  path.setAttribute("aria-hidden", "true");
  path.hidden = true;
  // A row that appeared because another source was dropped explains itself:
  // otherwise the source count grows from 8 to 9 with nothing to account for it.
  const flag = document.createElement("span");
  flag.className = "source-path source-flag";
  flag.setAttribute("aria-hidden", "true");
  flag.hidden = true;
  flag.textContent = "replacement";
  const meta = document.createElement("span");
  meta.className = "source-meta";
  meta.append(host, path, flag);
  text.append(title, meta);

  const note = document.createElement("span");
  note.className = "source-note";

  row.append(glyph, text, note);

  row.style.willChange = "transform, opacity";
  const spring = new Motion.Spring(0, {
    damping: Motion.PRESETS.snappy.damping,
    response: Motion.PRESETS.snappy.response,
    onUpdate: (value) => {
      row.style.opacity = String(Motion.clamp(value, 0, 1));
      row.style.transform = Motion.prefersReducedMotion()
        ? "none"
        : `translate3d(0, ${(1 - value) * 8}px, 0)`;
    },
    // A row that has arrived is not going to move again; a dozen rows held
    // as compositor layers for the life of the popup would be.
    onRest: () => { row.style.willChange = ""; }
  });

  // The mark arrives out of the host it belongs to, so it travels the few
  // pixels from behind it rather than blinking into place.
  const pathSpring = new Motion.Spring(0, {
    damping: Motion.PRESETS.snappy.damping,
    response: Motion.PRESETS.snappy.response,
    onUpdate: (value) => {
      const shown = Motion.clamp(value, 0, 1);
      path.style.opacity = String(shown);
      path.style.transform = Motion.prefersReducedMotion()
        ? "none"
        : `translate3d(${(shown - 1) * 4}px, 0, 0)`;
    },
    onRest: () => { path.style.willChange = ""; }
  });

  return { row, spring, pathSpring, path: "" };
}

function updateSourceRow(record, entry) {
  const row = record.row;
  row.dataset.state = rowState(entry);
  row.querySelector(".source-title").textContent = entry.title || entry.url;
  row.querySelector(".source-host").textContent = entry.host;
  const note = row.querySelector(".source-note");
  note.textContent = entry.note;

  const flag = row.querySelector(".source-flag");
  flag.hidden = !entry.replacement;

  // How it was captured, and why it was not captured quietly, are on the row
  // itself rather than only in the finished document.
  const wasPath = record.path;
  const isPath = entry.path || "";
  record.path = isPath;
  if (isPath !== wasPath) {
    const mark = row.querySelector(".source-path");
    const rendered = isPath === "rendered";
    mark.textContent = rendered ? "rendered" : "";
    mark.hidden = !rendered;
    if (rendered && !Motion.prefersReducedMotion()) {
      mark.style.willChange = "transform, opacity";
      record.pathSpring.to(1, Motion.PRESETS.snappy);
    } else {
      // Reduced motion cross-fades the mark in through CSS instead.
      record.pathSpring.set(rendered ? 1 : 0);
    }
  }

  const spoken = isPath === "rendered"
    ? "rendered in a tab"
    : (isPath === "quiet" ? "read without a tab" : "");
  // A thin quiet capture is kept, so the caveat travels with it: the note
  // already ends in "· thin", and the hover text and the label say how thin.
  const caveat = entry.pathReason || entry.thinNote || "";
  note.title = caveat ? `${entry.note} — ${caveat}` : entry.note;
  row.setAttribute("aria-label", [
    entry.host,
    entry.note,
    spoken,
    caveat,
    entry.replacement ? "replacing a dropped source" : ""
  ].filter(Boolean).join(", "));
}

// The list's scroll-edge fade belongs where content actually passes under an
// edge: at the top of an unscrolled list there is nothing above the first row,
// and fading it there dimmed the first title to announce content that does not
// exist.
const SOURCE_MASK_FADE = "0.5rem";

function syncSourceMask() {
  const list = researchSources;
  const scrollable = list.scrollHeight - list.clientHeight;
  const atTop = list.scrollTop <= 1;
  const atBottom = scrollable <= 1 || list.scrollTop >= scrollable - 1;
  list.style.setProperty("--mask-top", atTop ? "0rem" : SOURCE_MASK_FADE);
  list.style.setProperty("--mask-bottom", atBottom ? "0rem" : SOURCE_MASK_FADE);
}

// Rows are keyed by the source they show, not by how many there are: the
// engine promotes a reserve mid-run, and rebuilding the list on the new count
// restarted every spinner, threw away every row's arrival spring and dropped
// the promoted row in with no motion at all.
function renderSourceRows(snapshot) {
  const fresh = snapshot.runId !== renderedRunKey;
  if (fresh) {
    researchSources.textContent = "";
    sourceRows.clear();
    renderedRunKey = snapshot.runId || "";
  }
  // A popup opened mid-run must not animate rows into a state that predates
  // the window: the stagger runs only when every source is still queued, which
  // is exactly the case where nothing has happened yet.
  const stagger = fresh && snapshot.entries.every((entry) => entry.status === "pending");
  const seen = new Set();

  snapshot.entries.forEach((entry, index) => {
    // Discovery drops duplicate URLs, so the URL is the identity; the index
    // suffix only exists so a repeat could never collapse two rows into one.
    const key = seen.has(entry.url) ? `${entry.url}#${index}` : entry.url;
    seen.add(key);

    let record = sourceRows.get(key);
    const arriving = !record;
    if (arriving) {
      record = createSourceRow();
      sourceRows.set(key, record);
    }

    // Position follows the snapshot, but an existing row is only moved when it
    // is genuinely out of place: a promoted reserve is appended and nothing
    // above it is touched.
    const atIndex = researchSources.children[index];
    if (atIndex !== record.row) researchSources.insertBefore(record.row, atIndex || null);

    updateSourceRow(record, entry);

    if (arriving) {
      if (Motion.prefersReducedMotion()) {
        record.spring.set(1);
        record.row.style.willChange = "";
      } else if (stagger) {
        // The stagger points down the list, in the direction the work travels.
        setTimeout(() => record.spring.to(1, Motion.PRESETS.snappy), index * 40);
      } else {
        // A row that arrives on its own — a promoted reserve — slides in the
        // same way the first batch did.
        record.spring.to(1, Motion.PRESETS.snappy);
      }
    }
  });

  for (const [key, record] of sourceRows) {
    if (seen.has(key)) continue;
    record.row.remove();
    sourceRows.delete(key);
  }

  syncSourceMask();
}

function renderResult(snapshot) {
  const cancelled = snapshot.phase === "cancelled";

  researchFile.textContent = snapshot.filename || "—";
  researchTokens.textContent = `~${snapshot.tokenCount.toLocaleString()}`;
  const capture = snapshot.rendered
    ? ` (${snapshot.quiet} without a tab, ${snapshot.rendered} rendered in one)`
    : "";
  researchSourcesMeta.textContent = cancelled
    ? `${snapshot.succeeded} of ${snapshot.total} sources were fetched before you stopped.`
    : `${snapshot.succeeded} of ${snapshot.total} sources${capture}`;

  const notes = [];
  if (snapshot.resultsTooLargeToPersist) {
    notes.push("The document was too large to keep in session storage — copy or save it before closing the popup.");
  }
  if (snapshot.captureNote) notes.push(snapshot.captureNote);
  if (snapshot.degraded) notes.push(snapshot.degraded);
  researchResultNote.classList.toggle("hidden", notes.length === 0);
  researchResultNote.textContent = notes.join(" ");

  researchCopyBtn.textContent = cancelled ? `Keep these ${snapshot.succeeded}` : "Copy Markdown";
  researchAgainBtn.textContent = cancelled ? "Discard" : "New search";

  const failures = researchFailures(snapshot);
  researchFailedToggle.classList.toggle("hidden", failures.length === 0);
  researchFailedToggle.textContent = researchFailureSummary(failures);

  researchFailedList.textContent = "";
  failures.forEach((failure) => {
    const item = document.createElement("li");
    item.dataset.state = failure.state;
    const host = document.createElement("span");
    host.className = "source-host";
    host.textContent = failure.host;
    const note = document.createElement("span");
    note.className = "source-note";
    note.textContent = failure.reason;
    note.title = failure.reason;
    item.append(host, note);
    researchFailedList.appendChild(item);
  });
}

// Nothing is smoothed over: a source that failed and a candidate that was
// dropped before it was ever opened both keep their verbatim reason — and they
// are not the same event, so each carries which of the three it was.
function researchFailures(snapshot) {
  const failures = snapshot.entries
    .filter((entry) => entry.status === "error" || entry.status === "skipped")
    .map((entry) => ({ host: entry.host, reason: entry.note, state: rowState(entry) }));
  snapshot.rejected.forEach((item) => {
    // Scored, dropped and never opened: this candidate did not fail, and it was
    // not skipped either — the filter never let the run near it.
    failures.push({ host: item.host, reason: item.reason, state: "dropped" });
  });
  return failures;
}

// "3 sources failed" over a paywall, a junk page and a candidate the filter
// dropped told the user the run broke three times, which is not what happened.
// Each group is counted in its own words and the zero terms are left out.
function researchFailureSummary(failures) {
  const counts = { failed: 0, skipped: 0, dropped: 0 };
  failures.forEach((failure) => {
    if (failure.state === "failed") counts.failed++;
    else if (failure.state === "dropped") counts.dropped++;
    else counts.skipped++;
  });

  const parts = [];
  if (counts.failed) parts.push(`${counts.failed} failed`);
  if (counts.skipped) parts.push(`${counts.skipped} skipped`);
  if (counts.dropped) {
    parts.push(`${counts.dropped} dropped by the filter`);
  }
  const total = counts.failed + counts.skipped + counts.dropped;
  const noun = total === 1 ? "source" : "sources";
  return `${total} ${noun}: ${parts.join(", ")}`;
}

// `present: false` writes the failure into the sheet without raising it: a
// failure the user did not ask for — a run whose results expired while the
// popup was closed — must not throw a surface over a window they opened for
// something else, and must not fire the alert channel either.
function showResearchError(message, options) {
  const present = !options || options.present !== false;
  researchErrorText.textContent = message;
  researchSheet.dataset.state = "error";
  researchSheetTitle.textContent = "Research failed";
  researchInput.readOnly = false;
  if (present) {
    researchAlert.textContent = message;
    if (!isSheetOpen()) openSheet();
  }
  showBlock("error");
}

function updateResearchBar(snapshot) {
  const live = snapshot.phase === "searching" || snapshot.phase === "running";
  researchBar.classList.toggle("is-running", live);
  const collapsed = live && !isSheetOpen();
  researchBarNote.classList.toggle("hidden", !collapsed);
  if (collapsed) {
    researchBarNote.textContent = snapshot.total > 0
      ? `Researching ${snapshot.completed} / ${snapshot.total}`
      : "Finding sources…";
  }
}

// Announcements are the screen-reader channel; the row list is aria-live=off
// because its churn would flood it.
function announceResearch(snapshot) {
  const phase = snapshot.phase;
  let sentence = "";

  if (phase === "searching") {
    sentence = `Finding sources for "${snapshot.query}".`;
  } else if (phase === "running") {
    const fetching = snapshot.entries.filter((entry) => entry.status === "fetching");
    const lead = fetching.length === 1
      ? `Fetching ${fetching[0].host}.`
      : `Fetching ${fetching.length} sources.`;
    sentence = `${lead} ${snapshot.completed} of ${snapshot.total} done.`;
  } else if (phase === "done") {
    sentence = `Downloaded ${snapshot.filename}. ${snapshot.succeeded} of ${snapshot.total} sources, about ${snapshot.tokenCount.toLocaleString()} tokens.`;
  } else if (phase === "cancelled") {
    sentence = `Cancelled. ${snapshot.succeeded} of ${snapshot.total} sources were fetched.`;
  }

  if (!sentence || sentence === lastSummaryText) return;

  const final = phase !== "searching" && phase !== "running";
  const now = Date.now();
  if (!final && now - lastSummaryAt < SUMMARY_INTERVAL_MS) return;

  lastSummaryAt = now;
  lastSummaryText = sentence;
  researchSummary.textContent = sentence;
}

// Delivery ------------------------------------------------------------------
// The primary key says "Research & Download", so a finished run downloads
// itself. A cancelled run does not: stopping is not the same as asking for
// what was collected, so it offers the choice instead.
//
// Once, and once only. The background holds a finished run in `done` for ten
// minutes and hands that same snapshot to every popup that connects, so a
// marker living in this window's memory would write the file to Downloads
// again on every open. It is written to storage instead — which also means the
// run still delivers itself when it finished with the popup closed.
function readDeliveredRunId() {
  return browserAPI.storage.local
    .get({ [RESEARCH_DELIVERED_KEY]: null })
    .then((stored) => stored[RESEARCH_DELIVERED_KEY]);
}

function rememberDeliveredRunId(runId) {
  return browserAPI.storage.local.set({ [RESEARCH_DELIVERED_KEY]: runId });
}

async function deliverResearchDocument(snapshot, previous) {
  if (snapshot.phase !== "done") return;
  if (!snapshot.runId || researchDeliveredRunId === snapshot.runId) return;
  if (previous && previous.phase === "done" && previous.runId === snapshot.runId) return;

  researchDeliveredRunId = snapshot.runId;
  if (await readDeliveredRunId() === snapshot.runId) return;

  try {
    const doc = await requestResearchDocument(snapshot.runId);
    downloadMarkdownFile(doc.filename.replace(/\.md$/, ""), doc.markdown);
    await rememberDeliveredRunId(snapshot.runId);
  } catch (error) {
    // The document is gone — the run's ten minutes lapsed — and no later open
    // can bring it back, so the run is marked delivered rather than asked for
    // again, and the reason waits in the sheet instead of jumping out of it.
    await rememberDeliveredRunId(snapshot.runId);
    showResearchError(error.message, { present: isSheetOpen() });
  }
}

function moveResearchFocus(snapshot, previous) {
  if (!previous) return;
  if (previous.phase !== snapshot.phase) {
    if (snapshot.phase === "searching" || snapshot.phase === "running") {
      if (isSheetOpen()) researchCancelBtn.focus({ preventScroll: true });
    } else if (snapshot.phase === "done" || snapshot.phase === "cancelled") {
      if (isSheetOpen()) researchCopyBtn.focus({ preventScroll: true });
    } else if (snapshot.phase === "error" || snapshot.phase === "empty" || snapshot.phase === "interrupted") {
      if (isSheetOpen()) researchRetryBtn.focus({ preventScroll: true });
    }
  }
}

// Actions -------------------------------------------------------------------

// The permission request has to be the first thing the gesture does: both
// browsers only honour permissions.request from inside a user-action handler,
// and any await before it spends the gesture. Denial is not a failure — the
// run falls back to a background tab per source, which needs no host access.
//
// Resolves with { granted, note }, because the ways this can end are not one
// answer and must not read like one: the user declined, the browser has no
// optional-origin API at all (Firefox honours optional_host_permissions only
// from 116, and the package still supports 109), the request threw, or the run
// was going to open tabs anyway. The note is what the run reports at run level.
function requestResearchHostAccess() {
  if (researchCaptureValue === "render") {
    return Promise.resolve({ granted: false, note: null });
  }
  if (!browserAPI.permissions || typeof browserAPI.permissions.request !== "function") {
    return Promise.resolve({
      granted: false,
      note: "This browser does not offer optional site access, so every source was opened in a background tab"
    });
  }
  try {
    return browserAPI.permissions.request(RESEARCH_ORIGINS).then(
      (granted) => ({
        granted: granted === true,
        note: granted === true
          ? null
          : "Without site access, every source is opened in a background tab"
      }),
      (error) => ({
        granted: false,
        note: `Site access could not be requested (${error && error.message ? error.message : error}), so every source was opened in a background tab`
      })
    );
  } catch (error) {
    return Promise.resolve({
      granted: false,
      note: `Site access could not be requested (${error && error.message ? error.message : error}), so every source was opened in a background tab`
    });
  }
}

async function startResearch() {
  const query = researchInput.value.trim();
  if (!query) return;

  const access = await requestResearchHostAccess();

  researchLocalError = null;
  researchDeliveredRunId = null;
  renderedRunKey = "";
  lastSummaryText = "";
  researchSources.textContent = "";
  sourceRows.clear();
  progressTotal = 0;
  progressSpring.set(0);
  researchFill.style.transform = "scaleX(0)";
  researchPhase.textContent = "Finding sources…";
  researchPhase.classList.remove("research-degraded");
  researchCount.hidden = true;
  researchSheetTitle.textContent = "Researching";
  researchSheet.dataset.state = "run";
  researchInput.readOnly = true;

  if (!isSheetOpen()) openSheet();
  showBlock("run");
  researchCancelBtn.focus({ preventScroll: true });

  researchPort.postMessage({
    type: "start",
    query,
    sourceCount: researchSourceCountValue,
    hostAccess: access.granted,
    hostAccessNote: access.note,
    settings: getCurrentSettings()
  });
}

function cancelResearch() {
  if (!researchSnapshot || !researchSnapshot.runId) return;
  researchPort.postMessage({ type: "cancel", runId: researchSnapshot.runId });
}

function isResearchRunning() {
  return !!researchSnapshot &&
    (researchSnapshot.phase === "searching" || researchSnapshot.phase === "running");
}

function resetResearch() {
  researchLocalError = null;
  researchDeliveredRunId = null;
  renderedRunKey = "";
  lastSummaryText = "";
  researchInput.value = "";
  researchInput.readOnly = false;
  researchSources.textContent = "";
  sourceRows.clear();
  researchSheet.dataset.state = "plan";
  researchSheetTitle.textContent = "Research";
  researchCount.hidden = true;
  goSpring.to(0, Motion.PRESETS.snappy);
  showBlock("plan");
  closeSheet();
}

function initResearch() {
  researchPort = connectResearchPort();
  initSegmentedControl();
  initSheetGesture();
  // The sheet is a different height in every state, and a state can change
  // while it is on screen: the travel follows the surface instead of being
  // sampled once at open time.
  new ResizeObserver(measureSheetTravel).observe(researchSheet);
  renderSheet(0);
  blockSprings.plan.set(1);
  researchPlan.style.opacity = "1";
  researchGoBtn.style.opacity = "0";
  researchGoBtn.style.pointerEvents = "none";

  researchInput.addEventListener("input", () => {
    const hasQuery = researchInput.value.trim().length > 0;
    researchGoBtn.disabled = !hasQuery;
    goSpring.to(hasQuery ? 1 : 0, Motion.PRESETS.snappy);

    if (isResearchRunning()) return;
    if (hasQuery && !isSheetOpen()) {
      researchSheet.dataset.state = "plan";
      showBlock("plan");
      openSheet();
      researchInput.focus({ preventScroll: true });
    } else if (!hasQuery && isSheetOpen()) {
      closeSheet();
    }
  });

  // Raising the sheet is bound to the tap, not to focus: closing it returns
  // focus to the field, and a focus handler would reopen what the user just
  // pushed away. Tabbing into the field also should not raise a surface.
  researchInput.addEventListener("click", () => {
    if (researchInput.value.trim() && !isSheetOpen()) openSheet();
  });

  researchInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (!isResearchRunning()) startResearch();
  });

  researchGoBtn.addEventListener("click", startResearch);
  researchStartBtn.addEventListener("click", startResearch);
  researchCancelBtn.addEventListener("click", cancelResearch);
  researchRetryBtn.addEventListener("click", startResearch);

  researchEditBtn.addEventListener("click", () => {
    researchSheet.dataset.state = "plan";
    researchSheetTitle.textContent = "Research";
    showBlock("plan");
    researchInput.focus({ preventScroll: true });
    researchInput.select();
  });

  researchCopyBtn.addEventListener("click", async () => {
    if (!researchSnapshot || !researchSnapshot.runId) return;
    const cancelled = researchSnapshot.phase === "cancelled";
    try {
      const doc = await requestResearchDocument(researchSnapshot.runId);
      if (cancelled) {
        downloadMarkdownFile(doc.filename.replace(/\.md$/, ""), doc.markdown);
        researchFile.textContent = doc.filename;
        researchSheet.dataset.state = "done";
        researchSheetTitle.textContent = "Downloaded";
        researchCopyBtn.textContent = "Copy Markdown";
        researchAgainBtn.textContent = "New search";
      } else {
        await navigator.clipboard.writeText(doc.markdown);
        researchCopyBtn.textContent = "Copied!";
        setTimeout(() => { researchCopyBtn.textContent = "Copy Markdown"; }, 2000);
      }
    } catch (error) {
      showResearchError(error.message);
    }
  });

  researchAgainBtn.addEventListener("click", resetResearch);

  researchSources.addEventListener("scroll", syncSourceMask, { passive: true });
  // The sheet's blocks animate their height, so the list becomes scrollable a
  // few frames after the rows are rendered — with no scroll event to notice it.
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(syncSourceMask).observe(researchSources);
  }

  researchFailedToggle.addEventListener("click", () => {
    const expanded = researchFailedToggle.getAttribute("aria-expanded") === "true";
    researchFailedToggle.setAttribute("aria-expanded", expanded ? "false" : "true");
    researchFailedList.classList.toggle("hidden", expanded);
  });

  researchScrim.addEventListener("click", () => {
    if (isSheetOpen()) closeSheet();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (isConvertMenuOpen() || isChatLimitMenuOpen()) return;
    // Escape dismisses the sheet and nothing else, running or not. Pushing the
    // sheet away with a drag leaves the run alive and the bar counting, so the
    // keyboard form of the same gesture must not instead destroy four minutes
    // of work with no confirmation. Cancelling stays on the Cancel button,
    // which is on screen in exactly that state.
    if (isSheetOpen()) {
      closeSheet();
    } else if (researchInput.value) {
      researchInput.value = "";
      researchGoBtn.disabled = true;
      goSpring.to(0, Motion.PRESETS.snappy);
    }
  });
}

async function generateFileNameFromPageTitle() {
  let baseFilename = "scrapllm"; // Default filename
  try {
    const tabs = await browserAPI.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (tabs && tabs.length > 0 && tabs[0].title) {
      let pageTitle = tabs[0].title.trim();
      if (pageTitle) {
        // Sanitize the title to be a valid filename
        let sanitizedTitle = pageTitle
          .replace(/[<>:"/\\|?*\x00-\x1F]/g, "") // Remove invalid characters
          .replace(/[\s./]+/g, "_") // Replace spaces, dots, slashes with underscores
          .replace(/_+/g, "_") // Consolidate multiple underscores
          .replace(/^_+|_+$/g, ""); // Trim leading/trailing underscores

        if (sanitizedTitle.length > MAX_FILENAME_LENGTH) {
          // Limit length
          sanitizedTitle = sanitizedTitle
            .substring(0, MAX_FILENAME_LENGTH)
            .replace(/_+$/g, "");
        }
        if (sanitizedTitle) baseFilename = sanitizedTitle;
      }
    }
  } catch (error) {
    console.error("Error getting tab title for filename:", error);
    // Silently use default filename if error occurs, or show a non-critical error
  } finally {
    return baseFilename;
  }
}

// Generic file download function
function downloadFile(filename, content, mimeType = "text/markdown") {
  let a = null;
  let url = null;

  try {
    // Create a blob and download
    const blob = content instanceof Blob ? content : new Blob([content], { type: mimeType });
    url = URL.createObjectURL(blob);

    a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
  } catch (error) {
    console.error("Error downloading file:", error);
  } finally {
    // Clean up, ensuring 'a' and 'url' are defined if an error occurred before their assignment
    if (a && a.parentElement) {
      document.body.removeChild(a);
    }
    if (url) {
      URL.revokeObjectURL(url);
    }
  }
}

// Helper for markdown file downloads
function downloadMarkdownFile(filename, content) {
  downloadFile(`${filename}.md`, content, "text/markdown");
}
