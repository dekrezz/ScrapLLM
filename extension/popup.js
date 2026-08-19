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

    api.storage = {
      sync: {
        get: function (keys) {
          return new Promise((resolve, reject) => {
            chrome.storage.sync.get(keys, (result) => {
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
            chrome.storage.sync.set(items, () => {
              if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message || 'Unknown error'));
              } else {
                resolve();
              }
            });
          });
        },
      },
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
const copyChatBtn = document.getElementById("copyChatBtn");
const chatLimitBtn = document.getElementById("chatLimitBtn");
const chatLimitMenu = document.getElementById("chatLimitMenu");
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

// Token Counter DOM elements
const tokenCounter = document.getElementById("tokenCounter");
const tokenCountValue = document.getElementById("tokenCountValue");
const tokenWarning = document.getElementById("tokenWarning");
const showTokenCountCheckbox = document.getElementById("showTokenCount");


// Current token count for display
let currentTokenCount = 0;

// Default token counter settings
const DEFAULT_TOKEN_SETTINGS = {
  showTokenCount: true,
  tokenContextLimit: 8192
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
function setTheme(theme) {
  const isDark = theme === THEMES.DARK;
  bodyTag.classList.toggle("dark-theme", isDark);
  bodyTag.classList.toggle("light-theme", !isDark);

  // Update theme buttons
  lightThemeBtn.classList.toggle("active", !isDark);
  darkThemeBtn.classList.toggle("active", isDark);

  localStorage.setItem(THEME_KEY, theme);
}

function initTheme() {
  const userThemePreference = localStorage.getItem(THEME_KEY);
  if (userThemePreference === THEMES.DARK || userThemePreference === THEMES.LIGHT) {
    setTheme(userThemePreference);
  } else {
    setTheme(THEMES.LIGHT);
  }
}

/**
 * Update token counter display
 * @param {number} count - Token count
 * @param {number} limit - Context limit
 */
function updateTokenDisplay(count, limit) {
  currentTokenCount = count;

  // The count is the whole display: a number and its unit. The budget is only
  // surfaced when it is actually at risk (see updateTokenWarning).
  tokenCountValue.textContent = count.toLocaleString();

  const percentage = Math.min((count / limit) * 100, 100);

  // Show/hide the counter
  if (showTokenCountCheckbox.checked) {
    tokenCounter.classList.remove('hidden');
  } else {
    tokenCounter.classList.add('hidden');
  }

  // Update warning message
  tokenWarning.classList.remove('hidden', 'error');
  if (percentage >= 100) {
    tokenWarning.textContent = `⚠️ Exceeds limit by ${(count - limit).toLocaleString()} tokens`;
    tokenWarning.classList.add('error');
  } else if (percentage >= 90) {
    tokenWarning.textContent = `⚠️ ${(limit - count).toLocaleString()} tokens remaining`;
  } else if (percentage >= 75) {
    tokenWarning.textContent = `${(limit - count).toLocaleString()} tokens remaining`;
  } else {
    tokenWarning.classList.add('hidden');
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

    const response = await browserAPI.tabs.sendMessage(tabs[0].id, { action: "getChatInfo" });
    const info = response && response.success ? response.info : null;
    if (!info || !info.isChat) return;

    chatAction.classList.remove("hidden");
  } catch (error) {
    // No content script on this page (store, about:, PDF viewer).
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
    setResearchSourceCount(data.researchSourceCount, { persist: false });
    setResearchCapture(data.researchCapture, { persist: false });
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
    const researchSourceCount = researchSourceCountValue;
    const researchCapture = researchCaptureValue;
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
      researchSourceCount,
      researchCapture,
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
    researchSourceCount: researchSourceCountValue,
    researchCapture: researchCaptureValue,
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

    // Copy to clipboard
    await navigator.clipboard.writeText(response.markdown);

    // Update UI
    statusIndicator.textContent = "Copied to clipboard!";
    statusIndicator.className = "status success";

    // Update token display
    const contextLimit = DEFAULT_TOKEN_SETTINGS.tokenContextLimit;
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

    // Get current settings
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

const RESEARCH_PORT_NAME = "scrapllm-research";
const researchCaptureRadios = document.querySelectorAll('input[name="researchCapture"]');
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
let renderedRunKey = "";
let lastSummaryAt = 0;
let lastSummaryText = "";
const documentRequests = [];
const rowSprings = [];
const pathSprings = [];

function prefersReducedTransparency() {
  return typeof matchMedia === "function" &&
         matchMedia("(prefers-reduced-transparency: reduce)").matches;
}

// Springs -------------------------------------------------------------------
// The sheet is a material arriving: it travels, scales and resolves out of a
// blur together, so it reads as a surface rather than an opacity fade. Bounce
// belongs here and nowhere else in this feature — this is the surface a
// gesture can throw.

const sheetSpring = new Motion.Spring(0, {
  damping: Motion.PRESETS.sheet.damping,
  response: Motion.PRESETS.sheet.response,
  onUpdate: (value) => renderSheet(value),
  onRest: (spring) => {
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

  researchSheet.style.transform = reduced
    ? "none"
    : `translate3d(0, ${(1 - value) * sheetTravel}px, 0) scale(${0.96 + value * 0.04})`;
  researchSheet.style.filter = flat || value > 0.99 ? "none" : `blur(${(1 - value) * 8}px)`;
  researchSheet.style.opacity = reduced ? (value > 0.5 ? "1" : "0") : "1";
  researchScrim.style.opacity = String(Motion.clamp(value, 0, 1));
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
    researchGoBtn.style.transform = Motion.prefersReducedMotion()
      ? "none"
      : `scale(${0.6 + value * 0.4})`;
    researchGoBtn.style.opacity = String(Motion.clamp(value, 0, 1));
    researchGoBtn.style.pointerEvents = value > 0.5 ? "" : "none";
  }
});

// The blocks cross in the same frame — the outgoing one leaves while the
// incoming one arrives — because the sheet itself never moves between states.
function makeBlockSpring(element) {
  return new Motion.Spring(0, {
    damping: Motion.PRESETS.snappy.damping,
    response: Motion.PRESETS.snappy.response,
    onUpdate: (value) => {
      const reduced = Motion.prefersReducedMotion();
      element.style.opacity = String(Motion.clamp(value * 1.4, 0, 1));
      element.style.transform = reduced ? "none" : `scale(${0.96 + value * 0.04})`;
      element.style.filter = reduced || value > 0.99 ? "none" : `blur(${(1 - value) * 6}px)`;
    },
    onRest: (spring) => {
      if (spring.value <= 0.001) element.classList.add("hidden");
    }
  });
}

const blockSprings = {
  plan: makeBlockSpring(researchPlan),
  run: makeBlockSpring(researchRun),
  result: makeBlockSpring(researchResult),
  error: makeBlockSpring(researchError)
};

function showBlock(name) {
  Object.keys(blockSprings).forEach((key) => {
    const spring = blockSprings[key];
    const element = { plan: researchPlan, run: researchRun, result: researchResult, error: researchError }[key];
    if (key === name) {
      element.classList.remove("hidden");
      spring.to(1, Motion.PRESETS.snappy);
    } else if (spring.target > 0) {
      spring.to(0, Motion.PRESETS.snappy);
    }
  });
}

// Sheet presentation --------------------------------------------------------

function isSheetOpen() {
  return sheetSpring.target > 0.5;
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
  // Re-measured on every open: each state is a different height, and the
  // travel distance is the sheet's own height, not a constant.
  sheetTravel = researchSheet.offsetHeight || sheetTravel;
  if (opts.immediate) {
    sheetSpring.set(1);
    renderSheet(1);
  } else {
    sheetSpring.to(1, Motion.PRESETS.sheet);
  }
}

function closeSheet() {
  if (!isSheetOpen()) return;
  sheetSpring.to(0, Motion.PRESETS.sheet);
  // The field raised the sheet, so the field gets the focus back.
  researchInput.focus({ preventScroll: true });
}

function initSheetGesture() {
  let startProgress = 1;

  Motion.draggable(researchSheet, {
    axis: "y",
    threshold: 10,
    canStart: (event) => isSheetOpen() &&
      !event.target.closest("button, input, .research-sources, .research-failed-list"),
    onStart: () => { startProgress = sheetSpring.value; },
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

  sheetSpring.to(target, {
    damping: Motion.PRESETS.sheet.damping,
    response: Motion.PRESETS.sheet.response,
    velocity: -velocityPxPerSecond / sheetTravel
  });
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
  deliverResearchDocument(snapshot, previous);
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
    researchTrack.removeAttribute("aria-valuenow");
    researchTrack.setAttribute("aria-valuemax", "0");
    researchTrack.setAttribute("aria-valuetext", "Finding sources");
    progressSpring.set(0);
    researchFill.style.transform = "scaleX(0)";
  } else {
    researchTrack.setAttribute("aria-valuenow", String(snapshot.completed));
    researchTrack.setAttribute("aria-valuemax", String(total));
    researchTrack.setAttribute("aria-valuetext", `${snapshot.completed} of ${total} sources fetched`);
    const value = total > 0 ? snapshot.completed / total : 0;
    if (value > progressSpring.target) progressSpring.to(value, Motion.PRESETS.move);
  }

  renderSourceRows(snapshot);
}

const ROW_STATES = {
  pending: "queued",
  fetching: "fetching",
  ok: "done",
  error: "failed",
  skipped: "failed"
};

function renderSourceRows(snapshot) {
  const key = `${snapshot.runId}:${snapshot.entries.length}`;
  const rebuild = key !== renderedRunKey;
  // A popup opened mid-run must not animate rows into a state that predates
  // the window: the stagger runs only when every source is still queued, which
  // is exactly the case where nothing has happened yet.
  const stagger = rebuild && snapshot.entries.every((entry) => entry.status === "pending");

  if (rebuild) {
    researchSources.textContent = "";
    rowSprings.length = 0;
    pathSprings.length = 0;
    renderedRunKey = key;

    snapshot.entries.forEach((entry, index) => {
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
      const meta = document.createElement("span");
      meta.className = "source-meta";
      meta.append(host, path);
      text.append(title, meta);

      const note = document.createElement("span");
      note.className = "source-note";

      row.append(glyph, text, note);
      researchSources.appendChild(row);

      const spring = new Motion.Spring(0, {
        damping: Motion.PRESETS.snappy.damping,
        response: Motion.PRESETS.snappy.response,
        onUpdate: (value) => {
          row.style.opacity = String(Motion.clamp(value, 0, 1));
          row.style.transform = Motion.prefersReducedMotion()
            ? "none"
            : `translate3d(0, ${(1 - value) * 8}px, 0)`;
        }
      });
      rowSprings.push(spring);

      // The mark arrives out of the host it belongs to, so it travels the few
      // pixels from behind it rather than blinking into place.
      pathSprings.push(new Motion.Spring(0, {
        damping: Motion.PRESETS.snappy.damping,
        response: Motion.PRESETS.snappy.response,
        onUpdate: (value) => {
          const shown = Motion.clamp(value, 0, 1);
          path.style.opacity = String(shown);
          path.style.transform = Motion.prefersReducedMotion()
            ? "none"
            : `translate3d(${(shown - 1) * 4}px, 0, 0)`;
        }
      }));

      if (!stagger || Motion.prefersReducedMotion()) {
        spring.set(1);
      } else {
        // The stagger points down the list, in the direction the work travels.
        setTimeout(() => spring.to(1, Motion.PRESETS.snappy), index * 40);
      }
    });
  }

  const rows = researchSources.children;
  snapshot.entries.forEach((entry, index) => {
    const row = rows[index];
    if (!row) return;
    row.dataset.state = ROW_STATES[entry.status] || "queued";
    row.querySelector(".source-title").textContent = entry.title || entry.url;
    row.querySelector(".source-host").textContent = entry.host;
    const note = row.querySelector(".source-note");
    note.textContent = entry.note;
    // How it was captured, and why it was not captured quietly, are on the row
    // itself rather than only in the finished document.
    const wasPath = row.dataset.path || "";
    const isPath = entry.path || "";
    row.dataset.path = isPath;
    if (isPath !== wasPath) {
      const mark = row.querySelector(".source-path");
      const pathSpring = pathSprings[index];
      const rendered = isPath === "rendered";
      mark.textContent = rendered ? "rendered" : "";
      mark.hidden = !rendered;
      if (rendered && !Motion.prefersReducedMotion()) {
        pathSpring.to(1, Motion.PRESETS.snappy);
      } else {
        // Reduced motion cross-fades the mark in through CSS instead.
        pathSpring.set(rendered ? 1 : 0);
      }
    }
    const spoken = isPath === "rendered"
      ? "rendered in a tab"
      : (isPath === "quiet" ? "read without a tab" : "");
    note.title = entry.pathReason ? `${entry.note} — ${entry.pathReason}` : entry.note;
    row.setAttribute("aria-label", [entry.host, entry.note, spoken, entry.pathReason]
      .filter(Boolean)
      .join(", "));
  });
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
  researchFailedToggle.textContent = failures.length === 1
    ? "1 source failed"
    : `${failures.length} sources failed`;

  researchFailedList.textContent = "";
  failures.forEach((failure) => {
    const item = document.createElement("li");
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
// dropped before it was ever opened both keep their verbatim reason.
function researchFailures(snapshot) {
  const failures = snapshot.entries
    .filter((entry) => entry.status === "error" || entry.status === "skipped")
    .map((entry) => ({ host: entry.host, reason: entry.note }));
  snapshot.rejected.forEach((item) => {
    failures.push({ host: item.host, reason: item.reason });
  });
  return failures;
}

function showResearchError(message) {
  researchErrorText.textContent = message;
  researchAlert.textContent = message;
  researchSheet.dataset.state = "error";
  researchSheetTitle.textContent = "Research failed";
  researchInput.readOnly = false;
  if (!isSheetOpen()) openSheet();
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
function deliverResearchDocument(snapshot, previous) {
  if (snapshot.phase !== "done") return;
  if (!snapshot.runId || researchDeliveredRunId === snapshot.runId) return;
  if (previous && previous.phase === "done" && previous.runId === snapshot.runId) return;

  researchDeliveredRunId = snapshot.runId;
  requestResearchDocument(snapshot.runId)
    .then((doc) => {
      downloadMarkdownFile(doc.filename.replace(/\.md$/, ""), doc.markdown);
    })
    .catch((error) => {
      showResearchError(error.message);
    });
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
function requestResearchHostAccess() {
  if (researchCaptureValue === "render") return Promise.resolve(false);
  if (!browserAPI.permissions || typeof browserAPI.permissions.request !== "function") {
    return Promise.resolve(false);
  }
  try {
    return browserAPI.permissions.request(RESEARCH_ORIGINS).catch(() => false);
  } catch (error) {
    return Promise.resolve(false);
  }
}

async function startResearch() {
  const query = researchInput.value.trim();
  if (!query) return;

  const hostAccess = await requestResearchHostAccess();

  researchLocalError = null;
  researchDeliveredRunId = null;
  renderedRunKey = "";
  lastSummaryText = "";
  researchSources.textContent = "";
  rowSprings.length = 0;
  pathSprings.length = 0;
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
    hostAccess,
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
  rowSprings.length = 0;
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
    if (isResearchRunning()) {
      cancelResearch();
    } else if (isSheetOpen()) {
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
