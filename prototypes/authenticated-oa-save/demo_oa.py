#!/usr/bin/env python3
import datetime
import email
import hashlib
import io
import json
import os
import sys
import urllib.parse
import zipfile
from http import cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ROOT = Path(__file__).resolve().parent
STATE = Path(os.environ.get("AUTH_OA_STATE", "/tmp/wps-authenticated-oa-save"))
LOG = STATE / "requests.jsonl"
CURRENT = STATE / "contract.current.bin"
SESSION_NAME = "oa_session"
SESSION_VALUE = "ticket-38-demo-session"
SOURCE_PATH = "/UploadFiles/2026/contract.docx"
SAVE_PATH = "/RoadFlow/uploadfiles/OfficeSave"


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
<w:p><w:r><w:t>Ticket 38 authenticated OA save probe</w:t></w:r></w:p><w:sectPr/>
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


def parse_fields(body, content_type):
    message = email.message_from_bytes(
        (f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n").encode() + body
    )
    fields = []
    filedata = None
    for part in message.walk():
        if part.is_multipart():
            continue
        disposition = part.get("Content-Disposition", "")
        if "form-data" not in disposition:
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


def artifact_format(data):
    if data.startswith(b"PK\x03\x04"):
        return "DOCX/ZIP"
    if data.startswith(bytes.fromhex("d0cf11e0a1b11ae1")):
        return "CFB/OLE"
    return "unknown"


class Handler(BaseHTTPRequestHandler):
    server_version = "Ticket38DemoOA/0.1"

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

    def common_headers(self):
        self.send_header("Access-Control-Allow-Origin", "chrome-extension://mjjoapeohdfkepmocpahbimmmenlfdcb")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Credentials", "true")

    def send_body(self, status, content_type, body, extra_headers=None):
        self.send_response(status)
        self.common_headers()
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        for name, value in extra_headers or []:
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.record(204)
        self.send_response(204)
        self.common_headers()
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/oa/session/start":
            body = b"<!doctype html><title>Demo OA</title><p>Authenticated Demo OA session ready.</p>"
            self.record(200, {"setCookie": f"{SESSION_NAME}={SESSION_VALUE}; Path=/; HttpOnly; SameSite=Lax"})
            self.send_body(200, "text/html; charset=utf-8", body, [
                ("Set-Cookie", f"{SESSION_NAME}={SESSION_VALUE}; Path=/; HttpOnly; SameSite=Lax")
            ])
            return

        if parsed.path == "/oa/login":
            self.record(200)
            self.send_body(200, "text/html; charset=utf-8", b"<!doctype html><title>Login required</title><p>Login required.</p>")
            return

        if parsed.path == SOURCE_PATH and not self.authenticated():
            location = "/oa/login?returnUrl=" + urllib.parse.quote(self.path, safe="")
            self.record(302, {"location": location, "auth": "missing"})
            self.send_body(302, "text/plain; charset=utf-8", b"login required", [("Location", location)])
            return

        if parsed.path in (SOURCE_PATH, "/control/contract.docx"):
            data = ensure_document()
            self.record(200, {"auth": "accepted" if self.authenticated() else "public-control", "artifactFormat": artifact_format(data)})
            self.send_body(200, "application/vnd.openxmlformats-officedocument.wordprocessingml.document", data, [
                ("Content-Disposition", 'attachment; filename="contract.docx"')
            ])
            return

        if parsed.path == "/__evidence":
            entries = []
            if LOG.exists():
                entries = [json.loads(line) for line in LOG.read_text(encoding="utf-8").splitlines() if line]
            data = ensure_document()
            body = json.dumps({
                "requests": entries,
                "artifact": {
                    "bytes": len(data),
                    "sha256": hashlib.sha256(data).hexdigest(),
                    "format": artifact_format(data),
                    "markers": [marker.decode(errors="replace") for marker in data.split(b"ticket-38 ")[1:]],
                },
            }, ensure_ascii=False, indent=2).encode()
            self.record(200)
            self.send_body(200, "application/json; charset=utf-8", body)
            return

        if parsed.path == "/__artifact":
            data = ensure_document()
            self.record(200, {"artifactFormat": artifact_format(data), "artifactBytes": len(data)})
            self.send_body(200, "application/octet-stream", data)
            return

        self.record(404)
        self.send_body(404, "text/plain", b"not found")

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != SAVE_PATH:
            self.record(404)
            self.send_body(404, "text/plain", b"not found")
            return

        if not self.authenticated():
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length)
            fields, _ = parse_fields(raw, self.headers.get("Content-Type", ""))
            response = {"Success": False, "Message": "OA session required", "Data": None}
            body = json.dumps(response).encode()
            self.record(401, {"auth": "missing", "multipartFields": fields, "response": response})
            self.send_body(401, "application/json; charset=utf-8", body)
            return

        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length)
        fields, filedata = parse_fields(raw, self.headers.get("Content-Type", ""))
        query = urllib.parse.parse_qs(parsed.query)
        source_path = query.get("fileurl", [""])[0]
        if source_path != SOURCE_PATH or filedata is None:
            body = json.dumps({"Success": False, "Message": "invalid save request", "Data": None}).encode()
            self.record(400, {"fields": fields, "decodedFileurl": source_path})
            self.send_body(400, "application/json; charset=utf-8", body)
            return

        CURRENT.write_bytes(filedata)
        response = {
            "Success": True,
            "Message": "Document overwritten",
            "Data": {"fileurl": SOURCE_PATH},
        }
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
    port = int(os.environ.get("AUTH_OA_PORT", "49234"))
    print(f"Demo OA listening at http://127.0.0.1:{port}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
