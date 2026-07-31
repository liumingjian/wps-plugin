# Result: Authenticated OA Save Probe

Date: 2026-07-31

## Verdict

The proposed full route does **not** work on the designated machine. A packaged
extension editor can use the current Qaxbrowser OA session for
`saveURL_FormData`, but WPS cannot use that browser session when
`openDocument` retrieves the protected source Document.

This is also a data-integrity hazard: `openDocument` returned `true` after the
protected GET was redirected to the login page. WPS treated the returned HTML
as an active editable document, and a later authenticated save could overwrite
the source path with that content.

## Environment

- Kylin V10 ARM64 (`aarch64`)
- Qaxbrowser `Chrome/102.0.5005.200`
- WPS Office with `Kingsoft WPS Plugin`
- editor Origin: `chrome-extension://mjjoapeohdfkepmocpahbimmmenlfdcb`
- Demo OA Origin: `http://127.0.0.1:49234`

The normal browser tab held this current OA session:

```text
oa_session=ticket-38-demo-session; Path=/; HttpOnly; SameSite=Lax
```

## Protected Document GET

WPS first made protocol discovery without a Cookie, then used its DAV client:

```text
OPTIONS /UploadFiles/2026/
User-Agent: Microsoft Office Protocol Discovery
Cookie: <absent>

GET /UploadFiles/2026/contract.docx?... HTTP/1.1
User-Agent: Microsoft Data Access Internet Publishing Provider DAV
Cookie: <absent>

HTTP/1.1 302
Location: /oa/login?returnUrl=...
```

WPS followed the redirect, also without a Cookie, and received the login HTML.
Despite that, `Application.openDocument(...)` returned `true` and
`Application.ActiveDocument` was present. The same result occurred for the
cache-busted reopen attempt.

## Protected overwrite-save POST

With the browser session present, `saveURL_FormData` used Qaxbrowser's network
stack and did carry the current OA Cookie:

```text
POST /RoadFlow/uploadfiles/OfficeSave?fileurl=%2FUploadFiles%2F2026%2Fcontract.docx
Origin: chrome-extension://mjjoapeohdfkepmocpahbimmmenlfdcb
User-Agent: Mozilla/5.0 ... Qaxbrowser
Cookie: oa_session=ticket-38-demo-session
Content-Type: multipart/form-data; boundary=...
```

The decoded `fileurl` was the exact source path. The multipart body contained:

```text
md5sum   text/plain                    32 bytes
filename text/plain                    caller-supplied metadata string
filedata application/octet-stream      WPS document payload
```

The Demo OA overwrote the source artifact and returned:

```json
{"Success":true,"Message":"Document overwritten","Data":{"fileurl":"/UploadFiles/2026/contract.docx"}}
```

`saveURL_FormData` returned `true`. It did not invoke the page's
`saveComplete(type, code, result)` callback in this probe.

Without the browser session, the same multipart POST carried no Cookie. The
server returned `401` with:

```json
{"Success":false,"Message":"OA session required","Data":null}
```

In that case `saveURL_FormData` returned `false`; treating that boolean as a
failure produced the visible red `打开或保存失败` state.

## Stored artifact and reopen

The saved payloads were CFB/OLE, not DOCX/ZIP. The final overwritten artifact
was 11,776 bytes with SHA-256:

```text
d4af694ca3caa9747df36f8c3557ae8aded65fa5f47f000886434cfcdc0fc874
```

It contained both the probe edit marker and the text `Login required.`. This
confirms the cache-busted reopen did not retrieve the stored source Document;
it opened the unauthenticated redirect target and then overwrote the source
path with that document.

## Decision implication

The current destination's direct authenticated-open premise is invalid on this
machine. The CRX editor host remains technically viable, and direct OA save can
reuse the browser session, but V1 must not pass a cookie-protected source URL to
WPS and trust the `openDocument` return value.

Before the save, installer, or editor UI contracts can be finalized, the map
must choose a different authenticated source-delivery boundary or redraw the
destination. A safe design must also prevent any save until the exact source
Document has been independently verified as opened.

Primary evidence is in `evidence/result.json`, the four screenshots, and
`evidence/stored-artifact.bin`.
