// ScrapLLM Multi-Tab Utilities
// Shared utilities for multi-tab processing in popup and background scripts

const MultiTabUtils = (function() {
  const MAX_FILENAME_LENGTH = 100;
  const LARGE_TAB_COUNT_THRESHOLD = 20; // Warn user when processing more than this many tabs

  function shouldWarnAboutLargeTabCount(tabCount) {
    return tabCount > LARGE_TAB_COUNT_THRESHOLD;
  }

  function getLargeTabCountWarning(tabCount) {
    return `You are about to process ${tabCount} tabs. This may take some time and use significant memory. Do you want to continue?`;
  }

  // Index-cursor worker pool. Shared by the multi-tab path (4 at a time) and
  // by the research engine (3 at a time). `handler` must resolve, never reject:
  // a rejection would sink the whole pool.
  async function runPool(items, concurrency, handler) {
    const total = items.length;
    const results = new Array(total);
    let nextIndex = 0;

    // JavaScript is single-threaded, so the cursor needs no locking.
    async function worker() {
      while (nextIndex < total) {
        const index = nextIndex++;
        results[index] = await handler(items[index], index);
      }
    }

    const workerCount = Math.max(0, Math.min(concurrency, total));
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return results;
  }

  // Ask one tab's content script for its Markdown. Never throws: a dead tab or
  // a refused message comes back as a failure object with the reason intact.
  async function convertTabToMarkdown(tabId, settings, browserAPI) {
    try {
      const response = await browserAPI.tabs.sendMessage(tabId, {
        action: "convertToMarkdown",
        settings: settings
      });

      if (response && response.success) {
        return {
          success: true,
          markdown: response.markdown,
          tokenCount: response.tokenCount || 0,
          metadata: response.metadata
        };
      }

      return {
        success: false,
        error: (response && response.error) || "Conversion failed"
      };
    } catch (error) {
      const errorMessage = error.message || "Failed to communicate with tab";
      console.error(errorMessage);
      return { success: false, error: errorMessage };
    }
  }

  // Process multiple tabs with concurrency limit using the worker pool
  async function processMultipleTabs(tabs, settings, browserAPI, progressCallback) {
    const total = tabs.length;
    const MAX_CONCURRENT = 4; // Max tabs processing simultaneously
    let completed = 0;

    if (progressCallback) {
      progressCallback(`Converting ${total} tabs...`);
    }

    const results = await runPool(tabs, MAX_CONCURRENT, async (tab) => {
      const outcome = await convertTabToMarkdown(tab.id, settings, browserAPI);

      const result = outcome.success
        ? {
          success: true,
          tab: tab,
          markdown: outcome.markdown,
          metadata: outcome.metadata,
          tokenCount: outcome.tokenCount || 0
        }
        : {
          success: false,
          tab: tab,
          error: outcome.error
        };

      completed++;
      if (progressCallback && total > MAX_CONCURRENT) {
        progressCallback(`Converted ${completed} of ${total} tabs...`);
      }

      return result;
    });

    return results;
  }

  // Merge multiple markdown results
  function mergeMarkdownResults(results) {
    const successfulResults = results.filter(r => r.success);

    if (successfulResults.length === 0) {
      throw new Error('No tabs were successfully converted');
    }

    const merged = successfulResults.map(result => result.markdown).join('\n\n---\n\n');
    return merged;
  }

  // Generate unique filename for ZIP entries
  function generateUniqueFilename(title, index, usedFilenames) {
    let baseFilename = sanitizeFilename(title);
    let filename = baseFilename;
    let counter = 1;

    while (usedFilenames.has(filename)) {
      filename = `${baseFilename}_${counter}`;
      counter++;
    }

    usedFilenames.add(filename);
    return `${filename}.md`;
  }

  // Sanitize filename
  function sanitizeFilename(title) {
    return title
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
      .replace(/[\s.]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '')
      .substring(0, MAX_FILENAME_LENGTH)
      .replace(/_+$/g, '') || 'untitled';
  }

  // Get date string for filenames
  function getDateString() {
    const now = new Date();
    return now.toISOString().split('T')[0]; // YYYY-MM-DD
  }

  // Create ZIP archive from results
  async function createZipArchive(results) {
    // Check if JSZip is loaded
    if (typeof JSZip === 'undefined') {
      throw new Error('JSZip library not loaded');
    }

    const zip = new JSZip();
    const usedFilenames = new Set();
    let successCount = 0;

    results.forEach((result, index) => {
      if (result.success) {
        const filename = generateUniqueFilename(
          result.tab.title,
          index,
          usedFilenames
        );
        zip.file(filename, result.markdown);
        successCount++;
      }
    });

    if (successCount === 0) {
      throw new Error('No tabs were successfully converted');
    }

    const blob = await zip.generateAsync({ type: 'blob' });
    const zipFilename = `scrapllm-export-${getDateString()}-${successCount}tabs.zip`;

    return { blob, filename: zipFilename, successCount };
  }

  // Get highlighted/selected tabs
  async function getHighlightedTabs(browserAPI) {
    const highlightedTabs = await browserAPI.tabs.query({
      highlighted: true,
      currentWindow: true
    });

    // Filter out browser internal pages
    const validTabs = highlightedTabs.filter(tab =>
      tab.url &&
      !tab.url.startsWith('chrome://') &&
      !tab.url.startsWith('edge://') &&
      !tab.url.startsWith('about:') &&
      !tab.url.startsWith('chrome-extension://') &&
      !tab.url.startsWith('moz-extension://')
    );

    return validTabs;
  }

  // Format results summary message
  function getResultsSummary(results) {
    const successCount = results.filter(r => r.success).length;
    const failedResults = results.filter(r => !r.success);
    const failCount = failedResults.length;

    let message = `${successCount} tab${successCount > 1 ? 's' : ''}`;
    if (failCount > 0) {
      message += ` (${failCount} failed)`;
    }

    return { message, successCount, failCount };
  }

  // Public API
  return {
    runPool,
    convertTabToMarkdown,
    processMultipleTabs,
    mergeMarkdownResults,
    generateUniqueFilename,
    sanitizeFilename,
    getDateString,
    createZipArchive,
    getHighlightedTabs,
    getResultsSummary,
    shouldWarnAboutLargeTabCount,
    getLargeTabCountWarning,
  };
})();

// For use in browser extension contexts (not modules)
if (typeof window !== 'undefined') {
  window.MultiTabUtils = MultiTabUtils;
}
