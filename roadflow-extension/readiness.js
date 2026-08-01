'use strict';

function evaluate(configuration, environment) {
  if (!RoadFlowConfiguration.validate(configuration).ok) {
    return Object.freeze({
      state: 'missing-configuration',
      title: 'Configuration required',
      guidance: 'Open extension settings and save one Trusted OA Origin and one Gateway URL template.'
    });
  }
  if (!environment.wpsInstalled) {
    return Object.freeze({
      state: 'wps-unavailable',
      title: 'WPS unavailable',
      guidance: 'Install the designated WPS build with its browser component, then restart Qaxbrowser.'
    });
  }
  if (!environment.npapiAvailable) {
    return Object.freeze({
      state: 'npapi-unavailable',
      title: 'WPS browser plugin unavailable',
      guidance: 'Enable the WPS browser plugin and NPAPI support in Qaxbrowser, then restart the browser.'
    });
  }
  return Object.freeze({
    state: 'ready',
    title: 'Environment ready',
    guidance: 'This browser profile is ready for RoadFlow Word editing.'
  });
}

function detectEnvironment(wpsObject, browserNavigator) {
  const plugins = Array.from(browserNavigator?.plugins || []);
  const mimeType = browserNavigator?.mimeTypes?.namedItem?.('application/x-wps');
  const wpsInstalled = Boolean(mimeType || plugins.some(plugin => /wps|kingsoft/i.test(plugin.name || '')));
  let application;
  try {
    application = wpsObject?.Application;
  } catch {
    // A blocked plugin object can throw while exposing its automation API.
  }
  const npapiAvailable = Boolean(application) && ['function', 'object'].includes(typeof application);
  return Object.freeze({ wpsInstalled, npapiAvailable });
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
    for (let attempt = 0; environment.wpsInstalled && !environment.npapiAvailable && attempt < 20; attempt += 1) {
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
