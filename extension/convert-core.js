// ScrapLLM Conversion Core
// The document-to-Markdown path, with every reference to the *live* page
// removed so the same code runs in three places:
//
//   1. content.js            — doc is the rendered page
//   2. offscreen.js (Chrome) — doc is HTML fetched in the background and parsed
//   3. background page (FF)  — same, parsed directly in the MV2 background page
//
// Nothing here reads `window.location` or `document.title`: the caller passes
// the source URL and title explicitly, because in the fetched paths the
// surrounding document is the extension's own page and would produce a
// chrome-extension:// "Source:" line and extension-relative links.

const ScrapLLMConvert = (function() {
  'use strict';

  const MIN_CONTENT_LENGTH = 50;      // Minimum meaningful iframe content length
  const LARGE_CONTENT_BYTES = 1000000;
  const TRUNCATE_BYTES = 100000;

  const NULL_LOGGER = {
    log: function() {},
    error: function() {}
  };

  // ==========================================================================
  // Token estimation (shared with the content script's message handler)
  // ==========================================================================

  function estimateTokens(markdown) {
    try {
      const wordCount = String(markdown).split(/\s+/).filter(w => w.length > 0).length;
      const charCount = String(markdown).length;
      return Math.ceil(Math.max(wordCount * 0.75, charCount / 4));
    } catch (e) {
      return 0;
    }
  }

  // ==========================================================================
  // Fetched-document preparation
  // ==========================================================================

  // A document produced by DOMParser has the *extension's* URL as its base URI,
  // so every relative link and image would resolve against chrome-extension://.
  // A <base> element inserted before anything reads the DOM fixes both
  // Readability's own resolution and makeUrlsAbsolute below.
  function applyBaseUrl(doc, url) {
    if (!doc || !url) return doc;
    const head = doc.head || doc.documentElement;
    if (!head) return doc;
    const existing = doc.querySelector('base[href]');
    if (existing) {
      try {
        existing.setAttribute('href', new URL(existing.getAttribute('href'), url).href);
        return doc;
      } catch (e) {
        existing.remove();
      }
    }
    const base = doc.createElement('base');
    base.setAttribute('href', url);
    head.insertBefore(base, head.firstChild);
    return doc;
  }

  // What the quiet-capture classifier needs to know about a parsed page before
  // it decides whether a rendering engine would have done better. Pure reading;
  // no mutation.
  const APP_SHELL_SELECTORS = ['#root', '#__next', '#app', 'app-root', '[ng-version]'];

  function inspectDocument(doc) {
    const bodyText = (doc && doc.body && doc.body.textContent) || '';
    let appShell = false;
    if (doc && typeof doc.querySelector === 'function') {
      for (const selector of APP_SHELL_SELECTORS) {
        let host = null;
        try {
          host = doc.querySelector(selector);
        } catch (e) {
          host = null;
        }
        if (host && (host.textContent || '').trim().length === 0) {
          appShell = true;
          break;
        }
      }
    }
    return {
      bodyTextLength: bodyText.trim().length,
      emptyAppShell: appShell
    };
  }

  // ==========================================================================
  // CONTENT EXTRACTION
  // ==========================================================================

  function extractFullPageContent(doc, url) {
    removeRedditAds(doc.body || doc, url);
    const scripts = doc.getElementsByTagName('script');
    const styles = doc.getElementsByTagName('style');
    for (let i = scripts.length - 1; i >= 0; i--) {
      scripts[i].parentNode.removeChild(scripts[i]);
    }
    for (let i = styles.length - 1; i >= 0; i--) {
      styles[i].parentNode.removeChild(styles[i]);
    }
    return doc.body;
  }

  function extractMainContent(doc, ctx) {
    try {
      const documentClone = doc.implementation.createHTMLDocument('Article');
      documentClone.documentElement.innerHTML = doc.documentElement.innerHTML;
      // Before Readability, not after: it strips class attributes from what it
      // returns, so by the time cleanContent runs there is nothing left to
      // identify an icon font by, and the ligature survives into the Markdown.
      removeIconLigatures(documentClone.body);
      // Same reason, plus a stronger one: a promoted post is structurally a
      // post, so left in place it competes for Readability's score and can be
      // picked as the article outright.
      removeRedditAds(documentClone.body, ctx.url);
      const reader = new Readability(documentClone);
      const article = reader.parse();

      if (!article || !article.content) {
        throw new Error('Could not extract main content');
      }

      const container = doc.createElement('div');
      container.innerHTML = article.content;

      return {
        content: container,
        articleData: {
          title: article.title || ctx.title,
          author: article.byline || extractAuthorFromMeta(ctx.doc),
          siteName: article.siteName || extractSiteNameFromMeta(ctx.doc, ctx.url),
          publishedTime: article.publishedTime || extractPublishedDateFromMeta(ctx.doc),
          excerpt: article.excerpt || ''
        },
        textLength: ((article.textContent || '').trim()).length
      };
    } catch (error) {
      console.error('Readability error:', error);
      ctx.logger.error('Readability error', error);
      return {
        content: fallbackContentExtraction(doc),
        articleData: null,
        textLength: 0
      };
    }
  }

  function fallbackContentExtraction(doc) {
    const container = doc.createElement('div');
    const mainContent = doc.querySelector('main') ||
                        doc.querySelector('article') ||
                        doc.querySelector('.content') ||
                        doc.querySelector('#content') ||
                        doc.body;
    container.appendChild(mainContent.cloneNode(true));
    return container;
  }

  function extractAuthorFromMeta(doc) {
    const authorSelectors = [
      'meta[name="author"]',
      'meta[property="article:author"]',
      'meta[name="dcterms.creator"]',
      'meta[name="DC.creator"]',
      'meta[property="og:author"]'
    ];
    for (const selector of authorSelectors) {
      const metaTag = doc.querySelector(selector);
      if (metaTag && metaTag.content) {
        return metaTag.content.trim();
      }
    }
    return '';
  }

  function extractSiteNameFromMeta(doc, url) {
    const siteNameSelectors = [
      'meta[property="og:site_name"]',
      'meta[name="application-name"]',
      'meta[name="apple-mobile-web-app-title"]'
    ];
    for (const selector of siteNameSelectors) {
      const metaTag = doc.querySelector(selector);
      if (metaTag && metaTag.content) {
        return metaTag.content.trim();
      }
    }
    try {
      return new URL(url).hostname;
    } catch (e) {
      return '';
    }
  }

  function extractPublishedDateFromMeta(doc) {
    const dateSelectors = [
      'meta[property="article:published_time"]',
      'meta[name="dcterms.created"]',
      'meta[name="DC.date.created"]',
      'meta[name="date"]',
      'meta[property="og:published_time"]',
      'time[datetime]',
      'time[pubdate]'
    ];
    for (const selector of dateSelectors) {
      const element = doc.querySelector(selector);
      if (element) {
        const dateValue = element.getAttribute('content') ||
                         element.getAttribute('datetime') ||
                         element.textContent;
        if (dateValue) {
          try {
            const date = new Date(dateValue.trim());
            if (!isNaN(date.getTime())) {
              return date.toISOString().split('T')[0];
            }
          } catch (e) {
            return dateValue.trim();
          }
        }
      }
    }
    return '';
  }

  // ==========================================================================
  // IFRAME CONTENT EXTRACTION
  // ==========================================================================
  //
  // Same-origin frames (including srcdoc) are read through the DOM.
  // Cross-origin frames stay behind the browser's origin checks: we keep a
  // link/warning instead of asking another window to echo its HTML.
  //
  // In a *fetched* document no frame has a contentWindow at all — nothing was
  // ever loaded — so the warning says that instead of blaming the origin check.

  function isHttpOrHttpsUrl(src) {
    if (!src || typeof src !== 'string') {
      return false;
    }
    // Require an explicit http(s) URL so srcdoc HTML cannot be resolved as
    // a relative path against the page.
    if (!/^https?:\/\//i.test(src.trim())) {
      return false;
    }
    try {
      const url = new URL(src);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch (e) {
      return false;
    }
  }

  function iframeFallbackInfo(iframe, iframeSrc) {
    return {
      src: iframeSrc,
      title: iframe.title || iframe.getAttribute('aria-label') || 'Embedded content'
    };
  }

  function createIframePlaceholder(doc, iframeSrc, iframeTitle) {
    const linkDiv = doc.createElement('div');
    linkDiv.className = 'scrapllm-iframe-link';
    const p = doc.createElement('p');
    p.appendChild(doc.createTextNode('[Embedded content: '));
    const title = iframeTitle || 'Embedded content';
    if (isHttpOrHttpsUrl(iframeSrc)) {
      const a = doc.createElement('a');
      a.href = iframeSrc;
      a.textContent = title;
      p.appendChild(a);
    } else {
      p.appendChild(doc.createTextNode(title));
    }
    p.appendChild(doc.createTextNode(']'));
    linkDiv.appendChild(p);
    return linkDiv;
  }

  function isSameOriginIframe(iframe) {
    try {
      if (!iframe.contentWindow) {
        return false;
      }
      const iframeDoc = iframe.contentWindow.document;
      return !!iframeDoc;
    } catch (e) {
      return false;
    }
  }

  function isHiddenEmptyIframe(iframe) {
    return !iframe.offsetParent && !iframe.src && !iframe.srcdoc;
  }

  function isRemoteIframeSrc(iframe) {
    return !!(iframe.src && iframe.src !== 'about:blank' && iframe.src !== 'javascript:void(0)');
  }

  function tryExtractSameOriginIframe(doc, iframe, iframeSrc, index) {
    const iframeDoc = iframe.contentWindow.document;
    const iframeBody = iframeDoc.body;
    const clonedIframeContent = iframeBody.cloneNode(true);

    const scripts = clonedIframeContent.querySelectorAll('script, style, noscript');
    for (let j = scripts.length - 1; j >= 0; j--) {
      scripts[j].parentNode.removeChild(scripts[j]);
    }

    const iframeText = clonedIframeContent.textContent || '';
    if (iframeText.trim().length <= MIN_CONTENT_LENGTH) {
      return { skipped: true, contentLength: iframeText.length };
    }

    const wrapper = doc.createElement('div');
    wrapper.className = 'scrapllm-iframe-content';
    wrapper.setAttribute('data-iframe-src', iframeSrc);
    wrapper.setAttribute('data-iframe-index', String(index));
    while (clonedIframeContent.firstChild) {
      wrapper.appendChild(clonedIframeContent.firstChild);
    }
    return { wrapper, contentLength: iframeText.length };
  }

  function collectIframeExtraction(ctx, iframes, logLabel) {
    const extractedContents = [];
    const unreadableIframes = [];

    ctx.logger.log(logLabel, {
      originalIframes: iframes.length
    });

    for (let i = 0; i < iframes.length; i++) {
      const iframe = iframes[i];
      const iframeSrc = iframe.src || iframe.srcdoc || 'about:blank';

      if (ctx.live && isHiddenEmptyIframe(iframe)) {
        continue;
      }

      if (ctx.live && isSameOriginIframe(iframe)) {
        try {
          const result = tryExtractSameOriginIframe(ctx.doc, iframe, iframeSrc, i);
          if (result.wrapper) {
            extractedContents.push(result.wrapper);
            ctx.logger.log('Extracted same-origin iframe', {
              src: iframeSrc.substring(0, 50),
              contentLength: result.contentLength
            });
          } else {
            ctx.logger.log('Iframe skipped (not enough content)', {
              src: iframeSrc.substring(0, 50),
              contentLength: result.contentLength
            });
          }
        } catch (e) {
          ctx.logger.error('Same-origin iframe extraction failed', e);
          if (iframe.src) {
            unreadableIframes.push(iframeFallbackInfo(iframe, iframeSrc));
          }
        }
      } else if (isRemoteIframeSrc(iframe)) {
        unreadableIframes.push(iframeFallbackInfo(iframe, iframeSrc));
      }
    }

    ctx.logger.log('Iframe extraction complete', {
      extracted: extractedContents.length,
      unreadable: unreadableIframes.length
    });

    return { extractedContents, unreadableIframes };
  }

  function unreadableIframeWarnings(ctx, unreadableIframes) {
    if (unreadableIframes.length === 0) {
      return [];
    }
    return [{
      type: ctx.live ? 'crossOriginIframe' : 'unloadedIframe',
      count: unreadableIframes.length,
      details: unreadableIframes.slice(0, 3)
    }];
  }

  // Extract iframe content from the ORIGINAL document and append it to the
  // content, because Readability may have removed the iframes.
  function extractAndReplaceIframesFromOriginal(ctx, clonedContent) {
    const originalIframes = Array.from(ctx.doc.querySelectorAll('iframe'));
    const { extractedContents, unreadableIframes } = collectIframeExtraction(
      ctx,
      originalIframes,
      'Starting iframe extraction from original document'
    );

    if (extractedContents.length > 0) {
      ctx.logger.log('Appending extracted iframe content to cloned content', {
        count: extractedContents.length
      });

      const iframeSection = ctx.doc.createElement('div');
      iframeSection.className = 'scrapllm-iframes';

      extractedContents.forEach((wrapper, index) => {
        const section = ctx.doc.createElement('div');
        section.className = 'scrapllm-iframe-section';
        section.appendChild(ctx.doc.createElement('hr'));
        const heading = ctx.doc.createElement('h3');
        heading.textContent = `Embedded Content ${index + 1}`;
        section.appendChild(heading);
        section.appendChild(wrapper);
        iframeSection.appendChild(section);
      });

      clonedContent.appendChild(iframeSection);
      ctx.logger.log('Appended iframe content to cloned content');
    }

    return unreadableIframeWarnings(ctx, unreadableIframes);
  }

  // fullPage / selection scope: the iframes are still present in the cloned
  // content, so they are replaced in place.
  function extractAndReplaceIframesFromCloned(ctx, content, preserveIframeLinks) {
    const originalIframes = Array.from(ctx.doc.querySelectorAll('iframe'));
    const { extractedContents, unreadableIframes } = collectIframeExtraction(
      ctx,
      originalIframes,
      'Starting iframe extraction from cloned content'
    );

    const clonedIframes = Array.from(content.querySelectorAll('iframe'));
    for (let i = 0; i < clonedIframes.length; i++) {
      const iframe = clonedIframes[i];
      const iframeSrc = iframe.src || iframe.srcdoc || 'about:blank';

      const extractedContent = extractedContents.find(c =>
        parseInt(c.getAttribute('data-iframe-index'), 10) === i
      );

      if (extractedContent) {
        const replacementDiv = ctx.doc.createElement('div');
        replacementDiv.className = 'scrapllm-iframe-replacement';
        while (extractedContent.firstChild) {
          replacementDiv.appendChild(extractedContent.firstChild);
        }
        iframe.parentNode.replaceChild(replacementDiv, iframe);
      } else if (preserveIframeLinks && iframeSrc && iframeSrc !== 'about:blank') {
        const iframeTitle = iframe.title || iframe.getAttribute('aria-label') || 'Embedded content';
        iframe.parentNode.replaceChild(
          createIframePlaceholder(ctx.doc, iframeSrc, iframeTitle), iframe);
      } else {
        iframe.parentNode.removeChild(iframe);
      }
    }

    return unreadableIframeWarnings(ctx, unreadableIframes);
  }

  // ==========================================================================
  // CONTENT CLEANING
  // ==========================================================================

  // Icon fonts draw a glyph from a ligature, so the element's TEXT is the icon's
  // NAME. On screen the reader sees an arrow; in Markdown they get the bare word
  // "arrow_forward" wedged into a sentence, and a page of icon buttons turns
  // into a list of nouns nobody wrote.
  //
  // Two rules keep this from eating real content. Only LEAF elements are
  // considered, so a card that wraps an icon next to its caption keeps the
  // caption — which matters on the pages where icon names are the subject, like
  // an icon gallery. And only a single wordless token is taken: "arrow_forward"
  // and "expand_more" go, a sentence never does.
  const ICON_FONT_SELECTOR = [
    '.material-icons', '.material-icons-outlined', '.material-icons-round',
    '[class*="material-symbols"]',
    '.fa', '.fas', '.far', '.fab', '.fal', '.fad',
    '[class^="fa-"]', '[class*=" fa-"]',
    '.glyphicon', '[class^="glyphicon-"]',
    '[class^="bi-"]', '[class*=" bi-"]',
    'ion-icon',
    '[class^="ri-"]', '[class*=" ri-"]',
    '[class*="lucide"]', '[class*="feather-icon"]'
  ].join(', ');

  const LIGATURE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

  // The element's own text, ignoring anything a child contributes.
  function ownText(node) {
    let text = '';
    for (let i = 0; i < node.childNodes.length; i++) {
      const child = node.childNodes[i];
      if (child.nodeType === 3) text += child.nodeValue;
    }
    return text.trim();
  }

  function removeIconLigatures(content) {
    const candidates = content.querySelectorAll(ICON_FONT_SELECTOR);
    for (let i = 0; i < candidates.length; i++) {
      const node = candidates[i];
      if (!node.parentNode) continue;

      if (node.children.length === 0) {
        const text = (node.textContent || '').trim();
        if (text && text.length <= 40 && LIGATURE.test(text)) {
          node.parentNode.removeChild(node);
        }
        continue;
      }

      // Not a leaf, but still an icon: ad scripts and page annotators inject
      // their own markup inside the icon's span, which would otherwise shield
      // the ligature from removal. Take the element's own text and leave
      // whatever was injected to the rules that handle it.
      const own = ownText(node);
      if (!own || own.length > 40 || !LIGATURE.test(own)) continue;
      for (let j = node.childNodes.length - 1; j >= 0; j--) {
        const child = node.childNodes[j];
        if (child.nodeType === 3) node.removeChild(child);
      }
    }

    // The same shape, declared a second way: an element the page hides from
    // assistive technology is decoration by the author's own statement.
    const hidden = content.querySelectorAll('[aria-hidden="true"]');
    for (let i = 0; i < hidden.length; i++) {
      const node = hidden[i];
      if (!node.parentNode || node.children.length > 0) continue;
      const text = (node.textContent || '').trim();
      if (text && text.length <= 40 && LIGATURE.test(text)) {
        node.parentNode.removeChild(node);
      }
    }
  }

  // Reddit ships its own promoted posts and comment-tree ads as first-class
  // elements in the same DOM as real content, so nothing upstream has a reason
  // to drop them: to Readability a promoted post is a post, and the full-page
  // path takes the body verbatim. They are removed by name instead.
  const REDDIT_AD_SELECTORS = [
    'shreddit-ad-post',
    'shreddit-comments-page-ad',
    'shreddit-comment-tree-ad',
    'shreddit-dynamic-ad-link',
    'shreddit-sponsored-post',
    '[promoted]',
    '[is-sponsored]',
    '[data-promoted="true"]',
    '[data-testid="promotedlink"]',
    '[data-adclicklocation]',
    '.promotedlink',
    '.thing.promoted',
    '.ad-container',
    '#ad_1'
  ];

  function isRedditHost(url) {
    try {
      return /(^|\.)reddit\.com$/i.test(new URL(url).hostname);
    } catch (error) {
      return false;
    }
  }

  // Confined to Reddit hosts: a legitimate `.promoted` or `[promoted]` on some
  // other site is that site's content, and removing it would be the kind of
  // silent loss this extension exists to avoid.
  function removeRedditAds(content, url) {
    if (!isRedditHost(url)) return;

    for (const selector of REDDIT_AD_SELECTORS) {
      let elements;
      try {
        elements = content.querySelectorAll(selector);
      } catch (error) {
        continue; // a selector this DOM implementation will not parse
      }
      for (let i = elements.length - 1; i >= 0; i--) {
        if (elements[i].parentNode) elements[i].parentNode.removeChild(elements[i]);
      }
    }

    // Reddit adds ad elements faster than any fixed list tracks, but they are
    // consistently named: a shreddit-* custom element with "ad" as a word in
    // its tag. Matched on the tag name because CSS has no wildcard for it.
    const all = content.querySelectorAll('*');
    for (let i = all.length - 1; i >= 0; i--) {
      const tag = (all[i].tagName || '').toLowerCase();
      if (/^shreddit-(.+-)?ads?(-.+)?$/.test(tag) && all[i].parentNode) {
        all[i].parentNode.removeChild(all[i]);
      }
    }
  }

  function cleanContent(ctx, content, settings) {
    // For fullPage and selection scopes, extract iframes from cloned content.
    // For mainContent scope, this was already done before Readability.
    let iframeWarnings = [];
    if (settings.contentScope !== 'mainContent') {
      iframeWarnings = extractAndReplaceIframesFromCloned(
        ctx, content, settings.preserveIframeLinks !== false);
    }

    // Remove elements that shouldn't be included
    const elementsToRemove = [
      'script', 'style', 'noscript',
      'nav', 'footer', '.comments', '.ads', '.sidebar',
    ];

    if (!settings.includeImages) {
      elementsToRemove.push('img', 'picture', 'svg');
    }

    elementsToRemove.forEach(selector => {
      const elements = content.querySelectorAll(selector);
      for (let i = 0; i < elements.length; i++) {
        if (elements[i].parentNode) {
          elements[i].parentNode.removeChild(elements[i]);
        }
      }
    });

    removeRedditAds(content, ctx.url);
    removeIconLigatures(content);

    // Remove empty paragraphs and divs
    const emptyElements = content.querySelectorAll('p:empty, div:empty');
    for (let i = 0; i < emptyElements.length; i++) {
      emptyElements[i].parentNode.removeChild(emptyElements[i]);
    }

    makeUrlsAbsolute(content, ctx.baseURI);
    return iframeWarnings;
  }

  function makeUrlsAbsolute(content, baseURI) {
    const links = content.querySelectorAll('a');
    for (let i = 0; i < links.length; i++) {
      if (links[i].getAttribute('href')) {
        try {
          links[i].setAttribute('href', new URL(links[i].getAttribute('href'), baseURI).href);
        } catch (e) {}
      }
    }

    const images = content.querySelectorAll('img');
    for (let i = 0; i < images.length; i++) {
      if (images[i].getAttribute('src')) {
        try {
          images[i].setAttribute('src', new URL(images[i].getAttribute('src'), baseURI).href);
        } catch (e) {}
      }
    }
  }

  // ==========================================================================
  // TURNDOWN CONFIGURATION
  // ==========================================================================

  function configureTurndownService(settings) {
    const turndownService = new TurndownService({
      headingStyle: 'atx',
      hr: '---',
      bulletListMarker: '-',
      codeBlockStyle: 'fenced',
      emDelimiter: '*'
    });

    if (settings.preserveTables) {
      // Prevent thead and tbody from adding extra newlines
      turndownService.addRule('thead', {
        filter: 'thead',
        replacement: function(content) {
          return content;
        }
      });

      turndownService.addRule('tbody', {
        filter: 'tbody',
        replacement: function(content) {
          return content;
        }
      });

      // Add custom table rules before default rules can process them
      turndownService.addRule('table', {
        filter: 'table',
        replacement: function(content) {
          return '\n\n' + content + '\n\n';
        }
      });

      turndownService.addRule('tableRow', {
        filter: 'tr',
        replacement: function(content, node) {
          const cells = node.querySelectorAll('th, td');
          let output = '|' + content + '\n';

          // Check if this row contains th elements (header row)
          const hasHeaderCell = Array.from(cells).some(cell => cell.nodeName === 'TH');

          // Add separator row after header row
          if (hasHeaderCell) {
            const separator = '|' + Array.from(cells).map(() => ' --- |').join('') + '\n';
            output += separator;
          }

          return output;
        }
      });

      turndownService.addRule('tableCell', {
        filter: ['th', 'td'],
        replacement: function(content) {
          return ' ' + content.trim() + ' |';
        }
      });
    }

    if (!settings.includeImages) {
      turndownService.addRule('images', {
        filter: 'img',
        replacement: function() {
          return '';
        }
      });
    }

    if (!settings.includeLinks) {
      turndownService.addRule('stripLinks', {
        filter: function(node) {
          return node.nodeName === 'A' && node.href;
        },
        replacement: function(content) {
          return content;
        }
      });
    }

    turndownService.addRule('fencedCodeBlock', {
      filter: function(node) {
        return node.nodeName === 'PRE';
      },
      replacement: function(content, node) {
        const codeElement = node.querySelector('code');
        const languageClasses = [
          (codeElement && codeElement.getAttribute('class')) || '',
          node.getAttribute('class') || ''
        ].join(' ');
        const languageMatch = languageClasses.match(/(?:language|lang)-(\S+)/);
        const languageIdentifier = languageMatch ? languageMatch[1] : '';
        const codeContainer = (codeElement || node).cloneNode(true);

        // Syntax highlighters often emit <pre><span>...<br>...</span></pre>.
        // textContent preserves the highlighted text, but <br> needs explicit handling.
        const lineBreaks = codeContainer.querySelectorAll('br');
        lineBreaks.forEach(lineBreak => lineBreak.replaceWith('\n'));

        const code = codeContainer.textContent.replace(/\n$/, '');
        const fenceMatches = code.match(/^`{3,}/gm) || [];
        const fenceSize = fenceMatches.reduce(
          (size, fence) => Math.max(size, fence.length + 1),
          3
        );
        const fence = '`'.repeat(fenceSize);

        return (
          '\n\n' + fence + languageIdentifier + '\n' +
          code +
          '\n' + fence + '\n\n'
        );
      }
    });

    return turndownService;
  }

  // ==========================================================================
  // POST-PROCESSING
  // ==========================================================================

  function postProcessMarkdown(markdown, settings, articleData, ctx) {
    markdown = markdown.replace(/\n{3,}/g, '\n\n');
    markdown = markdown.replace(/([^\n])(\n#{1,6} )/g, '$1\n\n$2');
    markdown = markdown.replace(/(\n[*\-+] [^\n]+)(\n[*\-+] )/g, '$1\n$2');

    if (settings.includeMetadata && settings.metadataFormat) {
      const metadataText = formatMetadata(settings.metadataFormat, articleData, ctx);
      if (metadataText) {
        markdown = markdown + '\n\n' + metadataText;
      }
    }

    return markdown;
  }

  function formatMetadata(template, articleData, ctx) {
    const pageTitle = (ctx && ctx.title) || '';
    const pageUrl = (ctx && ctx.url) || '';
    try {
      const metadata = {
        title: (articleData && articleData.title) || pageTitle || 'Untitled',
        url: pageUrl,
        date: (articleData && articleData.publishedTime) || '',
        author: (articleData && articleData.author) || '',
        siteName: (articleData && articleData.siteName) || new URL(pageUrl).hostname,
        excerpt: (articleData && articleData.excerpt) || ''
      };

      let formatted = template;
      Object.entries(metadata).forEach(([key, value]) => {
        const placeholder = new RegExp(`\\{${key}\\}`, 'g');
        formatted = formatted.replace(placeholder, value);
      });

      return formatted;
    } catch (error) {
      console.error('Error formatting metadata:', error);
      return `---\nSource: [${pageTitle || 'Untitled'}](${pageUrl})`;
    }
  }

  // ==========================================================================
  // THE GENERIC CONVERSION
  // ==========================================================================

  // options:
  //   doc              the source document (live page, or a parsed one)
  //   url, title       the *source's* URL and title, never the host page's
  //   settings         the user settings object
  //   live             true when `doc` is a rendered page (default false)
  //   logger           { log, error } — DebugLog in the content script
  //   extractSelection optional () => Element, only the live page can do this
  //   appendNotes      optional string[] appended before the metadata block
  //
  // Returns { markdown, articleData, tokenCount, textLength, warnings }.
  function convertDocument(options) {
    const settings = (options && options.settings) || {};
    const doc = options.doc;
    if (!doc || !doc.documentElement) {
      throw new Error('No document to convert');
    }

    const ctx = {
      doc,
      url: options.url || '',
      title: options.title || '',
      live: options.live === true,
      logger: options.logger || NULL_LOGGER,
      baseURI: options.baseURI || doc.baseURI || options.url || ''
    };

    const docClone = doc.cloneNode(true);
    let content;
    let articleData = null;
    let textLength = 0;

    switch (settings.contentScope) {
      case 'fullPage':
        content = extractFullPageContent(docClone, ctx.url);
        textLength = ((content && content.textContent) || '').trim().length;
        break;
      case 'selection':
        if (typeof options.extractSelection !== 'function') {
          throw new Error('No text is selected');
        }
        content = options.extractSelection();
        textLength = ((content && content.textContent) || '').trim().length;
        break;
      case 'mainContent':
      default: {
        const result = extractMainContent(docClone, ctx);
        content = result.content;
        articleData = result.articleData;
        textLength = result.textLength;
        break;
      }
    }

    if (!content) {
      ctx.logger.log('Content extraction failed');
      throw new Error('No content could be extracted');
    }

    ctx.logger.log('Content extracted', { innerHTMLLength: (content.innerHTML || '').length });

    const contentSize = content.innerHTML.length;
    if (contentSize > LARGE_CONTENT_BYTES) {
      console.warn('Large content detected:', contentSize, 'bytes');
      ctx.logger.log('Large content detected', { size: contentSize });
    }

    // Extract iframes BEFORE cleanContent (which removes them). For the
    // mainContent scope they must come from the original document, because
    // Readability drops them.
    let iframeWarnings = [];
    if (settings.contentScope === 'mainContent') {
      iframeWarnings = extractAndReplaceIframesFromOriginal(ctx, content);
    }

    const cleanWarnings = cleanContent(ctx, content, settings);
    iframeWarnings = iframeWarnings.concat(cleanWarnings);

    ctx.logger.log('Iframe warnings', {
      count: iframeWarnings.length,
      types: iframeWarnings.map(w => w.type)
    });

    const turndownService = configureTurndownService(settings);

    try {
      let markdown = turndownService.turndown(content);

      if (!markdown || markdown.trim() === '') {
        throw new Error('Conversion resulted in empty markdown');
      }

      ctx.logger.log('Conversion successful', {
        markdownLength: markdown.length,
        hasTables: markdown.includes('|---')
      });

      if (settings.includeTitle) {
        const pageTitle = (ctx.title || '').trim();
        if (pageTitle.length > 0) {
          markdown = `# ${pageTitle}\n\n${markdown}`;
        }
      }

      const crossOrigin = iframeWarnings.find(w => w.type === 'crossOriginIframe');
      if (crossOrigin) {
        markdown += `\n\n---\n> **Note:** This page contains ${crossOrigin.count} cross-origin iframe(s) that could not be accessed due to browser security policies. Some content may be missing. Links to these iframes have been preserved where possible.\n`;
        ctx.logger.log('Added iframe warning', { count: crossOrigin.count });
      }

      const unloaded = iframeWarnings.find(w => w.type === 'unloadedIframe');
      if (unloaded) {
        markdown += `\n\n---\n> **Note:** This page was captured from its server-rendered HTML, so the content of ${unloaded.count} embedded frame(s) was never loaded and is not included. Links to those frames have been preserved where possible.\n`;
        ctx.logger.log('Added unloaded-iframe warning', { count: unloaded.count });
      }

      // Notes the caller could only work out on the live page (the scroll pass)
      // land here, before the metadata block, so the metadata stays last.
      (options.appendNotes || []).forEach(note => {
        markdown += note;
      });

      return {
        markdown: postProcessMarkdown(markdown, settings, articleData, ctx),
        articleData,
        textLength,
        warnings: iframeWarnings
      };
    } catch (error) {
      ctx.logger.error('Conversion failed', error);
      console.error('Turndown conversion error:', error);

      if (contentSize > TRUNCATE_BYTES) {
        const simplifiedContent = doc.createElement('div');
        simplifiedContent.innerHTML = content.innerHTML.substring(0, TRUNCATE_BYTES);
        return {
          markdown: turndownService.turndown(simplifiedContent) +
            '\n\n---\n*Note: Content was truncated due to size limitations.*',
          articleData,
          textLength,
          warnings: iframeWarnings
        };
      }

      throw error;
    }
  }

  // Parse fetched HTML and convert it, in one call — this is what the offscreen
  // document (Chrome) and the MV2 background page (Firefox) run.
  function convertHtml(options) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(options.html, 'text/html');
    applyBaseUrl(doc, options.url);

    const docTitle = (doc.title || '').trim();
    const title = docTitle || options.title || options.url;
    const probe = inspectDocument(doc);

    const converted = convertDocument({
      doc,
      url: options.url,
      title,
      settings: options.settings,
      live: false,
      logger: options.logger
    });

    return {
      markdown: converted.markdown,
      articleData: converted.articleData,
      title,
      textLength: converted.textLength,
      bodyTextLength: probe.bodyTextLength,
      emptyAppShell: probe.emptyAppShell,
      tokenCount: estimateTokens(converted.markdown)
    };
  }

  return {
    convertDocument,
    convertHtml,
    configureTurndownService,
    postProcessMarkdown,
    formatMetadata,
    estimateTokens,
    inspectDocument,
    applyBaseUrl
  };
})();

if (typeof window !== 'undefined') {
  window.ScrapLLMConvert = ScrapLLMConvert;
} else if (typeof self !== 'undefined') {
  self.ScrapLLMConvert = ScrapLLMConvert;
}
