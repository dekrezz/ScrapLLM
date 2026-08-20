// ScrapLLM Chat
// Copies an LLM conversation — the whole thread or just the last N exchanges,
// where one exchange is a user turn plus the assistant's reply.
//
// Two extraction paths, in this order:
//
// 1. The site's own conversation API, when it has one (claude.ai, chatgpt.com).
//    A chat is a *tree*, not a list: editing a message mid-thread grows a
//    second branch and leaves the old one behind in the database. The UI shows
//    a single root→leaf path, so we walk parents up from the active leaf and
//    export exactly what the user sees. Scraping the DOM cannot know this, and
//    virtualised transcripts drop everything off-screen anyway.
//
// 2. The rendered DOM, for everything else — Gemini, Grok, Perplexity,
//    DeepSeek, Copilot, Cursor, and self-hosted front-ends on localhost
//    (Open WebUI, LibreChat, LobeChat, AnythingLLM, Jan…). Known layouts are
//    matched first; unknown ones fall back to a role-detection heuristic, so a
//    front-end nobody has heard of still works if it labels its turns at all.
const ScrapLLMChat = (function () {
  'use strict';

  const ROOT_PARENT = '00000000-0000-4000-8000-000000000000';
  const API_TIMEOUT = 12000;

  // Attributes and class fragments front-ends use to mark who is speaking.
  // Ordered by how explicit they are: an author-role attribute is a statement,
  // a class containing "user" is a hint.
  const ROLE_ATTRIBUTES = [
    'data-message-author-role',
    'data-message-role',
    'data-author-role',
    'data-role',
    'data-testid-role'
  ];

  const USER_HINTS = /(?:^|[-_ ])(?:user|human|you|me|query|prompt|request)(?:$|[-_ ])/i;
  const ASSISTANT_HINTS = /(?:^|[-_ ])(?:assistant|assistent|bot|ai|model|response|answer|reply|agent|gpt|claude|gemini|grok)(?:$|[-_ ])/i;

  let logger = { log() {}, error() {} };

  // ==========================================================================
  // SITE REGISTRY
  // ==========================================================================

  const SITES = [
    {
      id: 'claude',
      label: 'Claude',
      host: /(^|\.)claude\.ai$/i,
      thread: /^\/chat\/([0-9a-f-]{36})/i,
      api: fetchClaudeConversation
    },
    {
      id: 'chatgpt',
      label: 'ChatGPT',
      host: /(^|\.)(?:chatgpt\.com|chat\.openai\.com)$/i,
      thread: /^\/(?:c|g\/[^/]+\/c|share)\/([0-9a-zA-Z-]{16,})/i,
      api: fetchChatGptConversation,
      dom: { turn: 'article[data-testid^="conversation-turn"], [data-message-author-role]' }
    },
    {
      id: 'google-ai',
      label: 'Google AI Mode',
      // google.com, google.co.uk, google.de… all serve it from /search, and the
      // udm parameter is what separates the AI conversation from a plain result
      // page on the very same path.
      host: /(^|\.)google\.[a-z]{2,3}(?:\.[a-z]{2})?$/i,
      thread: /^\/search/i,
      query: (search) => new URLSearchParams(search).get('udm') === '50',
      extract: extractGoogleAiMode
    },
    {
      id: 'gemini',
      label: 'Gemini',
      host: /(^|\.)gemini\.google\.com$/i,
      thread: /^\/(?:app|share)\//i,
      dom: { user: 'user-query, .user-query-container', assistant: 'model-response, message-content.model-response-text' }
    },
    {
      id: 'grok',
      label: 'Grok',
      host: /(^|\.)(?:grok\.com|x\.ai)$/i,
      thread: /^\/(?:chat|c|share)\//i
    },
    {
      id: 'perplexity',
      label: 'Perplexity',
      host: /(^|\.)perplexity\.ai$/i,
      thread: /^\/(?:search|page)\//i
    },
    {
      id: 'deepseek',
      label: 'DeepSeek',
      host: /(^|\.)(?:deepseek\.com|chat\.deepseek\.com)$/i,
      thread: /^\/a\/chat\//i
    },
    {
      id: 'copilot',
      label: 'Copilot',
      host: /(^|\.)copilot\.microsoft\.com$/i,
      thread: /^\/(?:chats?|c)\//i
    },
    {
      id: 'mistral',
      label: 'Le Chat',
      host: /(^|\.)chat\.mistral\.ai$/i,
      thread: /^\/chat\//i
    },
    {
      id: 'cursor',
      label: 'Cursor',
      host: /(^|\.)cursor\.(?:com|sh)$/i,
      thread: /^\/(?:agents?|chat|dashboard)/i
    },
    {
      id: 'openwebui',
      label: 'Local chat',
      // Self-hosted front-ends sit on a loopback port (Open WebUI 8080,
      // LibreChat 3080, LobeChat 3210, Jan 1337, …). The port is not a
      // reliable identifier, so any local origin is a candidate and the DOM
      // decides whether there is a conversation on it.
      host: /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|.*\.local)$/i,
      thread: /.*/
    }
  ];

  function getSite(location) {
    const loc = location || window.location;
    return SITES.find(site => site.host.test(loc.hostname)) || null;
  }

  function isThreadUrl(site, location) {
    const loc = location || window.location;
    if (site.thread && !site.thread.test(loc.pathname)) return false;
    // Some surfaces live on a path they share with something else entirely and
    // are told apart by the query string.
    if (site.query && !site.query(loc.search || '')) return false;
    return true;
  }

  // ==========================================================================
  // CONVERSATION APIS
  // ==========================================================================

  async function fetchJson(url, options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), API_TIMEOUT);
    try {
      const response = await fetch(url, Object.assign({
        credentials: 'include',
        headers: { Accept: 'application/json' },
        signal: controller.signal
      }, options || {}));
      if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
      const type = response.headers.get('content-type') || '';
      if (!type.includes('json')) throw new Error(`Expected JSON, got "${type || 'unknown'}"`);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  // Walk parents from the active leaf back to the root. Anything the user
  // edited away hangs off a sibling branch and is correctly skipped.
  function walkActiveBranch(byId, leafId, parentOf) {
    const chain = [];
    const seen = new Set();
    let id = leafId;
    while (id && byId.has(id) && !seen.has(id)) {
      seen.add(id);
      const node = byId.get(id);
      chain.push(node);
      id = parentOf(node);
    }
    return chain.reverse();
  }

  async function fetchClaudeConversation(location) {
    const conversationId = location.pathname.split('/').pop();
    const orgs = await fetchJson('/api/organizations');
    if (!Array.isArray(orgs) || !orgs.length) throw new Error('No Claude organization on this session');
    const orgId = orgs[0].uuid;
    const data = await fetchJson(
      `/api/organizations/${orgId}/chat_conversations/${conversationId}?tree=True&rendering_mode=raw`
    );

    const all = data.chat_messages || [];
    if (!all.length) return null;
    const byId = new Map(all.map(m => [m.uuid, m]));

    let leafId = data.current_leaf_message_uuid;
    if (!leafId || !byId.has(leafId)) {
      // Older payloads omit the pointer; the newest message is the leaf.
      leafId = all.slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0].uuid;
    }

    const chain = walkActiveBranch(byId, leafId, (m) => (m.parent_message_uuid === ROOT_PARENT ? null : m.parent_message_uuid));
    logger.log('Claude conversation fetched', { total: all.length, active: chain.length });

    return {
      title: data.name || conversationId,
      messages: chain.map(m => ({
        role: m.sender === 'human' ? 'user' : 'assistant',
        text: claudeMessageText(m),
        time: m.created_at || ''
      })).filter(m => m.text)
    };
  }

  function claudeMessageText(message) {
    if (Array.isArray(message.content) && message.content.length) {
      return message.content.map(block => {
        if (block.type === 'text') return block.text || '';
        if (block.type === 'thinking') return `> [thinking]\n> ${String(block.thinking || '').replace(/\n/g, '\n> ')}`;
        if (block.type === 'tool_use') return `\`\`\`json\n${JSON.stringify(block.input, null, 2)}\n\`\`\``;
        if (block.type === 'tool_result') return `\`\`\`\n${typeof block.content === 'string' ? block.content : JSON.stringify(block.content, null, 2)}\n\`\`\``;
        return '';
      }).filter(Boolean).join('\n\n').trim();
    }
    return String(message.text || '').trim();
  }

  async function fetchChatGptConversation(location) {
    const match = location.pathname.match(/([0-9a-zA-Z-]{16,})$/);
    if (!match) return null;
    const conversationId = match[1];

    // The backend wants the session's bearer token, not just the cookie.
    const session = await fetchJson('/api/auth/session');
    const token = session && session.accessToken;
    if (!token) throw new Error('No ChatGPT session token (signed out?)');

    const data = await fetchJson(`/backend-api/conversation/${conversationId}`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` }
    });

    const mapping = data.mapping || {};
    const byId = new Map(Object.entries(mapping));
    const leafId = data.current_node || [...byId.keys()].pop();
    const chain = walkActiveBranch(byId, leafId, (node) => node.parent);
    logger.log('ChatGPT conversation fetched', { total: byId.size, active: chain.length });

    const messages = chain.map(node => node.message).filter(Boolean).map(message => {
      const role = message.author && message.author.role;
      if (role !== 'user' && role !== 'assistant') return null; // system/tool noise
      const parts = (message.content && message.content.parts) || [];
      const text = parts
        .map(part => (typeof part === 'string' ? part : (part && part.text) || ''))
        .join('\n\n')
        .trim();
      if (!text) return null;
      return {
        role,
        text,
        time: message.create_time ? new Date(message.create_time * 1000).toISOString() : ''
      };
    }).filter(Boolean);

    return { title: data.title || conversationId, messages };
  }

  // ==========================================================================
  // DOM EXTRACTION
  // ==========================================================================

  function roleFromAttributes(element) {
    for (const attribute of ROLE_ATTRIBUTES) {
      const value = element.getAttribute && element.getAttribute(attribute);
      if (!value) continue;
      const normalized = value.toLowerCase();
      if (/user|human/.test(normalized)) return 'user';
      if (/assistant|model|bot|ai/.test(normalized)) return 'assistant';
    }
    return null;
  }

  function roleFromHints(element) {
    const haystack = [
      element.tagName.toLowerCase(),
      typeof element.className === 'string' ? element.className : '',
      element.getAttribute('data-testid') || '',
      element.getAttribute('aria-label') || ''
    ].join(' ');
    if (USER_HINTS.test(haystack)) return 'user';
    if (ASSISTANT_HINTS.test(haystack)) return 'assistant';
    return null;
  }

  // Collect candidate turn elements, deepest-first so nested wrappers don't
  // swallow their own children.
  function collectTurns() {
    const attributeSelector = ROLE_ATTRIBUTES.map(a => `[${a}]`).join(', ');
    let nodes = Array.from(document.querySelectorAll(attributeSelector));

    if (nodes.length < 2) {
      nodes = Array.from(document.querySelectorAll(
        'article[data-testid*="turn"], [data-testid*="message"], user-query, model-response, ' +
        '[class*="message-row"], [class*="chat-message"], [class*="message-bubble"], ' +
        '[class*="user-message"], [class*="assistant-message"], [class*="ChatMessage"], ' +
        // Self-hosted front-ends often label nothing but the bubble itself.
        '[class*="chat-bubble"], [class*="chatBubble"], [class*="message-item"], [class*="messageItem"]'
      ));
    }

    if (nodes.length < 2) {
      // Last resort for unknown UIs: repeated sibling bubbles under one parent.
      // Requiring several of them keeps articles and comment lists out.
      const generic = Array.from(document.querySelectorAll('[class*="bubble"], [class*="msg"], [class*="turn"]'));
      if (generic.length >= 4) nodes = generic;
    }

    // Drop anything that is an ancestor of another candidate: we want leaves.
    return nodes.filter(node => !nodes.some(other => other !== node && node.contains(other)));
  }

  function extractFromDom(site, createTurndown) {
    const turns = collectTurns();
    if (turns.length < 2) return null;

    const messages = [];
    turns.forEach((turn, index) => {
      const role = roleFromAttributes(turn) ||
                   roleFromHints(turn) ||
                   // Nothing labelled: chats alternate, and the first turn is
                   // the user's. Better than dropping the transcript.
                   (index % 2 === 0 ? 'user' : 'assistant');
      const text = turnToMarkdown(turn, createTurndown);
      if (text) messages.push({ role, text, time: turnTimestamp(turn) });
    });

    if (messages.length < 2) return null;
    logger.log('Chat extracted from DOM', { site: site ? site.id : 'generic', turns: messages.length });
    return { title: document.title.replace(/\s*[|·—-]\s*(?:ChatGPT|Claude|Gemini|Grok|Perplexity|DeepSeek|Copilot).*$/i, '').trim(), messages };
  }

  function turnToMarkdown(turn, createTurndown) {
    const clone = turn.cloneNode(true);
    // Action rails ("Copy", "Regenerate", "Good response") are chrome, not
    // conversation, and they end up inline in the text otherwise.
    clone.querySelectorAll('button, [role="button"], svg, script, style, [aria-hidden="true"]').forEach(node => node.remove());
    if (createTurndown) {
      try {
        return createTurndown().turndown(clone.innerHTML).trim();
      } catch (error) {
        logger.error('Turndown failed on a chat turn', error);
      }
    }
    return (clone.textContent || '').trim();
  }

  function turnTimestamp(turn) {
    const time = turn.querySelector('time[datetime]');
    if (time) return time.getAttribute('datetime');
    const attribute = turn.getAttribute('data-timestamp') || turn.getAttribute('data-time');
    return attribute || '';
  }

  // Google's AI Mode is a conversation that does not look like one in the DOM:
  // there are no author-role attributes, no per-turn elements, and the class
  // names are build hashes that change without notice. Two things are stable —
  // the question is in the URL's q parameter, and the answer is Google's own
  // result column, data-container-id="main-col", which has been that for years.
  //
  // Signed out, the surface allows exactly one exchange. Signed in it allows
  // more, and each answer is appended to the same column; the follow-up
  // questions are rendered as headings whose text Google localises, so they are
  // read from the transcript rather than matched by a phrase.
  function extractGoogleAiMode(createTurndown) {
    const main = document.querySelector('[data-container-id="main-col"]');
    if (!main) return null;

    const query = new URLSearchParams(window.location.search).get('q') || '';
    const answer = googleAnswerMarkdown(main, createTurndown);
    if (!answer) return null;

    const messages = [];
    if (query.trim()) messages.push({ role: 'user', text: query.trim(), time: '' });
    messages.push({ role: 'assistant', text: answer, time: '' });

    logger.log('Google AI Mode captured', { question: query.length, answer: answer.length });

    return {
      title: query.trim() || document.title,
      messages
    };
  }

  // Google closes the answer column with its own furniture: a one-line "AI can
  // make mistakes" disclaimer, and after a thumbs-down a short feedback panel.
  // Both are localised — the disclaimer arrives in whatever language the IP
  // suggests — so they are recognised by shape rather than by phrase: a short
  // trailing block with no links, list, heading, table or code in it.
  //
  // The limits are deliberate. 120 characters keeps a real closing paragraph
  // (the answer's own "tell me more about X and I can be specific" runs well
  // past 200), and stopping after three blocks means a mistake trims a line or
  // two, never the answer.
  // Known remainder, measured rather than assumed: on a signed-out AI Mode page
  // two one-line notices survive this pass — the "AI can make mistakes"
  // disclaimer and one "a copy of this chat will be included" label. They sit
  // among the answer's own nodes rather than after them, so removing them by
  // position would mean guessing at the answer's last paragraph. About 90
  // characters out of 3,900; the panels that used to add 500 are gone.
  const FURNITURE_MAX_CHARS = 120;
  // Generous, because what is left after the panels are gone is a run of
  // one-line labels — a disclaimer, three copies of one notice, a thank-you —
  // and each is its own block. The 120-character rule is what protects the
  // answer, not this count.
  const FURNITURE_MAX_BLOCKS = 14;

  // The share row and the feedback panel are identified by where their links
  // point. Every string in them is translated; these hosts are not.
  const SHARE_AND_FEEDBACK_LINKS = [
    'a[href*="policies.google.com"]',
    'a[href*="support.google.com/legal"]',
    'a[href*="facebook.com/sharer"]',
    'a[href*="twitter.com/intent"]',
    'a[href*="x.com/intent"]',
    'a[href*="reddit.com/submit"]',
    'a[href*="api.whatsapp.com"]',
    'a[href*="wa.me"]',
    'a[href*="mail.google.com"]'
  ].join(', ');

  function isFurniture(element) {
    const text = (element.textContent || '').trim();
    if (!text || text.length > FURNITURE_MAX_CHARS) return false;
    return !element.querySelector('a, ul, ol, h1, h2, h3, h4, table, pre, code, img');
  }

  function trimGoogleFurniture(root) {
    // Walk the tail of the document rather than one branch of it: the closing
    // labels are not siblings of the answer, they are the last elements that
    // carry text, wherever they happen to hang.
    for (let removed = 0; removed < FURNITURE_MAX_BLOCKS; removed++) {
      const blocks = Array.from(root.querySelectorAll('*'))
        .filter(el => ownTextLength(el) > 0);
      const last = blocks[blocks.length - 1];
      if (!last) break;
      // Climb to the outermost element that still says only this much: the
      // label usually sits in two or three nested wrappers of its own.
      let block = last;
      while (block.parentElement && block.parentElement !== root &&
             (block.parentElement.textContent || '').trim() === (block.textContent || '').trim()) {
        block = block.parentElement;
      }
      if (!isFurniture(block)) break;
      block.remove();
    }
  }

  function ownTextLength(element) {
    let length = 0;
    for (let i = 0; i < element.childNodes.length; i++) {
      const child = element.childNodes[i];
      if (child.nodeType === 3) length += (child.nodeValue || '').trim().length;
    }
    return length;
  }

  function googleAnswerMarkdown(main, createTurndown) {
    const clone = main.cloneNode(true);
    // Feedback rails, "show more" affordances and the sources carousel are
    // chrome around the answer, not the answer.
    // The feedback panel first, while it is still recognisable. It is a block of
    // controls closing with Google's own policy links, and those URLs are the
    // one part of it that is never translated — unlike every string in it.
    clone.querySelectorAll(SHARE_AND_FEEDBACK_LINKS)
      .forEach(link => {
        const panel = link.closest('div');
        if (panel && panel !== clone) panel.remove();
      });

    // Share sheets and feedback prompts are dialogs, and ARIA roles are the one
    // part of Google's markup that is neither hashed nor translated.
    clone.querySelectorAll('[role="dialog"], [role="alertdialog"], [aria-modal="true"], [role="menu"], [role="tooltip"], [role="alert"], [role="status"]')
      .forEach(node => node.remove());

    clone.querySelectorAll('button, [role="button"], [role="navigation"], [role="listbox"], svg, style, script')
      .forEach(node => node.remove());

    // The action rail under the answer — copy, share, good response, bad
    // response, and the acknowledgement that replaces them — is built from
    // tooltips the page hides from assistive technology. Google says they are
    // not content; taking it at its word costs nothing, because the answer
    // itself is never hidden from a screen reader.
    clone.querySelectorAll('[aria-hidden="true"]').forEach(node => node.remove());
    // Google hangs a citation chip on the end of most sentences. The chip is an
    // icon, so the link has no text of its own and Turndown writes an empty
    // link — "[](https://…)" — into the middle of the prose. The citation is
    // worth nothing without its label, and the sentence reads worse with it.
    clone.querySelectorAll('a').forEach(link => {
      if (!(link.textContent || '').trim()) link.remove();
    });
    trimGoogleFurniture(clone);
    if (createTurndown) {
      try {
        return createTurndown().turndown(clone.innerHTML).trim();
      } catch (error) {
        logger.error('Turndown failed on the AI Mode answer', error);
      }
    }
    return (clone.textContent || '').trim();
  }

  // ==========================================================================
  // EXCHANGES
  // ==========================================================================

  // One exchange = a user turn plus everything the assistant said in reply.
  // Leading assistant turns (a greeting before the first prompt) form their own
  // group so nothing silently disappears.
  function groupExchanges(messages) {
    const groups = [];
    let current = null;
    messages.forEach(message => {
      if (message.role === 'user') {
        current = { messages: [message] };
        groups.push(current);
      } else if (current) {
        current.messages.push(message);
      } else {
        groups.push({ messages: [message] });
        current = null;
      }
    });
    return groups;
  }

  function resolveLimit(settings) {
    const raw = settings && settings.chatExchangeLimit;
    if (raw === 'all' || raw === 0) return Infinity;
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : Infinity;
  }

  // ==========================================================================
  // RENDERING
  // ==========================================================================

  function formatTime(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  }

  function render(conversation, site, settings) {
    const groups = groupExchanges(conversation.messages);
    const limit = resolveLimit(settings);
    const kept = limit === Infinity ? groups : groups.slice(-limit);
    const messages = kept.reduce((all, group) => all.concat(group.messages), []);
    if (!messages.length) return null;

    // A local front-end has no brand name; the origin is the honest label.
    const label = (site && site.label) || window.location.hostname || 'Chat';
    const header = [
      `# ${conversation.title || 'Conversation'}`,
      '',
      `**Source:** ${label} — ${window.location.href}`,
      `**Exchanges:** ${kept.length} of ${groups.length}${limit === Infinity ? '' : ` (last ${Math.min(limit, groups.length)})`}`,
      `**Messages:** ${messages.length}`,
      `**Exported:** ${formatTime(new Date().toISOString())}`
    ].join('\n');

    // Each turn is its own block with an index, a role and a time, so a model
    // reading the transcript can tell them apart and quote them.
    const body = messages.map((message, index) => {
      const number = String(index + 1).padStart(2, '0');
      const role = message.role === 'user' ? 'User' : 'Assistant';
      const time = formatTime(message.time);
      return `### [${number}] ${role}${time ? ` · ${time}` : ''}\n\n${message.text}`;
    }).join('\n\n---\n\n');

    return {
      markdown: `${header}\n\n---\n\n${body}`,
      articleData: {
        title: conversation.title || document.title,
        author: '',
        siteName: label,
        publishedTime: '',
        excerpt: (messages[0].text || '').slice(0, 300)
      }
    };
  }

  // ==========================================================================
  // PUBLIC API
  // ==========================================================================

  // Cheap probe for the popup: is this page a conversation worth offering the
  // button for, and how many exchanges are in it.
  function inspect() {
    const site = getSite(window.location);
    const onThread = site ? isThreadUrl(site, window.location) : false;
    const turns = collectTurns();
    const labelled = turns.filter(turn => roleFromAttributes(turn) || roleFromHints(turn)).length;

    const exchanges = turns.length ? groupExchanges(
      turns.map((turn, index) => ({
        role: roleFromAttributes(turn) || roleFromHints(turn) || (index % 2 === 0 ? 'user' : 'assistant'),
        text: 'x'
      }))
    ).length : 0;

    // A known chat host on a thread URL is enough on its own. Anywhere else we
    // require the page to say who is speaking on most turns — otherwise a
    // comment thread or a forum would light the button up on a page that has
    // no conversation to copy.
    const knownChat = !!site && onThread && (!!site.api || !!site.extract || turns.length >= 2);
    const looksLikeChat = turns.length >= 4 && labelled >= Math.ceil(turns.length / 2);

    return {
      isChat: knownChat || looksLikeChat,
      site: site ? site.id : null,
      label: (site && site.label) || window.location.hostname,
      exchanges
    };
  }

  // Returns { markdown, articleData }, or null when this page holds no
  // conversation (caller falls back to the generic extractor).
  async function convert(settings, deps) {
    logger = (deps && deps.logger) || logger;
    const createTurndown = deps && deps.createTurndown;
    const site = getSite(window.location);

    if (site && site.api && isThreadUrl(site, window.location)) {
      try {
        const conversation = await site.api(window.location);
        if (conversation && conversation.messages.length) {
          return render(conversation, site, settings || {});
        }
      } catch (error) {
        // The API is the better source, not the only one: fall through to the
        // DOM rather than failing the copy outright.
        logger.error(`${site.label} API unavailable, using the rendered page`, error);
      }
    }

    // A site with its own extractor knows something the generic reader cannot
    // work out from the markup alone.
    if (site && site.extract && isThreadUrl(site, window.location)) {
      const captured = site.extract(createTurndown);
      if (captured && captured.messages.length) {
        return render(captured, site, settings || {});
      }
    }

    const scraped = extractFromDom(site, createTurndown);
    if (!scraped) return null;
    return render(scraped, site, settings || {});
  }

  return {
    getSite,
    inspect,
    convert,
    // Exposed for tests
    _internals: { groupExchanges, resolveLimit, walkActiveBranch, roleFromHints, collectTurns, render, SITES }
  };
})();

if (typeof window !== 'undefined') {
  window.ScrapLLMChat = ScrapLLMChat;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ScrapLLMChat;
}
