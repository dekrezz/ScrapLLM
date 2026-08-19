// LLMFeeder Settings Utilities
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
      redditMaxComments: 250
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
