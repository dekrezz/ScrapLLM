// ScrapLLM YouTube Extractor
// Renders a video page as: title, channel and facts, the full description, and
// the comment thread.
//
// None of that survives the generic path. The description on screen is clamped
// to two lines behind a "...more" button, and the comments are not in the
// document at all until you scroll to them — they arrive from an internal API,
// a page at a time. Readability sees a player and some chrome.
//
// So the data is read where the page itself reads it: `ytInitialPlayerResponse`
// for the video (it carries the description in full, unclamped), and YouTube's
// own `/youtubei/v1/next` endpoint for the comments. Both are same-origin from
// the content script, so no extra host permission is involved, and no request
// goes anywhere except youtube.com.
const ScrapLLMYouTube = (function () {
  'use strict';

  const FETCH_TIMEOUT = 10000; // ms
  const DEFAULT_MAX_COMMENTS = 100;
  // YouTube returns 20 comments per continuation, so the ceiling is reached in
  // whole pages; this only bounds how many pages we are willing to ask for.
  const MAX_COMMENT_PAGES = 25;

  const WATCH_PATH_RE = /^\/watch$/;
  const SHORTS_PATH_RE = /^\/shorts\/([A-Za-z0-9_-]{6,})/;

  let logger = { log() {}, error() {} };

  // ==========================================================================
  // PAGE DETECTION
  // ==========================================================================

  function isYouTubeHost(hostname) {
    return /(^|\.)youtube\.com$/i.test(hostname || '') || /^youtu\.be$/i.test(hostname || '');
  }

  // Returns 'video' or null (null = let the generic pipeline handle it)
  function getPageType(location) {
    const loc = location || window.location;
    if (!isYouTubeHost(loc.hostname)) return null;
    const path = loc.pathname || '/';
    if (WATCH_PATH_RE.test(path) && new URLSearchParams(loc.search).get('v')) return 'video';
    if (SHORTS_PATH_RE.test(path)) return 'video';
    if (/^youtu\.be$/i.test(loc.hostname) && path.length > 1) return 'video';
    return null;
  }

  function isYouTubePage(location) {
    return getPageType(location) !== null;
  }

  function videoId(location) {
    const loc = location || window.location;
    const shorts = SHORTS_PATH_RE.exec(loc.pathname || '');
    if (shorts) return shorts[1];
    if (/^youtu\.be$/i.test(loc.hostname)) return (loc.pathname || '/').slice(1);
    return new URLSearchParams(loc.search).get('v') || '';
  }

  // ==========================================================================
  // EMBEDDED JSON
  // ==========================================================================

  // The page ships its state as `var ytInitialData = {...};` inside a script
  // tag. A regex cannot find where that object ends — the description alone
  // routinely contains braces and escaped quotes — so the extent is found by
  // matching braces while respecting string literals and escapes.
  function readEmbeddedJson(html, marker) {
    const at = html.indexOf(marker);
    if (at === -1) return null;
    const start = html.indexOf('{', at);
    if (start === -1) return null;

    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < html.length; i++) {
      const ch = html[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(html.slice(start, i + 1));
          } catch (error) {
            logger.error('YouTube embedded JSON did not parse', error);
            return null;
          }
        }
      }
    }
    return null;
  }

  function readConfigValue(html, key) {
    const match = new RegExp(`"${key}":"([^"]+)"`).exec(html);
    return match ? match[1] : null;
  }

  // ==========================================================================
  // FORMATTING
  // ==========================================================================

  function formatNumber(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num.toLocaleString('en-US') : String(value || '');
  }

  function formatDuration(seconds) {
    const total = Number(seconds);
    if (!Number.isFinite(total) || total <= 0) return '';
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h
      ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
      : `${m}:${String(s).padStart(2, '0')}`;
  }

  function formatDate(value) {
    if (!value) return '';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toISOString().slice(0, 10);
  }

  function joinMeta(parts) {
    return parts.filter(p => p !== undefined && p !== null && p !== '').join(' · ');
  }

  function normalizeText(text) {
    return String(text || '').replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  // A comment body is arbitrary text, and "#1" at the start of a line would
  // otherwise become a heading in the copied document.
  function demoteHeadings(text) {
    return normalizeText(text).replace(/^(#{1,6})(\s)/gm, '\\$1$2');
  }

  // ==========================================================================
  // VIDEO
  // ==========================================================================

  function renderVideoHeader(details, microformat, url) {
    const lines = [`# ${details.title || document.title}`];

    const published = microformat && (microformat.publishDate || microformat.uploadDate);
    const facts = joinMeta([
      details.author ? `by ${details.author}` : '',
      details.viewCount ? `${formatNumber(details.viewCount)} views` : '',
      formatDuration(details.lengthSeconds),
      published ? formatDate(published) : '',
      details.isLiveContent ? 'live' : ''
    ]);

    lines.push('');
    lines.push(`**Source:** YouTube`);
    if (facts) lines.push(`**Video:** ${facts}`);
    if (details.channelId) {
      lines.push(`**Channel:** https://www.youtube.com/channel/${details.channelId}`);
    }
    lines.push(`**URL:** ${url}`);
    if (Array.isArray(details.keywords) && details.keywords.length) {
      lines.push(`**Tags:** ${details.keywords.slice(0, 15).join(', ')}`);
    }
    return lines.join('\n');
  }

  // ==========================================================================
  // COMMENTS
  // ==========================================================================

  function findCommentsToken(node) {
    let token = null;
    (function walk(current) {
      if (token || !current || typeof current !== 'object') return;
      const section = current.itemSectionRenderer;
      if (section && section.sectionIdentifier === 'comment-item-section') {
        for (const item of section.contents || []) {
          const command = item.continuationItemRenderer
            && item.continuationItemRenderer.continuationEndpoint
            && item.continuationItemRenderer.continuationEndpoint.continuationCommand;
          if (command && command.token) {
            token = command.token;
            return;
          }
        }
      }
      for (const key in current) walk(current[key]);
    })(node);
    return token;
  }

  function findNextToken(node) {
    let token = null;
    (function walk(current) {
      if (token || !current || typeof current !== 'object') return;
      const command = current.continuationItemRenderer
        && current.continuationItemRenderer.continuationEndpoint
        && current.continuationItemRenderer.continuationEndpoint.continuationCommand;
      if (command && command.token) {
        token = command.token;
        return;
      }
      for (const key in current) walk(current[key]);
    })(node);
    return token;
  }

  // Comments arrive split in two: the order lives in view models scattered
  // through the response, while the text, author and like count live in a flat
  // batch of entity payloads keyed by id. Collecting the payloads and then
  // walking the view models in document order is what puts a reply under the
  // comment it answers instead of wherever the batch happened to place it.
  function collectComments(response) {
    const payloads = new Map();
    (function walk(node) {
      if (!node || typeof node !== 'object') return;
      if (node.commentEntityPayload && node.commentEntityPayload.key) {
        payloads.set(node.commentEntityPayload.key, node.commentEntityPayload);
      }
      for (const key in node) walk(node[key]);
    })(response);

    const ordered = [];
    const seen = new Set();
    (function walk(node) {
      if (!node || typeof node !== 'object') return;
      const view = node.commentViewModel && (node.commentViewModel.commentViewModel || node.commentViewModel);
      const key = view && (view.commentKey || view.commentId);
      if (key && payloads.has(key) && !seen.has(key)) {
        seen.add(key);
        ordered.push(payloads.get(key));
      }
      for (const k in node) walk(node[k]);
    })(response);

    // A response shape we do not recognise should still yield its comments
    // rather than an empty section.
    if (!ordered.length && payloads.size) {
      return Array.from(payloads.values());
    }
    return ordered;
  }

  function renderComment(payload, path) {
    const props = payload.properties || {};
    const author = payload.author || {};
    const toolbar = payload.toolbar || {};

    const meta = joinMeta([
      author.displayName || '[unknown]',
      toolbar.likeCountNotliked && toolbar.likeCountNotliked !== '0'
        ? `${toolbar.likeCountNotliked} likes`
        : '',
      props.publishedTime || '',
      author.isCreator ? '[creator]' : '',
      toolbar.replyCount && toolbar.replyCount !== '0' ? `${toolbar.replyCount} replies` : ''
    ]);

    const body = demoteHeadings((props.content && props.content.content) || '');
    return `**[${path}]** ${meta}\n\n${body || '_[empty]_'}`;
  }

  async function fetchCommentPage(token, apiKey, clientVersion) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
    try {
      const response = await fetch(`/youtubei/v1/next?key=${encodeURIComponent(apiKey)}&prettyPrint=false`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          context: { client: { clientName: 'WEB', clientVersion, hl: 'en', gl: 'US' } },
          continuation: token
        }),
        signal: controller.signal
      });
      if (!response.ok) {
        throw new Error(`YouTube's comment endpoint answered HTTP ${response.status}`);
      }
      return await response.json();
    } finally {
      clearTimeout(timeoutId);
    }
  }

  function resolveMaxComments(settings) {
    const raw = settings && settings.youtubeMaxComments;
    if (raw === 'all') return Infinity;
    const num = Number(raw);
    return Number.isFinite(num) && num > 0 ? num : DEFAULT_MAX_COMMENTS;
  }

  async function renderComments(initialData, apiKey, clientVersion, settings) {
    let token = findCommentsToken(initialData);
    if (!token) {
      return '## Comments\n\n_Comments are turned off for this video, or YouTube did not offer them._';
    }

    const limit = resolveMaxComments(settings);
    const rendered = [];
    // Reply level is the only nesting YouTube exposes, so the path is two
    // deep at most: "3" is a top-level comment, "3.1" the first reply to it.
    let topLevel = 0;
    let replies = 0;
    let pages = 0;
    let hitLimit = false;

    while (token && pages < MAX_COMMENT_PAGES && rendered.length < limit) {
      let response;
      try {
        response = await fetchCommentPage(token, apiKey, clientVersion);
      } catch (error) {
        logger.error('YouTube comment page failed', error);
        if (!rendered.length) {
          return `## Comments\n\n_${error.message}_`;
        }
        break;
      }
      pages += 1;

      const comments = collectComments(response);
      if (!comments.length) break;

      for (const payload of comments) {
        if (rendered.length >= limit) {
          hitLimit = true;
          break;
        }
        const level = Number((payload.properties || {}).replyLevel) || 0;
        let path;
        if (level === 0) {
          topLevel += 1;
          replies = 0;
          path = String(topLevel);
        } else {
          replies += 1;
          path = `${topLevel || 1}.${replies}`;
        }
        rendered.push(renderComment(payload, path));
      }

      token = findNextToken(response);
    }

    const header = `## Comments (${formatNumber(rendered.length)})`;
    const notes = [];
    if (hitLimit) {
      notes.push(`Only the first ${formatNumber(limit)} comments were included (limit set in ScrapLLM settings).`);
    } else if (token) {
      notes.push('YouTube had more pages of comments than this run asked for.');
    }

    const body = rendered.length ? rendered.join('\n\n') : '_No comments._';
    return notes.length
      ? `${header}\n\n${body}\n\n---\n> **Note:** ${notes.join(' ')}`
      : `${header}\n\n${body}`;
  }

  // ==========================================================================
  // CONVERSION
  // ==========================================================================

  async function convert(settings, deps) {
    const options = settings || {};
    logger = (deps && deps.logger) || logger;

    if (!isYouTubePage(window.location)) throw new Error('Not a YouTube video page');

    const html = document.documentElement.innerHTML;
    const player = readEmbeddedJson(html, 'ytInitialPlayerResponse');
    const details = (player && player.videoDetails) || null;

    // Without the player response there is no description and no title worth
    // having, so the page is handed back to the generic extractor rather than
    // emitting a heading with nothing under it.
    if (!details) {
      logger.log('YouTube player response missing; deferring to the generic extractor');
      return null;
    }

    const microformat = player.microformat && player.microformat.playerMicroformatRenderer;
    const url = `https://www.youtube.com/watch?v=${videoId(window.location)}`;
    const sections = [renderVideoHeader(details, microformat, url)];

    if (options.youtubeIncludeDescription !== false) {
      const description = normalizeText(details.shortDescription);
      sections.push('## Description', description || '_No description._');
    }

    if (options.youtubeIncludeComments !== false) {
      const apiKey = readConfigValue(html, 'INNERTUBE_API_KEY');
      const clientVersion = readConfigValue(html, 'INNERTUBE_CLIENT_VERSION');
      const initialData = readEmbeddedJson(html, 'ytInitialData');
      if (apiKey && clientVersion && initialData) {
        sections.push(await renderComments(initialData, apiKey, clientVersion, options));
      } else {
        sections.push('## Comments', '_YouTube did not expose the keys needed to load comments on this page._');
      }
    }

    return {
      markdown: sections.join('\n\n'),
      articleData: {
        title: details.title || document.title,
        author: details.author || '',
        siteName: 'YouTube',
        publishedTime: formatDate(microformat && (microformat.publishDate || microformat.uploadDate)),
        excerpt: normalizeText(details.shortDescription).slice(0, 300)
      }
    };
  }

  return {
    isYouTubePage,
    getPageType,
    convert,
    // Exposed for tests
    _internals: {
      readEmbeddedJson,
      readConfigValue,
      collectComments,
      renderComment,
      renderVideoHeader,
      formatDuration,
      resolveMaxComments,
      videoId
    }
  };
})();

if (typeof window !== 'undefined') {
  window.ScrapLLMYouTube = ScrapLLMYouTube;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ScrapLLMYouTube;
}
