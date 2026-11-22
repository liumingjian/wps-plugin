#!/usr/bin/env node
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const repo = fileURLToPath(new URL('../', import.meta.url));
const rawOrigin = process.env.FTP_MASTER_ORIGIN;
const origin = new URL(rawOrigin || 'about:blank');
if (!['http:', 'https:'].includes(origin.protocol) || rawOrigin !== origin.origin) {
  throw new Error('Set FTP_MASTER_ORIGIN to the exact ftp-master HTTP or HTTPS origin.');
}
const output = resolve(process.env.OUTPUT || `${repo}/dist/release/ftp-master-extension`);
const files = ['format-capabilities.js', 'hosted-editor.html', 'hosted-editor.css', 'hosted-editor.js'];
const manifest = {
  manifest_version: 3,
  name: 'ftp-master WPS Editor',
  version: '0.1.0',
  content_scripts: [{ matches: [`${origin.origin}/*`], js: ['origin.js', 'content.js'], run_at: 'document_start' }],
  web_accessible_resources: [{ resources: [...files, 'ftp-editor.js'], matches: [`${origin.origin}/*`] }],
  icons: { 128: 'icon.png' }
};
await mkdir(resolve(output, '..'), { recursive: true });
await mkdir(output);
await Promise.all([
  ...files.map(file => copyFile(resolve(repo, 'roadflow-extension', file), resolve(output, file))),
  ...['ftp-editor.js', 'content.js'].map(file => copyFile(resolve(repo, 'ftp-master-extension', file), resolve(output, file))),
  writeFile(resolve(output, 'origin.js'), `const FtpOfficeOrigin = ${JSON.stringify(origin.origin)};\n`),
  writeFile(resolve(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n'),
  readFile(resolve(repo, 'extension/icon.png.base64'), 'ascii')
    .then(icon => writeFile(resolve(output, 'icon.png'), Buffer.from(icon, 'base64')))
]);
console.log(output);
