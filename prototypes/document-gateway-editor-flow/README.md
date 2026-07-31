# Configured Document Gateway editor flow

PROTOTYPE: this answers whether the designated Kylin ARM64 + Qaxbrowser + WPS
machine can run the agreed V1 browser flow end to end. It is disposable and is
not the production extension or a generic OA integration.

The prototype keeps the flow state in memory and renders the complete state in
the editor footer. Its fixed Demo OA integration maps an original source path
through this permanent Gateway template:

```text
http://127.0.0.1:49240/wps/v1/document?fileurl={sourcePath}
```

Run the interactive prototype with one command:

```bash
bash prototypes/document-gateway-editor-flow/run.sh
```

Then click `Quarterly report.docx` in the Demo OA. A normal click is intercepted
without a prompt, the OA tab stays open, and a new packaged extension editor tab
opens. Edit in WPS, then use the page-level `Save` and `Return to OA` buttons.

Run the automated target-machine evidence pass with:

```bash
bash prototypes/document-gateway-editor-flow/run.sh --capture
```

Evidence is written under `evidence/`. The capture verifies the intercepted
click, single-use Editor Handoff, Gateway GET, authenticated RoadFlow-style
overwrite POST, and return to the still-open OA tab.

The return command focuses the originating OA tab and closes the editor tab.
It deliberately does not synchronously call WPS `Application.Quit()`: target
testing showed that call can block the editor renderer, while closing the tab
already tears down its embedded NPAPI object.

The Demo Gateway returns `no-store, no-cache, must-revalidate`. Target testing
showed that those headers alone do not force a fresh WPS GET. After resolving
`{sourcePath}`, the editor therefore appends an opaque `_wpsHandoff` cache key.
The cache key carries no credentials and does not change the separately
preserved `sourcePath` used by `OfficeSave`.

## Deliberate limitation

This first prototype has no independent Gateway-response preflight, fingerprint,
or Document-identity gate. `openDocument === true` plus `ActiveDocument` enables
save. A Gateway error page or wrong Document could therefore be edited and
overwrite the original `sourcePath`. The editor shows this risk; the prototype
does not claim to solve it.
