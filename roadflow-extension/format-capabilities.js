'use strict';

(() => {
  const definitions = [
    { format: 'doc', extension: '.doc', editorKind: 'writer', mimeType: 'application/x-wps', validation: 'doc', revisionTracking: true },
    { format: 'docx', extension: '.docx', editorKind: 'writer', mimeType: 'application/x-wps', validation: 'docx', revisionTracking: true },
    { format: 'wps', extension: '.wps', editorKind: 'writer', mimeType: 'application/x-wps', validation: 'wps', revisionTracking: true },
    { format: 'xls', extension: '.xls', editorKind: 'spreadsheet', mimeType: 'application/x-et', validation: 'xls', revisionTracking: true },
    { format: 'xlsx', extension: '.xlsx', editorKind: 'spreadsheet', mimeType: 'application/x-et', validation: 'xlsx', revisionTracking: true }
  ].map(Object.freeze);

  const byFormat = Object.freeze(Object.fromEntries(definitions.map(definition => [definition.format, definition])));
  const byExtension = Object.freeze(Object.fromEntries(definitions.map(definition => [definition.extension, definition])));

  function pathWithoutQuery(value) {
    if (typeof value !== 'string') return '';
    return value.split(/[?#]/, 1)[0];
  }

  function forPath(value) {
    const path = pathWithoutQuery(value);
    const filename = path.slice(path.lastIndexOf('/') + 1);
    const dot = filename.lastIndexOf('.');
    if (dot <= 0) return undefined;
    return byExtension[filename.slice(dot).toLowerCase()];
  }

  function forFormat(value) {
    return typeof value === 'string' ? byFormat[value.toLowerCase()] : undefined;
  }

  function isLikelyPath(value) {
    if (typeof value !== 'string') return false;
    return definitions.some(definition => {
      const escapedExtension = definition.extension.replace('.', '\\.');
      return new RegExp(`${escapedExtension}(?:[?#]|$)`, 'i').test(value);
    });
  }

  globalThis.RoadFlowFormatCapabilities = Object.freeze({
    formats: Object.freeze(definitions),
    forFormat,
    forPath,
    isLikelyPath
  });
})();
