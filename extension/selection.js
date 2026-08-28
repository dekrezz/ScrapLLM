// ScrapLLM Selection
// Turns a highlighted fragment into a citable excerpt: where it came from,
// which lines it covers, and whether it is prose or code.
//
// The generic selection path just dumps the highlighted nodes through Turndown.
// That loses the two things that make a pasted fragment usable as LLM context:
// the source it belongs to, and the fact that a block of code is code (an
// unfenced snippet gets re-flowed and mangled by every model that reads it).
var ScrapLLMSelection = typeof ScrapLLMSelection !== 'undefined' ? ScrapLLMSelection : (function () {
  'use strict';

  // Elements that mean "this is a code region" regardless of what the text
  // looks like. Highlighters differ, so match on the common families.
  const CODE_CONTAINER_SELECTOR = [
    'pre',
    'code',
    'samp',
    '.highlight',
    '.codehilite',
    '.code-block',
    '[class*="language-"]',
    '[class*="hljs"]',
    '[class*="prism"]',
    '[data-lang]',
    '[data-language]'
  ].join(', ');

  // Blocks we treat as one "line" when counting prose. HTML has no line
  // numbers, so a paragraph (or list item, heading, row) is the closest honest
  // unit a reader can point at.
  const PROSE_LINE_SELECTOR = 'p, li, h1, h2, h3, h4, h5, h6, blockquote, tr, dt, dd, figcaption';

  const LANGUAGE_CLASS_RE = /(?:^|\s)(?:language|lang|highlight|brush:|sourceCode)[-:]?([a-z0-9+#]+)/i;
  const KNOWN_LANGUAGES = new Set([
    'js', 'javascript', 'ts', 'typescript', 'jsx', 'tsx', 'json', 'yaml', 'yml',
    'python', 'py', 'ruby', 'rb', 'go', 'rust', 'rs', 'java', 'kotlin', 'swift',
    'c', 'cpp', 'csharp', 'cs', 'php', 'sql', 'bash', 'sh', 'shell', 'zsh',
    'html', 'xml', 'css', 'scss', 'diff', 'toml', 'ini', 'dockerfile', 'graphql',
    'markdown', 'md', 'text', 'plaintext'
  ]);

  let logger = { log() {}, error() {} };

  // ==========================================================================
  // SELECTION GEOMETRY
  // ==========================================================================

  function getRange() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    if (!range || range.collapsed || selection.toString().trim() === '') return null;
    return range;
  }

  function closestElement(node) {
    if (!node) return null;
    return node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  }

  function findCodeContainer(range) {
    const anchor = closestElement(range.commonAncestorContainer);
    if (!anchor) return null;
    const container = anchor.closest(CODE_CONTAINER_SELECTOR);
    if (!container) return null;
    // A lone <code> inside running text is an inline mention, not a block.
    if (container.tagName === 'CODE' && !container.closest('pre')) {
      const text = container.textContent || '';
      if (!text.includes('\n') && text.length < 120) return null;
    }
    return container.closest('pre') || container;
  }

  // Count the newlines between the start of `container` and `boundary`.
  function offsetLineIn(container, boundaryNode, boundaryOffset) {
    const probe = document.createRange();
    probe.selectNodeContents(container);
    try {
      probe.setEnd(boundaryNode, boundaryOffset);
    } catch (error) {
      return 0;
    }
    return probe.toString().split('\n').length;
  }

  // Prose has no lines, so index the block elements instead: "line 12" means
  // the twelfth paragraph-like block of the article.
  function proseBlockIndex(container, node) {
    const blocks = Array.from(container.querySelectorAll(PROSE_LINE_SELECTOR));
    if (!blocks.length) return null;
    const element = closestElement(node);
    if (!element) return null;
    const own = element.closest(PROSE_LINE_SELECTOR);
    if (!own) return null;
    const index = blocks.indexOf(own);
    return index === -1 ? null : index + 1;
  }

  function findProseContainer(range) {
    const anchor = closestElement(range.commonAncestorContainer);
    if (!anchor) return document.body;
    return anchor.closest('article, main, [role="main"], .content, #content') || document.body;
  }

  // ==========================================================================
  // CLASSIFICATION
  // ==========================================================================

  // Structure first (a highlighter's own markup is authoritative), then shape
  // of the text — indentation, statement punctuation, declaration keywords.
  function looksLikeCode(text) {
    const lines = text.split('\n').filter(line => line.trim() !== '');
    if (!lines.length) return false;

    const indented = lines.filter(line => /^[ \t]{2,}\S/.test(line)).length;
    const terminated = lines.filter(line => /[;{}]\s*$/.test(line)).length;
    const declarations = lines.filter(line =>
      /^\s*(?:def|class|function|const|let|var|import|from|package|public|private|func|fn|type|struct|interface|return|if|for|while|switch|case|else|elif|try|catch|except|async|await|#include|using|SELECT|INSERT|UPDATE|CREATE)\b/i.test(line)
    ).length;
    const operators = (text.match(/(?:=>|->|::|!==|===|\+=|\|\||&&|=\s*\()/g) || []).length;
    const bracketed = lines.filter(line => /[[\]{}()]/.test(line)).length;

    const ratio = (count) => count / lines.length;
    let score = 0;
    if (ratio(indented) > 0.3) score += 2;
    if (ratio(terminated) > 0.25) score += 2;
    if (ratio(declarations) > 0.25) score += 2;
    if (ratio(bracketed) > 0.5) score += 1;
    if (operators >= 2) score += 1;
    // Prose gives itself away: long sentences that end in a full stop.
    const sentences = lines.filter(line => /[a-z][.!?]$/.test(line.trim())).length;
    if (ratio(sentences) > 0.4) score -= 2;

    return score >= 3;
  }

  function isKnownLanguage(value) {
    return KNOWN_LANGUAGES.has(String(value).toLowerCase().replace(/\d+$/, ''));
  }

  function detectLanguageFromDom(container) {
    let node = container;
    for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
      const explicit = node.getAttribute && (node.getAttribute('data-lang') || node.getAttribute('data-language'));
      if (explicit && isKnownLanguage(explicit)) return normalizeLanguage(explicit);
      const className = typeof node.className === 'string' ? node.className : '';
      const match = className.match(LANGUAGE_CLASS_RE);
      if (match && isKnownLanguage(match[1])) return normalizeLanguage(match[1]);
      const child = node.querySelector && node.querySelector('code[class]');
      if (child) {
        const childMatch = (child.className || '').match(LANGUAGE_CLASS_RE);
        if (childMatch && isKnownLanguage(childMatch[1])) return normalizeLanguage(childMatch[1]);
      }
    }
    return '';
  }

  // Only guess when the signal is unambiguous — a wrong fence label is worse
  // than none, because it makes a reader trust the wrong syntax.
  function guessLanguage(text) {
    if (/^\s*[{[][\s\S]*[}\]]\s*$/.test(text) && /"[^"]+"\s*:/.test(text)) return 'json';
    if (/^\s*(?:def|class)\s+\w+|^\s*from\s+\w+\s+import\b|^\s*import\s+\w+$/m.test(text)) return 'python';
    // Python without a declaration in view: colon-terminated blocks plus the
    // keywords no other common language spells this way.
    if (/^\s*(?:if|elif|else|for|while|with|try|except)\b.*:\s*$/m.test(text) &&
        /\b(?:elif|print\(|None|True|False)\b/.test(text)) return 'python';
    if (/\b(?:const|let|function)\b[\s\S]*=>|\bconsole\.log\(/.test(text)) return 'javascript';
    if (/^\s*(?:func|package)\s+\w+/m.test(text) && /\bfmt\./.test(text)) return 'go';
    if (/^\s*(?:fn|impl|pub fn)\s+\w+/m.test(text)) return 'rust';
    if (/^\s*(?:SELECT|INSERT INTO|UPDATE|DELETE FROM|CREATE TABLE)\b/im.test(text)) return 'sql';
    if (/^\s*(?:#!\/bin\/(?:ba)?sh|\$ )/m.test(text)) return 'bash';
    if (/^\s*<\w+[\s>]/m.test(text) && /<\/\w+>/.test(text)) return 'html';
    return '';
  }

  function normalizeLanguage(language) {
    const map = { js: 'javascript', ts: 'typescript', py: 'python', rb: 'ruby', rs: 'rust', sh: 'bash', shell: 'bash', zsh: 'bash', yml: 'yaml', md: 'markdown', cs: 'csharp', text: '', plaintext: '' };
    // Sphinx and friends version their classes (`highlight-python3`,
    // `language-js2`); the fence wants the family, not the dialect number.
    const key = String(language).toLowerCase().replace(/\d+$/, '');
    return map[key] !== undefined ? map[key] : key;
  }

  // ==========================================================================
  // INSPECTION (used by the popup to decide whether to offer the button)
  // ==========================================================================

  function inspect() {
    const range = getRange();
    if (!range) return { hasSelection: false };

    const text = String(window.getSelection());
    const codeContainer = findCodeContainer(range);
    const isCode = !!codeContainer || looksLikeCode(text);
    const lines = describeLines(range, codeContainer, isCode);

    return {
      hasSelection: true,
      characters: text.length,
      lineCount: text.split('\n').filter(line => line.trim() !== '').length,
      isCode,
      language: isCode ? (detectLanguageFromDom(codeContainer || closestElement(range.commonAncestorContainer)) || guessLanguage(text)) : '',
      startLine: lines.start,
      endLine: lines.end
    };
  }

  function describeLines(range, codeContainer, isCode) {
    if (isCode && codeContainer) {
      return {
        start: offsetLineIn(codeContainer, range.startContainer, range.startOffset),
        end: offsetLineIn(codeContainer, range.endContainer, range.endOffset)
      };
    }
    const proseContainer = findProseContainer(range);
    const start = proseBlockIndex(proseContainer, range.startContainer);
    const end = proseBlockIndex(proseContainer, range.endContainer);
    if (start === null || end === null) {
      // No block structure to count against (plain text node, table cell soup):
      // fall back to the selection's own line span.
      const own = String(window.getSelection()).split('\n').length;
      return { start: 1, end: own };
    }
    return { start, end: Math.max(start, end) };
  }

  // ==========================================================================
  // CONVERSION
  // ==========================================================================

  function sourceLabel() {
    const { hostname, pathname } = window.location;
    const path = pathname && pathname !== '/' ? pathname.replace(/\/$/, '') : '';
    return hostname + path;
  }

  function buildHeader(startLine, endLine, isCode) {
    const range = startLine === endLine
      ? `Line ${startLine}`
      : `Lines ${startLine} to ${endLine}`;
    const kind = isCode ? 'code' : 'text';
    return `> ${range} of ${kind} from [${sourceLabel()}](${window.location.href})`;
  }

  // Dedent a code selection: a fragment copied out of the middle of an indented
  // block keeps its original leading whitespace, which reads as broken code.
  function dedent(text) {
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    const indents = lines
      .filter(line => line.trim() !== '')
      .map(line => (line.match(/^[ \t]*/) || [''])[0].length);
    const common = indents.length ? Math.min(...indents) : 0;
    return common > 0 ? lines.map(line => line.slice(common)).join('\n') : lines.join('\n');
  }

  // A fence has to be longer than any backtick run inside the snippet.
  function fenceFor(text) {
    const runs = text.match(/`{3,}/g) || [];
    const longest = runs.reduce((max, run) => Math.max(max, run.length), 2);
    return '`'.repeat(longest + 1);
  }

  // Returns { markdown, articleData } or null when nothing is selected.
  function convert(settings, deps) {
    logger = (deps && deps.logger) || logger;
    const range = getRange();
    if (!range) return null;

    const rawText = String(window.getSelection());
    const codeContainer = findCodeContainer(range);
    const isCode = !!codeContainer || looksLikeCode(rawText);
    const { start, end } = describeLines(range, codeContainer, isCode);
    const header = buildHeader(start, end, isCode);

    let body;
    if (isCode) {
      // Take the text as-is: Turndown would escape the punctuation that makes
      // code legible, and syntax highlighting adds spans we don't want.
      const code = dedent(rawText).replace(/\s+$/, '');
      const language = detectLanguageFromDom(codeContainer || closestElement(range.commonAncestorContainer)) || guessLanguage(code);
      const fence = fenceFor(code);
      body = `${fence}${language}\n${code}\n${fence}`;
      logger.log('Selection converted as code', { language, lines: end - start + 1 });
    } else {
      const container = document.createElement('div');
      container.appendChild(range.cloneContents());
      const createTurndown = deps && deps.createTurndown;
      body = createTurndown
        ? createTurndown().turndown(container).trim()
        : (container.textContent || '').trim();
      logger.log('Selection converted as prose', { blocks: end - start + 1 });
    }

    if (!body) return null;

    return {
      markdown: `${header}\n\n${body}`,
      articleData: {
        title: document.title,
        author: '',
        siteName: window.location.hostname,
        publishedTime: '',
        excerpt: rawText.slice(0, 300)
      }
    };
  }

  return {
    inspect,
    convert,
    // Exposed for tests
    _internals: { looksLikeCode, guessLanguage, dedent, fenceFor, buildHeader, describeLines }
  };
})();

if (typeof window !== 'undefined') {
  window.ScrapLLMSelection = ScrapLLMSelection;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ScrapLLMSelection;
}
