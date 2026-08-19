// ScrapLLM X (Twitter) Extractor
// Renders X threads (post + replies) and listings (profile, feed, search) as
// structured Markdown.
//
// Unlike Reddit there is no public JSON representation of a page that a
// content script can read, so the DOM is the only source. X ships two very
// different renderings of the same route:
//
//   1. The logged-out server-rendered page, which annotates every top-level
//      post with schema.org microdata (`article[data-tweet-id]` +
//      `meta[itemprop=...]`). Ids, timestamps, author and engagement counts
//      come straight from those meta tags, so they need no class-name guessing.
//      This layout was verified live against x.com while writing this module.
//   2. The logged-in React app, which uses the long-standing
//      `data-testid="tweet" | "tweetText" | "User-Name" | "tweetPhoto"` hooks
//      and `<time datetime>`. It could not be exercised from this environment
//      (no session available), so those selectors are used strictly as
//      per-field fallbacks: whatever the app layout still exposes is picked up,
//      and anything unreadable degrades to an empty field instead of failing.
//
// Every getter therefore reads "best available source first" rather than
// assuming one layout, and `convert()` returns null when a route holds no
// readable post so the caller can fall back to the generic pipeline.
const ScrapLLMX = (function () {
  'use strict';

  // /<handle>/status/<id> (also the legacy /statuses/ form)
  const POST_PATH_RE = /^\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d+)(?:\/|$)/i;
  // /<handle>, /<handle>/with_replies, /<handle>/media, /<handle>/highlights
  const PROFILE_PATH_RE = /^\/([A-Za-z0-9_]{1,15})(?:\/(with_replies|media|highlights|articles|superfollows))?\/?$/i;
  const HASHTAG_PATH_RE = /^\/hashtag\/[^/]+\/?$/i;
  const LIST_PATH_RE = /^\/i\/lists\/\d+\/?$/i;
  const FEED_PATHS = ['/', '/home', '/explore', '/search'];
  // First path segment values that are product surfaces, not accounts.
  const RESERVED_HANDLES = new Set([
    'home', 'explore', 'search', 'notifications', 'messages', 'settings', 'compose',
    'i', 'intent', 'login', 'logout', 'signup', 'account', 'privacy', 'tos', 'about',
    'jobs', 'download', 'share', 'hashtag', 'bookmarks', 'lists', 'topics', 'connect_people'
  ]);

  const DEFAULT_MAX_POSTS = 100;
  const THREAD_REPLY_SCROLL_LIMIT = 250; // replies we are willing to walk in a thread
  const LISTING_EXCERPT_LENGTH = 400;
  // Wall-clock ceiling for the whole collection pass. content.js grants X pages
  // the same SCROLL_TIMEOUT_HEADROOM it grants the lazy-loading pass, so this
  // must stay comfortably under that headroom or the popup gets a timeout
  // error while we are still scrolling.
  const COLLECT_TIME_BUDGET = 11000;
  const SCROLL_STEP_DELAY = 450; // ms to let the virtualised list render a page
  const MAX_SCROLL_STEPS = 40;
  // How many scrolls may yield nothing new before we accept we hit the end
  // (X routinely renders one empty frame while fetching the next page).
  const IDLE_SCROLL_TOLERANCE = 3;

  let logger = { log() {}, error() {} };

  // ==========================================================================
  // PAGE DETECTION
  // ==========================================================================

  function isXHost(hostname) {
    return /(^|\.)(x\.com|twitter\.com)$/i.test(hostname || '');
  }

  // Returns 'post', 'listing' or null (null = let the generic pipeline handle it)
  function getPageType(location) {
    const loc = location || window.location;
    if (!isXHost(loc.hostname)) return null;
    const path = (loc.pathname || '/').replace(/\/+$/, '') || '/';

    if (POST_PATH_RE.test(path)) return 'post';
    if (FEED_PATHS.includes(path.toLowerCase())) return 'listing';
    if (HASHTAG_PATH_RE.test(path) || LIST_PATH_RE.test(path)) return 'listing';

    const profile = path.match(PROFILE_PATH_RE);
    if (profile && !RESERVED_HANDLES.has(profile[1].toLowerCase())) return 'listing';

    // /i/flow/login, /messages, /settings/... - nothing post-shaped to render.
    return null;
  }

  function isXPage(location) {
    return getPageType(location) !== null;
  }

  function currentPostId(location) {
    const loc = location || window.location;
    const match = (loc.pathname || '').match(POST_PATH_RE);
    return match ? match[2] : null;
  }

  // ==========================================================================
  // FORMATTING HELPERS
  // ==========================================================================

  function formatNumber(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num.toLocaleString('en-US') : String(value || '');
  }

  function formatIsoTimestamp(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  }

  function normalizeBody(text) {
    return String(text || '')
      .replace(/\r\n?/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function indentBlock(text, indent) {
    return normalizeBody(text)
      .split('\n')
      .map(line => (line.trim() === '' ? '' : indent + line))
      .join('\n');
  }

  function joinMeta(parts) {
    return parts.filter(part => part !== undefined && part !== null && part !== '').join(' · ');
  }

  function truncate(text, maxLength) {
    const clean = normalizeBody(text).replace(/\n+/g, ' ');
    if (clean.length <= maxLength) return clean;
    return clean.slice(0, maxLength).replace(/\s+\S*$/, '') + '…';
  }

  function authorLabel(post) {
    if (!post) return '';
    if (post.handle && post.name) return `${post.name} (@${post.handle})`;
    if (post.handle) return `@${post.handle}`;
    return post.name || '[unknown author]';
  }

  // Prefers the absolute timestamp; the app and the reply lists often only
  // carry a relative label ("3h"), which is still better than nothing.
  function postDate(post) {
    return formatIsoTimestamp(post.isoDate) || post.timeLabel || '';
  }

  function metricsLine(metrics) {
    if (!metrics) return '';
    return joinMeta([
      metrics.replies !== null && metrics.replies !== undefined ? `${formatNumber(metrics.replies)} replies` : '',
      metrics.reposts !== null && metrics.reposts !== undefined ? `${formatNumber(metrics.reposts)} reposts` : '',
      metrics.likes !== null && metrics.likes !== undefined ? `${formatNumber(metrics.likes)} likes` : '',
      metrics.views !== null && metrics.views !== undefined ? `${formatNumber(metrics.views)} views` : ''
    ]);
  }

  // ==========================================================================
  // DOM READING
  // ==========================================================================

  // Nested articles (quoted posts) would otherwise answer every descendant
  // query on their host post.
  function ownNodes(article, selector) {
    return Array.from(article.querySelectorAll(selector))
      .filter(node => node.closest('article') === article);
  }

  function ownNode(article, selector) {
    return ownNodes(article, selector)[0] || null;
  }

  function metaContent(article, itemprop) {
    const node = article.querySelector(`:scope > meta[itemprop="${itemprop}"]`);
    return node ? node.getAttribute('content') : '';
  }

  function authorMeta(article, itemprop) {
    const author = article.querySelector(':scope > [itemprop="author"]');
    if (!author) return '';
    const node = author.querySelector(`meta[itemprop="${itemprop}"]`);
    return node ? node.getAttribute('content') : '';
  }

  // schema.org counters, keyed by their human name (Likes/Retweets/Replies/Views).
  function microdataStats(article) {
    const stats = {};
    Array.from(article.querySelectorAll(':scope > [itemprop="interactionStatistic"]')).forEach(node => {
      const name = node.querySelector('meta[itemprop="name"]');
      const count = node.querySelector('meta[itemprop="userInteractionCount"]');
      if (name && count) stats[name.getAttribute('content')] = Number(count.getAttribute('content'));
    });
    return stats;
  }

  function parseCompactCount(raw) {
    const text = String(raw || '').trim().replace(/,/g, '');
    if (!text) return null;
    const match = text.match(/^([\d.]+)\s*([KMB])?$/i);
    if (!match) return null;
    const scale = { k: 1e3, m: 1e6, b: 1e9 }[(match[2] || '').toLowerCase()] || 1;
    const value = parseFloat(match[1]);
    return Number.isFinite(value) ? Math.round(value * scale) : null;
  }

  // The logged-out layout renders each action as an icon button carrying the
  // aria-label plus a sibling button holding the count, so the count lives on
  // the shared parent rather than on the labelled node itself.
  function labelledButtonCount(article, label) {
    const button = ownNodes(article, `button[aria-label="${label}"]`)[0];
    if (!button || !button.parentElement) return null;
    return parseCompactCount(button.parentElement.innerText || button.parentElement.textContent);
  }

  // The React app puts every count into one aria-label on the action bar,
  // e.g. "12 replies, 40 reposts, 300 likes, 5000 views".
  function groupAriaCounts(article) {
    const group = ownNode(article, 'div[role="group"][aria-label]');
    if (!group) return {};
    const label = group.getAttribute('aria-label') || '';
    const counts = {};
    label.split(',').forEach(part => {
      const match = part.trim().match(/^([\d.,]+)\s+(\w+)/);
      if (match) counts[match[2].toLowerCase()] = parseCompactCount(match[1]);
    });
    return counts;
  }

  // The focused post of a thread renders its view count as a link ("7.4M Views")
  // instead of the labelled action button used everywhere else.
  function viewCountFromLink(article) {
    for (const node of ownNodes(article, 'a[href*="/status/"], button')) {
      const match = (node.innerText || node.textContent || '').trim().match(/^([\d.,]+\s*[KMB]?)\s*views$/i);
      if (match) {
        const count = parseCompactCount(match[1].replace(/\s+/g, ''));
        if (count !== null) return count;
      }
    }
    return null;
  }

  function readMetrics(article) {
    const stats = microdataStats(article);
    const aria = groupAriaCounts(article);
    const pick = (statName, label, ariaKeys) => {
      if (Number.isFinite(stats[statName])) return stats[statName];
      const fromButton = labelledButtonCount(article, label);
      if (fromButton !== null) return fromButton;
      for (const key of ariaKeys) {
        if (Number.isFinite(aria[key])) return aria[key];
      }
      return null;
    };
    return {
      replies: pick('Replies', 'Reply', ['replies', 'reply']),
      reposts: pick('Retweets', 'Repost', ['reposts', 'repost', 'retweets']),
      likes: pick('Likes', 'Like', ['likes', 'like']),
      views: pick('Views', 'View count', ['views']) ?? viewCountFromLink(article)
    };
  }

  function readPermalink(article, id) {
    const anchors = ownNodes(article, 'a[href*="/status/"]');
    const match = anchors.find(a => !id || (a.getAttribute('href') || '').includes(`/status/${id}`)) || anchors[0];
    return match || null;
  }

  function readText(article) {
    // The app marks the body explicitly; the logged-out layout renders it as
    // the single dir="auto" block that belongs to this post.
    const explicit = ownNode(article, 'div[data-testid="tweetText"]');
    const node = explicit || ownNodes(article, 'div[dir="auto"]').find(el => (el.innerText || el.textContent || '').trim());
    const rendered = node ? normalizeBody(node.innerText || node.textContent) : '';
    // Microdata text is the raw tweet (t.co links unexpanded); only useful when
    // nothing was rendered, e.g. a media-only post.
    return rendered || normalizeBody(metaContent(article, 'text'));
  }

  function readMedia(article) {
    const media = [];
    ownNodes(article, 'img[src*="pbs.twimg.com/media/"], div[data-testid="tweetPhoto"] img').forEach(img => {
      const src = img.getAttribute('src');
      if (src && !media.some(item => item.src === src)) media.push({ type: 'image', src, alt: img.getAttribute('alt') || '' });
    });
    ownNodes(article, 'video').forEach(video => {
      // The <video> src is a blob: URL that means nothing outside the page, so
      // the poster frame is the only durable reference we can emit.
      const poster = video.getAttribute('poster') || '';
      media.push({ type: 'video', src: poster, alt: 'video' });
    });
    return media;
  }

  function readHandleAndName(article, permalinkHref) {
    const fromPermalink = (permalinkHref || '').match(/^(?:https?:\/\/[^/]+)?\/([A-Za-z0-9_]{1,15})\/status/i);
    const handle = authorMeta(article, 'alternateName') || (fromPermalink ? fromPermalink[1] : '');

    let name = authorMeta(article, 'name');
    if (!name) {
      const userName = ownNode(article, 'div[data-testid="User-Name"]');
      if (userName) {
        name = normalizeBody((userName.innerText || '').split('\n')[0]);
      }
    }
    if (!name && handle) {
      // Logged-out layout: the display name and the @handle are two anchors
      // pointing at the same profile; the one without the @ is the name.
      // The avatar link points at the same profile with no text, so require a
      // label that is neither empty nor the @handle itself.
      const anchor = ownNodes(article, `a[href$="/${handle}"]`).find(a => {
        const label = (a.textContent || '').trim();
        return label && !label.startsWith('@');
      });
      if (anchor) name = normalizeBody(anchor.textContent);
    }
    return { handle, name };
  }

  function readQuoted(article) {
    const nested = Array.from(article.querySelectorAll('article[data-tweet-id]'))
      .find(node => node.parentElement && node.parentElement.closest('article') === article);
    if (nested) return readPost(nested);

    // React app: the quoted post is not an <article> but a link-role card.
    const card = ownNode(article, 'div[role="link"]');
    if (!card) return null;
    const text = normalizeBody((card.querySelector('div[data-testid="tweetText"]') || {}).innerText);
    if (!text) return null;
    const link = card.querySelector('a[href*="/status/"]');
    const href = link ? link.getAttribute('href') : '';
    const author = href.match(/\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/i);
    return {
      id: author ? author[2] : '',
      url: href ? new URL(href, location.origin).toString() : '',
      handle: author ? author[1] : '',
      name: '',
      isoDate: '',
      timeLabel: '',
      text,
      media: [],
      quoted: null,
      metrics: null,
      pinned: false
    };
  }

  function readPost(article) {
    const id = article.getAttribute('data-tweet-id') || metaContent(article, 'identifier') || '';
    const permalink = readPermalink(article, id);
    const href = permalink ? permalink.getAttribute('href') : '';
    const { handle, name } = readHandleAndName(article, href);
    const resolvedId = id || ((href || '').match(/\/status\/(\d+)/) || [])[1] || '';
    const timeEl = ownNode(article, 'time[datetime]');

    return {
      id: resolvedId,
      url: metaContent(article, 'url') || (href ? new URL(href, location.origin).toString() : ''),
      handle,
      name,
      isoDate: metaContent(article, 'datePublished') || metaContent(article, 'dateCreated') ||
               (timeEl ? timeEl.getAttribute('datetime') : ''),
      // Relative label ("3h", "Aug 13") - the only date replies expose in the
      // logged-out layout.
      timeLabel: normalizeBody(permalink ? permalink.textContent : (timeEl ? timeEl.textContent : '')),
      text: readText(article),
      media: readMedia(article),
      quoted: readQuoted(article),
      metrics: readMetrics(article),
      pinned: /(^|\n)Pinned(\n|$)/.test(article.innerText || '')
    };
  }

  // ==========================================================================
  // COLLECTION (virtualised timeline)
  // ==========================================================================

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function topLevelArticles() {
    return Array.from(document.querySelectorAll('article[data-tweet-id], article[data-testid="tweet"]'))
      .filter(article => !article.parentElement || !article.parentElement.closest('article'));
  }

  // X keeps only the visible slice of a timeline in the DOM, so a single query
  // sees a handful of posts. Scroll in steps, harvesting whatever is mounted on
  // each pass and deduplicating by post id; DOM order within a pass is the
  // timeline order, so appending preserves it.
  async function collectPosts(limit, budgetMs) {
    const seen = new Set();
    const posts = [];
    const startScroll = window.scrollY;
    const deadline = Date.now() + budgetMs;
    let idlePasses = 0;
    let truncated = false;

    const harvest = () => {
      let added = 0;
      for (const article of topLevelArticles()) {
        const post = readPost(article);
        if (!post.id || seen.has(post.id)) continue;
        if (!post.text && !post.media.length && !post.quoted) continue;
        seen.add(post.id);
        posts.push(post);
        added += 1;
        if (posts.length >= limit) break;
      }
      return added;
    };

    harvest();

    for (let step = 0; step < MAX_SCROLL_STEPS; step += 1) {
      if (posts.length >= limit) { truncated = true; break; }
      if (Date.now() > deadline) { truncated = true; break; }

      const beforeScroll = window.scrollY;
      window.scrollTo(0, window.scrollY + window.innerHeight * 0.9);
      await sleep(SCROLL_STEP_DELAY);
      const added = harvest();
      const atBottom = window.scrollY === beforeScroll &&
                       window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;

      if (added === 0 && atBottom) break;
      idlePasses = added === 0 ? idlePasses + 1 : 0;
      if (idlePasses >= IDLE_SCROLL_TOLERANCE) break;
    }

    window.scrollTo(0, startScroll);
    return { posts, truncated: truncated || posts.length >= limit };
  }

  // ==========================================================================
  // RENDERING
  // ==========================================================================

  function renderMedia(media, settings, indent) {
    if (!media || !media.length) return '';
    if (settings.includeImages === false) {
      return indentBlock(`_${media.length} media attachment(s)._`, indent || '');
    }
    const lines = media.map(item => (item.type === 'video'
      ? `_Video_${item.src ? ` (poster: ${item.src})` : ''}`
      : `![${item.alt || 'image'}](${item.src})`));
    return indentBlock(lines.join('\n'), indent || '');
  }

  function renderQuoted(quoted, settings, indent) {
    if (!quoted) return '';
    const head = joinMeta([`**Quoting ${authorLabel(quoted)}**`, postDate(quoted), quoted.url]);
    const body = normalizeBody(quoted.text);
    const block = [head, body ? body.split('\n').map(line => (line ? `> ${line}` : '>')).join('\n') : '']
      .filter(Boolean).join('\n');
    const media = renderMedia(quoted.media, settings, '');
    return indentBlock([block, media].filter(Boolean).join('\n'), indent || '');
  }

  function renderPostBody(post, settings, indent) {
    const blocks = [];
    const text = normalizeBody(post.text);
    if (text) blocks.push(indentBlock(text, indent || ''));
    const media = renderMedia(post.media, settings, indent);
    if (media) blocks.push(media);
    const quoted = renderQuoted(post.quoted, settings, indent);
    if (quoted) blocks.push(quoted);
    if (!blocks.length) blocks.push(indentBlock('_No readable post body._', indent || ''));
    return blocks.join('\n\n');
  }

  // A poster continuing their own thought posts a reply to themselves; X shows
  // it inline. Treat the unbroken run of same-author posts that directly
  // follows the root as part of the post, not as replies.
  function splitSelfThread(rootHandle, replies) {
    const continuation = [];
    let index = 0;
    while (index < replies.length && replies[index].handle &&
           replies[index].handle.toLowerCase() === String(rootHandle || '').toLowerCase()) {
      continuation.push(replies[index]);
      index += 1;
    }
    return { continuation, rest: replies.slice(index) };
  }

  function renderThread(collected, settings, postId) {
    const posts = collected.posts;
    const rootIndex = posts.findIndex(post => post.id === postId);
    if (rootIndex === -1) return null;

    const root = posts[rootIndex];
    // Posts rendered above the focused one are the conversation it answers.
    const ancestors = posts.slice(0, rootIndex);
    const below = posts.slice(rootIndex + 1);
    const { continuation, rest } = splitSelfThread(root.handle, below);
    const includeReplies = settings.xIncludeReplies !== false;

    const sections = [];
    const title = truncate(root.text, 100) || `Post by ${authorLabel(root)}`;
    sections.push([
      `# ${title}`,
      '',
      '**Source:** X (Twitter)',
      `**Author:** ${authorLabel(root)}${root.pinned ? ' [pinned]' : ''}`,
      `**Posted:** ${postDate(root)}`,
      `**Link:** ${root.url || window.location.href}`,
      metricsLine(root.metrics) ? `**Engagement:** ${metricsLine(root.metrics)}` : ''
    ].filter(Boolean).join('\n'));

    if (ancestors.length) {
      sections.push('## In reply to');
      ancestors.forEach(post => {
        sections.push(`- ${joinMeta([`**${authorLabel(post)}**`, postDate(post), post.url])}`);
        sections.push(renderPostBody(post, settings, '  '));
      });
    }

    sections.push('## Post');
    sections.push(renderPostBody(root, settings, ''));

    continuation.forEach((post, index) => {
      sections.push(`**Thread continued (${index + 2}/${continuation.length + 1})** — ${joinMeta([postDate(post), metricsLine(post.metrics)])}`);
      sections.push(renderPostBody(post, settings, ''));
    });

    if (includeReplies) {
      sections.push(`## Replies (${formatNumber(rest.length)}${root.metrics && root.metrics.replies !== null ? ` of ${formatNumber(root.metrics.replies)}` : ''})`);
      if (rest.length) {
        const lines = [];
        rest.forEach(post => {
          lines.push(`- ${joinMeta([`**${authorLabel(post)}**`, postDate(post), metricsLine(post.metrics), post.url])}`);
          lines.push(renderPostBody(post, settings, '  '));
          lines.push('');
        });
        sections.push(lines.join('\n').replace(/\n{3,}/g, '\n\n').trim());
      } else {
        sections.push('_No replies were rendered on the page._');
      }
    }

    const notes = [
      'Replies come from the rendered page; X loads them lazily and hides the rest behind "show more".'
    ];
    if (collected.truncated) notes.push('Collection stopped at the configured post limit or time budget.');
    // Microdata articles are only served to signed-out visitors, who get a
    // heavily trimmed reply list before the login wall.
    if (document.querySelector('article[itemscope]')) {
      notes.push('Signed-out view: X shows visitors only the first few replies before the login wall.');
    }
    sections.push(`---\n> **Note:** ${notes.join(' ')}`);

    logger.log('X thread rendered', {
      ancestors: ancestors.length,
      continuation: continuation.length,
      replies: rest.length,
      truncated: collected.truncated
    });

    return {
      markdown: sections.join('\n\n'),
      articleData: {
        title,
        author: authorLabel(root),
        siteName: 'X (Twitter)',
        publishedTime: postDate(root),
        excerpt: truncate(root.text, 300)
      }
    };
  }

  function renderListing(collected, settings) {
    const posts = collected.posts;
    if (!posts.length) return null;

    const heading = document.title ? document.title.replace(/\s*\/\s*X$/, '') : 'X timeline';
    const lines = [
      `# ${heading}`,
      '',
      '**Source:** X (Twitter) listing',
      `**URL:** ${window.location.href}`,
      `**Posts:** ${formatNumber(posts.length)}`,
      '',
      '## Posts',
      ''
    ];

    posts.forEach((post, index) => {
      lines.push(`${index + 1}. **${authorLabel(post)}**${post.pinned ? ' [pinned]' : ''}`);
      lines.push(`   ${joinMeta([postDate(post), metricsLine(post.metrics)])}`);
      if (post.url) lines.push(`   Link: ${post.url}`);
      const excerpt = truncate(post.text, LISTING_EXCERPT_LENGTH);
      if (excerpt) lines.push(`   > ${excerpt}`);
      if (post.quoted) {
        lines.push(`   > Quoting ${authorLabel(post.quoted)}: ${truncate(post.quoted.text, 200)}`);
      }
      if (post.media.length && settings.includeImages !== false) {
        post.media.forEach(item => lines.push(`   ${item.type === 'video' ? `Video poster: ${item.src}` : `Image: ${item.src}`}`));
      }
      lines.push('');
    });

    lines.push('---');
    lines.push('> **Note:** This is a timeline page collected by scrolling; open an individual post to capture its replies.');

    logger.log('X listing rendered', { posts: posts.length, truncated: collected.truncated });

    return {
      markdown: lines.join('\n'),
      articleData: {
        title: heading,
        author: posts[0].handle ? `@${posts[0].handle}` : '',
        siteName: 'X (Twitter)',
        publishedTime: '',
        excerpt: truncate(posts[0].text, 300)
      }
    };
  }

  // ==========================================================================
  // SETTINGS
  // ==========================================================================

  function resolveMaxPosts(settings) {
    const raw = settings && settings.xMaxPosts;
    if (raw === 'all' || raw === 0) return Number.MAX_SAFE_INTEGER;
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_POSTS;
  }

  // ==========================================================================
  // PUBLIC ENTRY POINT
  // ==========================================================================

  // Returns { markdown, articleData }, or null when the route is an X page with
  // nothing readable (empty feed, login wall, unknown markup) so the caller can
  // fall back to generic extraction.
  async function convert(settings, deps) {
    const options = settings || {};
    logger = (deps && deps.logger) || logger;

    const pageType = getPageType(window.location);
    if (!pageType) throw new Error('Not a supported X page');

    const postId = currentPostId(window.location);
    const limit = pageType === 'post'
      ? Math.min(resolveMaxPosts(options), THREAD_REPLY_SCROLL_LIMIT)
      : resolveMaxPosts(options);

    const collected = await collectPosts(limit, COLLECT_TIME_BUDGET);
    logger.log('X posts collected', { pageType, count: collected.posts.length, truncated: collected.truncated });

    if (!collected.posts.length) {
      logger.log('X page held no readable posts; deferring to the generic extractor');
      return null;
    }

    if (pageType === 'post') {
      const thread = renderThread(collected, options, postId);
      if (thread) return thread;
      // The focused post never mounted (deleted, age-gated, still loading).
      logger.log('X thread root not found in the DOM; deferring to the generic extractor');
      return null;
    }

    return renderListing(collected, options);
  }

  return {
    isXPage,
    getPageType,
    convert,
    // Exposed for tests
    _internals: {
      readPost,
      renderThread,
      renderListing,
      splitSelfThread,
      parseCompactCount,
      resolveMaxPosts,
      currentPostId,
      POST_PATH_RE,
      PROFILE_PATH_RE
    }
  };
})();

if (typeof window !== 'undefined') {
  window.ScrapLLMX = ScrapLLMX;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ScrapLLMX;
}
