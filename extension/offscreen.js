// ScrapLLM offscreen parser (Chrome MV3 only)
//
// The service worker fetches a research source's HTML and sends it here to be
// parsed and converted, because a worker has no DOM and Readability needs one.
// One document serves a whole run; parsing a page costs single-digit
// milliseconds, so the three concurrent sources simply queue behind each other.
//
// `chrome.runtime` is the only extensions API available in an offscreen
// document, which is why this file never touches tabs or storage.

const OFFSCREEN_TARGET = 'scrapllm-offscreen';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Messages for anyone else (the popup's port traffic, for instance) are not
  // ours to answer: returning false leaves them for their real listener.
  if (!message || message.target !== OFFSCREEN_TARGET) return false;

  if (message.action === 'convertHtml') {
    try {
      const result = ScrapLLMConvert.convertHtml({
        html: message.html,
        url: message.url,
        title: message.title,
        settings: message.settings || {}
      });
      sendResponse({ success: true, result });
    } catch (error) {
      sendResponse({ success: false, error: (error && error.message) || String(error) });
    }
    return false;
  }

  // A text/plain or text/markdown source never reaches the converter, but its
  // token count still has to come from the same estimator as everything else.
  if (message.action === 'estimateTokens') {
    try {
      sendResponse({ success: true, tokenCount: ScrapLLMConvert.estimateTokens(message.markdown) });
    } catch (error) {
      sendResponse({ success: false, error: (error && error.message) || String(error) });
    }
    return false;
  }

  sendResponse({ success: false, error: `Unknown offscreen action: ${message.action}` });
  return false;
});
