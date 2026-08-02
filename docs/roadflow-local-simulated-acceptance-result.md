# RoadFlow local simulated acceptance result

Status: **ACCEPTED FOR THE REVISED #51 SCOPE**

Date: 2026-08-02

This result accepts the RoadFlow route at the agreed endpoint: a simulated OA
Document Link and mock server on the designated local Kylin/Qaxbrowser/WPS
machine. It makes no claim about a customer OA or customer Gateway. The separate
production template remains `NOT ACCEPTED`.

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
| Repository commit under test | `cd1cf47b57de78412f816b2763dd3d6bcb7afb0d` |
| UTC completion | `2026-08-02T07:10:03Z` |
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

## Current-machine NPAPI evidence

Qaxbrowser was launched with an isolated local profile and connected to the
repository mock server. Browser and process inspection proved:

- `navigator.plugins` contained `Kingsoft WPS Plugin` and `npremoteplugin-qax`;
- `navigator.mimeTypes["application/x-wps"]` existed;
- the mounted WPS object exposed `Application` as a function and an active
  Document;
- Qaxbrowser started its `--type=npapi-plugin` process with
  `libbrowsergrapher.so`, and WPS started with `-automation -x11embed`;
- WPS fetched `/documents/acceptance/content` with the Microsoft DAV User-Agent;
- inserting marker `LOCAL-ACCEPTANCE-20260802` and choosing Save produced one
  multipart POST and receipt `145411e419914637b0b09c2e86382cea`;
- Return invoked the WPS exit path; reopening with cache identity
  `reopen-20260802` opened an active Document whose content still contained the
  marker.

| Evidence | SHA-256 |
| --- | --- |
| Stored edited Document | `fd18f34262830e2e9dee93cfb7668578e71208633a996a7574cb9f16b497b1d1` |
| Mock overwrite receipt | `b08b440a2ff34da4352800bc82111d4d6be76cd8a4adaf92b3cdc563c89f6878` |
| Mock server log | `dca4a0f7171b7a6dffab72d00d65a265266117ca99718dfa32b37cafb315127b` |
| Reopened WPS viewport screenshot | `0c6abd6a2af5c2faac98fc96d018fdea37316792738c975f5c81a27e2dcabe30` |

## Compatibility decision

The current WPS `saveURL_FormData` upload is a CFB/OLE Word Document even when
the initial mock source is DOCX. The local mock server preserves the submitted
artifact byte-for-byte, and current WPS reopens it with the saved marker. The
revised #51 scope accepts that local behavior; it does not claim DOCX
serialization preservation or customer OA compatibility.

## Delivery boundary

The tested RoadFlow CRX route has no Native Messaging permission, local agent,
DEB dependency, product middleware, root setup, or browser/WPS binary repair.
The local mock server is acceptance infrastructure, not a production component.

Final status: **ACCEPTED FOR SIMULATED OA AND LOCAL ENVIRONMENT**
