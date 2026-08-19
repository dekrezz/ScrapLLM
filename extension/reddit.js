// ScrapLLM Reddit Extractor
// Renders Reddit threads (post + comment tree) and listings as structured Markdown.
//
// Primary source is Reddit's public JSON representation of the current page
// (`<permalink>.json`), fetched same-origin from the content script so it needs
// no extra host permissions and reuses the user's session (private subs,
// logged-in sorts). Readability cannot see collapsed/virtualised comments, so
// the generic pipeline loses most of a thread - the JSON does not.
// When the JSON endpoint is unavailable (bot check, network error, unusual
// route) we fall back to scraping the rendered DOM of either the current
// (`shreddit-*` custom elements) or the old (`.thing`) interface.
const ScrapLLMReddit = (function () {
  'use strict';

  // Paths like /r/sub/comments/<id>/<slug>/, /comments/<id>, /user/x/comments/<id>
  const POST_PATH_RE = /^\/(?:(?:r|u|user)\/[^/]+\/)?comments\/([a-z0-9]+)(?:\/|$)/i;
  // Listing surfaces we can render as a post index.
  const LISTING_PATH_RE = /^\/(?:(?:r|u|user)\/[^/]+(?:\/(?:hot|new|top|rising|best|controversial|submitted|posts)?\/?)?|)$/i;

  const JSON_FETCH_TIMEOUT = 10000; // ms
  const POST_COMMENT_FETCH_LIMIT = 500; // Reddit's documented ceiling per request
  const DEFAULT_MAX_COMMENTS = 250;
  const DEFAULT_COMMENT_SORT = 'confidence'; // "Best"
  const LISTING_POST_LIMIT = 50;
  const LISTING_EXCERPT_LENGTH = 400;
  // Beyond this depth we stop widening the indent so deep chains stay readable
  // (and stay clear of the 4-space-per-level code block threshold in renderers).
  const MAX_INDENT_DEPTH = 8;

  const VALID_SORTS = ['confidence', 'top', 'new', 'controversial', 'old', 'qa'];

  let logger = { log() {}, error() {} };

  // ==========================================================================
  // PAGE DETECTION
  // ==========================================================================

  function isRedditHost(hostname) {
    return /(^|\.)reddit\.com$/i.test(hostname || '');
  }

  // Returns 'post', 'listing' or null (null = let the generic pipeline handle it)
  function getPageType(location) {
    const loc = location || window.location;
    if (!isRedditHost(loc.hostname)) return null;
    const path = loc.pathname || '/';
    if (POST_PATH_RE.test(path)) return 'post';
    if (LISTING_PATH_RE.test(path)) return 'listing';
    return null;
  }

  function isRedditPage(location) {
    return getPageType(location) !== null;
  }

  // ==========================================================================
  // JSON FETCHING
  // ==========================================================================

  function buildJsonUrl(location, extraParams) {
    const loc = location || window.location;
    const path = loc.pathname.replace(/\/+$/, '');
    const url = new URL(loc.origin + path + '/.json');
    // Keep listing qualifiers the user is looking at (?t=week, ?after=..., ...)
    new URLSearchParams(loc.search).forEach((value, key) => {
      url.searchParams.set(key, value);
    });
    Object.entries(extraParams || {}).forEach(([key, value]) => {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    });
    url.searchParams.set('raw_json', '1');
    return url.toString();
  }

  async function fetchJson(url) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), JSON_FETCH_TIMEOUT);
    try {
      const response = await fetch(url, {
        credentials: 'include',
        headers: { Accept: 'application/json' },
        signal: controller.signal
      });
      if (!response.ok) {
        throw new Error(`Reddit JSON request failed with HTTP ${response.status}`);
      }
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('json')) {
        // Reddit serves the bot-check / login wall as HTML on the same URL.
        throw new Error(`Reddit returned "${contentType || 'unknown'}" instead of JSON`);
      }
      return await response.json();
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // ==========================================================================
  // FORMATTING HELPERS
  // ==========================================================================

  function formatNumber(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num.toLocaleString('en-US') : String(value);
  }

  function formatPoints(score, scoreHidden) {
    if (scoreHidden) return 'score hidden';
    if (score === undefined || score === null) return 'score unknown';
    const points = Math.abs(Number(score)) === 1 ? 'point' : 'points';
    return `${formatNumber(score)} ${points}`;
  }

  function formatUtc(seconds) {
    if (!seconds) return '';
    const date = new Date(Number(seconds) * 1000);
    if (Number.isNaN(date.getTime())) return '';
    return date.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  }

  function formatIsoTimestamp(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  }

  function authorLabel(author) {
    if (!author || author === '[deleted]') return '[deleted]';
    return `u/${author}`;
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

  function permalinkToUrl(permalink) {
    if (!permalink) return '';
    if (/^https?:\/\//i.test(permalink)) return permalink;
    return 'https://www.reddit.com' + permalink;
  }

  // Flags that change how a comment/post should be read (mod voice, OP, pinned).
  function badges(data) {
    const list = [];
    if (data.is_submitter) list.push('OP');
    if (data.distinguished === 'moderator') list.push('MOD');
    if (data.distinguished === 'admin') list.push('ADMIN');
    if (data.stickied) list.push('pinned');
    if (data.locked) list.push('locked');
    if (data.edited) list.push('edited');
    return list.length ? `[${list.join(', ')}]` : '';
  }

  // ==========================================================================
  // POST RENDERING (JSON)
  // ==========================================================================

  function renderPostBody(post, settings) {
    const blocks = [];
    const selftext = normalizeBody(post.selftext);
    if (selftext) blocks.push(selftext);

    if (post.poll_data && Array.isArray(post.poll_data.options)) {
      const options = post.poll_data.options
        .map(option => `- ${option.text}${option.vote_count !== undefined && option.vote_count !== null ? ` — ${formatNumber(option.vote_count)} votes` : ''}`)
        .join('\n');
      blocks.push(`**Poll** (${formatNumber(post.poll_data.total_vote_count || 0)} votes total):\n${options}`);
    }

    if (post.is_gallery && post.media_metadata) {
      const images = Object.values(post.media_metadata)
        .map(item => item && item.s && (item.s.u || item.s.gif))
        .filter(Boolean);
      if (images.length) {
        blocks.push(settings.includeImages === false
          ? `_Gallery with ${images.length} image(s)._`
          : images.map((src, index) => `![gallery image ${index + 1}](${src})`).join('\n'));
      }
    } else if (post.post_hint === 'image' && post.url) {
      blocks.push(settings.includeImages === false ? `_Image post: ${post.url}_` : `![${post.title || 'image'}](${post.url})`);
    } else if (post.is_video && post.media && post.media.reddit_video) {
      blocks.push(`_Video post:_ ${post.media.reddit_video.fallback_url || post.url}`);
    }

    const crosspost = Array.isArray(post.crosspost_parent_list) ? post.crosspost_parent_list[0] : null;
    if (crosspost) {
      const crossBody = normalizeBody(crosspost.selftext);
      blocks.push(joinMeta([
        `**Crosspost from ${crosspost.subreddit_name_prefixed || 'r/' + crosspost.subreddit}**`,
        `"${crosspost.title}"`,
        `by ${authorLabel(crosspost.author)}`
      ]) + (crossBody ? `\n\n${crossBody}` : ''));
    }

    if (!blocks.length) {
      blocks.push(post.url ? `_Link post:_ ${post.url}` : '_No post body._');
    }
    return blocks.join('\n\n');
  }

  function renderPostHeader(post) {
    const lines = [`# ${post.title || 'Untitled Reddit post'}`, ''];
    const subreddit = post.subreddit_name_prefixed || (post.subreddit ? `r/${post.subreddit}` : 'Reddit');
    const upvoteRatio = typeof post.upvote_ratio === 'number'
      ? ` (${Math.round(post.upvote_ratio * 100)}% upvoted)`
      : '';

    lines.push(`**Source:** Reddit — ${subreddit}`);
    lines.push(`**Author:** ${authorLabel(post.author)}${badges(post) ? ' ' + badges(post) : ''}`);
    lines.push(`**Posted:** ${formatUtc(post.created_utc)}`);
    lines.push(`**Score:** ${formatPoints(post.score, post.hide_score)}${upvoteRatio} · **Comments:** ${formatNumber(post.num_comments || 0)}`);
    if (post.link_flair_text) lines.push(`**Flair:** ${post.link_flair_text}`);
    if (post.url && !post.is_self && !post.is_gallery) lines.push(`**Link:** ${post.url}`);
    lines.push(`**Permalink:** ${permalinkToUrl(post.permalink)}`);
    return lines.join('\n');
  }

  function shouldSkipComment(comment) {
    const body = String(comment.body || '').trim();
    const hasReplies = comment.replies && comment.replies.data &&
                       Array.isArray(comment.replies.data.children) &&
                       comment.replies.data.children.length > 0;
    return (body === '[removed]' || body === '[deleted]' || body === '') && !hasReplies;
  }

  function renderCommentTree(children, depth, state) {
    const lines = [];
    for (const child of children) {
      if (child.kind === 'more') {
        // Reddit truncates long threads; surface what we did not load instead
        // of silently dropping it.
        state.notLoaded += Number(child.data && child.data.count) || 0;
        continue;
      }
      if (child.kind !== 't1' || !child.data) continue;
      if (state.rendered >= state.limit) {
        state.limitReached = true;
        break;
      }

      const comment = child.data;
      const indent = '  '.repeat(Math.min(depth, MAX_INDENT_DEPTH));
      const replies = comment.replies && comment.replies.data ? comment.replies.data.children || [] : [];

      if (shouldSkipComment(comment)) continue;

      const meta = joinMeta([
        `**${authorLabel(comment.author)}**`,
        formatPoints(comment.score, comment.score_hidden),
        formatUtc(comment.created_utc),
        badges(comment),
        depth > MAX_INDENT_DEPTH ? `depth ${depth}` : ''
      ]);
      lines.push(`${indent}- ${meta}`);

      const body = normalizeBody(comment.body) || '_[removed]_';
      lines.push(indentBlock(body, indent + '  '));
      state.rendered += 1;

      if (replies.length) {
        const nested = renderCommentTree(replies, depth + 1, state);
        if (nested) lines.push(nested);
      }
      lines.push('');
    }
    return lines.join('\n').replace(/\n{3,}/g, '\n\n');
  }

  function renderThread(json, settings) {
    const post = json && json[0] && json[0].data && json[0].data.children &&
                 json[0].data.children[0] && json[0].data.children[0].data;
    if (!post) throw new Error('Reddit JSON did not contain a post');

    const commentChildren = (json[1] && json[1].data && json[1].data.children) || [];
    const state = {
      rendered: 0,
      notLoaded: 0,
      limitReached: false,
      limit: resolveMaxComments(settings)
    };
    const commentsMarkdown = renderCommentTree(commentChildren, 0, state);

    const sortLabel = sortDisplayName(resolveSort(settings));
    const sections = [
      renderPostHeader(post),
      '## Post',
      renderPostBody(post, settings),
      `## Comments (${formatNumber(state.rendered)} of ${formatNumber(post.num_comments || state.rendered)}, sorted by ${sortLabel})`
    ];

    sections.push(commentsMarkdown.trim() || '_No comments._');

    const notes = [];
    if (state.limitReached) {
      notes.push(`Only the first ${formatNumber(state.limit)} comments were included (limit set in ScrapLLM settings).`);
    }
    if (state.notLoaded > 0) {
      notes.push(`${formatNumber(state.notLoaded)} further replies were collapsed by Reddit and not loaded.`);
    }
    if (notes.length) {
      sections.push(`---\n> **Note:** ${notes.join(' ')}`);
    }

    logger.log('Reddit thread rendered', {
      comments: state.rendered,
      notLoaded: state.notLoaded,
      limitReached: state.limitReached
    });

    return {
      markdown: sections.join('\n\n'),
      articleData: {
        title: post.title || document.title,
        author: authorLabel(post.author),
        siteName: post.subreddit_name_prefixed || 'Reddit',
        publishedTime: formatUtc(post.created_utc),
        excerpt: truncate(post.selftext || post.title || '', 300)
      }
    };
  }

  // ==========================================================================
  // LISTING RENDERING (JSON)
  // ==========================================================================

  // Returns null when the listing holds nothing we can render, so the caller
  // can hand the page back to the generic pipeline instead of failing.
  function renderListing(json, settings) {
    const children = (json && json.data && json.data.children) || [];
    const entries = children.filter(child => child.kind === 't3' || child.kind === 't1');
    if (!entries.length) return null;

    const first = entries[0].data;
    const subreddit = first.subreddit_name_prefixed || (first.subreddit ? `r/${first.subreddit}` : 'Reddit');
    const heading = document.title ? document.title.replace(/\s*:\s*r\/.*$/, '') : subreddit;

    const lines = [
      `# ${heading || subreddit}`,
      '',
      `**Source:** Reddit listing — ${subreddit}`,
      `**URL:** ${window.location.href}`,
      `**Entries:** ${formatNumber(entries.length)}`,
      '',
      '## Entries',
      ''
    ];

    entries.forEach((child, index) => {
      const item = child.data;
      if (child.kind === 't3') {
        const target = item.is_self ? permalinkToUrl(item.permalink) : item.url;
        lines.push(`${index + 1}. **[${item.title}](${target})**`);
        lines.push(`   ${joinMeta([
          item.subreddit_name_prefixed,
          authorLabel(item.author),
          formatPoints(item.score, item.hide_score),
          `${formatNumber(item.num_comments || 0)} comments`,
          formatUtc(item.created_utc),
          item.link_flair_text ? `flair: ${item.link_flair_text}` : '',
          badges(item)
        ])}`);
        if (!item.is_self && item.url) lines.push(`   Link: ${item.url}`);
        lines.push(`   Permalink: ${permalinkToUrl(item.permalink)}`);
        const excerpt = truncate(item.selftext, LISTING_EXCERPT_LENGTH);
        if (excerpt) lines.push(`   > ${excerpt}`);
      } else {
        // Comment entry (profile pages, /r/sub/comments listings)
        lines.push(`${index + 1}. **Comment on [${item.link_title || 'a post'}](${permalinkToUrl(item.permalink)})**`);
        lines.push(`   ${joinMeta([
          item.subreddit_name_prefixed,
          authorLabel(item.author),
          formatPoints(item.score, item.score_hidden),
          formatUtc(item.created_utc),
          badges(item)
        ])}`);
        const excerpt = truncate(item.body, LISTING_EXCERPT_LENGTH);
        if (excerpt) lines.push(`   > ${excerpt}`);
      }
      lines.push('');
    });

    lines.push('---');
    lines.push('> **Note:** This is a listing page. Open an individual post to capture its full comment tree.');

    logger.log('Reddit listing rendered', { entries: entries.length });

    return {
      markdown: lines.join('\n'),
      articleData: {
        title: document.title,
        author: '',
        siteName: subreddit,
        publishedTime: '',
        excerpt: truncate(first.title || first.body || '', 300)
      }
    };
  }

  // ==========================================================================
  // DOM FALLBACK
  // ==========================================================================

  function htmlToMarkdown(element, createTurndown) {
    if (!element) return '';
    try {
      return normalizeBody(createTurndown().turndown(element.innerHTML));
    } catch (error) {
      logger.error('Reddit DOM markdown conversion failed', error);
      return normalizeBody(element.textContent);
    }
  }

  // shreddit nests reply elements inside their parent, so a plain descendant
  // query would return a reply's body. Take the first match that still belongs
  // to this comment.
  function ownCommentBody(commentEl) {
    return Array.from(commentEl.querySelectorAll('[slot="comment"]'))
      .find(node => node.closest('shreddit-comment') === commentEl) || null;
  }

  function extractShredditThread(createTurndown, settings) {
    const postEl = document.querySelector('shreddit-post');
    if (!postEl) return null;

    const attr = name => postEl.getAttribute(name) || '';
    const title = attr('post-title') || (postEl.querySelector('[slot="title"]') || {}).textContent || document.title;
    const subreddit = attr('subreddit-prefixed-name') || 'Reddit';
    const bodyEl = postEl.querySelector('[slot="text-body"]');
    const flairEl = postEl.querySelector('[slot="post-flair"]');

    const header = [
      `# ${title.trim()}`,
      '',
      `**Source:** Reddit — ${subreddit}`,
      `**Author:** ${authorLabel(attr('author'))}`,
      `**Posted:** ${formatIsoTimestamp(attr('created-timestamp'))}`,
      `**Score:** ${formatPoints(attr('score'))} · **Comments:** ${formatNumber(attr('comment-count') || 0)}`
    ];
    if (flairEl && flairEl.textContent.trim()) header.push(`**Flair:** ${flairEl.textContent.trim()}`);
    if (attr('content-href') && attr('post-type') === 'link') header.push(`**Link:** ${attr('content-href')}`);
    header.push(`**Permalink:** ${permalinkToUrl(attr('permalink'))}`);

    const commentEls = Array.from(document.querySelectorAll('shreddit-comment'));
    const limit = resolveMaxComments(settings);
    const commentLines = [];
    let rendered = 0;

    for (const commentEl of commentEls) {
      if (rendered >= limit) break;
      const depth = Number(commentEl.getAttribute('depth')) || 0;
      const bodyMarkdown = htmlToMarkdown(ownCommentBody(commentEl), createTurndown);
      if (!bodyMarkdown) continue;
      const indent = '  '.repeat(Math.min(depth, MAX_INDENT_DEPTH));
      const meta = joinMeta([
        `**${authorLabel(commentEl.getAttribute('author'))}**`,
        formatPoints(commentEl.getAttribute('score')),
        formatIsoTimestamp(commentEl.getAttribute('created')),
        commentEl.hasAttribute('is-op') ? '[OP]' : '',
        depth > MAX_INDENT_DEPTH ? `depth ${depth}` : ''
      ]);
      commentLines.push(`${indent}- ${meta}`);
      commentLines.push(indentBlock(bodyMarkdown, indent + '  '));
      commentLines.push('');
      rendered += 1;
    }

    const sections = [
      header.join('\n'),
      '## Post',
      htmlToMarkdown(bodyEl, createTurndown) || (attr('content-href') ? `_Link post:_ ${attr('content-href')}` : '_No post body._'),
      `## Comments (${formatNumber(rendered)} of ${formatNumber(attr('comment-count') || rendered)} — rendered comments only)`,
      commentLines.join('\n').trim() || '_No comments visible on the page._',
      '---\n> **Note:** Extracted from the rendered page because Reddit\'s JSON API was unavailable. Collapsed and not-yet-loaded comments are missing.'
    ];

    return {
      markdown: sections.join('\n\n'),
      articleData: {
        title: title.trim(),
        author: authorLabel(attr('author')),
        siteName: subreddit,
        publishedTime: formatIsoTimestamp(attr('created-timestamp')),
        excerpt: ''
      }
    };
  }

  function extractOldRedditThread(createTurndown, settings) {
    const postEl = document.querySelector('#siteTable .thing.link, #siteTable div.thing');
    if (!postEl) return null;

    const titleEl = postEl.querySelector('a.title');
    const title = titleEl ? titleEl.textContent.trim() : document.title;
    const author = (postEl.querySelector('.tagline .author') || {}).textContent || '';
    const scoreEl = postEl.querySelector('.score.unvoted');
    // Comment pages don't render the .subreddit link the way listings do, so
    // fall back to the /r/<sub>/ segment of the path.
    const subredditEl = postEl.querySelector('.subreddit');
    const pathSubreddit = (window.location.pathname.match(/^\/r\/([^/]+)/) || [])[1];
    const subredditName = (subredditEl && subredditEl.textContent.trim()) ||
                          (pathSubreddit ? `r/${pathSubreddit}` : 'Reddit');
    const timeEl = postEl.querySelector('.tagline time');
    const bodyEl = postEl.querySelector('.expando .usertext-body .md, .usertext-body .md');

    const header = [
      `# ${title}`,
      '',
      `**Source:** Reddit — ${subredditName}`,
      `**Author:** ${authorLabel(author.trim())}`,
      `**Posted:** ${timeEl ? formatIsoTimestamp(timeEl.getAttribute('datetime')) : ''}`,
      `**Score:** ${scoreEl ? formatPoints(scoreEl.getAttribute('title') || scoreEl.textContent.trim()) : 'score unknown'}`,
      `**Permalink:** ${permalinkToUrl(postEl.getAttribute('data-permalink') || window.location.pathname)}`
    ];
    if (titleEl && titleEl.getAttribute('href') && !/^\/r\//.test(titleEl.getAttribute('href'))) {
      header.push(`**Link:** ${titleEl.href}`);
    }

    const limit = resolveMaxComments(settings);
    const commentEls = Array.from(document.querySelectorAll('.commentarea .thing.comment'));
    const commentLines = [];
    let rendered = 0;

    for (const commentEl of commentEls) {
      if (rendered >= limit) break;
      if (commentEl.classList.contains('deleted')) continue;
      // old.reddit nests replies in .child wrappers; ancestor count is the depth.
      let depth = 0;
      let parent = commentEl.parentElement;
      while (parent) {
        if (parent.classList && parent.classList.contains('child')) depth += 1;
        parent = parent.parentElement;
      }
      const entry = commentEl.querySelector(':scope > .entry');
      if (!entry) continue;
      const bodyMarkdown = htmlToMarkdown(entry.querySelector('.usertext-body .md'), createTurndown);
      if (!bodyMarkdown) continue;
      const scoreNode = entry.querySelector('.score.unvoted');
      const timeNode = entry.querySelector('.tagline time');
      const indent = '  '.repeat(Math.min(depth, MAX_INDENT_DEPTH));
      const meta = joinMeta([
        `**${authorLabel((entry.querySelector('.author') || {}).textContent)}**`,
        scoreNode ? formatPoints(scoreNode.getAttribute('title') || scoreNode.textContent.replace(/\D+/g, '')) : 'score hidden',
        timeNode ? formatIsoTimestamp(timeNode.getAttribute('datetime')) : '',
        entry.querySelector('.submitter') ? '[OP]' : '',
        depth > MAX_INDENT_DEPTH ? `depth ${depth}` : ''
      ]);
      commentLines.push(`${indent}- ${meta}`);
      commentLines.push(indentBlock(bodyMarkdown, indent + '  '));
      commentLines.push('');
      rendered += 1;
    }

    const sections = [
      header.join('\n'),
      '## Post',
      htmlToMarkdown(bodyEl, createTurndown) || '_No post body._',
      `## Comments (${formatNumber(rendered)} — rendered comments only)`,
      commentLines.join('\n').trim() || '_No comments visible on the page._',
      '---\n> **Note:** Extracted from the rendered page because Reddit\'s JSON API was unavailable. Collapsed and not-yet-loaded comments are missing.'
    ];

    return {
      markdown: sections.join('\n\n'),
      articleData: {
        title,
        author: authorLabel(author.trim()),
        siteName: subredditName,
        publishedTime: timeEl ? formatIsoTimestamp(timeEl.getAttribute('datetime')) : '',
        excerpt: ''
      }
    };
  }

  function extractFromDom(pageType, createTurndown, settings) {
    if (pageType !== 'post') return null;
    return extractShredditThread(createTurndown, settings) ||
           extractOldRedditThread(createTurndown, settings);
  }

  // ==========================================================================
  // SETTINGS
  // ==========================================================================

  function resolveMaxComments(settings) {
    const raw = settings && settings.redditMaxComments;
    if (raw === 'all' || raw === 0) return Number.MAX_SAFE_INTEGER;
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_COMMENTS;
  }

  function resolveSort(settings) {
    const sort = settings && settings.redditCommentSort;
    return VALID_SORTS.includes(sort) ? sort : DEFAULT_COMMENT_SORT;
  }

  function sortDisplayName(sort) {
    return sort === 'confidence' ? 'best' : sort;
  }

  // ==========================================================================
  // PUBLIC ENTRY POINT
  // ==========================================================================

  // Returns { markdown, articleData }, or null when the page is a Reddit route
  // with nothing to render (caller should fall back to generic extraction).
  // Throws with a Reddit-specific message when a thread exists but neither the
  // JSON API nor the DOM could be read.
  async function convert(settings, deps) {
    const options = settings || {};
    const createTurndown = (deps && deps.createTurndown) || null;
    logger = (deps && deps.logger) || logger;

    const pageType = getPageType(window.location);
    if (!pageType) throw new Error('Not a supported Reddit page');

    const params = pageType === 'post'
      ? { limit: POST_COMMENT_FETCH_LIMIT, sort: resolveSort(options), threaded: 'true' }
      : { limit: LISTING_POST_LIMIT };
    const jsonUrl = buildJsonUrl(window.location, params);

    let jsonError = null;
    try {
      logger.log('Fetching Reddit JSON', { url: jsonUrl, pageType });
      const json = await fetchJson(jsonUrl);
      if (pageType === 'post') return renderThread(json, options);
      const listing = renderListing(json, options);
      if (listing) return listing;
      // Nothing post-like on this listing (empty feed, profile with no
      // activity) - let the generic extractor handle the page.
      logger.log('Reddit listing had no renderable entries; deferring to the generic extractor');
      return null;
    } catch (error) {
      jsonError = error;
      logger.error('Reddit JSON extraction failed', error);
    }

    if (createTurndown) {
      const domResult = extractFromDom(pageType, createTurndown, options);
      if (domResult) {
        logger.log('Reddit DOM fallback used', { reason: jsonError && jsonError.message });
        return domResult;
      }
    }

    throw new Error(
      `Reddit extraction failed (${jsonError ? jsonError.message : 'no data'}). ` +
      'Reload the page while logged in, or turn off Reddit mode in ScrapLLM settings to use the generic extractor.'
    );
  }

  return {
    isRedditPage,
    getPageType,
    convert,
    // Exposed for tests
    _internals: {
      buildJsonUrl,
      renderThread,
      renderListing,
      renderCommentTree,
      resolveMaxComments,
      resolveSort,
      POST_PATH_RE,
      LISTING_PATH_RE
    }
  };
})();

if (typeof window !== 'undefined') {
  window.ScrapLLMReddit = ScrapLLMReddit;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ScrapLLMReddit;
}
