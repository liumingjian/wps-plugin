const HOST = 'com.liumingjian.wps_edit_agent';

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  chrome.runtime.sendNativeMessage(HOST, request, (response) => {
    if (chrome.runtime.lastError) {
      sendResponse({ version: 1, status: 'failed', taskId: request.taskId, documentId: request.documentId, message: `Local agent unavailable: ${chrome.runtime.lastError.message}` });
      return;
    }
    sendResponse(response);
  });
  return true;
});
