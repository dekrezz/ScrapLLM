// ScrapLLM Discord Extractor
// Renders an open channel as a transcript: author, timestamp, message, and the
// message a reply points at.
//
// Read entirely from the rendered page. Discord's own API would be faster and
// would reach the whole history, but calling it needs the user's account token,
// which Discord treats as self-botting and bans for — so the extension takes
// what is on screen and scrolls for more, exactly as a person would.
//
// The message list is virtualised: nodes above and below the viewport are
// destroyed, so a single pass sees a few dozen messages at most. Older history
// is loaded by scrolling the list's own container upward — the window itself
// does not scroll.
const ScrapLLMDiscord = (function () {
  'use strict';

  const DEFAULT_MAX_MESSAGES = 200;
  const MAX_SCROLL_STEPS = 60;
  const SCROLL_STEP_DELAY = 320;   // ms; below this Discord has not painted yet
  const IDLE_SCROLL_TOLERANCE = 3; // passes that add nothing before giving up
  const TIME_BUDGET = 45000;       // ms

  const CHANNEL_PATH_RE = /^\/channels\/(@me|\d+)\/(\d+)/;

  let logger = { log() {}, error() {} };

  // ==========================================================================
  // PAGE DETECTION
  // ==========================================================================

  function isDiscordHost(hostname) {
    return /(^|\.)discord\.com$/i.test(hostname || '');
  }

  // Returns 'channel' or null (null = let the generic pipeline handle it)
  function getPageType(location) {
    const loc = location || window.location;
    if (!isDiscordHost(loc.hostname)) return null;
    return CHANNEL_PATH_RE.test(loc.pathname || '/') ? 'channel' : null;
  }

  function isDiscordPage(location) {
    return getPageType(location) !== null;
  }

  // ==========================================================================
  // DOM READING
  // ==========================================================================

  // Discord's class names are hashed and change between builds, so nothing here
  // depends on them. The id prefixes (`chat-messages-`, `message-content-`)
  // are part of how the app addresses its own nodes and have been stable for
  // years; class lookups appear only as a fallback.
  function messageNodes() {
    return Array.from(document.querySelectorAll('li[id^="chat-messages-"], li[id^="chat-messages_"]'));
  }

  function scrollerFor(node) {
    let current = node && node.parentElement;
    while (current) {
      const style = getComputedStyle(current);
      if (/(auto|scroll)/.test(style.overflowY) && current.scrollHeight > current.clientHeight + 20) {
        return current;
      }
      current = current.parentElement;
    }
    return null;
  }

  function textOf(node) {
    return node ? node.textContent.replace(/\s+\n/g, '\n').trim() : '';
  }

  function readAuthor(node) {
    const byId = node.querySelector('[id^="message-username-"]');
    const named = (byId && byId.querySelector('[class*="username"]')) ||
                  byId ||
                  node.querySelector('[class*="username"]');
    return textOf(named);
  }

  function readTimestamp(node) {
    const time = node.querySelector('time[datetime]');
    if (!time) return '';
    const value = new Date(time.getAttribute('datetime'));
    return Number.isNaN(value.getTime())
      ? textOf(time)
      : value.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  }

  // The line above a message that says which message it answers. Discord
  // renders it as a separate node, not as part of the body.
  function readReplyContext(node) {
    const context = node.querySelector('[id^="message-reply-context-"]');
    if (!context) return '';
    // Discord puts the quoted author and the quoted text in adjacent nodes with
    // no whitespace between them, so reading textContent off the container
    // yields "aliceHas anyone shipped...". The parts are read separately and
    // the author is kept apart from what they said.
    const parts = Array.from(context.childNodes)
      .map(child => child.textContent.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    if (!parts.length) return '';
    const author = parts[0];
    const quoted = parts.slice(1).join(' ').trim();
    const text = quoted ? `${author}: ${quoted}` : author;
    return text.length > 160 ? text.slice(0, 160) + '…' : text;
  }

  function readAttachments(node) {
    const links = new Set();
    node.querySelectorAll('a[href*="cdn.discordapp.com"], a[href*="media.discordapp.net"]')
      .forEach(a => links.add(a.getAttribute('href')));
    node.querySelectorAll('[class*="attachment"] a[href], [class*="embed"] a[href]')
      .forEach(a => {
        const href = a.getAttribute('href');
        if (href && /^https?:/i.test(href)) links.add(href);
      });
    return Array.from(links).slice(0, 6);
  }

  function readMessage(node) {
    const content = node.querySelector('[id^="message-content-"]');
    return {
      id: node.id,
      author: readAuthor(node),
      timestamp: readTimestamp(node),
      reply: readReplyContext(node),
      text: textOf(content),
      attachments: readAttachments(node),
      // Position in the list, so a harvest that ran across several scroll
      // passes can be put back into conversation order.
      top: node.getBoundingClientRect().top
    };
  }

  // ==========================================================================
  // COLLECTION
  // ==========================================================================

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function resolveMaxMessages(settings) {
    const raw = settings && settings.discordMaxMessages;
    if (raw === 'all') return Infinity;
    const num = Number(raw);
    return Number.isFinite(num) && num > 0 ? num : DEFAULT_MAX_MESSAGES;
  }

  async function collectMessages(settings) {
    const limit = resolveMaxMessages(settings);
    const deadline = Date.now() + TIME_BUDGET;
    const byId = new Map();

    const nodes = messageNodes();
    if (!nodes.length) return { messages: [], truncated: false, scrolled: false };

    const scroller = scrollerFor(nodes[0]);
    const startScroll = scroller ? scroller.scrollTop : 0;

    const harvest = () => {
      let added = 0;
      for (const node of messageNodes()) {
        if (byId.has(node.id)) continue;
        const message = readMessage(node);
        if (!message.text && !message.attachments.length) continue;
        byId.set(node.id, message);
        added += 1;
      }
      return added;
    };

    harvest();

    let idlePasses = 0;
    let truncated = false;
    let scrolled = false;

    // Upward: the newest messages are already on screen, and everything older
    // is what has to be fetched.
    if (scroller) {
      for (let step = 0; step < MAX_SCROLL_STEPS; step += 1) {
        if (byId.size >= limit) { truncated = true; break; }
        if (Date.now() > deadline) { truncated = true; break; }
        if (scroller.scrollTop <= 0) break;

        scroller.scrollTop = Math.max(0, scroller.scrollTop - scroller.clientHeight * 0.85);
        scrolled = true;
        await sleep(SCROLL_STEP_DELAY);

        const added = harvest();
        idlePasses = added === 0 ? idlePasses + 1 : 0;
        if (idlePasses >= IDLE_SCROLL_TOLERANCE) break;
      }
      scroller.scrollTop = startScroll;
    }

    // Oldest first. Nodes collected on later passes sat higher in the list, and
    // the ids are snowflakes, so sorting by id restores the true order without
    // depending on where each node happened to be when it was read.
    const messages = Array.from(byId.values()).sort((a, b) => {
      const left = /(\d{6,})$/.exec(a.id);
      const right = /(\d{6,})$/.exec(b.id);
      if (left && right) return left[1].localeCompare(right[1], 'en', { numeric: true });
      return 0;
    });

    return {
      messages: messages.slice(Math.max(0, messages.length - limit)),
      truncated: truncated || messages.length > limit,
      scrolled
    };
  }

  // ==========================================================================
  // RENDERING
  // ==========================================================================

  function channelName() {
    const heading = document.querySelector('h1[class*="title"], [class*="titleWrapper"] h1, header h1');
    const text = heading ? heading.textContent.trim() : '';
    if (text) return text;
    // "#general | My Server - Discord"
    const title = (document.title || '').replace(/\s*-\s*Discord$/, '').trim();
    return title || 'Discord channel';
  }

  function demoteHeadings(text) {
    return String(text || '').replace(/^(#{1,6})(\s)/gm, '\\$1$2');
  }

  function renderMessage(message, previousAuthor) {
    const lines = [];
    // Discord hides the author on consecutive messages from the same person;
    // the transcript restores it, because a model reading this has no avatar
    // column to infer it from.
    const author = message.author || previousAuthor || '[unknown]';
    const meta = [author, message.timestamp].filter(Boolean).join(' · ');
    lines.push(`**${meta}**`);
    if (message.reply) lines.push(`> replying to ${message.reply}`);
    lines.push('');
    lines.push(demoteHeadings(message.text) || '_[no text]_');
    if (message.attachments.length) {
      lines.push('');
      lines.push(...message.attachments.map(url => `- Attachment: ${url}`));
    }
    return { block: lines.join('\n'), author };
  }

  async function convert(settings, deps) {
    const options = settings || {};
    logger = (deps && deps.logger) || logger;

    if (!isDiscordPage(window.location)) throw new Error('Not a Discord channel page');

    const { messages, truncated, scrolled } = await collectMessages(options);
    logger.log('Discord messages collected', { count: messages.length, truncated, scrolled });

    // An empty channel, a server list with nothing open, or a view that never
    // rendered a message: hand it back rather than emitting a bare heading.
    if (!messages.length) return null;

    const name = channelName();
    const header = [
      `# ${name}`,
      '',
      `**Source:** Discord`,
      `**Channel:** ${window.location.href}`,
      `**Messages:** ${messages.length}${truncated ? ' (most recent)' : ''}`
    ].join('\n');

    const blocks = [];
    let previousAuthor = '';
    for (const message of messages) {
      const rendered = renderMessage(message, previousAuthor);
      previousAuthor = rendered.author;
      blocks.push(rendered.block);
    }

    const sections = [header, '## Transcript', blocks.join('\n\n')];
    const notes = [];
    if (truncated) {
      notes.push(`Only the most recent ${messages.length} messages were included (limit set in ScrapLLM settings).`);
    }
    notes.push('Read from the rendered channel, so history older than what loading reached is not here.');
    sections.push(`---\n> **Note:** ${notes.join(' ')}`);

    return {
      markdown: sections.join('\n\n'),
      articleData: {
        title: name,
        author: messages[0].author || '',
        siteName: 'Discord',
        publishedTime: messages[0].timestamp || '',
        excerpt: (messages[messages.length - 1].text || '').slice(0, 300)
      }
    };
  }

  return {
    isDiscordPage,
    getPageType,
    convert,
    // Exposed for tests
    _internals: {
      readMessage,
      renderMessage,
      channelName,
      resolveMaxMessages,
      messageNodes,
      CHANNEL_PATH_RE
    }
  };
})();

if (typeof window !== 'undefined') {
  window.ScrapLLMDiscord = ScrapLLMDiscord;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ScrapLLMDiscord;
}
