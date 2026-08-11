# RoadFlow WPS Editor

RoadFlow WPS Editor is a Qaxbrowser extension for opening OA document links in
the WPS installation on the customer's workstation. It keeps the OA page as
the source of truth, uses the local WPS Writer or WPS ET editor for editing,
and sends the saved result back to the OA `OfficeSave` endpoint.

The primary delivery is a fixed-ID signed CRX for the designated RoadFlow OA
environment. The repository also contains an older Native Messaging and local
agent route under `extension/`; that route is documented separately and is not
the current RoadFlow direct-OA CRX.

## What Problem It Solves

Many customer OA systems expose Word or Excel files as ordinary download links.
Opening those links normally downloads a copy, loses the local WPS editing
experience, and does not provide a reliable way to save the edited document
back to the original OA record. Some OA forms load the document link inside one
or more `iframe` elements, which makes a top-level-only browser integration
miss the user's click.

RoadFlow WPS Editor solves this boundary problem by:

- intercepting supported document links in the OA page and same-origin frames;
- opening a packaged editor in a new browser tab while retaining the original
  OA tab and frame state;
- opening the original HTTP or HTTPS document URL in the locally installed WPS;
- validating the downloaded bytes and format before editing is unlocked;
- enabling revision tracking in WPS Writer or change history and highlighting in
  WPS ET; and
- saving the edited bytes through the OA's existing authenticated overwrite
  endpoint, then returning to the tab that launched the editor.

The extension is an integration boundary, not a web-office editor. WPS remains
responsible for rendering and editing Office documents; the extension handles
link interception, validation, WPS API calls, and return navigation; the OA
remains responsible for authorization and durable storage.

## Features

### Supported formats

- Word: `.doc`, `.docx`, and `.wps`.
- Excel: `.xls` and `.xlsx`.

The extension chooses the WPS surface from the file extension. Word uses
`application/x-wps`; Excel uses `application/x-et`. A `.docx` or `.xlsx` link
may be serialized by WPS as a same-family legacy CFB document during saving.
Same-family serializations are accepted; malformed documents and cross-family
payloads are rejected.

### OA and iframe navigation

- Ordinary HTTP or HTTPS `<a href="...">` document links are supported.
- Content scripts run in all frames, including nested same-origin OA forms.
- A click opens a new editor tab instead of downloading the file in the OA tab.
- **返回** closes the editor tab and focuses the original OA tab. If the click
  came from an iframe, the iframe remains at its original editing page.
- Modifier-key clicks, non-primary clicks, unsupported formats, and
  untrusted/cross-origin links retain normal browser behavior.

### Revision display

For Writer documents, the extension enables tracked revisions and displays
insertions, deletions, and comments before the editor becomes editable.

For Excel documents, the extension uses the WPS ET workbook APIs. An exclusive
workbook is first converted to shared revision mode, then the extension enables
change history, requests all-change highlighting for everyone, displays changes
on screen, and avoids creating a separate change-list sheet.

### Save behavior

The Word and Excel save paths intentionally use the native API exposed by their
corresponding WPS application:

| Format | Local WPS operation | OA upload shape |
| --- | --- | --- |
| `.doc`, `.docx`, `.wps` | `Document.saveURL_FormData(officeSaveURL, "formId:formeditor")` | `md5sum`, `filename=formId:formeditor`, and `filedata` |
| `.xls`, `.xlsx` | `Workbook.Save()` followed by `Application.SaveDocumentToServer(officeSaveURL)` | ET sends the raw workbook as multipart field `file`, normally with an empty filename |

The Excel path does not reuse the Writer upload method. The OA endpoint must
accept the ET native request, validate it against the authorized `.xls` or
`.xlsx` target, and atomically replace the original only after validation.

## Architecture

The current RoadFlow route is a direct OA integration:

```text
OA page or iframe
    -> RoadFlow content script
    -> source identity and format validation
    -> new OA-origin Blob editor tab
    -> WPS Writer (application/x-wps) or WPS ET (application/x-et)
    -> OA /RoadFlow/uploadfiles/OfficeSave
    -> original OA tab or iframe
```

The direct route does not require a Gateway, Native Messaging host, local
agent, DEB package, resident service, or OA page-side SDK. It does require the
customer OA to serve the original document URL directly to WPS and to expose a
compatible authenticated `OfficeSave` endpoint.

## Quick Start

### Requirements

- Go `1.23.2` for the repository's Go build and test commands.
- Node.js and npm for browser tests.
- Qaxbrowser with the WPS browser plugin enabled.
- A WPS installation that exposes `application/x-wps` and `application/x-et`.
- A customer or local OA origin serving supported document links.

The real customer acceptance must use the customer's Qaxbrowser, WPS build,
OA origin, authentication state, and a disposable test document. A local demo
proves the integration contract but does not replace customer acceptance.

### Run the Excel save demo

The demo accepts a real WPS ET `SaveDocumentToServer` request and records the
request shape, committed byte count, and MD5. It uses
`/tmp/file-editor/uploads/工作簿1.xls` as the default source file. Set
`ROADFLOW_EXCEL_DEMO_FILE` when that file is not available.

```sh
ROADFLOW_EXCEL_DEMO_FILE=/path/to/test.xls \
ROADFLOW_EXCEL_DEMO_STATE=/tmp/roadflow-excel-save-demo \
node prototypes/roadflow-excel-save-demo/server.mjs
```

Open <http://127.0.0.1:4318/> in Qaxbrowser. The demo provides an
`Acceptance.xls` link and these diagnostic endpoints:

- `GET /healthz` checks that the demo is running.
- `GET /diagnostics` reports the current MD5, received multipart parts, and
  successful saves.
- `POST /RoadFlow/uploadfiles/OfficeSave?fileurl=/UploadFiles/2026/Acceptance.xls`
  is the overwrite endpoint used by the editor.

Load an unpacked RoadFlow extension for local testing:

```sh
OUTPUT=/tmp/roadflow-extension-dev \
VERSION=1.0.21 \
bash ./scripts/stage-roadflow-extension.sh
```

In Qaxbrowser, open `chrome://extensions`, enable Developer mode, choose
**Load unpacked**, and select `/tmp/roadflow-extension-dev`. Configure the
extension's **Trusted OA Origin** as:

```text
http://127.0.0.1:4318
```

Click **打开 Acceptance.xls**, edit a cell in WPS, click **保存**, inspect
`/diagnostics`, and click **返回**. The save record should show transport
`wps-et-save-document-to-server` and `status=200`.

### Run the local Word simulator

The Go simulator exercises the direct-OA Word route at port `4317`:

```sh
bash ./scripts/run-roadflow-simulator.sh
```

Open <http://127.0.0.1:4317/>, simulate login, open the acceptance document,
edit it in WPS, save, and return. See
[`docs/roadflow-local-manual-acceptance-zh.md`](docs/roadflow-local-manual-acceptance-zh.md)
for the manual flow.

## Build and Test

Run the complete Go suite and the hosted-editor browser suite from the
repository root:

```sh
go test ./...
npm install
npm run test:browser
```

The browser suite covers Writer and ET mounting, revision setup, save retries,
return behavior, iframe-related handoff data, responsive editor controls, and
the Excel native save contract.

### Stage the RoadFlow extension

Staging copies the RoadFlow assets and injects the requested version into the
manifest. It does not require the release key:

```sh
OUTPUT=/tmp/roadflow-extension \
VERSION=1.0.21 \
bash ./scripts/stage-roadflow-extension.sh
```

The RoadFlow fixed extension ID is:

```text
bojjhibgkhknccepabkojdjodhhgdjfd
```

### Build a signed CRX

The signed package requires the supplier-held encrypted RoadFlow release key
and the designated Qaxbrowser binary. The command refuses to overwrite an
existing output file.

```sh
ROADFLOW_CRX_RELEASE_KEY=/secure/roadflow-crx-release.pem \
VERSION=1.0.21 \
bash ./scripts/package-roadflow-crx.sh
```

The default output is:
`dist/release/roadflow-wps-editor-1.0.21.crx`.

### Build the historical Kylin Native Messaging package

The repository still contains the original Local WPS Editing path. It uses
`extension/`, Native Messaging, a local agent, and an ARM64 DEB, and is not the
RoadFlow direct-OA CRX described above:

```sh
OUTPUT=/tmp/local-wps-extension VERSION=1.0.1 \
bash ./scripts/stage-extension.sh
MAINTAINER='Supplier Support <support@example.com>' \
bash ./scripts/build-deb-arm64.sh
```

Use [`docs/customer-installation.md`](docs/customer-installation.md) only when
working on that historical route. Use
[`docs/roadflow-customer-installation.md`](docs/roadflow-customer-installation.md)
for the current RoadFlow CRX.

## OA Integration Contract

### Source document

The document link must be an HTTP or HTTPS URL whose path ends in one of the
supported extensions. WPS must be able to read that URL directly. Browser-only
redirects, challenge pages, and links that require JavaScript to manufacture a
different download request are not guaranteed to work.

The extension validates the bytes it reads before opening WPS. The current
limits are:

- 25 MiB compressed input;
- at most 2,048 archive members;
- at most 100 MiB expanded content; and
- at most 100:1 archive expansion.

### OfficeSave endpoint

The OA must preserve the exact original source path in the `fileurl` query
parameter and authorize it against the logged-in user and the server-managed
overwrite target. The endpoint should commit atomically and return a structured
success response only after the replacement is complete.

For Writer, preserve the existing strict multipart contract:

```text
md5sum=<lowercase MD5 of filedata>
filename=formId:formeditor
filedata=<serialized Word document>
```

For Excel, accept the native ET request:

```text
file=<serialized XLS or XLSX workbook>
```

The ET request has no Writer `md5sum` or `filename=formId:formeditor` fields and
normally has an empty multipart filename. The server calculates the received
MD5, validates the bytes against the source extension, and only then replaces
the authorized target. See
[`roadflowoa/office_save.go`](roadflowoa/office_save.go) and
[`roadflowoa/office_save_test.go`](roadflowoa/office_save_test.go) for the
reference implementation and contract tests.

### Authentication and origin

The extension trusts an explicitly configured OA origin, or can be placed in
all-origin mode for controlled testing. Production installations should use
the exact OA scheme, host, and optional port. The OA remains responsible for
session authentication, authorization, and document storage; the extension
does not receive or store OA passwords or tokens.

## Constraints and Important Notes

- The browser must have the WPS NPAPI/browser plugin enabled. A normal browser
  page without the WPS plugin cannot render the editor surface.
- The integration assumes one active editor per document. It is not a
  multi-user concurrency or conflict-resolution system.
- The OA source URL must remain stable between browser validation and the WPS
  open/save operations. Direct OA mode has no Gateway delivery receipt.
- The extension does not intercept arbitrary JavaScript downloads, unsupported
  formats, cross-origin links in scoped mode, or modified/modifier-key clicks.
- A save failure leaves the WPS editor open for one explicit retry. Returning
  after a failed save requires the user to confirm discarding the in-memory
  edit.
- Do not deploy the RoadFlow CRX with the legacy `extension/` package scripts;
  the two routes have different extension IDs and deployment contracts.
- Keep customer cookies, document contents, paths, tokens, and unredacted WPS
  diagnostic output out of issue reports and acceptance records.
- Customer production acceptance must be performed on the designated machine;
  local demos and automated tests are evidence of the implementation contract,
  not evidence that every customer Qaxbrowser/WPS build is compatible.

## Troubleshooting

### "Document verification failed"

Check that the link is a supported extension, the response is the actual
document rather than an HTML login/challenge page, the bytes are stable, and
the configured Trusted OA Origin matches the page and source origin.

### "WPS ActiveWorkbook 创建超时" or a blank editor

Verify that Qaxbrowser exposes the WPS plugin, the WPS installation is running,
and the editor surface type is `application/x-et` for Excel or
`application/x-wps` for Word. Confirm that WPS can open the original document
URL directly outside the extension.

### Excel opens but saving fails

Inspect the browser and OA server logs for the `OfficeSave` request. Excel
should produce a multipart part named `file`, while Word should produce
`filedata` plus the two metadata fields. Verify the source `fileurl`, login
session, authorized overwrite target, HTTP status, and same-family format
validation. In the local demo, inspect:

```sh
curl -sS http://127.0.0.1:4318/diagnostics | jq
```

An old OA handler that only accepts the Word multipart contract will reject the
ET request even though WPS successfully saved the workbook locally.

## Repository Layout

| Path | Purpose |
| --- | --- |
| `roadflow-extension/` | Current RoadFlow direct-OA CRX source and browser tests |
| `roadflowoa/` | Authenticated OA overwrite contract and format validation |
| `roadflowgateway/` | Optional/reference Gateway and editor handoff contracts |
| `roadflowsimulator/` | Local Go OA simulator for the Word acceptance route |
| `prototypes/roadflow-excel-save-demo/` | Real WPS ET Excel save demo |
| `scripts/stage-roadflow-extension.sh` | Build unpacked RoadFlow extension assets |
| `scripts/package-roadflow-crx.sh` | Build signed RoadFlow CRX |
| `extension/` and `cmd/native-host/` | Historical Native Messaging/local-agent route |
| `docs/` | Customer installation, acceptance, architecture, and research notes |

## More Documentation

- [`docs/roadflow-customer-installation.md`](docs/roadflow-customer-installation.md)
  - install and configure the current RoadFlow CRX.
- [`docs/roadflow-production-acceptance.md`](docs/roadflow-production-acceptance.md)
  - customer-machine acceptance checklist.
- [`docs/roadflow-local-manual-acceptance-zh.md`](docs/roadflow-local-manual-acceptance-zh.md)
  - Chinese local manual acceptance flow.
- [`docs/roadflow-local-simulated-acceptance-result.md`](docs/roadflow-local-simulated-acceptance-result.md)
  - scope and evidence for the local simulator.
- [`docs/adr/0006-use-browser-hosted-wps-for-roadflow.md`](docs/adr/0006-use-browser-hosted-wps-for-roadflow.md)
  - decision record for the browser-hosted WPS route.
- [`docs/customer-installation.md`](docs/customer-installation.md)
  - historical Native Messaging/DEB installation route.
