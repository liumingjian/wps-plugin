async page => {
  await page.reload();
  const status = await page.getByRole('status').textContent();
  if (!status || status === 'Failed to fetch') throw new Error(`Demo is not ready: ${status}`);

  const request = (message, match, timeoutMs = 7000) => page.evaluate(
    ({ message, match, timeoutMs }) => new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Bridge reply timeout for ${message.type}`)), timeoutMs);
      const listener = event => {
        if (event.data?.source !== 'wps-edit-extension-prototype') return;
        if (!match.every(([key, value]) => event.data?.[key] === value)) return;
        clearTimeout(timeout);
        window.removeEventListener('message', listener);
        resolve(event.data);
      };
      window.addEventListener('message', listener);
      window.postMessage({ source: 'wps-edit-sdk-prototype', version: 1, ...message }, location.origin);
    }),
    { message, match, timeoutMs }
  );

  const ping = await request({ type: 'ping' }, [['type', 'pong'], ['status', 'accepted']]);
  const success = await request(
    { type: 'notification-probe', outcome: 'success' },
    [['type', 'notification-shown'], ['outcome', 'success']]
  );
  const failure = await request(
    { type: 'notification-probe', outcome: 'failure' },
    [['type', 'notification-shown'], ['outcome', 'failure']]
  );
  const worker = page.context().serviceWorkers().find(value => value.url().includes('mjjoapeohdfkepmocpahbimmmenlfdcb'));
  if (!worker) throw new Error('Production extension service worker is missing.');
  const notifications = await worker.evaluate(() => new Promise(resolve => chrome.notifications.getAll(resolve)));
  for (const reply of [success, failure]) {
    if (reply.status !== 'completed' || !reply.notificationId || !notifications[reply.notificationId]) {
      throw new Error(`Notification was not retained by Qaxbrowser: ${JSON.stringify(reply)}`);
    }
  }
  return {
    page: page.url(),
    ping,
    success,
    failure,
    notificationIds: Object.keys(notifications)
  };
}
