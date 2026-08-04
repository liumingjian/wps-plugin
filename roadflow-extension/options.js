'use strict';

const form = document.querySelector('#setup-form');
const originInput = document.querySelector('#trusted-origin');
const message = document.querySelector('#form-message');
let savedConfiguration;

async function loadSavedConfiguration() {
  const stored = await chrome.storage.local.get(RoadFlowConfiguration.STORAGE_KEY);
  const result = RoadFlowConfiguration.validate(stored[RoadFlowConfiguration.STORAGE_KEY]);
  if (!result.ok) return;
  savedConfiguration = result.value;
  originInput.value = result.value.trustedOrigin;
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  message.textContent = '';
  const result = RoadFlowConfiguration.validate({
    trustedOrigin: originInput.value
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
    const stillGranted = await chrome.permissions.contains({ origins: requestedPatterns });
    if (!stillGranted) {
      message.textContent = 'Origin access was not granted. Configuration was not changed.';
      return;
    }

    // The options page is already an extension-owned, user-initiated boundary.
    // Persist directly after the browser confirms the requested Origin so a
    // sleeping or stale Service Worker cannot make setup fail.
    await chrome.storage.local.set({ [RoadFlowConfiguration.STORAGE_KEY]: result.value });
    if (savedConfiguration) {
      const active = RoadFlowConfiguration.permissionPatterns(result.value);
      const obsolete = RoadFlowConfiguration.permissionPatterns(savedConfiguration)
        .filter(pattern => !active.includes(pattern));
      if (obsolete.length > 0) {
        try { await chrome.permissions.remove({ origins: obsolete }); } catch {}
      }
    }
  } catch (error) {
    console.error('RoadFlow configuration could not be applied:', error);
    message.textContent = 'Configuration could not be applied. Check browser extension permissions and try again.';
    return;
  }
  savedConfiguration = result.value;
  message.textContent = 'Configuration saved for this browser profile.';
});

void loadSavedConfiguration();
