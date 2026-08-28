// ScrapLLM Content Script
(function() {
  'use strict';

  // ==========================================================================
  // CONSTANTS
  // ==========================================================================

  const ERROR_MESSAGES = {
    NO_CONTENT: 'No content could be extracted from this page.',
    TIMEOUT: 'Conversion timed out. The page might be too large.',
    NO_SELECTION: 'No text is selected. Please select text or use a different content scope.',
    PERMISSION_DENIED: 'Permission denied. Please check extension permissions.',
    GENERAL: 'An error occurred during conversion.'
  };

  const CONVERSION_TIMEOUT = 15000; // 15 seconds baseline (extended dynamically when scrolling lazy-loaded pages)
  const MAX_DEBUG_LOG_ENTRIES = 500; // Keep memory usage in check
  const SCROLL_LOAD_DELAY = 300; // ms to wait after scroll for content to load
  const MAX_SCROLL_ATTEMPTS = 50; // Maximum scroll iterations per container
  // Wall-clock ceiling for the whole scroll pass, shared across every container
  // we walk. MAX_SCROLL_ATTEMPTS alone cannot bound the pass: a page with N
  // scrollable containers costs N times the per-container budget, which would
  // outlive the conversion timeout and keep yanking the page around long after
  // the user has been shown an error.
  const SCROLL_PASS_BUDGET = 15000;
  const SCROLL_TIMEOUT_HEADROOM = SCROLL_PASS_BUDGET; // ms of extra time we may need when scrolling

  // ==========================================================================
  // DEBUG LOGGING SYSTEM
  // ==========================================================================

  const DebugLog = {
    logs: [],
    enabled: false,

    init(settings) {
      this.enabled = settings?.debugMode || false;
      if (this.enabled) {
        this.clear();
        this.log('Debug mode enabled', { url: window.location.href, timestamp: new Date().toISOString() });
      }
    },

    log(message, data) {
      if (this.enabled) {
        const entry = {
          time: new Date().toISOString(),
          message,
          ...(data !== undefined && { data })
        };
        this.logs.push(entry);
        // Keep only last MAX_DEBUG_LOG_ENTRIES entries to prevent memory issues
        if (this.logs.length > MAX_DEBUG_LOG_ENTRIES) {
          this.logs.shift();
        }
      }
    },

    error(message, error) {
      if (this.enabled) {
        this.log(message, {
          error: error?.message || String(error),
          stack: error?.stack
        });
      }
    },

    getLogs() {
      return this.logs.map(entry => {
        let str = `[${entry.time}] ${entry.message}`;
        if (entry.data !== undefined) {
          str += '\n  ' + JSON.stringify(entry.data, null, 2);
        }
        return str;
      }).join('\n');
    },

    clear() {
      this.logs = [];
    }
  };

  // ==========================================================================
  // BROWSER RUNTIME WRAPPER
  // ==========================================================================

  const browserRuntime = (function() {
    if (typeof browser !== 'undefined' && browser.runtime) {
      return browser.runtime;
    } else if (typeof chrome !== 'undefined' && chrome.runtime) {
      return chrome.runtime;
    }
    return {
      onMessage: { addListener: function() {} }
    };
  })();

  // ==========================================================================
  // MESSAGE HANDLERS
  // ==========================================================================

  browserRuntime.onMessage.addListener((request, sender, sendResponse) => {
    // Ping handler
    if (request.action === 'ping') {
      sendResponse({ success: true });
      return true;
    }

    // Selection probe: the popup asks on open whether the page has a selection
    // worth offering a dedicated button for.
    if (request.action === 'getSelectionInfo') {
      try {
        const info = typeof ScrapLLMSelection !== 'undefined'
          ? ScrapLLMSelection.inspect()
          : { hasSelection: false };
        sendResponse({ success: true, info });
      } catch (error) {
        sendResponse({ success: false, error: error.message });
      }
      return true;
    }

    // Chat probe: does this page hold an LLM conversation?
    if (request.action === 'getChatInfo') {
      try {
        const info = typeof ScrapLLMChat !== 'undefined'
          ? ScrapLLMChat.inspect()
          : { isChat: false };
        sendResponse({ success: true, info });
      } catch (error) {
        sendResponse({ success: false, error: error.message });
      }
      return true;
    }

    // Get debug logs handler
    if (request.action === 'getDebugLogs') {
      sendResponse({ success: true, logs: DebugLog.getLogs() });
      return true;
    }

    // Copy to clipboard handler
    if (request.action === 'copyToClipboard' && request.text) {
      copyTextToClipboard(request.text)
        .then(() => sendResponse({ success: true }))
        .catch(error => sendResponse({
          success: false,
          error: 'Failed to copy to clipboard: ' + error.message
        }));
      return true;
    }

    // Main conversion handler - async
    if (request.action === 'convertToMarkdown') {
      // Extend the conversion timeout when the user has opted into the
      // scroll-to-load pass, since that step alone can take up to
      // SCROLL_TIMEOUT_HEADROOM ms before extraction even begins.
      const requestSettings = request.settings || request.options || {};
      // X timelines are virtualised, so the X extractor has to scroll to collect
      // posts and needs the same headroom even when lazy-loading is off.
      const needsScrollHeadroom = requestSettings.triggerLazyLoading === true ||
        (requestSettings.xMode !== false &&
         typeof ScrapLLMX !== 'undefined' &&
         ScrapLLMX.isXPage(window.location));
      const conversionTimeout = needsScrollHeadroom
        ? CONVERSION_TIMEOUT + SCROLL_TIMEOUT_HEADROOM
        : CONVERSION_TIMEOUT;
      const timeoutId = setTimeout(() => {
        sendResponse({
          success: false,
          error: ERROR_MESSAGES.TIMEOUT
        });
      }, conversionTimeout);

      (async () => {
        try {
          const settings = request.settings || request.options || {};
          const markdown = await convertToMarkdown(settings);
          clearTimeout(timeoutId);
          
          // Calculate token count estimation for response
          const tokenCount = ScrapLLMConvert.estimateTokens(markdown);
          
          sendResponse({ success: true, markdown, tokenCount });
        } catch (error) {
          clearTimeout(timeoutId);
          console.error('Conversion error:', error);
          DebugLog.error('Conversion error', error);

          let errorMessage = ERROR_MESSAGES.GENERAL;
          if (error.message.includes('No content')) {
            errorMessage = ERROR_MESSAGES.NO_CONTENT;
          } else if (error.message.includes('No text is selected')) {
            errorMessage = ERROR_MESSAGES.NO_SELECTION;
          } else if (error.message.includes('Permission')) {
            errorMessage = ERROR_MESSAGES.PERMISSION_DENIED;
          }

          sendResponse({
            success: false,
            error: errorMessage,
            details: error.message
          });
        }
      })();

      return true;
    }

    // Show notification handler
    if (request.action === 'showNotification') {
      showNotification(request.title, request.message);
      sendResponse({ success: true });
      return true;
    }

    // Download markdown handler
    if (request.action === 'downloadMarkdown') {
      try {
        downloadMarkdownFile(request.markdown, request.title);
        sendResponse({ success: true });
      } catch (error) {
        console.error('Download error:', error);
        sendResponse({ success: false, error: error.message });
      }
      return true;
    }

    // Download file from data URL (used for ZIP downloads)
    if (request.action === 'downloadFile') {
      try {
        const a = document.createElement('a');
        a.href = request.dataUrl;
        a.download = request.filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        sendResponse({ success: true });
      } catch (error) {
        console.error('Download file error:', error);
        sendResponse({ success: false, error: error.message });
      }
      return true;
    }
  });

  // ==========================================================================
  // UTILITY FUNCTIONS
  // ==========================================================================

  function downloadMarkdownFile(markdown, title) {
    const MAX_FILENAME_LENGTH = 100;
    let filename = title
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
      .replace(/[\s./]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '');
    
    if (filename.length > MAX_FILENAME_LENGTH) {
      filename = filename.substring(0, MAX_FILENAME_LENGTH).replace(/_+$/g, '');
    }
    if (!filename) filename = 'scrapllm';
    
    const blob = new Blob([markdown], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${filename}.md`;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
  }

  async function copyTextToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.left = '-999999px';
    textarea.style.top = '-999999px';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    return new Promise((resolve, reject) => {
      try {
        const success = document.execCommand('copy');
        if (success) resolve();
        else reject(new Error('execCommand returned false'));
      } catch (err) {
        reject(err);
      } finally {
        document.body.removeChild(textarea);
      }
    });
  }

  // ==========================================================================
  // LAZY LOADING DETECTION AND SCROLL EXTRACTION
  // ==========================================================================

  /**
   * Hosts that we know ship lazy-loaded conversational UIs. Exact/subdomain
   * matching keeps the detector focused without treating unrelated domains
   * like `notchatgpt.com` as positive matches.
   */
  const KNOWN_LAZY_HOSTS = [
    'gemini.google.com',
    'aistudio.google.com',
    'chat.openai.com',
    'chatgpt.com',
    'claude.ai',
    'poe.com',
    'perplexity.ai',
    'copilot.microsoft.com'
  ];

  /**
   * Tight, semantically-meaningful selectors. We deliberately avoid loose
   * `[class*="..."]` matches here because they fire on too many ordinary
   * pages (any class containing "chat", "scroll", "conversation", etc.) and
   * trigger a noisy scroll pass + footer warning when nothing is actually
   * lazy-loaded.
   */
  const LAZY_CONTAINER_SELECTORS = [
    '[role="log"]',
    '[role="feed"]',
    '[data-conversation]',
    '[data-virtual]',
    '[data-test-id*="conversation"]'
  ];

  /**
   * Single source of truth for "is this DOM node a scrollable container we
   * could meaningfully scroll through?". Used by both the detector and the
   * scroll-pass collector so the threshold lives in one place.
   */
  function isMeaningfullyScrollable(el) {
    const style = window.getComputedStyle(el);
    const overflowsY = style.overflowY === 'auto' || style.overflowY === 'scroll';
    return overflowsY && el.clientHeight > 0 && el.scrollHeight > el.clientHeight * 2;
  }

  /**
   * Detects if a page likely uses virtual scrolling/lazy loading for content.
   * Cheap and short-circuits on the first positive signal so we don't pay
   * an O(DOM) scan on every conversion.
   */
  function detectLazyLoadingPattern() {
    const host = window.location.hostname || '';
    const matchedHost = KNOWN_LAZY_HOSTS.find(h => host === h || host.endsWith('.' + h)) || null;
    if (matchedHost) {
      DebugLog.log('Lazy loading detection', { matchedHost, isLazyLoaded: true });
      return { isLazyLoaded: true, reason: 'host:' + matchedHost };
    }

    if (document.querySelector(LAZY_CONTAINER_SELECTORS.join(', '))) {
      DebugLog.log('Lazy loading detection', { reason: 'semantic-selector', isLazyLoaded: true });
      return { isLazyLoaded: true, reason: 'semantic' };
    }

    DebugLog.log('Lazy loading detection', { isLazyLoaded: false });
    return { isLazyLoaded: false, reason: null };
  }

  /**
   * Attempts to load all lazy-loaded content by scrolling through the page.
   * Returns information about what was loaded; `scrolled: false` means no
   * suitable container was found and the caller should not warn the user
   * about partial content.
   */
  async function scrollToLoadAllContent(scrollables) {
    if (scrollables.length === 0) {
      DebugLog.log('No scrollable containers found');
      return { scrolled: false, heightDelta: 0, contentChanged: false };
    }

    DebugLog.log('Found scrollable containers', { count: scrollables.length });

    // Save the user's viewport position so we can restore it after the
    // scroll-pass instead of dumping them at the top of the page.
    const savedScrollX = window.scrollX;
    const savedScrollY = window.scrollY;

    // Share one wall-clock budget across every container. Each container gets
    // an even slice of whatever time is left, so a container that finishes
    // early hands its unused time to the ones after it.
    const passDeadline = Date.now() + SCROLL_PASS_BUDGET;

    let totalHeightDelta = 0;
    let contentChanged = false;
    let containersScrolled = 0;
    for (let i = 0; i < scrollables.length; i++) {
      const timeLeft = passDeadline - Date.now();
      if (timeLeft <= SCROLL_LOAD_DELAY) {
        DebugLog.log('Scroll budget exhausted, skipping remaining containers', {
          skipped: scrollables.length - i
        });
        break;
      }

      const containerDeadline = Date.now() + timeLeft / (scrollables.length - i);
      const result = await scrollContainerToLoadContent(scrollables[i], containerDeadline);
      totalHeightDelta += result.heightDelta;
      contentChanged = contentChanged || result.contentChanged;
      containersScrolled++;
    }

    window.scrollTo(savedScrollX, savedScrollY);

    // Virtualised lists re-render from their scroll handler, which fires
    // asynchronously. Without this settle delay we clone the DOM mid-render
    // and capture fewer rows than were on screen before the pass started.
    await sleep(SCROLL_LOAD_DELAY);

    DebugLog.log('Scroll loading complete', { totalHeightDelta, contentChanged, containersScrolled });
    return { scrolled: true, heightDelta: totalHeightDelta, contentChanged };
  }

  /**
   * Find all scrollable containers on the page using the same
   * `isMeaningfullyScrollable` heuristic as the detector.
   *
   * Semantic lazy-load containers (role=log/feed, data-conversation, etc.)
   * take priority. Burning budget on the window / generic main wrappers as
   * well would leave less time for the surface that actually loads content —
   * the multi-scroller timeout #101 fixed. Only fall back to those generic
   * containers when no semantic match is scrollable.
   */
  function findScrollableContainers() {
    const containers = [];
    const seen = new Set();

    document.querySelectorAll(LAZY_CONTAINER_SELECTORS.join(', ')).forEach(el => {
      if (isMeaningfullyScrollable(el) && !seen.has(el)) {
        seen.add(el);
        containers.push({ element: el, isWindow: false });
      }
    });

    if (containers.length > 0) {
      return containers;
    }

    if (document.documentElement.scrollHeight > window.innerHeight * 1.5) {
      containers.push({ element: document.documentElement, isWindow: true });
    }

    document.querySelectorAll('main, article, .main-content, #content').forEach(el => {
      if (isMeaningfullyScrollable(el) && !seen.has(el)) {
        seen.add(el);
        containers.push({ element: el, isWindow: false });
      }
    });

    return containers;
  }

  /**
   * Scroll a container to load lazy-loaded content.
   * Stall detection looks at `scrollHeight` and a bounded text signature
   * because virtualised lists can recycle DOM nodes without growing height.
   */
  async function scrollContainerToLoadContent(containerInfo, deadline) {
    const { element, isWindow } = containerInfo;
    const getScrollHeight = () => isWindow ? document.documentElement.scrollHeight : element.scrollHeight;
    const getClientHeight = () => isWindow ? window.innerHeight : element.clientHeight;
    const getTextSignature = () => {
      const text = ((isWindow ? document.body : element).innerText || '').trim();
      return text.slice(0, 2000) + '|' + text.slice(-2000);
    };
    const getCurrentScroll = () => isWindow ? window.scrollY : element.scrollTop;
    const scrollTo = (pos) => {
      if (isWindow) {
        window.scrollTo(0, pos);
      } else {
        element.scrollTop = pos;
      }
    };

    const originalScroll = getCurrentScroll();
    const startHeight = getScrollHeight();
    const startTextSignature = getTextSignature();
    let previousHeight = startHeight;
    let previousTextSignature = startTextSignature;
    let attempts = 0;
    let stallCount = 0;

    // First, scroll to top to ensure top content is loaded
    scrollTo(0);
    if (Date.now() + SCROLL_LOAD_DELAY <= deadline) {
      await sleep(SCROLL_LOAD_DELAY);
    }

    const clientHeight = getClientHeight();
    const scrollStep = clientHeight * 0.8;
    let currentPos = 0;

    while (attempts < MAX_SCROLL_ATTEMPTS && Date.now() + SCROLL_LOAD_DELAY <= deadline) {
      attempts++;

      currentPos += scrollStep;
      scrollTo(currentPos);
      await sleep(SCROLL_LOAD_DELAY);

      const newHeight = getScrollHeight();
      const newTextSignature = getTextSignature();

      const grewHeight = newHeight > previousHeight;
      const changedText = newTextSignature !== previousTextSignature;

      if (grewHeight || changedText) {
        previousHeight = newHeight;
        previousTextSignature = newTextSignature;
        stallCount = 0;
      } else {
        stallCount++;
      }

      const maxScroll = newHeight - clientHeight;
      if (currentPos >= maxScroll - 10) {
        if (stallCount >= 3) {
          DebugLog.log('Reached bottom of scrollable container', {
            attempts,
            finalHeight: newHeight,
            heightDelta: newHeight - startHeight,
            contentChanged: newTextSignature !== startTextSignature
          });
          break;
        }
        // Nudge past the bottom to trigger any remaining lazy loaders.
        currentPos = maxScroll + 100;
        scrollTo(currentPos);
        if (Date.now() + SCROLL_LOAD_DELAY > deadline) {
          break;
        }
        await sleep(SCROLL_LOAD_DELAY);
      }
    }

    scrollTo(originalScroll);

    return {
      heightDelta: previousHeight - startHeight,
      contentChanged: previousTextSignature !== startTextSignature
    };
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // The core takes the source URL and title as data rather than reading the
  // ambient document, because in the background paths the ambient document is
  // the extension's own page.
  function pageContext() {
    return { url: window.location.href, title: document.title };
  }

  // ==========================================================================
  // MAIN CONVERSION FUNCTION
  // ==========================================================================

  async function convertToMarkdown(settings) {
    DebugLog.init(settings);
    DebugLog.log('Conversion started', {
      contentScope: settings.contentScope,
      preserveTables: settings.preserveTables,
      includeImages: settings.includeImages,
      includeTitle: settings.includeTitle,
      includeLinks: settings.includeLinks,
      triggerLazyLoading: settings.triggerLazyLoading === true,
      redditMode: settings.redditMode !== false,
      xMode: settings.xMode !== false,
      githubMode: settings.githubMode !== false
    });

    // Reddit pages: Readability keeps the post body but drops the comment tree
    // (collapsed/virtualised nodes are never in the extracted article), so
    // threads and listings go through the dedicated Reddit extractor instead.
    if (settings.redditMode !== false &&
        settings.contentScope !== 'selection' &&
        typeof ScrapLLMReddit !== 'undefined' &&
        ScrapLLMReddit.isRedditPage(window.location)) {
      const redditPageType = ScrapLLMReddit.getPageType(window.location);
      DebugLog.log('Reddit page detected', { pageType: redditPageType });
      const reddit = await ScrapLLMReddit.convert(settings, {
        logger: {
          log: (message, data) => DebugLog.log(message, data),
          error: (message, error) => DebugLog.error(message, error)
        },
        createTurndown: () => ScrapLLMConvert.configureTurndownService(settings)
      });
      if (reddit) {
        // The Reddit renderer already emits its own H1 title, so includeTitle
        // is intentionally not applied a second time here.
        return ScrapLLMConvert.postProcessMarkdown(
          reddit.markdown, settings, reddit.articleData, pageContext());
      }
      // convert() returns null for Reddit routes with nothing to render
      // (empty feed, profile with no activity); fall through to the generic
      // extraction below.
      DebugLog.log('Reddit extractor returned no content; using generic extraction');
    }

    // GitHub repository pages: what is on screen is a compiled copy of what we
    // actually want. The README is HTML built from Markdown, so converting it
    // back is a lossy round trip, and the file list is one directory deep. The
    // API has the original Markdown and the whole tree.
    if (settings.githubMode !== false &&
        settings.contentScope !== 'selection' &&
        typeof ScrapLLMGitHub !== 'undefined' &&
        ScrapLLMGitHub.isGitHubPage(window.location)) {
      DebugLog.log('GitHub repository page detected');
      try {
        const github = await ScrapLLMGitHub.convert(settings, {
          logger: {
            log: (message, data) => DebugLog.log(message, data),
            error: (message, error) => DebugLog.error(message, error)
          }
        });
        if (github) {
          // The GitHub renderer emits its own H1, so includeTitle is
          // intentionally not applied a second time here.
          return ScrapLLMConvert.postProcessMarkdown(
            github.markdown, settings, github.articleData, pageContext());
        }
      } catch (error) {
        // A private repo, a spent rate limit or an offline API is a reason to
        // fall back to the page in front of the user, not to fail the copy.
        DebugLog.error('GitHub extractor failed; using generic extraction', error);
      }
    }

    // X (Twitter) pages: the timeline is virtualised and Readability keeps at
    // most the first visible post, so threads and timelines go through the
    // dedicated X extractor instead.
    if (settings.xMode !== false &&
        settings.contentScope !== 'selection' &&
        typeof ScrapLLMX !== 'undefined' &&
        ScrapLLMX.isXPage(window.location)) {
      const xPageType = ScrapLLMX.getPageType(window.location);
      DebugLog.log('X page detected', { pageType: xPageType });
      const x = await ScrapLLMX.convert(settings, {
        logger: {
          log: (message, data) => DebugLog.log(message, data),
          error: (message, error) => DebugLog.error(message, error)
        },
        createTurndown: () => ScrapLLMConvert.configureTurndownService(settings)
      });
      if (x) {
        // The X renderer already emits its own H1 title, so includeTitle is
        // intentionally not applied a second time here.
        return ScrapLLMConvert.postProcessMarkdown(
          x.markdown, settings, x.articleData, pageContext());
      }
      // convert() returns null for X routes with nothing to render (login
      // wall, empty timeline); fall through to the generic extraction below.
      DebugLog.log('X extractor returned no content; using generic extraction');
    }

    // Detect and handle lazy-loaded content before extraction.
    // The detector itself is gated on the user setting so we don't pay for
    // host/selector lookups (or surface a false-positive footer warning) on
    // pages where the user has explicitly opted out. We also skip the
    // scroll-pass when the user is converting a selection: scrolling moves
    // the page out from under them and `window.getSelection()` would be
    // collapsed by the time we read it.
    let lazyLoadInfo = { isLazyLoaded: false, reason: null };
    let scrollResult = { scrolled: false, heightDelta: 0, contentChanged: false };
    const lazyLoadingEnabled = settings.triggerLazyLoading === true &&
                               settings.contentScope !== 'selection';

    if (lazyLoadingEnabled) {
      lazyLoadInfo = detectLazyLoadingPattern();
      if (lazyLoadInfo.isLazyLoaded) {
        // Probe for actual containers before notifying the user. If there's
        // nothing meaningful to scroll we'd rather stay silent than flash a
        // toast that doesn't reflect any real work.
        const probe = findScrollableContainers();
        if (probe.length > 0) {
          DebugLog.log('Attempting to load lazy-loaded content via scrolling', { reason: lazyLoadInfo.reason });
          showNotification('Loading content...', 'Scrolling to load all content before extraction');
          scrollResult = await scrollToLoadAllContent(probe);
          DebugLog.log('Scroll loading result', scrollResult);
        } else {
          DebugLog.log('Lazy load detected but no scrollable container; skipping scroll-pass');
        }
      }
    }

    // Conversations are their own scope: the transcript lives behind the site's
    // API or in a virtualised list, and Readability sees neither.
    if (settings.contentScope === 'chat' && typeof ScrapLLMChat !== 'undefined') {
      const chat = await ScrapLLMChat.convert(settings, {
        logger: {
          log: (message, data) => DebugLog.log(message, data),
          error: (message, error) => DebugLog.error(message, error)
        },
        createTurndown: () => ScrapLLMConvert.configureTurndownService(settings)
      });
      if (chat) {
        return ScrapLLMConvert.postProcessMarkdown(
          chat.markdown, settings, chat.articleData, pageContext());
      }
      throw new Error('No conversation could be extracted from this page');
    }

    // A highlighted fragment is an excerpt, not a page: it gets a source line,
    // a line range and a code fence when the fragment is code.
    if (settings.contentScope === 'selection' && typeof ScrapLLMSelection !== 'undefined') {
      const excerpt = ScrapLLMSelection.convert(settings, {
        logger: {
          log: (message, data) => DebugLog.log(message, data),
          error: (message, error) => DebugLog.error(message, error)
        },
        createTurndown: () => ScrapLLMConvert.configureTurndownService(settings)
      });
      if (excerpt) {
        // The header already names the source, so the metadata block would
        // repeat it.
        const excerptSettings = Object.assign({}, settings, { includeMetadata: false });
        return ScrapLLMConvert.postProcessMarkdown(
          excerpt.markdown, excerptSettings, excerpt.articleData, pageContext());
      }
      throw new Error('No text is selected');
    }

    // Only warn when we have evidence the scroll-pass changed the rendered
    // content. Emitting this for every positive detector hit is noisier
    // than helpful on pages that use ARIA logs for non-lazy content.
    const appendNotes = [];
    if (lazyLoadInfo.isLazyLoaded && scrollResult.scrolled &&
        (scrollResult.heightDelta > 0 || scrollResult.contentChanged)) {
      appendNotes.push(`\n\n---\n> **Note:** This page uses dynamic content loading (virtual scrolling). The extension scrolled to load all visible content, but some may still be missing if it wasn't rendered in the DOM. For long conversations or feeds, try scrolling through the entire content manually before converting.\n`);
      DebugLog.log('Added lazy load warning', { scrollResult, reason: lazyLoadInfo.reason });
    }

    // Converting a chat page as a page captures whichever messages happen to be
    // rendered. The popup keeps that action out of the front row for exactly
    // this reason, but it stays reachable — so when it is used, the output says
    // what it is instead of passing a slice off as the thread.
    if (settings.contentScope !== 'chat' && typeof ScrapLLMChat !== 'undefined') {
      try {
        if (ScrapLLMChat.inspect().isChat) {
          appendNotes.push('\n\n---\n> **Note:** This page is a conversation, and only the messages rendered at the time of capture are included — a transcript is loaded in pieces as you scroll. Use Copy Chat for the whole thread.\n');
          DebugLog.log('Page conversion on a chat page: added partial-transcript note');
        }
      } catch (error) {
        DebugLog.error('Chat probe failed during page conversion', error);
      }
    }

    const converted = ScrapLLMConvert.convertDocument({
      doc: document,
      url: window.location.href,
      title: document.title,
      settings,
      live: true,
      logger: {
        log: (message, data) => DebugLog.log(message, data),
        error: (message, error) => DebugLog.error(message, error)
      },
      extractSelection: extractSelectedContent,
      appendNotes
    });

    return converted.markdown;
  }

  // ==========================================================================
  // CONTENT EXTRACTION FUNCTIONS
  // ==========================================================================
  //
  // Everything that does not need the live page lives in convert-core.js, so
  // the background can run the identical conversion on fetched HTML. What is
  // left here is what only a rendered page can answer.

  function extractSelectedContent() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.toString().trim() === '') {
      throw new Error('No text is selected');
    }
    const container = document.createElement('div');
    const range = selection.getRangeAt(0);
    container.appendChild(range.cloneContents());
    return container;
  }

  // ==========================================================================
  // NOTIFICATION SYSTEM
  // ==========================================================================

  function showNotification(title, message) {
    const existingNotifications = document.querySelectorAll('.scrapllm-notification');
    existingNotifications.forEach(notification => {
      if (notification.parentNode) {
        notification.parentNode.removeChild(notification);
      }
    });

    const notification = document.createElement('div');
    notification.className = 'scrapllm-notification';

    // A translucent floating layer over unknown page content: a heavy dark
    // material with a strong blur (big surfaces read as thicker), an accent
    // rail for status instead of a shouting gradient, and vibrancy-grade text
    // so it stays legible over whatever is underneath. Transform and opacity
    // are driven by springs below, never by a CSS transition, so the card can
    // be grabbed and thrown while it is still arriving.
    const reduceTransparency = matchMedia('(prefers-reduced-transparency: reduce)').matches;
    notification.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      display: flex;
      align-items: stretch;
      gap: 0;
      background: ${reduceTransparency ? 'rgb(28, 28, 30)' : 'rgba(28, 28, 30, 0.82)'};
      color: #ffffff;
      border-radius: 16px;
      box-shadow: 0 20px 56px rgba(0, 0, 0, 0.34), 0 2px 8px rgba(0, 0, 0, 0.2);
      padding: 16px 44px 16px 18px;
      z-index: 2147483647;
      max-width: 380px;
      min-width: 300px;
      font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
      font-size: 14px;
      line-height: 1.45;
      ${reduceTransparency ? '' : '-webkit-backdrop-filter: saturate(180%) blur(30px); backdrop-filter: saturate(180%) blur(30px);'}
      border: 1px solid rgba(255, 255, 255, 0.14);
      opacity: 0;
      touch-action: pan-y;
      cursor: grab;
      will-change: transform, opacity;
    `;

    const contentWrapper = document.createElement('div');
    contentWrapper.style.cssText = `
      display: flex;
      align-items: flex-start;
      gap: 12px;
    `;

    const iconWrapper = document.createElement('div');
    iconWrapper.style.cssText = `
      flex-shrink: 0;
      width: 24px;
      height: 24px;
      display: flex;
      align-items: center;
      justify-content: center;
      margin-top: 2px;
    `;

    let iconSVG = '';
    if (title.toLowerCase().includes('success')) {
      iconSVG = `
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M9 12L11 14L15 10M21 12C21 16.9706 16.9706 21 12 21C7.02944 21 3 16.9706 3 12C3 7.02944 7.02944 3 12 3C16.9706 3 21 7.02944 21 12Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      `;
      notification.style.boxShadow += ', inset 3px 0 0 #30d158';
      iconWrapper.style.color = '#30d158';
    } else if (title.toLowerCase().includes('error') || title.toLowerCase().includes('failed')) {
      iconSVG = `
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M12 9V13M12 17H12.01M21 12C21 16.9706 16.9706 21 12 21C7.02944 21 3 16.9706 3 12C3 7.02944 7.02944 3 12 3C16.9706 3 21 7.02944 21 12Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      `;
      notification.style.boxShadow += ', inset 3px 0 0 #ff453a';
      iconWrapper.style.color = '#ff453a';
    } else {
      iconSVG = `
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M13 16H12V12H11M12 8H12.01M21 12C21 16.9706 16.9706 21 12 21C7.02944 21 3 16.9706 3 12C3 7.02944 7.02944 3 12 3C16.9706 3 21 7.02944 21 12Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      `;
      notification.style.boxShadow += ', inset 3px 0 0 #0a84ff';
      iconWrapper.style.color = '#0a84ff';
    }
    iconWrapper.innerHTML = iconSVG;

    const textWrapper = document.createElement('div');
    textWrapper.style.cssText = `
      flex: 1;
      min-width: 0;
    `;

    const titleElement = document.createElement('div');
    titleElement.textContent = title;
    titleElement.style.cssText = `
      font-size: 15px;
      font-weight: 600;
      line-height: 1.25;
      letter-spacing: -0.012em;
      margin: 0 0 2px 0;
      color: #ffffff;
    `;

    const messageElement = document.createElement('div');
    messageElement.style.cssText = `
      font-size: 13px;
      font-weight: 450;
      line-height: 1.45;
      letter-spacing: 0.002em;
      margin: 0;
      color: rgba(255, 255, 255, 0.92);
      word-wrap: break-word;
      white-space: pre-line;
    `;
    
    // Handle multiline messages
    const lines = message.split('\n').filter(line => line.trim() !== '');
    if (lines.length > 1) {
      lines.forEach((line, index) => {
        const lineDiv = document.createElement('div');
        lineDiv.textContent = line;
        if (index > 0) {
          lineDiv.style.marginTop = '4px';
        }
        messageElement.appendChild(lineDiv);
      });
    } else {
      messageElement.textContent = message;
    }

    const closeButton = document.createElement('button');
    closeButton.style.cssText = `
      position: absolute;
      top: 8px;
      right: 8px;
      background: none;
      border: none;
      color: rgba(255, 255, 255, 0.7);
      cursor: pointer;
      padding: 4px;
      border-radius: 4px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background-color 100ms ease-out, color 100ms ease-out, transform 100ms ease-out;
    `;
    closeButton.addEventListener('pointerdown', () => {
      closeButton.style.transform = 'scale(0.88)';
      closeButton.style.backgroundColor = 'rgba(255, 255, 255, 0.16)';
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach((type) => {
      closeButton.addEventListener(type, () => {
        closeButton.style.transform = 'scale(1)';
      });
    });
    closeButton.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M18 6L6 18M6 6L18 18" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    `;

    closeButton.addEventListener('mouseenter', () => {
      closeButton.style.backgroundColor = 'rgba(255, 255, 255, 0.1)';
      closeButton.style.color = '#ffffff';
    });
    closeButton.addEventListener('mouseleave', () => {
      closeButton.style.backgroundColor = 'transparent';
      closeButton.style.color = 'rgba(255, 255, 255, 0.7)';
    });

    textWrapper.appendChild(titleElement);
    textWrapper.appendChild(messageElement);
    contentWrapper.appendChild(iconWrapper);
    contentWrapper.appendChild(textWrapper);
    notification.appendChild(contentWrapper);
    notification.appendChild(closeButton);

    document.body.appendChild(notification);
    animateNotification(notification, closeButton);
  }

  // Spring-driven presentation for the notification card: it materialises on
  // the same axis it dismisses on, tracks the finger 1:1 when swiped, and
  // leaves at the velocity the finger let go with.
  function animateNotification(notification, closeButton) {
    const Motion = typeof ScrapLLMMotion !== 'undefined' ? ScrapLLMMotion : null;
    const width = notification.getBoundingClientRect().width || 340;
    const OFFSCREEN = width + 40;
    let removed = false;

    const render = (x, present) => {
      const travelling = Math.abs(x) > 1;
      notification.style.transform =
        `translate3d(${x}px, 0, 0) scale(${0.94 + present * 0.06})`;
      notification.style.opacity = String(present * (travelling ? 0.92 : 1));
      // Materialise: the blur resolves as the surface arrives, so it reads as
      // glass forming rather than a flat fade.
      if (present < 0.995) {
        notification.style.filter = `blur(${(1 - present) * 8}px)`;
      } else {
        notification.style.filter = 'none';
      }
    };

    const destroy = () => {
      if (notification.parentNode) notification.parentNode.removeChild(notification);
    };

    if (!Motion || Motion.prefersReducedMotion()) {
      // Reduced motion keeps the feedback but drops the travel: a short
      // cross-fade in place, no slide, no overshoot.
      notification.style.transition = 'opacity 200ms ease';
      notification.style.transform = 'none';
      requestAnimationFrame(() => { notification.style.opacity = '1'; });
      const dismiss = () => {
        if (removed) return;
        removed = true;
        notification.style.opacity = '0';
        setTimeout(destroy, 220);
      };
      closeButton.addEventListener('click', dismiss);
      const timeout = setTimeout(dismiss, 4000);
      closeButton.addEventListener('click', () => clearTimeout(timeout));
      return;
    }

    const presence = new Motion.Spring(0, {
      damping: Motion.PRESETS.sheet.damping,
      response: Motion.PRESETS.sheet.response,
      onUpdate: (value) => render(offset.value, value)
    });
    const offset = new Motion.Spring(OFFSCREEN, {
      damping: Motion.PRESETS.sheet.damping,
      response: Motion.PRESETS.sheet.response,
      onUpdate: (value) => render(value, presence.value),
      onRest: (spring) => {
        if (removed && Math.abs(spring.value) >= OFFSCREEN - 1) destroy();
      }
    });

    render(OFFSCREEN, 0);
    requestAnimationFrame(() => {
      offset.to(0, Motion.PRESETS.sheet);
      presence.to(1, Motion.PRESETS.sheet);
    });

    const dismiss = (velocity) => {
      if (removed) return;
      removed = true;
      clearTimeout(autoDismiss);
      offset.to(OFFSCREEN, { ...Motion.PRESETS.sheet, velocity: velocity || 0 });
      presence.to(0, Motion.PRESETS.snappy);
      // Belt and braces: if the tab is backgrounded mid-flight the spring stops
      // ticking, so guarantee removal.
      setTimeout(destroy, 800);
    };

    let autoDismiss = setTimeout(() => dismiss(0), 4000);
    closeButton.addEventListener('click', () => dismiss(0));

    let startX = 0;
    Motion.draggable(notification, {
      axis: 'x',
      canStart: () => !removed,
      onStart: () => {
        clearTimeout(autoDismiss);
        startX = offset.value;
        notification.style.cursor = 'grabbing';
      },
      onMove: ({ delta }) => {
        // Free to the right (the dismiss direction), resisted to the left.
        const raw = startX + delta;
        offset.set(raw >= 0 ? raw : Motion.rubberband(raw, width));
      },
      onEnd: ({ delta, velocity, cancelled }) => {
        notification.style.cursor = 'grab';
        const current = startX + delta;
        if (cancelled) {
          offset.to(0, Motion.PRESETS.sheet);
          autoDismiss = setTimeout(() => dismiss(0), 4000);
          return;
        }
        // Land where the flick is going, not where the finger stopped.
        const projected = current + Motion.project(velocity);
        if (velocity > 200 || projected > width * 0.4) {
          dismiss(velocity);
        } else {
          offset.to(0, { ...Motion.PRESETS.sheet, velocity });
          autoDismiss = setTimeout(() => dismiss(0), 4000);
        }
      }
    });
  }

})();
