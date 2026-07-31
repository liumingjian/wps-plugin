# Configured Document Gateway editor flow result

Date: 2026-07-31

## Provisional verdict

The agreed technical flow works end to end on the designated Kylin ARM64 +
Qaxbrowser `Chrome/102.0.5005.200` + WPS machine, subject to human review and the
deliberately deferred Document-integrity gate.

Two consecutive captures with per-handoff Gateway cache keys are in
`evidence-cache-key-1/result.json` and `evidence-cache-key-2/result.json`. Every
recorded assertion is `true` in both captures:

- a normal same-Origin DOCX click opened the fixed-ID packaged editor without a
  prompt and left the OA tab open;
- the Editor Handoff was consumed exactly once;
- `{sourcePath}` was URL-encoded into the configured Gateway template while the
  original path remained separate for save;
- WPS identified itself as `WPS文字`, fetched the Gateway URL through its DAV
  client without an OA Cookie, opened the Document, and accepted an edit;
- `saveURL_FormData` posted to the fixed `OfficeSave?fileurl=<sourcePath>` URL
  with the browser's OA Cookie;
- the server returned success, overwrote the source, and the stored DOCX
  contained the capture's inserted marker;
- Return focused the still-open OA tab and closed the editor tab;
- the editor state and warning continued to mark the identity gate as deferred.

## Findings that changed the prototype

1. Synchronous `Application.Quit()` sometimes blocked the editor renderer after
   a successful save. Return now asks the service worker to focus the OA tab and
   close the editor tab; closing the tab tears down its embedded NPAPI object.
2. `Cache-Control: no-store, no-cache, must-revalidate` was insufficient by
   itself: WPS reused a stable Gateway URL in a later run without issuing a GET.
   The editor now appends the opaque, single-use handoff ID as `_wpsHandoff` to
   the resolved Gateway URL. Consecutive runs then produced distinct DAV GETs.

The failed stable-URL repeat is retained in `evidence-repeat/result.json` as the
primary evidence for the cache finding.

## Evidence note

`Page.captureScreenshot` does not capture the native NPAPI child-window pixels,
so `editor-saved.png` shows a blank WPS region. The same capture records the WPS
application name, successful calls, server requests, and marker inside the saved
DOCX; those are the functional evidence for the embedded editor.

## Deliberate limitation

The prototype enables save after `openDocument === true` and the presence of
`ActiveDocument`. It does not preflight the Gateway response or independently
verify Document identity. A wrong Document could still overwrite the original
`sourcePath`; this prototype does not resolve that risk.

