(function installDocumentLinkInterceptor() {
  "use strict";

  function eligibleAnchor(event) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;
    const anchor = event.composedPath().find((node) => node instanceof HTMLAnchorElement);
    if (!anchor || !anchor.href) return null;
    const url = new URL(anchor.href, location.href);
    if (url.origin !== location.origin || !/\.(doc|docx)$/i.test(url.pathname)) return null;
    return { anchor, url };
  }

  document.addEventListener("click", (event) => {
    const match = eligibleAnchor(event);
    if (!match) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    document.documentElement.dataset.gatewayFlow = "intercepted";
    chrome.runtime.sendMessage({
      type: "intercept-document-link",
      sourceUrl: match.url.href,
      sourcePath: match.url.pathname,
      title: match.anchor.download || match.anchor.textContent.trim() || match.url.pathname.split("/").pop()
    }, (response) => {
      if (chrome.runtime.lastError || !response || !response.ok) {
        document.documentElement.dataset.gatewayFlow = "failed";
        document.documentElement.dataset.gatewayFlowError = chrome.runtime.lastError?.message || response?.error || "No extension response";
        return;
      }
      document.documentElement.dataset.gatewayFlow = "editor-opened";
    });
  }, true);
})();
