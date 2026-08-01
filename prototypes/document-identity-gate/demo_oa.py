#!/usr/bin/env python3
import datetime
import email
import hashlib
import io
import json
import os
import threading
import time
import urllib.parse
import zipfile
from http import cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


STATE = Path(os.environ.get("IDENTITY_GATE_STATE", "/tmp/wps-document-identity-gate"))
LOG = STATE / "requests.jsonl"
CURRENT = STATE / "document.current.bin"
SESSION_NAME = "oa_session"
SESSION_VALUE = "ticket-42-demo-session"
SOURCE_PATH = "/UploadFiles/2026/quarterly-report.docx"
SAVE_PATH = "/RoadFlow/uploadfiles/OfficeSave"
GATEWAY_PATH = "/wps/v1/document"
RECEIPT_PATH = "/wps/v1/delivery-receipt"
lock = threading.Lock()
prepared = {}
receipts = {}


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def write_log(entry):
    STATE.mkdir(parents=True, exist_ok=True)
    with lock:
        with LOG.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry, ensure_ascii=False, sort_keys=True) + "\n")


def minimal_docx(label):
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
        "word/document.xml": f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:r><w:t>{label}</w:t></w:r></w:p><w:sectPr/>
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
        CURRENT.write_bytes(minimal_docx("Ticket 42 Document Identity Gate source"))
    return CURRENT.read_bytes()


def artifact_format(data):
    if data.startswith(b"PK\x03\x04"):
        return "DOCX"
    if data.startswith(bytes.fromhex("d0cf11e0a1b11ae1")):
        return "DOC"
    return "unknown"


def parse_fields(body, content_type):
    message = email.message_from_bytes(
        (f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n").encode() + body
    )
    filedata = None
    for part in message.walk():
        if part.is_multipart() or "form-data" not in part.get("Content-Disposition", ""):
            continue
        if part.get_param("name", header="content-disposition") == "filedata":
            filedata = part.get_payload(decode=True) or b""
    return filedata


def oa_page(scenario, run_id):
    options = [
        ("success", "Matching source and receipt"),
        ("missing-session", "OA session removed before source read"),
        ("error-page", "Authenticated source returns HTML"),
        ("wrong-document", "Gateway delivers another valid DOCX"),
        ("missing-receipt", "Gateway omits the receipt"),
        ("mismatch", "Receipt metadata is falsified"),
        ("timeout", "Receipt arrives after the gate timeout"),
        ("stale-seed", "Seed the stable Gateway cache URL"),
        ("stale-cache", "Reuse the stable Gateway cache URL"),
        ("fresh-retry", "First receipt missing, fresh retry succeeds"),
    ]
    links = "".join(
        f'<a class="scenario {"active" if value == scenario else ""}" href="/oa?case={value}&run={urllib.parse.quote(run_id)}">{label}</a>'
        for value, label in options
    )
    source = f"{SOURCE_PATH}?case={urllib.parse.quote(scenario)}&run={urllib.parse.quote(run_id)}"
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Document Identity Gate Demo OA</title><style>
*{{box-sizing:border-box}}body{{margin:0;background:#f4f6f8;color:#18222d;font:14px/1.5 Arial,sans-serif;letter-spacing:0}}
header{{height:52px;display:flex;align-items:center;padding:0 28px;background:#243746;color:#fff;font-weight:700}}
main{{max-width:1000px;margin:26px auto;padding:0 20px}}h1{{font-size:22px;margin:0 0 5px}}p{{color:#5b6775;margin:0 0 18px}}
.layout{{display:grid;grid-template-columns:280px 1fr;gap:18px}}.scenarios,.document{{background:#fff;border:1px solid #d6dce3;border-radius:6px;padding:16px}}
.scenario{{display:block;padding:7px 9px;color:#334252;text-decoration:none;border-left:3px solid transparent}}.scenario.active{{background:#eaf3fa;border-color:#1769aa;color:#125484;font-weight:700}}
.document a{{display:block;margin-top:18px;padding:18px;border:1px solid #cbd5df;border-radius:4px;color:#1769aa;font-weight:700;text-decoration:none}}
code{{font-size:12px}}@media(max-width:700px){{.layout{{grid-template-columns:1fr}}}}
</style></head><body><header>RoadFlow Demo OA</header><main><h1>Document Identity Gate</h1><p>Prototype fault scenario: <code>{scenario}</code></p>
<div class="layout"><nav class="scenarios">{links}</nav><section class="document"><strong>Authenticated Document Link</strong><a id="document-link" href="{source}">Quarterly report.docx</a><p id="oa-state">The packaged editor must remain locked until source identity and Gateway Delivery Receipt match.</p></section></div>
</main></body></html>""".encode()


class Handler(BaseHTTPRequestHandler):
    server_version = "Ticket42IdentityGate/0.1"

    def request_cookie(self):
        return self.headers.get("Cookie", "")

    def authenticated(self):
        jar = cookies.SimpleCookie()
        jar.load(self.request_cookie())
        return SESSION_NAME in jar and jar[SESSION_NAME].value == SESSION_VALUE

    def record(self, status, extra=None):
        entry = {"time": now(), "method": self.command, "path": self.path, "status": status,
                 "cookie": self.request_cookie(), "userAgent": self.headers.get("User-Agent", "")}
        if extra:
            entry.update(extra)
        write_log(entry)

    def send_body(self, status, content_type, body, headers=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        for name, value in headers or []:
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)
        self.wfile.flush()

    def do_OPTIONS(self):
        self.record(204)
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(parsed.query)
        scenario = query.get("case", ["success"])[0]
        run_id = query.get("run", ["manual"])[0]

        if parsed.path == "/oa/session/start":
            self.record(302, {"session": "started"})
            self.send_body(302, "text/plain", b"session ready", [
                ("Set-Cookie", f"{SESSION_NAME}={SESSION_VALUE}; Path=/; HttpOnly; SameSite=Lax"),
                ("Location", f"/oa?case={urllib.parse.quote(scenario)}&run={urllib.parse.quote(run_id)}"),
            ])
            return

        if parsed.path == "/oa/session/clear":
            self.record(200, {"session": "cleared"})
            self.send_body(200, "text/plain", b"session cleared", [
                ("Set-Cookie", f"{SESSION_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax"),
            ])
            return

        if parsed.path == "/oa":
            if not self.authenticated():
                self.record(401, {"auth": "missing"})
                self.send_body(401, "text/plain", b"OA session required")
                return
            self.record(200, {"auth": "accepted", "scenario": scenario})
            self.send_body(200, "text/html; charset=utf-8", oa_page(scenario, run_id))
            return

        if parsed.path == SOURCE_PATH:
            if not self.authenticated():
                self.record(401, {"auth": "missing", "directSource": True, "scenario": scenario})
                self.send_body(401, "text/plain", b"OA session required")
                return
            if scenario == "error-page":
                body = b"<!doctype html><title>Session error</title><p>This is not a Document.</p>"
                self.record(200, {"auth": "accepted", "directSource": True, "scenario": scenario, "actualFormat": "unknown"})
                self.send_body(200, "text/html; charset=utf-8", body)
                return
            data = ensure_document()
            self.record(200, {"auth": "accepted", "directSource": True, "scenario": scenario,
                              "actualFormat": artifact_format(data), "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
            self.send_body(200, "application/vnd.openxmlformats-officedocument.wordprocessingml.document", data)
            return

        if parsed.path == "/__prepare":
            handoff = query.get("handoff", [""])[0]
            cache_key = query.get("cacheKey", [""])[0]
            source_path = query.get("sourcePath", [""])[0]
            if not handoff or not cache_key or source_path != SOURCE_PATH:
                self.record(400, {"prepare": True})
                self.send_body(400, "application/json", b'{"ok":false}')
                return
            with lock:
                prepared[cache_key] = {"handoff": handoff, "sourcePath": source_path, "scenario": scenario}
                receipts.pop(handoff, None)
            self.record(200, {"prepare": True, "handoff": handoff, "cacheKey": cache_key, "scenario": scenario})
            self.send_body(200, "application/json", b'{"ok":true}')
            return

        if parsed.path == GATEWAY_PATH:
            source_path = query.get("fileurl", [""])[0]
            cache_key = query.get("_wpsHandoff", [""])[0]
            with lock:
                attempt = dict(prepared.get(cache_key, {}))
            scenario = attempt.get("scenario", scenario)
            if source_path != SOURCE_PATH or not attempt:
                body = b"<!doctype html><title>Gateway error</title><p>Unknown handoff.</p>"
                self.record(404, {"gateway": True, "cacheKey": cache_key, "decodedFileurl": source_path})
                self.send_body(404, "text/html; charset=utf-8", body)
                return
            data = minimal_docx("Different but valid Gateway Document") if scenario == "wrong-document" else ensure_document()
            self.record(200, {"gateway": True, "handoff": attempt["handoff"], "cacheKey": cache_key,
                              "scenario": scenario, "decodedFileurl": source_path, "actualFormat": artifact_format(data),
                              "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
            self.send_body(200, "application/vnd.openxmlformats-officedocument.wordprocessingml.document", data, [
                ("Content-Disposition", 'attachment; filename="quarterly-report.docx"'),
                ("Cache-Control", "public, max-age=3600" if scenario in ("stale-seed", "stale-cache") else "no-store, no-cache, must-revalidate"),
                ("Pragma", "no-cache"),
            ])
            if scenario in ("missing-receipt", "fresh-retry", "stale-cache"):
                return
            receipt = {
                "handoff": attempt["handoff"], "sourcePath": source_path, "format": artifact_format(data),
                "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(), "deliveredAt": now(),
                "expiresAtEpochMs": int(time.time() * 1000) + 15000,
                "availableAtEpochMs": int(time.time() * 1000) + (6000 if scenario == "timeout" else 0),
            }
            if scenario == "mismatch":
                receipt["sha256"] = "0" * 64
            with lock:
                receipts[attempt["handoff"]] = receipt
            write_log({"time": now(), "method": "INTERNAL", "path": RECEIPT_PATH, "status": 201,
                       "receiptRecorded": True, "scenario": scenario, "receipt": receipt})
            return

        if parsed.path == RECEIPT_PATH:
            handoff = query.get("handoff", [""])[0]
            with lock:
                receipt = dict(receipts.get(handoff, {}))
            current_ms = int(time.time() * 1000)
            if not receipt or current_ms < receipt.get("availableAtEpochMs", 0) or current_ms > receipt.get("expiresAtEpochMs", 0):
                self.record(404, {"receiptLookup": True, "handoff": handoff})
                self.send_body(404, "application/json", b'{"found":false}')
                return
            self.record(200, {"receiptLookup": True, "handoff": handoff})
            self.send_body(200, "application/json", json.dumps(receipt).encode())
            return

        if parsed.path == "/__evidence":
            entries = []
            if LOG.exists():
                entries = [json.loads(line) for line in LOG.read_text(encoding="utf-8").splitlines() if line]
            data = ensure_document()
            body = json.dumps({"requests": entries, "artifact": {"bytes": len(data),
                "sha256": hashlib.sha256(data).hexdigest(), "format": artifact_format(data)}}, indent=2).encode()
            self.record(200, {"evidence": True})
            self.send_body(200, "application/json", body)
            return

        if parsed.path == "/favicon.ico":
            self.record(204)
            self.send_body(204, "image/x-icon", b"")
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
        filedata = parse_fields(raw, self.headers.get("Content-Type", ""))
        source_path = urllib.parse.parse_qs(parsed.query).get("fileurl", [""])[0]
        if not self.authenticated() or source_path != SOURCE_PATH or filedata is None:
            response = {"Success": False, "Message": "Invalid overwrite request", "Data": None}
            self.record(403, {"overwrite": True, "auth": "accepted" if self.authenticated() else "missing", "decodedFileurl": source_path})
            self.send_body(403, "application/json", json.dumps(response).encode())
            return
        CURRENT.write_bytes(filedata)
        response = {"Success": True, "Message": "Document overwritten", "Data": {"fileurl": SOURCE_PATH}}
        self.record(200, {"overwrite": True, "auth": "accepted", "decodedFileurl": source_path,
                          "storedBytes": len(filedata), "storedSha256": hashlib.sha256(filedata).hexdigest()})
        self.send_body(200, "application/json", json.dumps(response).encode())

    def log_message(self, _format, *_args):
        return


if __name__ == "__main__":
    STATE.mkdir(parents=True, exist_ok=True)
    print("Document Identity Gate Demo OA listening at http://127.0.0.1:49250/oa/session/start", flush=True)
    ThreadingHTTPServer(("127.0.0.1", 49250), Handler).serve_forever()
