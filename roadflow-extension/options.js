'use strict';

const form = document.querySelector('#setup-form');
const originInput = document.querySelector('#trusted-origin');
const message = document.querySelector('#form-message');
let savedConfiguration;
const DEBUG_PREFIX = '[RoadFlow WPS debug]';

function debug(event, details = {}) {
  if (typeof globalThis.console?.info !== 'function') return;
  console.info(`${DEBUG_PREFIX} ${event}`, details);
}

async function loadSavedConfiguration() {
  const stored = await chrome.storage.local.get(RoadFlowConfiguration.STORAGE_KEY);
  const result = RoadFlowConfiguration.validate(stored[RoadFlowConfiguration.STORAGE_KEY]);
  if (!result.ok) {
    debug('options-configuration-invalid', { message: result.message });
    return;
  }
  savedConfiguration = result.value;
  originInput.value = result.value.trustedOrigin;
  debug('options-configuration-loaded', {
    trustedOrigin: result.value.trustedOrigin,
    requestedPatterns: RoadFlowConfiguration.permissionPatterns(result.value)
  });
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  message.textContent = '';
  const result = RoadFlowConfiguration.validate({
    trustedOrigin: originInput.value
  });
  if (!result.ok) {
    debug('options-configuration-invalid', { message: result.message });
    message.textContent = result.message;
    return;
  }

  const requestedPatterns = RoadFlowConfiguration.permissionPatterns(result.value);
  debug('options-permission-requested', {
    trustedOrigin: result.value.trustedOrigin,
    requestedPatterns
  });
  try {
    const granted = await chrome.permissions.request({ origins: requestedPatterns });
    debug('options-permission-response', { granted, requestedPatterns });
    if (!granted) {
      message.textContent = 'Origin access was not granted. Configuration was not changed.';
      return;
    }
    const stillGranted = await chrome.permissions.contains({ origins: requestedPatterns });
    debug('options-permission-verified', { granted: stillGranted, requestedPatterns });
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
    debug('options-configuration-failed', {
      error: { name: error?.name, message: error?.message, stack: error?.stack }
    });
    console.error('RoadFlow configuration could not be applied:', error);
    message.textContent = 'Configuration could not be applied. Check browser extension permissions and try again.';
    return;
  }
  savedConfiguration = result.value;
  debug('options-configuration-saved', { trustedOrigin: result.value.trustedOrigin });
  message.textContent = 'Configuration saved for this browser profile.';
});

void loadSavedConfiguration();
