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

The extension acts on explicit ftp-master edit entries and requests the selected
File Version through the existing authenticated API. The embedded WPS surface
receives the permit's Document Gateway URL. The editor checks that delivery has
completed before it enables editing and saving. Save uses the permit's save URL
and the existing Writer or ET upload contract. ftp-master authorizes the save
and creates a File Version and an Audit Event. A failed save leaves the editor
open for retry.

## Acceptance

The automated browser tests exercise the DOCX and XLSX entry, delivery check,
embedded editor controls, format-specific save calls and return with simulated
WPS and server responses. The installed macOS Qaxbrowser 1.2.46012.7 exposed
neither `application/x-wps` nor `application/x-et` and neither probe exposed
`Application`.

Production acceptance requires an actual Kylin Qaxbrowser/WPS deployment. Open,
edit, save and reopen a DOCX and XLSX from ftp-master. Confirm that each save
creates a File Version with the edited bytes and the Audit Event. Attempt to
open with an expired or already delivered permit and confirm that the edit
surface remains locked and that no save is sent. The [Office integration
contract](https://github.com/liumingjian/ftp-master/blob/1dae29c99791dedbc9c06fac9464292e6d46852b/docs/office-integration.md)
describes the server authorization and payloads.
