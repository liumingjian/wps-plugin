'use strict';

function evaluate(configuration, environment) {
  if (!RoadFlowConfiguration.validate(configuration).ok) {
    return Object.freeze({
      state: 'missing-configuration',
      title: 'Configuration required',
      guidance: 'Open extension settings and save one Trusted OA Origin and one Gateway URL template.'
    });
  }
  if (!environment.npapiAvailable) {
    return Object.freeze({
      state: 'wps-npapi-unavailable',
      title: 'WPS or browser plugin unavailable',
      guidance: 'Verify the designated WPS installation and enable its browser plugin and NPAPI support in Qaxbrowser, then restart the browser.'
    });
  }
  return Object.freeze({
    state: 'ready',
    title: 'Environment ready',
    guidance: 'This browser profile is ready for RoadFlow Document editing.'
  });
}

function detectEnvironment(wpsObject, browserNavigator) {
  const plugins = Array.from(browserNavigator?.plugins || []);
  const mimeType = browserNavigator?.mimeTypes?.namedItem?.('application/x-wps');
  const pluginAdvertised = Boolean(mimeType || plugins.some(plugin => /wps|kingsoft/i.test(plugin.name || '')));
  let application;
  try {
    application = wpsObject?.Application;
  } catch {
    // A blocked plugin object can throw while exposing its automation API.
  }
  const npapiAvailable = pluginAdvertised && Boolean(application) && ['function', 'object'].includes(typeof application);
  return Object.freeze({ npapiAvailable });
}

globalThis.RoadFlowReadiness = Object.freeze({ detectEnvironment, evaluate });

if (typeof document !== 'undefined') {
  const title = document.querySelector('#readiness-title');
  const guidance = document.querySelector('#readiness-guidance');
  const settings = document.querySelector('#open-settings');
  const probe = document.createElement('object');
  probe.type = 'application/x-wps';
  probe.hidden = true;
  document.body.append(probe);

  chrome.storage.local.get(RoadFlowConfiguration.STORAGE_KEY).then(async stored => {
    let environment = detectEnvironment(probe, navigator);
    for (let attempt = 0; !environment.npapiAvailable && attempt < 20; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 250));
      environment = detectEnvironment(probe, navigator);
    }
    const result = evaluate(stored[RoadFlowConfiguration.STORAGE_KEY], environment);
    document.body.dataset.readiness = result.state;
    title.textContent = result.title;
    guidance.textContent = result.guidance;
  }).catch(() => {
    title.textContent = 'Readiness unavailable';
    guidance.textContent = 'Open extension settings and verify this browser profile configuration.';
  });
  settings.addEventListener('click', () => chrome.runtime.openOptionsPage());
}
