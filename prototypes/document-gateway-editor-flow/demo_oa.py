#!/usr/bin/env python3
import datetime
import email
import hashlib
import io
import json
import os
import urllib.parse
import zipfile
from http import cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


STATE = Path(os.environ.get("GATEWAY_FLOW_STATE", "/tmp/wps-document-gateway-flow"))
LOG = STATE / "requests.jsonl"
CURRENT = STATE / "contract.current.bin"
SESSION_NAME = "oa_session"
SESSION_VALUE = "ticket-40-demo-session"
SOURCE_PATH = "/UploadFiles/2026/quarterly-report.docx"
SAVE_PATH = "/RoadFlow/uploadfiles/OfficeSave"
GATEWAY_PATH = "/wps/v1/document"


def now():
    return datetime.datetime.utcnow().isoformat(timespec="milliseconds") + "Z"


def write_log(entry):
    STATE.mkdir(parents=True, exist_ok=True)
    with LOG.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry, ensure_ascii=False, sort_keys=True) + "\n")


def minimal_docx():
    files = {
        "[Content_Types].xml": """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>""",
        "_rels/.rels": """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>""",
        "word/document.xml": """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:r><w:t>Ticket 40 configured Document Gateway prototype</w:t></w:r></w:p><w:sectPr/>
</w:body></w:document>""",
    }
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, value in files.items():
            archive.writestr(name, value)
    return output.getvalue()


def ensure_document():
    STATE.mkdir(parents=True, exist_ok=True)
    if not CURRENT.exists():
        CURRENT.write_bytes(minimal_docx())
    return CURRENT.read_bytes()


def artifact_format(data):
    if data.startswith(b"PK\x03\x04"):
        return "DOCX/ZIP"
    if data.startswith(bytes.fromhex("d0cf11e0a1b11ae1")):
        return "CFB/OLE"
    return "unknown"


def artifact_contains(data, marker):
    if not marker:
        return None
    if data.startswith(b"PK\x03\x04"):
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                return any(marker in archive.read(name).decode("utf-8", errors="ignore") for name in archive.namelist())
        except zipfile.BadZipFile:
            return False
    return marker in data.decode("latin1", errors="ignore") or marker in data.decode("utf-16le", errors="ignore")


def parse_fields(body, content_type):
    message = email.message_from_bytes(
        (f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n").encode() + body
    )
    fields = []
    filedata = None
    for part in message.walk():
        if part.is_multipart() or "form-data" not in part.get("Content-Disposition", ""):
            continue
        name = part.get_param("name", header="content-disposition") or ""
        payload = part.get_payload(decode=True) or b""
        fields.append({
            "name": name,
            "filename": part.get_filename(),
            "contentType": part.get_content_type(),
            "bytes": len(payload),
            "value": payload.decode("utf-8", errors="replace") if len(payload) < 512 else None,
        })
        if name == "filedata":
            filedata = payload
    return fields, filedata


def oa_page():
    return """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Demo OA - Document Center</title><style>
*{box-sizing:border-box}body{margin:0;background:#f4f6f8;color:#18222d;font:14px/1.5 Arial,sans-serif;letter-spacing:0}
header{height:52px;display:flex;align-items:center;padding:0 28px;background:#243746;color:#fff;font-weight:700}
main{max-width:960px;margin:32px auto;padding:0 20px}h1{font-size:22px;margin:0 0 6px}p{color:#5b6775;margin:0 0 24px}
.table{background:#fff;border:1px solid #d6dce3;border-radius:6px;overflow:hidden}.row{display:grid;grid-template-columns:1fr 150px 160px;align-items:center;min-height:58px;padding:0 18px;border-top:1px solid #e2e6eb}.row:first-child{border-top:0;background:#f8f9fa;font-size:12px;font-weight:700;color:#5b6775}.doc{font-weight:600;color:#1769aa;text-decoration:none}.doc:hover{text-decoration:underline}.tag{color:#137333}.note{margin-top:18px;padding:12px 14px;border-left:3px solid #1769aa;background:#eaf3fa;color:#334252}
</style></head><body><header>RoadFlow Demo OA</header><main><h1>Document Center</h1><p>The browser session is authenticated. Open the current Word document from its normal link.</p>
<section class="table"><div class="row"><span>Document</span><span>Status</span><span>Updated</span></div><div class="row"><a class="doc" id="document-link" href="/UploadFiles/2026/quarterly-report.docx">Quarterly report.docx</a><span class="tag">Ready</span><span>Today</span></div></section>
<div class="note" id="oa-state">The originating OA tab remains open while the packaged WPS editor runs in a new tab.</div>
</main></body></html>""".encode()


class Handler(BaseHTTPRequestHandler):
    server_version = "Ticket40DemoOA/0.1"

    def request_cookie(self):
        return self.headers.get("Cookie", "")

    def authenticated(self):
        jar = cookies.SimpleCookie()
        jar.load(self.request_cookie())
        return SESSION_NAME in jar and jar[SESSION_NAME].value == SESSION_VALUE

    def record(self, status, extra=None):
        entry = {
            "time": now(),
            "method": self.command,
            "path": self.path,
            "status": status,
            "cookie": self.request_cookie(),
            "headers": dict(self.headers),
        }
        if extra:
            entry.update(extra)
        write_log(entry)

    def send_body(self, status, content_type, body, headers=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        for name, value in headers or []:
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.record(204)
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(parsed.query)

        if parsed.path == "/oa/session/start":
            self.record(302, {"setCookie": SESSION_VALUE})
            self.send_body(302, "text/plain", b"session ready", [
                ("Set-Cookie", f"{SESSION_NAME}={SESSION_VALUE}; Path=/; HttpOnly; SameSite=Lax"),
                ("Location", "/oa"),
            ])
            return

        if parsed.path == "/oa":
            if not self.authenticated():
                self.record(302, {"auth": "missing"})
                self.send_body(302, "text/plain", b"login required", [("Location", "/oa/session/start")])
                return
            body = oa_page()
            self.record(200, {"auth": "accepted"})
            self.send_body(200, "text/html; charset=utf-8", body)
            return

        if parsed.path == "/favicon.ico":
            self.record(204)
            self.send_body(204, "image/x-icon", b"")
            return

        if parsed.path == GATEWAY_PATH:
            source_path = query.get("fileurl", [""])[0]
            if source_path != SOURCE_PATH:
                body = b"<!doctype html><title>Gateway error</title><p>Unknown Document.</p>"
                self.record(404, {"gateway": True, "decodedFileurl": source_path})
                self.send_body(404, "text/html; charset=utf-8", body)
                return
            data = ensure_document()
            self.record(200, {
                "gateway": True,
                "decodedFileurl": source_path,
                "auth": "network-trusted-no-cookie-required",
                "artifactFormat": artifact_format(data),
            })
            self.send_body(200, "application/vnd.openxmlformats-officedocument.wordprocessingml.document", data, [
                ("Content-Disposition", 'attachment; filename="quarterly-report.docx"'),
                ("Cache-Control", "no-store, no-cache, must-revalidate"),
                ("Pragma", "no-cache"),
                ("Expires", "0"),
            ])
            return

        if parsed.path == SOURCE_PATH:
            if not self.authenticated():
                self.record(401, {"auth": "missing"})
                self.send_body(401, "text/plain", b"OA session required")
                return
            data = ensure_document()
            self.record(200, {"auth": "accepted", "directSource": True})
            self.send_body(200, "application/vnd.openxmlformats-officedocument.wordprocessingml.document", data)
            return

        if parsed.path == "/__evidence":
            entries = []
            if LOG.exists():
                entries = [json.loads(line) for line in LOG.read_text(encoding="utf-8").splitlines() if line]
            data = ensure_document()
            marker = query.get("marker", [""])[0]
            body = json.dumps({
                "requests": entries,
                "artifact": {
                    "bytes": len(data),
                    "sha256": hashlib.sha256(data).hexdigest(),
                    "format": artifact_format(data),
                    "marker": marker or None,
                    "markerPresent": artifact_contains(data, marker),
                },
            }, ensure_ascii=False, indent=2).encode()
            self.record(200)
            self.send_body(200, "application/json; charset=utf-8", body)
            return

        self.record(404)
        self.send_body(404, "text/plain", b"not found")

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != SAVE_PATH:
            self.record(404)
            self.send_body(404, "text/plain", b"not found")
            return

        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length)
        fields, filedata = parse_fields(raw, self.headers.get("Content-Type", ""))
        source_path = urllib.parse.parse_qs(parsed.query).get("fileurl", [""])[0]
        if not self.authenticated():
            response = {"Success": False, "Message": "OA session required", "Data": None}
            body = json.dumps(response).encode()
            self.record(401, {"auth": "missing", "decodedFileurl": source_path, "multipartFields": fields, "response": response})
            self.send_body(401, "application/json; charset=utf-8", body)
            return
        if source_path != SOURCE_PATH or filedata is None:
            response = {"Success": False, "Message": "Invalid overwrite request", "Data": None}
            body = json.dumps(response).encode()
            self.record(400, {"auth": "accepted", "decodedFileurl": source_path, "multipartFields": fields})
            self.send_body(400, "application/json; charset=utf-8", body)
            return

        CURRENT.write_bytes(filedata)
        response = {"Success": True, "Message": "Document overwritten", "Data": {"fileurl": SOURCE_PATH}}
        body = json.dumps(response, ensure_ascii=False).encode()
        self.record(200, {
            "auth": "accepted",
            "decodedFileurl": source_path,
            "multipartFields": fields,
            "storedBytes": len(filedata),
            "storedSha256": hashlib.sha256(filedata).hexdigest(),
            "storedFormat": artifact_format(filedata),
            "response": response,
        })
        self.send_body(200, "application/json; charset=utf-8", body)

    def log_message(self, _format, *_args):
        return


if __name__ == "__main__":
    STATE.mkdir(parents=True, exist_ok=True)
    port = int(os.environ.get("GATEWAY_FLOW_PORT", "49240"))
    print(f"Demo OA listening at http://127.0.0.1:{port}/oa/session/start", flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
