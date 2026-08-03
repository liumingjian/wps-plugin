# RoadFlow local simulated acceptance result

Status: **ACCEPTED FOR ISSUE #52 LOCAL END-TO-END SCOPE**

Date: 2026-08-02

This result accepts the RoadFlow route at the agreed endpoint: a simulated OA
Document Link and mock server on the designated local Kylin/Qaxbrowser/WPS
machine. It makes no claim about a customer OA or customer Gateway. The separate
production template remains `NOT ACCEPTED`.

To repeat this acceptance manually, use the Chinese step-by-step runbook in
[`roadflow-local-manual-acceptance-zh.md`](roadflow-local-manual-acceptance-zh.md).

## Accepted scope

- An ordinary `<a>` Document Link simulates the OA Edit Entry.
- Automated Chromium tests exercise the production content/editor assets and
  controlled source-identity, Gateway-receipt, and WPS boundaries.
- Current local Qaxbrowser exercises the real Kingsoft WPS NPAPI plugin against
  the local mock server, including DAV open, editing, overwrite, Return, and
  fresh-cache-key reopen.
- No customer environment, credential, deployment, or approval is required by
  this revised acceptance endpoint.

## Environment

| Field | Observed value |
| --- | --- |
| Repository base commit under test | `514afe46eb7920e2f894be520c4abe4d8cf4630f` plus current worktree |
| UTC completion | `2026-08-02T13:47:49Z` |
| OS | Kylin V10 SP1, Linux `5.4.18-142-generic`, AArch64 |
| Qaxbrowser | `qaxbrowser-safe-stable 1.0.46402.2-1`, Chromium `102.0.5005.200` |
| WPS | `wps-office 12.1.2.26885.AK.preread.sw` |
| WPS NPAPI plugin SHA-256 | `42a6ca8cec31ef8d85846a3e68c597aeb7def0ec9857a9a732b2b167ff702013` |
| Qax NPAPI bridge SHA-256 | `1a3f5d96113eacf41821049137b1b6c46b0c5e0f21bf7f58e6cc179eedf5e8ac` |

## Automated evidence

| Check | Result |
| --- | --- |
| `go test ./...` | Passed |
| `npm run test:browser` | Passed, 5 tests |
| `python3 -m unittest prototypes/npapi-wps-validation/tests/test_mock_server.py` | Passed, 5 tests |
| Responsive editor layout | Passed at 1280x720 and 360x640 |
| Failed Document Identity Gate | WPS object absent, Save disabled, zero overwrite calls |
| Recoverable Overwrite Failure | Live WPS object retained; retry occurs only on the next Save action |
| Simulated OA public workflow | Same tab, Save, Return, and different fresh handoff on reopen |
| Packaged editor handoff | OA-Origin Blob assembled from extension assets; no source path in URL |

## Current-machine NPAPI evidence

Qaxbrowser was launched with an isolated local profile and connected to the
repository mock server. Browser and process inspection proved:

- `navigator.plugins` contained `Kingsoft WPS Plugin` and `npremoteplugin-qax`;
- `navigator.mimeTypes["application/x-wps"]` existed;
- the mounted WPS object exposed `Application` as a function and an active
  Document;
- Qaxbrowser started its `--type=npapi-plugin` process with
  `libbrowsergrapher.so`, and WPS started with `-automation -x11embed`;
- WPS fetched `/wps/document` with the Microsoft DAV User-Agent and a fresh
  `_wpsHandoff`;
- inserting marker `ROADFLOW-REVIEWED-E2E-20260802-2205` and choosing Save produced
  an authenticated multipart `OfficeSave` POST;
- Return restored `http://127.0.0.1:4317/`; reopening used a new Blob UUID and
  WPS `ActiveDocument.Content.Text` still contained the marker.

| Evidence | SHA-256 |
| --- | --- |
| Clean source Document | `fd18f34262830e2e9dee93cfb7668578e71208633a996a7574cb9f16b497b1d1` |
| Stored edited Document | `bdaa875878f5022035104c1d235ba5b075e6c05ff3fc3c17fa6f46bf1fada46f` |
| Reopened WPS editor screenshot | `d197b1192a3b3f27e9c3ddf24cf571b5388b3804ffd3a9c565afc8beb80765d7` |
| Signed CRX 1.0.2 | `59f855722f3768c1e603ae942e4a83af5565ce215a86ad8930d34f4104f26893` |

## Compatibility decision

The current WPS `saveURL_FormData` upload is a CFB/OLE Word Document even when
the initial mock source is DOCX. The local mock server preserves the submitted
artifact byte-for-byte, and current WPS reopens it with the saved marker. The
issue #52 local scope accepts that local behavior; it does not claim DOCX
serialization preservation or customer OA compatibility.

## Delivery boundary

The tested RoadFlow CRX route has no Native Messaging permission, local agent,
DEB dependency, product middleware, root setup, or browser/WPS binary repair.
The local mock server is acceptance infrastructure, not a production component.

Final status: **ACCEPTED FOR SIMULATED OA AND LOCAL ENVIRONMENT**
