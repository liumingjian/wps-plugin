#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const port = Number(process.env.ROADFLOW_EXCEL_DEMO_PORT || 4318);
const sourcePath = '/UploadFiles/2026/Acceptance.xls';
const initialPath = path.resolve(process.env.ROADFLOW_EXCEL_DEMO_FILE || '/tmp/file-editor/uploads/工作簿1.xls');
const stateDir = path.resolve(process.env.ROADFLOW_EXCEL_DEMO_STATE || '/tmp/roadflow-excel-save-demo');
const currentPath = path.join(stateDir, 'Acceptance.xls');
const maxUploadBytes = 25 << 20;
const saves = [];
const requests = [];

fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
if (!fs.existsSync(currentPath)) fs.copyFileSync(initialPath, currentPath);

function currentBytes() {
  return fs.readFileSync(currentPath);
}

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  response.end(body);
}

function html() {
  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>RoadFlow Excel 保存 Demo</title>
<style>body{max-width:760px;margin:48px auto;padding:0 24px;font:16px/1.6 sans-serif;color:#17202a}a{color:#1558b0;font-size:20px}code,pre{background:#f3f5f7;padding:12px;display:block;overflow:auto}dt{font-weight:600}dd{margin:0 0 8px}</style></head>
<body>
<h1>RoadFlow Excel 保存 Demo</h1>
<p>此页面提供同源 Excel 下载和 OfficeSave 接口，供 Qaxbrowser + WPS ET 验证。</p>
<p><a href="${sourcePath}">打开 Acceptance.xls</a></p>
<dl><dt>Trusted OA Origin</dt><dd><code>http://127.0.0.1:${port}</code></dd>
<dt>OfficeSave</dt><dd><code>POST /RoadFlow/uploadfiles/OfficeSave?fileurl=${sourcePath}</code></dd></dl>
<h2>最近保存</h2><pre id="diagnostics">loading...</pre>
<script>async function refresh(){const r=await fetch('/diagnostics',{cache:'no-store'});document.querySelector('#diagnostics').textContent=JSON.stringify(await r.json(),null,2)} refresh(); setInterval(refresh,2000);</script>
</body></html>`;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', chunk => {
      size += chunk.length;
      if (size > maxUploadBytes) {
        reject(new Error('request too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function dispositionValue(value, name) {
  const match = new RegExp(`${name}="([^"]*)"`, 'i').exec(value || '');
  return match ? match[1] : undefined;
}

function parseMultipart(body, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!match) throw new Error('multipart boundary missing');
  const boundary = Buffer.from(`--${match[1] || match[2]}`);
  const separator = Buffer.from('\r\n\r\n');
  const nextBoundary = Buffer.from(`\r\n${boundary.toString()}`);
  const parts = [];
  let cursor = body.indexOf(boundary);
  if (cursor !== 0) throw new Error('multipart boundary invalid');

  while (cursor !== -1) {
    let contentStart = cursor + boundary.length;
    if (body.subarray(contentStart, contentStart + 2).toString() === '--') break;
    if (body.subarray(contentStart, contentStart + 2).toString() !== '\r\n') throw new Error('multipart delimiter invalid');
    contentStart += 2;
    const headerEnd = body.indexOf(separator, contentStart);
    if (headerEnd === -1) throw new Error('multipart headers missing');
    const headers = body.subarray(contentStart, headerEnd).toString('utf8');
    const dataStart = headerEnd + separator.length;
    const dataEnd = body.indexOf(nextBoundary, dataStart);
    if (dataEnd === -1) throw new Error('multipart body incomplete');
    const disposition = /content-disposition:\s*([^\r\n]+)/i.exec(headers)?.[1] || '';
    parts.push({
      name: dispositionValue(disposition, 'name'),
      filename: dispositionValue(disposition, 'filename'),
      data: body.subarray(dataStart, dataEnd)
    });
    cursor = dataEnd + 2;
  }
  return parts;
}

async function saveOfficeFile(request, response, requestURL) {
  const requestRecord = {
    at: new Date().toISOString(),
    method: request.method,
    path: requestURL.pathname,
    query: requestURL.search,
    contentType: request.headers['content-type'] || '',
    bytes: 0,
    status: 0
  };
  requests.push(requestRecord);
  if (requestURL.searchParams.get('fileurl') !== sourcePath) {
    requestRecord.status = 403;
    requestRecord.code = 'overwrite_forbidden';
    json(response, 403, { Success: false, Code: 'overwrite_forbidden', Message: 'fileurl mismatch' });
    return;
  }
  try {
    const body = await readBody(request);
    requestRecord.bytes = body.length;
    const parts = parseMultipart(body, request.headers['content-type']);
    requestRecord.parts = parts.map(part => ({
      name: part.name,
      filename: part.filename,
      bytes: part.data.length,
      ...(part.filename || part.data.length <= 1024
        ? { text: part.filename ? undefined : part.data.toString('utf8') }
        : { textLength: part.data.length })
    }));
    const fields = Object.fromEntries(parts.filter(part => !part.filename && part.name !== 'file').map(part => [part.name, part.data.toString('utf8')]));
    const standardFilePart = parts.find(part => part.name === 'filedata' && part.filename);
    const nativeETFilePart = parts.find(part => part.name === 'file' && !part.filename);
    const isNativeETUpload = Boolean(nativeETFilePart?.data.length) && !standardFilePart && Object.keys(fields).length === 0;
    const filePart = standardFilePart || nativeETFilePart;
    if ((!isNativeETUpload && (fields.filename !== 'formId:formeditor' || !/^[a-f0-9]{32}$/.test(fields.md5sum || ''))) || !filePart?.data.length) {
      requestRecord.status = 400;
      requestRecord.code = 'invalid_multipart';
      json(response, 400, { Success: false, Code: 'invalid_multipart', Message: 'OfficeSave fields are invalid' });
      return;
    }
    const md5sum = crypto.createHash('md5').update(filePart.data).digest('hex');
    if (!isNativeETUpload && md5sum !== fields.md5sum) {
      requestRecord.status = 400;
      requestRecord.code = 'checksum_mismatch';
      json(response, 400, { Success: false, Code: 'checksum_mismatch', Message: 'md5sum mismatch' });
      return;
    }
    fs.writeFileSync(currentPath, filePart.data, { mode: 0o600 });
    const receipt = {
      at: new Date().toISOString(),
      fileurl: sourcePath,
      filename: isNativeETUpload ? '' : fields.filename,
      uploadFilename: filePart.filename,
      bytes: filePart.data.length,
      md5sum,
      transport: isNativeETUpload ? 'wps-et-save-document-to-server' : 'wps-formdata',
      userAgent: request.headers['user-agent'] || '',
      contentType: request.headers['content-type'] || ''
    };
    saves.push(receipt);
    requestRecord.status = 200;
    requestRecord.code = 'overwrite_committed';
    console.log(`[OfficeSave] committed ${JSON.stringify(receipt)}`);
    json(response, 200, { Success: true, Code: 'overwrite_committed', Message: 'Document overwritten.', Data: receipt });
  } catch (error) {
    requestRecord.status = 400;
    requestRecord.code = 'invalid_multipart';
    requestRecord.error = error.message;
    console.error(`[OfficeSave] rejected ${error.message}`);
    json(response, 400, { Success: false, Code: 'invalid_multipart', Message: error.message });
  }
}

const server = http.createServer(async (request, response) => {
  const requestURL = new URL(request.url, `http://127.0.0.1:${port}`);
  if (request.method === 'GET' && requestURL.pathname === '/') {
    const body = html();
    response.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
    response.end(body);
    return;
  }
  if (request.method === 'GET' && decodeURIComponent(requestURL.pathname) === sourcePath) {
    const bytes = currentBytes();
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Disposition': 'attachment; filename="Acceptance.xls"',
      'Content-Length': bytes.length,
      'Content-Type': 'application/vnd.ms-excel'
    });
    response.end(bytes);
    return;
  }
  if (request.method === 'POST' && requestURL.pathname === '/RoadFlow/uploadfiles/OfficeSave') {
    await saveOfficeFile(request, response, requestURL);
    return;
  }
  if (request.method === 'GET' && requestURL.pathname === '/diagnostics') {
    const bytes = currentBytes();
    json(response, 200, {
      sourcePath,
      currentBytes: bytes.length,
      currentMD5: crypto.createHash('md5').update(bytes).digest('hex'),
      requests,
      saves
    });
    return;
  }
  if (request.method === 'GET' && requestURL.pathname === '/healthz') {
    response.writeHead(204);
    response.end();
    return;
  }
  json(response, 404, { error: 'not found' });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`RoadFlow Excel save demo: http://127.0.0.1:${port}`);
  console.log(`Initial file: ${initialPath}`);
  console.log(`State file: ${currentPath}`);
});
