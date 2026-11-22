'use strict';

(() => {
  const origin = FtpOfficeOrigin;
  const isTextEditorAvailable = navigator.mimeTypes.namedItem('application/x-wps');
  const isSpreadsheetEditorAvailable = navigator.mimeTypes.namedItem('application/x-et');
  if (window !== top || location.origin !== origin || !isTextEditorAvailable || !isSpreadsheetEditorAvailable) return;

  const markAvailable = () => document.documentElement.setAttribute(
    'data-ftp-office-plugin', chrome.runtime.getManifest().version
  );
  if (document.documentElement) markAvailable();
  else document.addEventListener('DOMContentLoaded', markAvailable, { once: true });

  async function asset(name) {
    const response = await fetch(chrome.runtime.getURL(name));
    if (!response.ok) throw new Error('编辑器资源无法加载');
    return response.text();
  }

  function inlineScript(doc, source) {
    const script = doc.createElement('script');
    script.textContent = source;
    return script;
  }

  async function openEditor(popup, entry, fileId, versionId) {
    const response = await fetch(entry.href, {
      method: 'POST', credentials: 'same-origin', redirect: 'error', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ versionId })
    });
    if (response.status !== 201) throw new Error('无法开始编辑，请刷新文件列表后重试');
    const permit = await response.json();
    const supportedFormats = ['doc', 'docx', 'wps', 'xls', 'xlsx'];
    if (permit.versionId !== versionId || !supportedFormats.includes(permit.format) ||
        !/^[a-f0-9]{48}$/.test(permit.permitId) || typeof permit.title !== 'string') {
      throw new Error('编辑授权无效');
    }
    if (popup.closed) return;
    const [html, css, formats, integration, editor] = await Promise.all([
      asset('hosted-editor.html'), asset('hosted-editor.css'), asset('format-capabilities.js'),
      asset('ftp-editor.js'), asset('hosted-editor.js')
    ]);
    if (popup.closed) return;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const style = doc.createElement('style');
    style.textContent = css;
    doc.querySelector('link[rel="stylesheet"]').replaceWith(style);
    for (const script of doc.querySelectorAll('script')) script.remove();
    doc.title = 'ftp-master 在线编辑';
    doc.querySelector('#return-to-oa').textContent = '返回文件列表';
    doc.querySelector('#retry-verification').textContent = '返回后重新打开';
    const context = JSON.stringify({ ...permit, fileId }).replaceAll('<', '\\u003c');
    doc.body.append(inlineScript(doc, formats), inlineScript(doc, integration),
      inlineScript(doc, 'globalThis.FtpOfficePermit = ' + context + '\n'), inlineScript(doc, editor));
    const url = URL.createObjectURL(new Blob(['<!doctype html>', doc.documentElement.outerHTML], { type: 'text/html' }));
    try {
      popup.location.replace(url);
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
  }

  document.addEventListener('click', event => {
    const entry = event.target?.closest?.('a[data-ftp-office-edit="1"]');
    if (!entry || !event.isTrusted || event.defaultPrevented || event.button !== 0 ||
        event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || entry.origin !== origin ||
        entry.username || entry.password || entry.search || entry.hash ||
        !/^[1-9][0-9]*$/.test(entry.dataset.ftpOfficeVersion || '')) return;
    const fileId = /^\/api\/files\/([1-9][0-9]*)\/office-edits$/.exec(entry.pathname)?.[1];
    if (!fileId) return;
    const versionId = Number(entry.dataset.ftpOfficeVersion);
    if (!Number.isSafeInteger(versionId)) return;

    event.preventDefault();
    const popup = window.open('about:blank', '_blank');
    if (!popup) {
      window.alert('请允许本站打开编辑标签页，再试一次。');
      return;
    }
    popup.document.title = 'ftp-master 在线编辑';
    popup.document.body.textContent = '正在打开文档…';
    void openEditor(popup, entry, fileId, versionId).catch(error => {
      if (popup.closed) return;
      popup.document.body.textContent = error.message;
      const close = popup.document.createElement('button');
      close.type = 'button';
      close.textContent = '返回文件列表';
      close.addEventListener('click', () => popup.close());
      popup.document.body.append(' ', close);
    });
  }, true);
})();
