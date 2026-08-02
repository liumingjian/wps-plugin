'use strict';

const form = document.querySelector('#setup-form');
const originInput = document.querySelector('#trusted-origin');
const templateInput = document.querySelector('#gateway-template');
const message = document.querySelector('#form-message');
let savedConfiguration;

async function loadSavedConfiguration() {
  const stored = await chrome.storage.local.get(RoadFlowConfiguration.STORAGE_KEY);
  const result = RoadFlowConfiguration.validate(stored[RoadFlowConfiguration.STORAGE_KEY]);
  if (!result.ok) return;
  savedConfiguration = result.value;
  originInput.value = result.value.trustedOrigin;
  templateInput.value = result.value.gatewayTemplate;
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  message.textContent = '';
  const result = RoadFlowConfiguration.validate({
    trustedOrigin: originInput.value,
    gatewayTemplate: templateInput.value
  });
  if (!result.ok) {
    message.textContent = result.message;
    return;
  }

  const requestedPatterns = RoadFlowConfiguration.permissionPatterns(result.value);
  try {
    const granted = await chrome.permissions.request({ origins: requestedPatterns });
    if (!granted) {
      message.textContent = 'Origin access was not granted. Configuration was not changed.';
      return;
    }
    const response = await chrome.runtime.sendMessage({ type: 'apply-configuration', configuration: result.value });
    if (!response?.ok) {
      const retained = savedConfiguration ? RoadFlowConfiguration.permissionPatterns(savedConfiguration) : [];
      await chrome.permissions.remove({ origins: requestedPatterns.filter(pattern => !retained.includes(pattern)) });
      message.textContent = response?.message || 'Configuration could not be applied.';
      return;
    }
    if (savedConfiguration) {
      const active = RoadFlowConfiguration.permissionPatterns(result.value);
      const obsolete = RoadFlowConfiguration.permissionPatterns(savedConfiguration)
        .filter(pattern => !active.includes(pattern));
      if (obsolete.length > 0) await chrome.permissions.remove({ origins: obsolete });
    }
  } catch {
    message.textContent = 'Configuration could not be applied. Check browser extension permissions and try again.';
    return;
  }
  savedConfiguration = result.value;
  message.textContent = 'Configuration saved for this browser profile.';
});

void loadSavedConfiguration();
