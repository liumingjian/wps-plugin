'use strict';

(() => {
  function launch(permit) {
    const capability = RoadFlowFormatCapabilities.forFormat(permit?.format);
    if (!capability || !/^[a-f0-9]{48}$/.test(permit.permitId) || typeof permit.title !== 'string') {
      throw new Error('编辑授权无效');
    }
    const base = `/api/office/permits/${permit.permitId}`;
    const documentURL = new URL(permit.documentUrl, location.origin);
    const officeSaveURL = new URL(permit.saveUrl, location.origin);
    const deliveryURL = new URL(permit.deliveryCheckUrl, location.origin);
    for (const url of [documentURL, officeSaveURL, deliveryURL]) {
      if (url.origin !== location.origin || url.username || url.password || url.search || url.hash) {
        throw new Error('编辑授权地址无效');
      }
    }
    if (!documentURL.pathname.startsWith(`${base}/document/`) ||
        !/^\/[^/]+$/.test(documentURL.pathname.slice(`${base}/document`.length)) ||
        officeSaveURL.pathname !== `${base}/save` || deliveryURL.pathname !== `${base}/delivery`) {
      throw new Error('编辑授权地址无效');
    }
    return {
      title: permit.title,
      expectedFormat: permit.format,
      editorKind: capability.editorKind,
      documentURL: documentURL.href,
      officeSaveURL: officeSaveURL.href,
      deliveryURL: deliveryURL.href,
      returnMode: 'close'
    };
  }

  async function checkDelivery(url, expected) {
    const timeout = new AbortController();
    const deadline = setTimeout(() => timeout.abort(), 10_000);
    try {
      while (!timeout.signal.aborted) {
        const response = await fetch(url, {
          credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: timeout.signal
        });
        if (response.status !== 200) break;
        const { delivered } = await response.json();
        if (delivered === expected) return;
        if (!expected || delivered !== false) break;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    } catch {
      // A transport or decoding failure also leaves the editor locked.
    } finally {
      clearTimeout(deadline);
    }
    throw new Error('无法确认 WPS 收到所选文件');
  }

  globalThis.FtpOfficeEditor = Object.freeze({ launch, checkDelivery });
})();
