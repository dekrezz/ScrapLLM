// ScrapLLM Settings Utilities
// Shared settings constants and functions used across popup and background scripts

const SettingsUtils = (function() {
  // Default metadata format template
  const DEFAULT_METADATA_FORMAT = "---\nSource: [{title}]({url})";

  // Get user settings with defaults
  async function getUserSettings(browserAPI) {
    return await browserAPI.storage.sync.get({
      contentScope: 'mainContent',
      preserveTables: true,
      includeImages: true,
      includeTitle: true,
      includeLinks: true,
      includeMetadata: true,
      metadataFormat: DEFAULT_METADATA_FORMAT,
      debugMode: false,
      // Off by default. Triggers a scroll-pass on lazy-loading surfaces (chat
      // UIs, virtualised feeds) before extraction. Has visible side effects
      // (page movement, optional footer warning) so users opt in explicitly.
      triggerLazyLoading: false,
      // Reddit-aware extraction: renders the post plus its comment tree from
      // Reddit's own JSON instead of letting Readability drop the discussion.
      redditMode: true,
      // Comment sort passed to Reddit ('confidence' is what the UI calls "Best")
      redditCommentSort: 'confidence',
      // Comment ceiling per thread; 'all' means no cap.
      redditMaxComments: 250,
      // Chat export: how many exchanges (one user turn plus the assistant's
      // reply) to copy, counted from the end. Defaults to a slice rather than
      // 'all' — a two-year-old thread can be tens of thousands of messages,
      // and copying it whole is a good way to hang the tab.
      chatExchangeLimit: 10,
      // GitHub-aware extraction: builds a repository page from the REST API —
      // heading, description, the README as its original Markdown, and the
      // whole file tree. The rendered page cannot give either: its README is
      // HTML compiled from Markdown, and its file list is one level deep.
      githubMode: true,
      // Whether the capture carries the README.
      githubIncludeReadme: true,
      // Whether the capture carries the recursive file tree.
      githubIncludeTree: true,
      // Ceiling on tree entries; 'all' means no cap. A monorepo can hold six
      // figures of paths, which is not a thing to paste into a model.
      githubMaxTreeEntries: 1000,
      // X-aware extraction: renders the thread (post + replies) or the timeline
      // by walking the virtualised list instead of the first visible post only.
      xMode: true,
      // Post ceiling per page (thread replies or timeline entries); 'all' means
      // no cap, bounded only by the extractor's own time budget.
      xMaxPosts: 100,
      // Whether a thread capture includes the replies under the focused post.
      xIncludeReplies: true,
      // Research: how many sources one run tries to capture. The picker offers
      // 5 / 8 / 12; research.js re-clamps to 5..12 whatever arrives.
      researchSourceCount: 8,
      // Research capture strategy. 'quiet' fetches each source's HTML in the
      // background and converts it with no tab at all, escalating to a tab only
      // for the pages that genuinely need a rendering engine. 'render' opens a
      // background tab for every source, which is slower and visible but uses
      // the page's own session and runs its JavaScript.
      researchCapture: 'quiet',
      // Research quality gate. Scores every captured page and drops the ones
      // that are readable but worthless — affiliate and coupon spam, paid-signal
      // landings, scraped mirrors of a page already captured — and pulls the
      // next candidate in their place. One switch, not one knob per threshold:
      // the thresholds are measurements, not preferences.
      researchJunkFilter: true
    });
  }

  // Public API
  return {
    DEFAULT_METADATA_FORMAT,
    getUserSettings
  };
})();

// For use in browser extension contexts (not modules)
if (typeof window !== 'undefined') {
  window.SettingsUtils = SettingsUtils;
}
