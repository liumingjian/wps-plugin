# ftp-master on Google Chrome and desktop WPS

2026-11-21. The local acceptance target is Google Chrome on macOS arm64, with the file browser in Chrome and editing in the desktop WPS application. A disposable extension and Native Messaging Host completed a real DOCX and XLSX edit, save and reopen against ftp-master on this Mac.

## Target and evidence

| Component | Tested version or configuration |
| --- | --- |
| macOS | 27.2.1, arm64, build 26B131 |
| Google Chrome | 157.0.8103.81, dedicated user data directory and unpacked Manifest V3 extension |
| WPS Office for Mac | 7.4.1, bundle `com.kingsoft.wpsoffice.mac` |
| ftp-master | Isolated local QA images with fresh PostgreSQL, Redis and object storage, schema version 25 |
| Prototype | Local branch `codex/prototype-ftp-master-chrome`, commit `84e3ec0`, under `prototypes/ftp-master-chrome/` |

The original Chrome capability probe found neither `application/x-wps` nor `application/x-et`. Neither embedded object exposed `Application`. This accords with Chromium's permanent removal of NPAPI in Chrome 45. This repository's ADR 0001 describes the separate local application architecture. ADR 0006 records the RoadFlow decision for its designated Qaxbrowser environment. [Chromium NPAPI removal](https://www.chromium.org/developers/npapi-deprecation/) · [Original ftp-master ADR 0005](https://github.com/liumingjian/ftp-master/blob/1dae29c99791dedbc9c06fac9464292e6d46852b/docs/adr/0005-office-editing-via-wps-plugin.md) · [ADR 0001](adr/0001-use-native-messaging-local-agent.md) · [ADR 0006](adr/0006-use-browser-hosted-wps-for-roadflow.md)

## Live round trip

The prototype extension marked the configured ftp-master origin and handled a real file-browser edit entry. A session-authenticated request started the edit with the listed File Version. The host fetched the Document Gateway URL without the browser session cookie. The extension observed delivery change from false to true before asking the host to open the Work Copy with macOS Launch Services.

An accessibility script typed each marker in the active WPS document and saved it with Cmd+S. The host returned the persisted bytes. Back in Chrome, Save submitted the matching Writer or ET multipart shape with the browser session. The real service returned HTTP 200 and created a File Version with the actual format. Refreshing the file browser and clicking online edit again requested the new version and opened a new Work Copy. Each reopened Work Copy matched the WPS-saved bytes and contained the marker.

| Document | Base → saved File Version | Actual format | Marker | SHA-256 of saved and reopened bytes |
| --- | --- | --- | --- | --- |
| `chrome-word.docx` | 1 → 3 | DOCX | `FTP-CHROME-WORD-VERIFIED-20261121` | `3e6a46b7ae3d9574c177349539cc0a39b29a391c047f725f5d3113e5ee722846` |
| `chrome-sheet.xlsx` | 2 → 4 | XLSX | `FTP-CHROME-SHEET-VERIFIED-20261121` | `0630594dec277624790e163d7de573f8dbdddea127693a2d65b17dd172f1b323` |

A negative probe advanced a scratch permit past expiry in the database and returned it to the extension via an intercepted edit-start response. The real Gateway returned 410. The extension kept Save disabled and skipped the native open call. A separate authenticated POST of valid DOCX bytes using that undelivered permit returned 409 with `document not delivered`. The database retained the same four File Versions. The five-minute deadline applies to **initial retrieval**. A previously delivered permit can support repeated saves under the current contract. [ftp-master office integration contract](https://github.com/liumingjian/ftp-master/blob/1dae29c99791dedbc9c06fac9464292e6d46852b/docs/office-integration.md)

The test used two small Office fixtures, one active edit per page, and an explicit switch back to Chrome to submit. Native Messaging prototyped a single base64 reply capped at 700,000 bytes before encoding. Forced Writer revision tracking, spreadsheet change history, stable detection of rapid saves, close or browser-exit recovery, overlapping saves and the remaining DOC/WPS/XLS formats still need acceptance. A rapid pair of reopen requests staged both copies, but only Word was observed in the foreground during that run. Reopening Excel on its own confirmed the exact workbook in WPS. A production launcher therefore needs per-Work-Copy open tracking. An exit-zero result from `open` acknowledges the launch request.

## Specification changes

The ftp-master specification now defines the flow for this Mac as **Chrome file browser → desktop WPS → browser submission → new File Version**. It retains the server's Modify check, 25 MiB limit, explicit Edit Entry, Edit Permit, version binding, delivery confirmation, payload validation, audit and Stale Save rules. Chrome sends the session-authenticated save request, and the host uses the single-use Gateway URL for retrieval. [ftp-master v1 specification](https://github.com/liumingjian/ftp-master/issues/1)

| Specification | Chrome adaptation |
| --- | --- |
| [ftp-master v1 specification](https://github.com/liumingjian/ftp-master/issues/1) | Record macOS and Google Chrome as a target with a desktop WPS execution path. Define the extension/host trust boundary and preserve requirements for the existing Kylin deployment. |
| [#58](https://github.com/liumingjian/wps-plugin/issues/58) | Add a Chrome MV3 extension and macOS host setup with a distinct fixed extension ID. Check the configured origin, host availability and usable WPS installation. Local acceptance uses an unpacked extension. Distribution requires a Web Store or managed installation decision. |
| [#59](https://github.com/liumingjian/wps-plugin/issues/59) | Keep the single origin, presence marker and trusted primary click rules. Verify the marker and explicit edit UI on Chrome, including the behavior when the host is unavailable. |
| [#60](https://github.com/liumingjian/wps-plugin/issues/60) | Start with the selected File Version and same-origin session. Stage the exact Gateway bytes in a job-owned Work Copy and confirm delivery before launch. Keep the file browser open while the desktop document is active. |
| [#61](https://github.com/liumingjian/wps-plugin/issues/61) | Submit a stable Snapshot in the existing multipart shape and verify the committed version receipt. Use an explicit Chrome submission after saving in WPS and relay the data in bounded chunks. Retain pending bytes through recovery and prevent duplicate submissions. |
| [#62](https://github.com/liumingjian/wps-plugin/issues/62) | Add real macOS Chrome acceptance for installation and Word/Excel edit, save, refresh and reopen. Check exact bytes, version/audit records, expired or undelivered permit refusals, recovery and simultaneous saves. Keep the established Kylin acceptance criteria for that deployment while it is in scope. |

Chrome supports loading an unpacked extension in developer mode. Ordinary macOS Chrome distribution requires a supported Web Store or enterprise policy path. Native Messaging authorizes a registered executable for an exact extension origin. The existing macOS setup script targets Qaxbrowser's profile directory. Its historical agent is DOCX-only and uses a TaskDescriptor plus hash-bound Acceptance and Completion Receipts, so ftp-master needs a deliberate adapter at that boundary. [Chrome extension distribution](https://developer.chrome.com/docs/extensions/how-to/distribute) · [Chrome Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging) · [macOS setup](../scripts/setup-macos-arm64.sh) · [Historical TaskDescriptor](../agent/contract.go) · [Historical transport](../agent/transport.go)

Decide whether forced revision tracking and spreadsheet change history remain required on macOS before finalizing the editor contract. WPS's desktop add-in model is a candidate interface for a focused follow-up. WPS support describes add-ins on Mac 6.13.0 and later. The available documentation and the live prototype do not establish the required automation behavior on the tested WPS build. [WPS add-in overview](https://open.wps.cn/documents/app-integration-dev/wps365/client/wpsoffice/wps-integration-mode/wps-addin-development/addin-overview) · [WPS first-party support reply](https://forum.wps.cn/topic/50515)
