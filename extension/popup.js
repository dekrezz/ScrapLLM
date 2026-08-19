// LLMFeeder Popup Script
// Created by @jatinkrmalik (https://github.com/jatinkrmalik)

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

const THEME_KEY = "llmfeeder-theme";
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

// Tagline element
const tagline = document.getElementById("tagline");

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

const Motion = window.LLMFeederMotion;
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
    canStart: (event) => navSpring.value < 0.5 && !event.target.closest("button, a, input, select, textarea"),
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

  // Show/hide counter and tagline
  if (showTokenCountCheckbox.checked) {
    tokenCounter.classList.remove('hidden');
    // Hide tagline with animation when token counter is shown
    if (tagline) {
      tagline.classList.add('hidden');
    }
  } else {
    tokenCounter.classList.add('hidden');
    // Show tagline when token counter is hidden
    if (tagline) {
      tagline.classList.remove('hidden');
    }
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
  // Show tagline when token counter is hidden
  if (tagline) {
    tagline.classList.remove('hidden');
  }
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

// Get appropriate store URL based on browser
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
}

function showSingleTabUI() {
  singleTabActions.classList.remove('hidden');
  multiTabActions.classList.add('hidden');
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
    const filename = `llmfeeder-merged-${MultiTabUtils.getDateString()}`;
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

async function generateFileNameFromPageTitle() {
  let baseFilename = "llmfeeder"; // Default filename
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
