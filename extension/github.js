// ScrapLLM GitHub Extractor
// Renders a repository page as: heading, description and facts, the README,
// and optionally the full file tree.
//
// Everything comes from GitHub's REST API rather than the rendered page, for
// two reasons. The README on screen is HTML that was *compiled* from Markdown —
// converting it back is a lossy round trip that mangles nested lists, badge
// rows and fenced code, when the original Markdown is one request away. And the
// file list on screen is one directory deep: the tree endpoint returns the
// whole repository in a single call, which is the structure a model actually
// needs to reason about a codebase.
//
// api.github.com sends `access-control-allow-origin: *`, so the content script
// can call it with no extra host permission. Unauthenticated callers get 60
// requests an hour per IP; a repository costs three, and running out is
// reported by name instead of failing silently.
const ScrapLLMGitHub = (function () {
  'use strict';

  const API = 'https://api.github.com';
  const FETCH_TIMEOUT = 10000; // ms
  const DEFAULT_MAX_TREE_ENTRIES = 1000;

  // /owner/repo, optionally followed by /tree/<ref> — the pages that are "the
  // repository" rather than a view onto one file.
  const REPO_PATH_RE = /^\/([^/]+)\/([^/]+?)(?:\/tree\/[^/]+)?\/?$/;

  // Paths that look like a repo but are GitHub's own furniture.
  const RESERVED_OWNERS = new Set([
    'features', 'topics', 'collections', 'trending', 'events', 'sponsors',
    'marketplace', 'explore', 'notifications', 'settings', 'pulls', 'issues',
    'codespaces', 'orgs', 'organizations', 'users', 'about', 'pricing',
    'security', 'enterprise', 'apps', 'login', 'join', 'new', 'search'
  ]);

  let logger = { log() {}, error() {} };

  // ==========================================================================
  // PAGE DETECTION
  // ==========================================================================

  function isGitHubHost(hostname) {
    return /^(www\.)?github\.com$/i.test(hostname || '');
  }

  function parseRepo(location) {
    const loc = location || window.location;
    if (!isGitHubHost(loc.hostname)) return null;
    const match = REPO_PATH_RE.exec(loc.pathname || '/');
    if (!match) return null;
    const [, owner, repo] = match;
    if (RESERVED_OWNERS.has(owner.toLowerCase())) return null;
    return { owner, repo: repo.replace(/\.git$/, '') };
  }

  // Returns 'repo' or null (null = let the generic pipeline handle it)
  function getPageType(location) {
    return parseRepo(location) ? 'repo' : null;
  }

  function isGitHubPage(location) {
    return getPageType(location) !== null;
  }

  // ==========================================================================
  // API
  // ==========================================================================

  async function apiGet(path) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
    try {
      const response = await fetch(API + path, {
        headers: { Accept: 'application/vnd.github+json' },
        signal: controller.signal
      });
      if (response.status === 403 || response.status === 429) {
        const remaining = response.headers.get('x-ratelimit-remaining');
        if (remaining === '0') {
          const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
          const minutes = Math.max(1, Math.ceil((reset - Date.now()) / 60000));
          throw new Error(
            `GitHub's API rate limit is spent (60 requests an hour for signed-out callers). It resets in about ${minutes} minute${minutes === 1 ? '' : 's'}.`
          );
        }
        throw new Error(`GitHub refused the request with HTTP ${response.status}`);
      }
      if (response.status === 404) {
        throw new Error('GitHub returned 404 — the repository is private, renamed or gone');
      }
      if (!response.ok) {
        throw new Error(`GitHub request failed with HTTP ${response.status}`);
      }
      return await response.json();
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // GitHub hands the README back base64-encoded, in whatever encoding the file
  // is. Decoding through TextDecoder rather than atob alone keeps non-ASCII
  // READMEs intact — a good half of them open with a non-Latin title or an
  // emoji in the first heading.
  function decodeBase64Utf8(value) {
    const clean = String(value || '').replace(/\s+/g, '');
    if (!clean) return '';
    const binary = atob(clean);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  }

  // ==========================================================================
  // FORMATTING
  // ==========================================================================

  function formatNumber(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num.toLocaleString('en-US') : String(value);
  }

  function formatDate(value) {
    if (!value) return '';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
  }

  function joinMeta(parts) {
    return parts.filter(p => p !== undefined && p !== null && p !== '').join(' · ');
  }

  function renderRepoHeader(repo) {
    const lines = [`# ${repo.full_name || repo.name}`];
    if (repo.description) lines.push('', repo.description.trim());

    const facts = joinMeta([
      repo.language,
      `${formatNumber(repo.stargazers_count || 0)} stars`,
      `${formatNumber(repo.forks_count || 0)} forks`,
      repo.license && repo.license.spdx_id && repo.license.spdx_id !== 'NOASSERTION'
        ? repo.license.spdx_id
        : '',
      repo.archived ? 'archived' : '',
      repo.updated_at ? `updated ${formatDate(repo.updated_at)}` : ''
    ]);

    lines.push('');
    lines.push(`**Repository:** ${repo.html_url}`);
    if (facts) lines.push(`**Facts:** ${facts}`);
    if (repo.homepage) lines.push(`**Homepage:** ${repo.homepage}`);
    if (Array.isArray(repo.topics) && repo.topics.length) {
      lines.push(`**Topics:** ${repo.topics.join(', ')}`);
    }
    return lines.join('\n');
  }

  // ==========================================================================
  // FILE TREE
  // ==========================================================================

  // The API returns a flat list of paths; this rebuilds the hierarchy so the
  // output shows how the repository is actually laid out rather than a column
  // of slash-separated strings a reader has to reassemble in their head.
  function buildTree(entries) {
    const root = { name: '', dir: true, children: new Map() };
    for (const entry of entries) {
      if (!entry || !entry.path) continue;
      const isDir = entry.type === 'tree';
      const parts = entry.path.split('/');
      let node = root;
      parts.forEach((part, index) => {
        const last = index === parts.length - 1;
        if (!node.children.has(part)) {
          node.children.set(part, {
            name: part,
            dir: last ? isDir : true,
            size: last && !isDir ? entry.size : undefined,
            children: new Map()
          });
        }
        node = node.children.get(part);
      });
    }
    return root;
  }

  // Directories first, then files, each alphabetically — the order a file
  // browser would show, so the output matches what the reader expects to see.
  function sortedChildren(node) {
    return Array.from(node.children.values()).sort((a, b) => {
      if (a.dir !== b.dir) return a.dir ? -1 : 1;
      return a.name.localeCompare(b.name, 'en');
    });
  }

  function renderTreeLines(node, prefix, lines) {
    const children = sortedChildren(node);
    children.forEach((child, index) => {
      const last = index === children.length - 1;
      const branch = last ? '└── ' : '├── ';
      lines.push(`${prefix}${branch}${child.name}${child.dir ? '/' : ''}`);
      if (child.dir) {
        renderTreeLines(child, prefix + (last ? '    ' : '│   '), lines);
      }
    });
    return lines;
  }

  function resolveMaxTreeEntries(settings) {
    const raw = settings && settings.githubMaxTreeEntries;
    if (raw === 'all') return Infinity;
    const num = Number(raw);
    return Number.isFinite(num) && num > 0 ? num : DEFAULT_MAX_TREE_ENTRIES;
  }

  function renderFileTree(treeData, repo, settings) {
    const all = Array.isArray(treeData.tree) ? treeData.tree : [];
    const limit = resolveMaxTreeEntries(settings);
    const entries = all.length > limit ? all.slice(0, limit) : all;

    const files = all.filter(e => e.type === 'blob').length;
    const dirs = all.filter(e => e.type === 'tree').length;

    const lines = [
      `## File tree`,
      '',
      `${formatNumber(files)} file${files === 1 ? '' : 's'} in ${formatNumber(dirs)} director${dirs === 1 ? 'y' : 'ies'}, on \`${repo.default_branch}\`.`,
      '',
      '```',
      `${repo.name}/`,
      ...renderTreeLines(buildTree(entries), '', []),
      '```'
    ];

    // Two different ways the list can be short of the whole repository, and
    // they are not the same fact: one is our ceiling, the other is GitHub's.
    if (all.length > entries.length) {
      lines.push('', `> Showing the first ${formatNumber(entries.length)} of ${formatNumber(all.length)} entries (limit set in ScrapLLM settings).`);
    }
    if (treeData.truncated) {
      lines.push('', '> GitHub truncated the tree: this repository is too large to return in one request, so deeper paths are missing.');
    }
    return lines.join('\n');
  }

  // ==========================================================================
  // CONVERSION
  // ==========================================================================

  async function convert(settings, deps) {
    const options = settings || {};
    logger = (deps && deps.logger) || logger;

    const target = parseRepo(window.location);
    if (!target) throw new Error('Not a GitHub repository page');

    const base = `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`;
    logger.log('GitHub repository detected', target);

    const repo = await apiGet(base);
    const sections = [renderRepoHeader(repo)];

    // The README is the point of the page, but a repository without one is
    // ordinary — say so and keep going rather than failing the capture.
    if (options.githubIncludeReadme !== false) {
      try {
        const readme = await apiGet(`${base}/readme`);
        const text = decodeBase64Utf8(readme.content).trim();
        if (text) {
          sections.push(`## ${readme.name || 'README'}`, text);
        }
      } catch (error) {
        logger.error('GitHub README unavailable', error);
        sections.push('## README', `_${error.message}_`);
      }
    }

    if (options.githubIncludeTree !== false) {
      try {
        const tree = await apiGet(
          `${base}/git/trees/${encodeURIComponent(repo.default_branch)}?recursive=1`);
        sections.push(renderFileTree(tree, repo, options));
      } catch (error) {
        logger.error('GitHub tree unavailable', error);
        sections.push('## File tree', `_${error.message}_`);
      }
    }

    return {
      markdown: sections.join('\n\n'),
      articleData: {
        title: repo.full_name || repo.name || document.title,
        author: (repo.owner && repo.owner.login) ? repo.owner.login : '',
        siteName: 'GitHub',
        publishedTime: formatDate(repo.created_at),
        excerpt: (repo.description || '').trim()
      }
    };
  }

  return {
    isGitHubPage,
    getPageType,
    convert,
    // Exposed for tests
    _internals: {
      parseRepo,
      buildTree,
      renderTreeLines,
      renderFileTree,
      renderRepoHeader,
      decodeBase64Utf8,
      resolveMaxTreeEntries,
      REPO_PATH_RE
    }
  };
})();

if (typeof window !== 'undefined') {
  window.ScrapLLMGitHub = ScrapLLMGitHub;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ScrapLLMGitHub;
}
