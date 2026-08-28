// ScrapLLM Telegram Extractor
// Renders the open Telegram Web conversation as a transcript: a channel, a
// group, one forum topic, or a private chat.
//
// Read from the rendered page. Telegram has no REST API for a user's own
// account — the clients speak MTProto over a websocket with the user's auth
// key, and reaching for that key would be account theft in all but name. What
// is on screen is what a person can copy, so that is what this copies, with the
// list scrolled for history.
//
// The four kinds of conversation are genuinely different documents and are
// detected apart:
//
//   channel   #-100…            no authors, has view counts and comment links
//   group     #-100…            an author per message, grouped when consecutive
//   topic     #-100…_<topicId>  a group filtered to one forum topic
//   private   #<positive id>    no authors at all; only "own" separates sides
const ScrapLLMTelegram = (function () {
  'use strict';

  const DEFAULT_MAX_MESSAGES = 200;
  const MAX_SCROLL_STEPS = 80;
  const SCROLL_STEP_DELAY = 300;   // ms; Telegram renders the next page in ~200
  const IDLE_SCROLL_TOLERANCE = 3;
  const TIME_BUDGET = 60000;       // ms

  let logger = { log() {}, error() {} };

  // ==========================================================================
  // PAGE DETECTION
  // ==========================================================================

  function isTelegramHost(hostname) {
    return /(^|\.)web\.telegram\.org$/i.test(hostname || '');
  }

  function chatStatusText() {
    const status = document.querySelector('.ChatInfo .status, #MiddleColumn .status');
    return status ? status.textContent.trim() : '';
  }

  // The hash is "#<peerId>" or "#<peerId>_<topicId>". Channels and groups are
  // negative, a private chat is positive — Telegram's own peer-id convention.
  function parseHash(location) {
    const loc = location || window.location;
    const match = /^#(-?\d+)(?:_(\d+))?/.exec(loc.hash || '');
    if (!match) return null;
    return { peerId: match[1], topicId: match[2] || null };
  }

  // The document title is "Chat" or "Chat › Topic"; the part after the chevron
  // is the only place the open topic's name is written.
  function topicNameFromTitle() {
    const parts = (document.title || '').split('›');
    return parts.length > 1 ? parts[parts.length - 1].trim() : '';
  }

  function chatTitle() {
    const el = document.querySelector('.ChatInfo .title, #MiddleColumn .ChatInfo .title');
    return el ? el.textContent.trim() : (document.title || '').split('›')[0].trim();
  }

  // Returns { kind, title, topicName, label } or null when this is not a
  // conversation we can render (chat list open, settings, no chat selected).
  function detect(location) {
    const loc = location || window.location;
    if (!isTelegramHost(loc.hostname)) return null;

    const hash = parseHash(loc);
    if (!hash) return null;
    if (!document.querySelector('.MessageList')) return null;

    const status = chatStatusText();
    const title = chatTitle();
    const topicName = hash.topicId ? topicNameFromTitle() : '';

    let kind;
    if (hash.topicId) kind = 'topic';
    else if (/subscriber|подписчи/i.test(status)) kind = 'channel';
    else if (/member|участник/i.test(status)) kind = 'group';
    else kind = 'private';

    return {
      kind,
      title,
      topicName,
      peerId: hash.peerId,
      topicId: hash.topicId,
      // What the button says, so the popup does not have to know the rules.
      label: kind === 'topic' && topicName ? topicName : title,
      isTelegram: true
    };
  }

  function isTelegramPage(location) {
    return detect(location) !== null;
  }

  // ==========================================================================
  // DATES
  // ==========================================================================

  const MONTHS = {
    january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6,
    august: 7, september: 8, october: 9, november: 10, december: 11,
    jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8,
    oct: 9, nov: 10, dec: 11,
    января: 0, февраля: 1, марта: 2, апреля: 3, мая: 4, июня: 5, июля: 6,
    августа: 7, сентября: 8, октября: 9, ноября: 10, декабря: 11
  };

  // Telegram writes date separators for people, not machines: "Today",
  // "Yesterday", "August 5", "5 August", "August 5, 2025". There is no
  // timestamp anywhere in the DOM to fall back on, so these are parsed. An
  // unparsed separator returns null and the messages under it are never
  // silently dropped by a date filter — they are kept and reported.
  function parseSeparatorDate(text, now) {
    const raw = String(text || '').trim();
    if (!raw) return null;
    const today = new Date(now || Date.now());
    today.setHours(0, 0, 0, 0);

    if (/^(today|сегодня)$/i.test(raw)) return today;
    if (/^(yesterday|вчера)$/i.test(raw)) {
      const d = new Date(today);
      d.setDate(d.getDate() - 1);
      return d;
    }

    const cleaned = raw.replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
    const monthFirst = /^([A-Za-zА-Яа-я]+)\s+(\d{1,2})(?:\s+(\d{4}))?$/.exec(cleaned);
    const dayFirst = /^(\d{1,2})\s+([A-Za-zА-Яа-я]+)(?:\s+(\d{4}))?$/.exec(cleaned);

    let monthName, day, year;
    if (monthFirst) {
      [, monthName, day, year] = monthFirst;
    } else if (dayFirst) {
      [, day, monthName, year] = dayFirst;
    } else {
      return null;
    }

    const month = MONTHS[String(monthName).toLowerCase()];
    if (month === undefined) return null;

    const parsed = new Date(Number(year || today.getFullYear()), month, Number(day));
    parsed.setHours(0, 0, 0, 0);
    // Without a year, a separator from December read in January would land in
    // the future; the only sane reading is the previous year.
    if (!year && parsed > today) parsed.setFullYear(parsed.getFullYear() - 1);
    return parsed;
  }

  // The date inputs hand over "YYYY-MM-DD", which `new Date()` reads as UTC
  // midnight — west of Greenwich that is the previous day locally, so a range
  // starting on the 5th would quietly begin on the 4th. Separator dates are
  // built in local time, so the bounds are too.
  function startOfDay(value) {
    if (!value) return null;
    const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value).trim());
    const d = parts
      ? new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]))
      : new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    d.setHours(0, 0, 0, 0);
    return d;
  }

  // ==========================================================================
  // DOM READING
  // ==========================================================================

  // Everything below keys off Telegram's semantic class names rather than its
  // hashed ones (`.DbUwzy9t`), which change with every build.
  function messageNodes() {
    return Array.from(document.querySelectorAll('.Message.message-list-item'))
      // Sponsored posts are ads Telegram injects into the message list itself.
      // They are a separate component, so they are dropped by name.
      .filter(node => !node.classList.contains('SponsoredMessage'));
  }

  function scrollerElement() {
    return document.querySelector('.MessageList.custom-scroll') ||
           document.querySelector('.MessageList');
  }

  // The meta block (views, time, edited marker) lives *inside* .text-content,
  // so reading textContent straight off it appends "3.4K17:59" to the message.
  // Telegram flags it for exactly this reason.
  function strippedClone(root) {
    if (!root) return null;
    const copy = root.cloneNode(true);
    copy.querySelectorAll('[data-ignore-on-paste], .MessageMeta, .Reactions, .message-action-buttons-container')
      .forEach(node => node.remove());
    return copy;
  }

  function readableText(root) {
    const copy = strippedClone(root);
    if (!copy) return '';
    return copy.textContent.replace(/ /g, ' ').replace(/[ \t]+\n/g, '\n').trim();
  }

  // Message bodies are rich: Telegram links a word to a URL, bolds, italicises,
  // fences code and hides spoilers, and none of that survives textContent — a
  // linked word arrives as a bare word with its destination gone. So the body
  // goes through Turndown, the converter the rest of the extension already
  // uses, and falls back to plain text only if that throws.
  function readableMarkdown(root, createTurndown) {
    const copy = strippedClone(root);
    if (!copy) return '';
    if (typeof createTurndown !== 'function') return readableText(root);
    try {
      const markdown = createTurndown().turndown(copy.innerHTML);
      return String(markdown || '').replace(/\n{3,}/g, '\n\n').trim() || readableText(root);
    } catch (error) {
      logger.error('Telegram markdown conversion failed', error);
      return readableText(root);
    }
  }

  function dateForMessage(node, now) {
    const group = node.closest('.message-date-group');
    const separator = group && group.querySelector('.sticky-date');
    const text = separator ? separator.textContent.trim() : '';
    return { text, date: parseSeparatorDate(text, now) };
  }

  // A message with no text still carries meaning; naming the medium is more
  // useful to a model than an empty line.
  function describeMedia(node) {
    const kinds = [];
    if (node.querySelector('.Sticker, [class*="Sticker"]')) kinds.push('sticker');
    if (node.querySelector('video, .Video, .message-media-duration')) kinds.push('video');
    if (node.querySelector('img.full-media, .Photo')) kinds.push('photo');
    if (node.querySelector('.Voice, [class*="Voice"]')) kinds.push('voice message');
    if (node.querySelector('.Audio, [class*="Audio"]')) kinds.push('audio');
    if (node.querySelector('.File, .document-name, [class*="Document"]')) kinds.push('file');
    if (node.querySelector('.Poll, [class*="Poll"]')) kinds.push('poll');
    const name = node.querySelector('.file-title, .document-name');
    if (name && name.textContent.trim()) kinds.push(`"${name.textContent.trim()}"`);
    return kinds.length ? `[${kinds.join(', ')}]` : '';
  }

  function readMessage(node, kind, chatName, now, createTurndown) {
    const own = node.classList.contains('own');
    const senderEl = node.querySelector('.message-title-name, .sender-title');
    // The forward container is always present and usually empty; only its text
    // means the message was actually forwarded.
    const forwardEl = node.querySelector('.forward-title-container');
    const forwarded = forwardEl ? forwardEl.textContent.trim() : '';

    const embedded = node.querySelector('.EmbeddedMessage');
    const reply = embedded
      ? {
          sender: readableText(embedded.querySelector('.sender-title, .message-title')),
          text: readableText(embedded.querySelector('.embedded-text-wrapper')) ||
                readableText(embedded)
        }
      : null;

    const views = node.querySelector('.message-views');
    // The visible count is rounded ("3.4K"); the exact one is in the tooltip.
    const viewsTitle = views ? (views.getAttribute('title') || '') : '';
    const exactViews = /Views:\s*([\d,\s]+)/i.exec(viewsTitle);

    const { text: dateText, date } = dateForMessage(node, now);

    return {
      id: node.getAttribute('data-message-id') || node.id,
      own,
      sender: senderEl ? senderEl.textContent.trim() : '',
      forwarded,
      reply,
      text: readableMarkdown(node.querySelector('.text-content'), createTurndown),
      media: describeMedia(node),
      time: (node.querySelector('.message-time') || {}).textContent || '',
      views: exactViews ? exactViews[1].replace(/\s/g, '') : (views ? views.textContent.trim() : ''),
      comments: (node.querySelector('.CommentButton, [class*="CommentButton"]') || {}).textContent || '',
      reactions: readableText(node.querySelector('.Reactions')),
      dateText,
      date
    };
  }

  // ==========================================================================
  // COLLECTION
  // ==========================================================================

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function resolveMaxMessages(settings) {
    const raw = settings && settings.telegramMaxMessages;
    if (raw === 'all') return Infinity;
    const num = Number(raw);
    return Number.isFinite(num) && num > 0 ? num : DEFAULT_MAX_MESSAGES;
  }

  function messageOrder(a, b) {
    const left = Number(String(a.id).replace(/\D/g, ''));
    const right = Number(String(b.id).replace(/\D/g, ''));
    if (Number.isFinite(left) && Number.isFinite(right)) return left - right;
    return 0;
  }

  async function collect(info, settings, createTurndown) {
    const limit = resolveMaxMessages(settings);
    const from = startOfDay(settings && settings.telegramDateFrom);
    const to = startOfDay(settings && settings.telegramDateTo);
    const now = Date.now();
    const deadline = Date.now() + TIME_BUDGET;

    const scroller = scrollerElement();
    const startScroll = scroller ? scroller.scrollTop : 0;
    const byId = new Map();
    let reachedBefore = false;   // scrolled past the start of the range
    let undatedKept = 0;

    const harvest = () => {
      let added = 0;
      for (const node of messageNodes()) {
        const id = node.getAttribute('data-message-id') || node.id;
        if (!id || byId.has(id)) continue;
        const message = readMessage(node, info.kind, info.title, now, createTurndown);
        if (!message.text && !message.media && !message.reply) continue;

        if (from || to) {
          if (!message.date) {
            // A separator we could not read is not a reason to lose a message.
            undatedKept += 1;
          } else {
            if (from && message.date < from) { reachedBefore = true; continue; }
            if (to && message.date > to) continue;
          }
        }
        byId.set(id, message);
        added += 1;
      }
      return added;
    };

    harvest();

    let idlePasses = 0;
    let truncated = false;

    if (scroller) {
      for (let step = 0; step < MAX_SCROLL_STEPS; step += 1) {
        if (byId.size >= limit) { truncated = true; break; }
        if (Date.now() > deadline) { truncated = true; break; }
        // Once the oldest rendered message is older than the range, there is
        // nothing further up worth loading.
        if (reachedBefore && from) break;
        if (scroller.scrollTop <= 0) break;

        scroller.scrollTop = Math.max(0, scroller.scrollTop - scroller.clientHeight * 0.85);
        await sleep(SCROLL_STEP_DELAY);
        const added = harvest();
        idlePasses = added === 0 ? idlePasses + 1 : 0;
        if (idlePasses >= IDLE_SCROLL_TOLERANCE) break;
      }
      scroller.scrollTop = startScroll;
    }

    const all = Array.from(byId.values()).sort(messageOrder);
    // The ceiling counts from the newest, because that is the end of a
    // conversation people mean by "the last N".
    const messages = all.length > limit ? all.slice(all.length - limit) : all;
    return { messages, truncated: truncated || all.length > limit, undatedKept };
  }

  // ==========================================================================
  // RENDERING
  // ==========================================================================

  function demoteHeadings(text) {
    return String(text || '').replace(/^(#{1,6})(\s)/gm, '\\$1$2');
  }

  function joinMeta(parts) {
    return parts.filter(p => p !== undefined && p !== null && p !== '').join(' · ');
  }

  // Who a message is from depends on the kind of conversation, and getting it
  // wrong is worse than saying nothing: a channel post has no author, a private
  // chat names only two people, and a group hides the name on consecutive
  // messages from the same person.
  function authorFor(message, info, previousAuthor) {
    if (info.kind === 'channel') {
      return message.forwarded ? `${info.title} (forwarded from ${message.forwarded})` : info.title;
    }
    if (info.kind === 'private') {
      return message.own ? 'You' : info.title;
    }
    if (message.own) return 'You';
    return message.sender || previousAuthor || '[unknown]';
  }

  function renderMessage(message, info, previousAuthor) {
    const author = authorFor(message, info, previousAuthor);
    const meta = joinMeta([
      author,
      message.dateText && message.time ? `${message.dateText} ${message.time}` : message.time,
      message.views ? `${message.views} views` : '',
      message.forwarded && info.kind !== 'channel' ? `forwarded from ${message.forwarded}` : '',
      message.comments ? message.comments.trim() : ''
    ]);

    const lines = [`**${meta}**`];
    if (message.reply && (message.reply.sender || message.reply.text)) {
      const quoted = [message.reply.sender, message.reply.text].filter(Boolean).join(': ');
      lines.push(`> replying to ${quoted.slice(0, 160)}${quoted.length > 160 ? '…' : ''}`);
    }
    lines.push('');
    const body = [demoteHeadings(message.text), message.media].filter(Boolean).join('\n\n');
    lines.push(body || '_[no text]_');
    if (message.reactions) lines.push(`\nReactions: ${message.reactions}`);
    return { block: lines.join('\n'), author };
  }

  function kindLabel(info) {
    if (info.kind === 'topic') return `${info.title} › ${info.topicName || 'topic'}`;
    return info.title;
  }

  async function convert(settings, deps) {
    const options = settings || {};
    logger = (deps && deps.logger) || logger;

    const info = detect(window.location);
    if (!info) throw new Error('No Telegram conversation is open');

    const createTurndown = deps && deps.createTurndown;
    const { messages, truncated, undatedKept } = await collect(info, options, createTurndown);
    logger.log('Telegram messages collected', {
      kind: info.kind, count: messages.length, truncated, undatedKept
    });
    if (!messages.length) return null;

    const header = [
      `# ${kindLabel(info)}`,
      '',
      '**Source:** Telegram',
      `**Kind:** ${info.kind === 'private' ? 'private chat' : info.kind}`,
      `**Messages:** ${messages.length}${truncated ? ' (most recent)' : ''}`,
      `**Link:** ${window.location.href}`
    ];
    const status = chatStatusText();
    if (status && info.kind !== 'private') header.splice(4, 0, `**Chat:** ${status}`);

    const blocks = [];
    let previousAuthor = '';
    for (const message of messages) {
      const rendered = renderMessage(message, info, previousAuthor);
      previousAuthor = rendered.author;
      blocks.push(rendered.block);
    }

    const notes = [];
    if (truncated) {
      notes.push(`Only the most recent ${messages.length} messages were included (limit set in ScrapLLM).`);
    }
    if (undatedKept) {
      notes.push(`${undatedKept} message${undatedKept === 1 ? '' : 's'} sat under a date separator this build could not parse and were kept rather than filtered out.`);
    }
    notes.push('Read from the rendered conversation, so history older than what loading reached is not here.');

    const sections = [
      header.join('\n'),
      '## Transcript',
      blocks.join('\n\n'),
      `---\n> **Note:** ${notes.join(' ')}`
    ];

    return {
      markdown: sections.join('\n\n'),
      articleData: {
        title: kindLabel(info),
        author: info.kind === 'channel' ? info.title : '',
        siteName: 'Telegram',
        publishedTime: messages[0].dateText || '',
        excerpt: (messages[messages.length - 1].text || '').slice(0, 300)
      }
    };
  }

  return {
    isTelegramPage,
    detect,
    convert,
    // Exposed for tests
    _internals: {
      parseSeparatorDate,
      parseHash,
      readableText,
      readMessage,
      renderMessage,
      authorFor,
      resolveMaxMessages,
      describeMedia,
      messageNodes
    }
  };
})();

if (typeof window !== 'undefined') {
  window.ScrapLLMTelegram = ScrapLLMTelegram;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ScrapLLMTelegram;
}
