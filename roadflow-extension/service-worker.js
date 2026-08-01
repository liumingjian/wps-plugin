'use strict';

importScripts('configuration.js');

chrome.runtime.onMessage.addListener((request, sender, respond) => {
  if (request?.type !== 'apply-configuration') return false;
  if (sender.url !== chrome.runtime.getURL('options.html')) {
    respond({ ok: false, message: 'Configuration request was not authorized.' });
    return false;
  }

  const result = RoadFlowConfiguration.validate(request.configuration);
  if (!result.ok) {
    respond(result);
    return false;
  }
  const matches = [RoadFlowConfiguration.originPattern(result.value.trustedOrigin)];
  chrome.permissions.contains({ origins: matches }).then(async granted => {
    if (!granted) {
      respond({ ok: false, message: 'Trusted OA Origin access was not granted.' });
      return;
    }
    await chrome.storage.local.set({ [RoadFlowConfiguration.STORAGE_KEY]: result.value });
    respond({ ok: true, configuration: result.value });
  }).catch(() => respond({ ok: false, message: 'Configuration could not be applied.' }));
  return true;
});
