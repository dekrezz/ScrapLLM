// ScrapLLM Background Script
// Handles keyboard shortcuts and background tasks
// Dependencies: libs/jszip.min.js, settings.js, multi-tab-utils.js, search.js,
// quiet-capture.js and research.js. Firefox's MV2 background is a real page, so
// it also loads Readability, Turndown and convert-core.js there and parses
// fetched research pages in place; Chrome's service worker has no DOM and uses
// an offscreen document instead.
// (loaded via manifest in Firefox, or importScripts in Chrome service worker)

// Load dependencies for Chrome service worker (not needed in Firefox)
if (typeof importScripts === 'function') {
  try {
    importScripts('libs/jszip.min.js', 'settings.js', 'multi-tab-utils.js', 'search.js',
                  'quiet-capture.js', 'source-quality.js', 'research.js');
  } catch (e) {
    console.error('Failed to load dependencies:', e);
    throw new Error('Critical dependencies failed to load. Please reinstall the extension.');
  }
}

// Create browser compatibility layer for service worker context
const browserAPI = (function() {
  // Check if we're in Firefox (browser is defined) or Chrome (chrome is defined)
  const isBrowser = typeof browser !== 'undefined';
  const isChrome = typeof chrome !== 'undefined';
  
  // Base object
  const api = {};
  
  // Helper to promisify callback-based Chrome APIs
  function promisify(chromeAPICall, context) {
    return (...args) => {
      return new Promise((resolve, reject) => {
        chromeAPICall.call(context, ...args, (result) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(result);
          }
        });
      });
    };
  }
  
  // Set up APIs
  if (isBrowser) {
    // Firefox already has promise-based APIs
    api.tabs = browser.tabs;
    api.runtime = browser.runtime;
    api.storage = browser.storage;
    api.commands = browser.commands;
    api.scripting = browser.scripting;
    // Use browser.menus for Firefox (more features than contextMenus)
    api.contextMenus = browser.menus || browser.contextMenus;
  } else if (isChrome) {
    // Chrome needs promisification
    api.tabs = {
      query: promisify(chrome.tabs.query, chrome.tabs),
      sendMessage: promisify(chrome.tabs.sendMessage, chrome.tabs),
      create: promisify(chrome.tabs.create, chrome.tabs),
      get: promisify(chrome.tabs.get, chrome.tabs),
      remove: promisify(chrome.tabs.remove, chrome.tabs),
      update: promisify(chrome.tabs.update, chrome.tabs),
      onHighlighted: chrome.tabs.onHighlighted,
      onActivated: chrome.tabs.onActivated,
      onRemoved: chrome.tabs.onRemoved
    };
    
    api.runtime = {
      onMessage: chrome.runtime.onMessage,
      onConnect: chrome.runtime.onConnect,
      onInstalled: chrome.runtime.onInstalled,
      onStartup: chrome.runtime.onStartup,
      getURL: chrome.runtime.getURL,
      // The worker talks to the offscreen parser over runtime messaging: it is
      // the only extensions API an offscreen document can use.
      sendMessage: promisify(chrome.runtime.sendMessage, chrome.runtime),
      lastError: chrome.runtime.lastError
    };

    // getContexts is Chrome 116+; research feature-detects it and falls back to
    // recovering from createDocument's own rejection.
    if (typeof chrome.runtime.getContexts === 'function') {
      api.runtime.getContexts = promisify(chrome.runtime.getContexts, chrome.runtime);
    }

    // chrome.offscreen is Chrome 109+ and MV3 only. Without it the research
    // engine has no DOM to parse in and every source goes through a tab.
    if (chrome.offscreen) {
      api.offscreen = {
        createDocument: promisify(chrome.offscreen.createDocument, chrome.offscreen),
        closeDocument: promisify(chrome.offscreen.closeDocument, chrome.offscreen)
      };
    }

    
    api.storage = {
      sync: {
        get: function(keys) {
          return new Promise((resolve, reject) => {
            chrome.storage.sync.get(keys, (result) => {
              if (chrome.runtime.lastError) {
                reject(chrome.runtime.lastError);
              } else {
                resolve(result);
              }
            });
          });
        },
        set: function(items) {
          return new Promise((resolve, reject) => {
            chrome.storage.sync.set(items, () => {
              if (chrome.runtime.lastError) {
                reject(chrome.runtime.lastError);
              } else {
                resolve();
              }
            });
          });
        }
      }
    };

    // storage.session only exists on Chrome 102+. Feature-detect rather than
    // assume: research falls back to an in-memory store when it is missing.
    if (chrome.storage.session) {
      api.storage.session = {
        get: promisify(chrome.storage.session.get, chrome.storage.session),
        set: promisify(chrome.storage.session.set, chrome.storage.session),
        remove: promisify(chrome.storage.session.remove, chrome.storage.session)
      };
    }
    
    api.commands = {
      onCommand: chrome.commands.onCommand
    };

    api.scripting = chrome.scripting;

    // Chrome contextMenus has special handling - create() returns ID synchronously
    api.contextMenus = {
      create: function(createProperties) {
        return new Promise((resolve, reject) => {
          const id = chrome.contextMenus.create(createProperties, () => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else {
              resolve(id);
            }
          });
        });
      },
      update: promisify(chrome.contextMenus.update, chrome.contextMenus),
      remove: promisify(chrome.contextMenus.remove, chrome.contextMenus),
      removeAll: function() {
        return new Promise((resolve, reject) => {
          chrome.contextMenus.removeAll(() => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else {
              resolve();
            }
          });
        });
      },
      onClicked: chrome.contextMenus.onClicked
    };
  }

  return api;
})();

// Ensure content script is injected before sending messages
async function ensureContentScriptLoaded(tabId) {
  try {
    // Try sending a ping message to check if content script is loaded
    await browserAPI.tabs.sendMessage(tabId, { action: "ping" }).catch(() => {
      // If error, inject the content script
      return browserAPI.scripting.executeScript({
        target: { tabId: tabId },
        files: ["libs/readability.js", "libs/turndown.js", "content.js"]
      });
    });
    return true;
  } catch (error) {
    console.error("Cannot inject content script:", error);
    return false;
  }
}

// Context Menu Management
const CONTEXT_MENU_IDS = {
  PARENT: 'scrapllm-parent',
  SINGLE_COPY: 'scrapllm-single-copy',
  SINGLE_DOWNLOAD: 'scrapllm-single-download',
  MULTI_COPY: 'scrapllm-multi-copy',
  MULTI_DOWNLOAD: 'scrapllm-multi-download',
  MULTI_ZIP: 'scrapllm-multi-zip'
};

// Current menu state
let currentMenuMode = null; // 'single' or 'multi'
let currentMenuTabCount = 0; // Track tab count for multi-tab mode
let menuUpdateLock = Promise.resolve(); // Mutex lock for menu operations

// Browser-specific contexts ('tab' is Firefox-only)
// Detect Firefox by checking for browser.menus API
// Chrome doesn't support "menus" permission, so browser.menus will be undefined
const isFirefox = typeof browser !== 'undefined' &&
                  typeof browser.menus !== 'undefined';

const PAGE_CONTEXTS = isFirefox
  ? ['page', 'selection', 'link', 'tab']  // Firefox supports 'tab' context
  : ['page', 'selection', 'link'];        // Chrome doesn't support 'tab'

// Helper to run menu operations with mutex lock
async function withMenuLock(operation) {
  menuUpdateLock = menuUpdateLock.then(async () => {
    await operation();
  }).catch(err => {
    console.error('Menu operation error:', err);
  });
  return menuUpdateLock;
}

// Create single-tab context menus
async function createSingleTabMenus() {
  return withMenuLock(async () => {
    await browserAPI.contextMenus.removeAll();

    const parentMenuProps = {
      id: CONTEXT_MENU_IDS.PARENT,
      title: 'Copy to Markdown',
      contexts: PAGE_CONTEXTS
    };

    if (isFirefox) {
      parentMenuProps.icons = {
        16: 'icons/icon16.png',
        32: 'icons/icon48.png'
      };
    }

    await browserAPI.contextMenus.create(parentMenuProps);

    await browserAPI.contextMenus.create({
      id: CONTEXT_MENU_IDS.SINGLE_COPY,
      parentId: CONTEXT_MENU_IDS.PARENT,
      title: 'Copy to Clipboard (Alt+Shift+M)',
      contexts: PAGE_CONTEXTS
    });

    await browserAPI.contextMenus.create({
      id: CONTEXT_MENU_IDS.SINGLE_DOWNLOAD,
      parentId: CONTEXT_MENU_IDS.PARENT,
      title: 'Download as Markdown (Alt+Shift+D)',
      contexts: PAGE_CONTEXTS
    });

    currentMenuMode = 'single';
    currentMenuTabCount = 0;
  });
}

// Create multi-tab context menus
async function createMultiTabMenus(tabCount) {
  return withMenuLock(async () => {
    await browserAPI.contextMenus.removeAll();

    const parentMenuProps = {
      id: CONTEXT_MENU_IDS.PARENT,
      title: `Copy to Markdown (${tabCount} tabs)`,
      contexts: PAGE_CONTEXTS
    };

    if (isFirefox) {
      parentMenuProps.icons = {
        16: 'icons/icon16.png',
        32: 'icons/icon48.png'
      };
    }

    await browserAPI.contextMenus.create(parentMenuProps);

    await browserAPI.contextMenus.create({
      id: CONTEXT_MENU_IDS.MULTI_COPY,
      parentId: CONTEXT_MENU_IDS.PARENT,
      title: 'Copy All Tabs (Alt+Shift+M)',
      contexts: PAGE_CONTEXTS
    });

    await browserAPI.contextMenus.create({
      id: CONTEXT_MENU_IDS.MULTI_DOWNLOAD,
      parentId: CONTEXT_MENU_IDS.PARENT,
      title: 'Download Merged File (Alt+Shift+D)',
      contexts: PAGE_CONTEXTS
    });

    await browserAPI.contextMenus.create({
      id: CONTEXT_MENU_IDS.MULTI_ZIP,
      parentId: CONTEXT_MENU_IDS.PARENT,
      title: 'Download as ZIP (Alt+Shift+Z)',
      contexts: PAGE_CONTEXTS
    });

    currentMenuMode = 'multi';
    currentMenuTabCount = tabCount;
  });
}

// Update context menus based on tab selection
async function updateContextMenus() {
  try {
    const highlightedTabs = await MultiTabUtils.getHighlightedTabs(browserAPI);
    const tabCount = highlightedTabs.length;

    if (tabCount > 1) {
      // Multi-tab mode - recreate if mode changed or tab count changed
      if (currentMenuMode !== 'multi' || currentMenuTabCount !== tabCount) {
        await createMultiTabMenus(tabCount);
      }
    } else {
      // Single-tab mode
      if (currentMenuMode !== 'single') {
        await createSingleTabMenus();
      }
    }
  } catch (error) {
    console.error('Error updating context menus:', error);
  }
}

// Handle context menu clicks
browserAPI.contextMenus.onClicked.addListener(async (info, tab) => {
  const menuItemId = info.menuItemId;

  // Single-tab actions
  if (menuItemId === CONTEXT_MENU_IDS.SINGLE_COPY) {
    // Trigger the keyboard shortcut handler for copy
    await handleKeyboardShortcut('convert_to_markdown');
  } else if (menuItemId === CONTEXT_MENU_IDS.SINGLE_DOWNLOAD) {
    // Trigger the keyboard shortcut handler for download
    await handleKeyboardShortcut('download_markdown');
  }
  // Multi-tab actions
  else if (menuItemId === CONTEXT_MENU_IDS.MULTI_COPY) {
    await handleKeyboardShortcut('convert_to_markdown');
  } else if (menuItemId === CONTEXT_MENU_IDS.MULTI_DOWNLOAD) {
    await handleKeyboardShortcut('download_markdown');
  } else if (menuItemId === CONTEXT_MENU_IDS.MULTI_ZIP) {
    await handleKeyboardShortcut('download_zip');
  }
});

// Listen for tab selection changes to update context menus
browserAPI.tabs.onHighlighted.addListener(() => {
  updateContextMenus();
});

// Listen for tab activation to update context menus
browserAPI.tabs.onActivated.addListener(() => {
  updateContextMenus();
});

// Initialize context menus when extension is installed or updated
browserAPI.runtime.onInstalled.addListener(async () => {
  await createSingleTabMenus();
});

// Initialize context menus when browser starts
browserAPI.runtime.onStartup.addListener(async () => {
  await createSingleTabMenus();
});

// Initialize context menus immediately on script load (for development/reload)
createSingleTabMenus();

// Show notification in the current tab
async function showNotificationInTab(title, message) {
  try {
    const tabs = await browserAPI.tabs.query({ active: true, currentWindow: true });
    if (!tabs || !tabs.length) return;

    const tab = tabs[0];

    // Send message to content script to show notification
    await browserAPI.tabs.sendMessage(tab.id, {
      action: 'showNotification',
      title: title,
      message: message
    });
  } catch (error) {
    console.error('Failed to show notification:', error);
  }
}

// Handle multi-tab commands
async function handleMultiTabCommand(command, tabs) {
  try {
    // Warn about large operations (can't use confirm in background, so just notify)
    if (MultiTabUtils.shouldWarnAboutLargeTabCount(tabs.length)) {
      await showNotificationInTab("Processing Many Tabs", `Converting ${tabs.length} tabs. This may take some time...`);
    }

    // Ensure content scripts are loaded in all tabs
    for (const tab of tabs) {
      await ensureContentScriptLoaded(tab.id);
    }

    // Get user settings
    const settings = await SettingsUtils.getUserSettings(browserAPI);

    // Process all tabs
    const results = await MultiTabUtils.processMultipleTabs(tabs, settings, browserAPI, null);
    const { message, successCount } = MultiTabUtils.getResultsSummary(results);

    if (successCount === 0) {
      await showNotificationInTab("Conversion Failed", "No tabs were successfully converted");
      return;
    }

    // Get token count settings
    let tokenSettings;
    try {
      tokenSettings = await browserAPI.storage.sync.get({
        showTokenCount: true,
        tokenContextLimit: 8192
      });
    } catch (e) {
      tokenSettings = { showTokenCount: true, tokenContextLimit: 8192 };
    }

    // Calculate total token count from all successful tabs
    let totalTokenCount = 0;
    results.forEach(result => {
      if (result.success && result.tokenCount) {
        totalTokenCount += result.tokenCount;
      }
    });

    // Format token count message
    let tokenMessage = "";
    if (tokenSettings.showTokenCount && totalTokenCount > 0) {
      const limit = tokenSettings.tokenContextLimit;
      const percentage = Math.round((totalTokenCount / limit) * 100);
      tokenMessage = `\n${totalTokenCount.toLocaleString()} tokens (${percentage}% of ${(limit/1000).toFixed(0)}K limit)`;
    }

    // Handle different commands
    if (command === "convert_to_markdown") {
      // Copy All: Merge and copy to clipboard
      const merged = MultiTabUtils.mergeMarkdownResults(results);

      // Copy to clipboard via active tab's content script
      const activeTabs = await browserAPI.tabs.query({ active: true, currentWindow: true });
      if (activeTabs && activeTabs.length > 0) {
        await browserAPI.tabs.sendMessage(activeTabs[0].id, {
          action: "copyToClipboard",
          text: merged
        });
        await showNotificationInTab("Success", `${message} copied to clipboard${tokenMessage}`);
      }

    } else if (command === "download_markdown") {
      // Download Merged: Single .md file
      const merged = MultiTabUtils.mergeMarkdownResults(results);
      const filename = `scrapllm-merged-${MultiTabUtils.getDateString()}.md`;

      // Trigger download via active tab
      const activeTabs = await browserAPI.tabs.query({ active: true, currentWindow: true });
      if (activeTabs && activeTabs.length > 0) {
        await browserAPI.tabs.sendMessage(activeTabs[0].id, {
          action: "downloadMarkdown",
          markdown: merged,
          title: filename.replace('.md', '')
        });
        await showNotificationInTab("Success", `${message} downloaded as merged file${tokenMessage}`);
      }

    } else if (command === "download_zip") {
      // Download ZIP: Individual files in archive
      const { blob, filename } = await MultiTabUtils.createZipArchive(results);

      // Convert blob to data URL for download
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Failed to read blob'));
        reader.readAsDataURL(blob);
      });

      const activeTabs = await browserAPI.tabs.query({ active: true, currentWindow: true });
      if (activeTabs && activeTabs.length > 0) {
        // Send download message to content script
        await browserAPI.tabs.sendMessage(activeTabs[0].id, {
          action: "downloadFile",
          dataUrl: dataUrl,
          filename: filename
        });
        await showNotificationInTab("Success", `ZIP with ${message} downloaded${tokenMessage}`);
      }
    }

  } catch (error) {
    console.error("Multi-tab command error:", error);
    await showNotificationInTab("Error", error.message || "Failed to process multiple tabs");
  }
}

// Handle keyboard shortcut/context menu action
async function handleKeyboardShortcut(command) {
  if (command === "convert_to_markdown" || command === "download_markdown" || command === "download_zip") {
    try {
      // Check if multiple tabs are selected
      const highlightedTabs = await MultiTabUtils.getHighlightedTabs(browserAPI);

      // Route to multi-tab handler if 2+ tabs selected
      if (highlightedTabs.length > 1) {
        await handleMultiTabCommand(command, highlightedTabs);
        return;
      }

      // Single-tab handling (existing behavior)
      const tabs = await browserAPI.tabs.query({ active: true, currentWindow: true });
      if (!tabs || !tabs.length) {
        console.error("No active tab found");
        return;
      }

      const activeTab = tabs[0];
      
      // Check if the URL is valid for content scripts
      const url = activeTab.url || "";
      if (!url || url.startsWith("chrome://") || url.startsWith("edge://") || url.startsWith("about:")) {
        await showNotificationInTab("Cannot Convert", "Cannot run on browser pages. Please try on a regular website.");
        return;
      }
      
      // Ensure content script is loaded
      const isLoaded = await ensureContentScriptLoaded(activeTab.id);
      if (!isLoaded) {
        await showNotificationInTab("Error", "Could not load content script. Try refreshing the page.");
        return;
      }

      // Get user settings
      const settings = await SettingsUtils.getUserSettings(browserAPI);
      
      // Send message to content script to perform conversion
      try {
        const response = await browserAPI.tabs.sendMessage(activeTab.id, {
          action: "convertToMarkdown",
          settings: settings
        });
        
        if (response && response.success) {
          // Get token count settings
          let tokenSettings;
          try {
            tokenSettings = await browserAPI.storage.sync.get({
              showTokenCount: true,
              tokenContextLimit: 8192
            });
          } catch (e) {
            tokenSettings = { showTokenCount: true, tokenContextLimit: 8192 };
          }

          // Format token count message
          let tokenMessage = "";
          if (tokenSettings.showTokenCount && response.tokenCount > 0) {
            const limit = tokenSettings.tokenContextLimit;
            const percentage = Math.round((response.tokenCount / limit) * 100);
            tokenMessage = `\n${response.tokenCount.toLocaleString()} tokens (${percentage}% of ${(limit/1000).toFixed(0)}K limit)`;
          }

          if (command === "download_markdown") {
            // Download as file
            const pageTitle = activeTab.title || "scrapllm";
            await browserAPI.tabs.sendMessage(activeTab.id, {
              action: "downloadMarkdown",
              markdown: response.markdown,
              title: pageTitle
            });
            await showNotificationInTab("Success", `Markdown file downloaded${tokenMessage}`);
          } else {
            // Copy to clipboard via content script
            await browserAPI.tabs.sendMessage(activeTab.id, {
              action: "copyToClipboard",
              text: response.markdown
            });
            await showNotificationInTab("Success", `Content converted and copied to clipboard${tokenMessage}`);
          }
        } else {
          await showNotificationInTab("Conversion Failed", response?.error || "Unknown error");
        }
      } catch (error) {
        console.error("Error during conversion:", error);
        await showNotificationInTab("Error", "Could not convert page. Please try again or open the extension popup.");
      }
    } catch (error) {
      console.error("Command handler error:", error);
    }
  }
}

// Handle keyboard shortcuts
browserAPI.commands.onCommand.addListener(async (command) => {
  await handleKeyboardShortcut(command);
});

// ---------------------------------------------------------------------------
// Research: long-lived port to the popup
// ---------------------------------------------------------------------------
// A port rather than runtime.sendMessage, for two reasons: the popup needs a
// stream of snapshots, and an open port keeps the MV3 service worker alive for
// the length of a run.

const RESEARCH_PORT_NAME = 'scrapllm-research';
const RESULTS_GONE_MESSAGE = 'Run results are no longer available — please run it again.';
const researchPorts = new Set();

function postToPort(port, message) {
  try {
    port.postMessage(message);
  } catch (error) {
    // The popup closed between the snapshot and the post; drop the port.
    researchPorts.delete(port);
  }
}

ScrapLLMResearch.init(browserAPI);

ScrapLLMResearch.onProgress((snapshot) => {
  researchPorts.forEach(port => postToPort(port, { type: 'snapshot', snapshot }));
});

// The port carries the whole merged document, including pages captured from
// the user's own session. Only this extension's own pages may hold it: a
// sender with a `tab` is a content script, running in a web page's frame.
function isExtensionPagePort(port) {
  const sender = port.sender;
  if (!sender) return false;
  if (sender.id !== browserAPI.runtime.id) return false;
  return sender.tab === undefined;
}

browserAPI.runtime.onConnect.addListener((port) => {
  if (port.name !== RESEARCH_PORT_NAME) return;
  if (!isExtensionPagePort(port)) {
    port.disconnect();
    return;
  }

  researchPorts.add(port);
  postToPort(port, { type: 'snapshot', snapshot: ScrapLLMResearch.getSnapshot() });

  port.onDisconnect.addListener(() => {
    researchPorts.delete(port);
  });

  port.onMessage.addListener(async (message) => {
    if (!message || !message.type) return;

    if (message.type === 'start') {
      try {
        const runId = await ScrapLLMResearch.start({
          query: message.query,
          sourceCount: message.sourceCount,
          settings: message.settings,
          // The popup is the only place that can ask for a host permission
          // (the request must sit in a user gesture), so it reports the answer
          // and, when the answer is no, why — a denial, a browser without the
          // API, and a request that threw are three different sentences. The
          // engine checks the claim against the permission the browser holds.
          hostAccess: message.hostAccess,
          hostAccessNote: message.hostAccessNote
        });
        postToPort(port, { type: 'accepted', runId });
      } catch (error) {
        postToPort(port, { type: 'error', message: error.message || String(error) });
      }
      return;
    }

    if (message.type === 'cancel') {
      ScrapLLMResearch.cancel(message.runId);
      return;
    }

    if (message.type === 'sync') {
      postToPort(port, { type: 'snapshot', snapshot: ScrapLLMResearch.getSnapshot() });
      return;
    }

    if (message.type === 'getDocument') {
      // A run id is required: the document is only ever handed back to a caller
      // that names the run it is asking about.
      if (!message.runId) {
        postToPort(port, { type: 'error', message: RESULTS_GONE_MESSAGE });
        return;
      }
      const doc = await ScrapLLMResearch.getDocument(message.runId);
      if (!doc) {
        postToPort(port, { type: 'error', message: RESULTS_GONE_MESSAGE });
        return;
      }
      postToPort(port, {
        type: 'document',
        runId: message.runId,
        filename: doc.filename,
        markdown: doc.markdown,
        tokenCount: doc.tokenCount
      });
    }
  });
});

// A worker restart (or a crash) can leave research tabs open with nobody to
// close them. Runs at module evaluation, before any new run can start.
ScrapLLMResearch.recoverOrphans();
