# Document Identity Gate target-machine result

Date: 2026-08-01

## Provisional verdict

Yes for the exercised DOCX route: the disposable CRX prototype enforced the
agreed Document Identity Gate on the designated Kylin V10 SP1 ARM64 +
Qaxbrowser `Chrome/102.0.5005.200` + WPS machine. Editing and overwrite remained
locked until an authenticated OA source identity exactly matched the Gateway
Delivery Receipt for the same fresh Editor Handoff.

This verdict remains provisional until human review. The full machine-readable
record is `evidence/result.json`; all 18 assertions are `true` in the final
self-contained capture.

## Evidence

- The extension content script read the original same-Origin source with the
  HttpOnly OA session Cookie, classified the actual serialization as DOCX, and
  derived byte count and SHA-256 without retaining the Document bytes.
- WPS identified itself as `WPS文字` and fetched the prepared Gateway URL with
  its DAV client. The Gateway recorded its metadata-only receipt only after the
  successful Word response had been written and flushed.
- The successful case matched handoff, sourcePath, actual format, byte count,
  and SHA-256. Only then did the embedded NPAPI object expand from its hidden
  locked state and the page-level **保存** control become enabled. One authenticated
  overwrite POST followed and succeeded.
- Missing OA session and a 200 HTML error page failed before WPS was mounted.
  A different valid DOCX, an omitted receipt, falsified receipt SHA-256, and a
  receipt delayed beyond the bounded timeout all failed after WPS open. Each
  failure destroyed the NPAPI object, exposed **重新验证** and **返回 OA**, kept
  **保存** disabled, and produced no overwrite POST.
- A run-unique stable Gateway URL was fetched once to seed WPS's cache. A new
  Editor Handoff then opened that cached URL without a new Gateway GET; because
  there was no receipt bound to the new handoff, the gate timed out and did not
  overwrite.
- The fresh-retry case first failed without a receipt, then used a different
  handoff identifier, repeated the authenticated source read and Gateway GET,
  and passed. Neither retry attempt overwrote the Document.
- The extension background readiness handshake and run-unique cache key make
  the complete evidence matrix reproducible with one command.

Representative UI captures are `evidence/success.png`,
`evidence/mismatch.png`, and `evidence/fresh-retry.png`. As in the earlier NPAPI
prototype, DevTools screenshots do not contain the native WPS child-window
pixels; WPS application state and server-side DAV evidence establish the
embedded editor behavior.

## Residual limitations

- The target-machine matrix exercised DOCX, not legacy DOC. The prototype's DOC
  classifier recognizes the CFB/OLE signature but does not deeply parse CFB.
- DOCX classification checks ZIP magic and required package member names. A
  production implementation should use a maintained parser and explicit size,
  decompression, and malformed-package limits.
- The Demo OA and Demo Gateway share one loopback process so faults can be
  injected deterministically. A real customer Gateway implementation,
  deployment topology, authorization of its receipt lookup, and operational
  receipt store were not validated.
- The in-memory receipt store and three-second polling timeout are prototype
  choices, not production persistence, retention, or timeout decisions.
- Recording after the response write and flush proves server-side completion to
  the socket. It does not prove that WPS parsed or rendered the bytes; the gate
  separately requires `openDocument === true` and `ActiveDocument`.
- The prototype retains the earlier new-editor-tab shell so the originating OA
  content script can repeat source reads. It does not re-test the already-decided
  production current-tab navigation and return behavior.
- The gate remains an open-time identity check. It does not add edit locking,
  save-time source comparison, version tokens, or conflict detection.

## Reproduce

```bash
bash prototypes/document-identity-gate/run.sh --capture
```

For manual review:

```bash
bash prototypes/document-identity-gate/run.sh
```
