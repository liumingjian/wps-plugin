'use strict';

(() => {
  const maxOfficeBytes = 25 * 1024 * 1024;

  function launch(permit) {
    const capability = RoadFlowFormatCapabilities.forFormat(permit?.format);
    if (!capability || !/^[a-f0-9]{48}$/.test(permit.permitId) ||
        typeof permit.title !== 'string' || !/^[1-9][0-9]*$/.test(permit.fileId) ||
        !Number.isSafeInteger(permit.versionId) || permit.versionId < 1) {
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
      fileId: permit.fileId,
      versionId: permit.versionId,
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

  async function saveSpreadsheet(application, context) {
    if (typeof application?.saveAsBase64Str !== 'function') throw new Error('WPS 表格导出接口不可用');
    const encoded = application.saveAsBase64Str(context.expectedFormat);
    if (typeof encoded !== 'string' || !encoded || encoded.length > 4 * Math.ceil(maxOfficeBytes / 3)) {
      throw new Error('WPS 表格导出失败或超出 25 MiB');
    }
    const raw = atob(encoded);
    if (!raw.length || raw.length > maxOfficeBytes) throw new Error('WPS 表格导出失败或超出 25 MiB');
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
    const body = new FormData();
    body.append('file', new Blob([bytes]), '');
    const response = await fetch(context.officeSaveURL, {
      method: 'POST', credentials: 'same-origin', redirect: 'error', cache: 'no-store', body
    });
    if (!response.ok || (await response.json()).Success !== true) throw new Error('保存失败');
  }

  async function refreshFileVersion(context) {
    try {
      if (!window.opener || window.opener.closed || window.opener.location.origin !== location.origin) return true;
      const timeout = new AbortController();
      const deadline = setTimeout(() => timeout.abort(), 5000);
      try {
        const response = await fetch(new URL(`/api/tree/${context.fileId}/versions`, location.origin), {
          credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: timeout.signal
        });
        if (!response.ok) return false;
        const [latest] = await response.json();
        if (!Number.isSafeInteger(latest?.id) || latest.id <= context.versionId ||
            !RoadFlowFormatCapabilities.forFormat(latest.format) ||
            !Number.isSafeInteger(latest.size) || latest.size <= 0 || latest.size > maxOfficeBytes) return false;
        const editURL = new URL(`/api/files/${context.fileId}/office-edits`, location.origin).href;
        for (const entry of window.opener.document.querySelectorAll('a[data-ftp-office-edit="1"]')) {
          if (entry.href === editURL && Number(entry.dataset.ftpOfficeVersion) < latest.id) {
            entry.dataset.ftpOfficeVersion = String(latest.id);
          }
        }
        return true;
      } finally {
        clearTimeout(deadline);
      }
    } catch {
      return false;
    }
  }

  globalThis.FtpOfficeEditor = Object.freeze({ launch, checkDelivery, saveSpreadsheet, refreshFileVersion });
})();
