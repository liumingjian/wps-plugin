# ftp-master embedded WPS editing in Qaxbrowser

The ftp-master Office extension opens a dedicated Qaxbrowser tab with an embedded
WPS Writer or ET surface. The file browser stays open at the selected directory.
The editor toolbar saves directly to ftp-master and closes the editor tab when
the user returns to the file list. The deployed browser and WPS installation
must expose the Writer and ET NPAPI components.

## Build and load the extension

Set the exact application origin, including any port. Run from the repository
root with Node.js.

```sh
FTP_MASTER_ORIGIN=https://files.example.org node scripts/stage-ftp-master-extension.mjs
```

On the designated Kylin V10 ARM64 desktop, open Qaxbrowser's extension manager,
enable developer mode, and load `dist/release/ftp-master-extension` as an
unpacked extension. Refresh the ftp-master page. The extension advertises its
availability on that origin when both WPS MIME types are present. Use a new
`OUTPUT` directory when staging for another deployment.

Select the filename to open a read-only WPS preview. Select the pencil in the
file row to edit. Both tabs close through the return-to-list control.

The extension requests the selected File Version through the authenticated
ftp-master API. A preview permit requires Browse and carries no save URL.
The embedded WPS surface
receives the permit's Document Gateway URL. The editor checks that delivery has
completed before it enables editing and saving. Writer submits through
`saveURL_FormData`. ET exports the workbook with `saveAsBase64Str` and the
editor submits its bytes as multipart `file` through the signed-in browser
session. ftp-master authorizes the save and creates a File Version and an Audit
Event. After a successful save, the extension reads the latest File Version
and updates the matching edit entry in the original directory. A failed save
leaves the editor open for retry.
The updated entry follows the file list's latest-version rule. If another
save lands before the version lookup, the entry opens that later version.

## Acceptance

The automated browser tests exercise the DOCX and XLSX entry, delivery check,
embedded editor controls, format-specific save calls, retry and file-list
updates with simulated WPS and server responses.

Production acceptance requires an actual Kylin Qaxbrowser/WPS deployment. Open,
edit, save and reopen a DOCX and XLSX from ftp-master. Confirm that each save
creates a File Version with the edited bytes and the Audit Event. Attempt to
open with an expired or already delivered permit and confirm that the edit
surface remains locked and that no save is sent. The [Office integration
contract](https://github.com/liumingjian/ftp-master/blob/1dae29c99791dedbc9c06fac9464292e6d46852b/docs/office-integration.md)
describes the server authorization and payloads.

## Kylin validation on 2026-11-22

- Kylin V10 SP1 ARM64 with Linux `5.4.18-167-generic`, Qaxbrowser
  `1.0.46402.2` (Chromium `102.0.5005.200`) and WPS
  `12.1.2.26885.AK.preread.sw`. Both `application/x-wps` and
  `application/x-et` were registered and their mounted objects exposed an
  `Application` function.
- The extension was staged for a loopback Origin and tested with the real
  ftp-master service at `f2e3b8d` and local PostgreSQL, Redis and MinIO stores.
  The production Origin and its deployment still need acceptance.
- Writer initially saved `fixture.docx` as version 3 with actual format
  `doc` (CFB/OLE). The final extension edited it again, saved version 8 and
  reopened it directly from the original directory. The reopened document
  contained `FTP_QAX_DOCX_1795322788963`. Save audit event 31 and the subsequent
  open audit event 32 both refer to version 8. The filename remained
  `fixture.docx`.
- ET saved `fixture.xlsx` as version 9 with actual format `xlsx` (OOXML).
  Reopening it directly from the original directory showed
  `FTP_QAX_XLSX_1795322798556`. Save audit event 36 and the subsequent open
  audit event 37 both refer to version 9.
- ET's native `SaveDocumentToServer` returned HTTP 401 because the request
  lacked the browser session. With the fixed extension, signing out before
  Save produced HTTP 401 in both Writer and ET and left the edited file open
  with Retry available. Signing in as the same user and retrying saved the
  same edit.
- An expired permit reached the Gateway and received HTTP 410. An already
  delivered permit stopped at the delivery check before WPS was mounted.
  Saving stayed disabled, the editor surface was absent after each failure
  and neither case created a save audit event.
