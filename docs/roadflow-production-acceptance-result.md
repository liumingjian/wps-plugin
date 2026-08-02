# RoadFlow production acceptance result

Status: **NOT EXECUTED**

This tracked file is a blank schema, not release evidence. For each release,
create a customer-controlled copy, complete it using
`roadflow-production-acceptance.md`, hash the evidence, and obtain the named
approvals. `NOT EXECUTED`, blanks, failures, or missing hashes mean the route is
not accepted.

## Release identity

| Field | Recorded value |
| --- | --- |
| UTC start/end | |
| Repository commit | |
| Signed CRX SHA-256 | |
| Fixed extension ID | `bojjhibgkhknccepabkojdjodhhgdjfd` |
| Kylin/kernel/architecture | |
| Qaxbrowser package | |
| WPS package | |
| OA deployment revision | |
| Gateway deployment revision | |
| Redacted OA/Gateway Origins reviewed in person | |
| Gateway receipt TTL / editor timeout | |

## Automated checks

| Check | Pass/fail | Evidence SHA-256 |
| --- | --- | --- |
| `go test ./...` | | |
| `npm run test:browser` | | |
| Deterministic staging | | |
| Signed fixed-ID CRX inspection | | |

## Gateway checks

| Check | Pass/fail | Log correlation / evidence SHA-256 |
| --- | --- | --- |
| Exact fixed-CRX receipt authorization and CORS | | |
| Unauthorized Origin variants rejected | | |
| Byte-preserving no-store DAV delivery | | |
| Receipt only after complete flushed delivery | | |
| Metadata-only receipt fields | | |
| Retention boundary and automatic cleanup | | |
| Conflicting receipt rejected | | |
| Delivery/lookup p50 and maximum below timeout | | |

## Target matrix

| Case | DOCX pass/fail + evidence | DOC pass/fail + evidence |
| --- | --- | --- |
| Same-tab Edit Entry and authenticated source read | | |
| NPAPI at fixed extension Origin | | |
| Gateway DAV, receipt, WPS edit, atomic Save | | |
| Return and fresh-handoff reopen | | |
| Authentication loss | | |
| Wrong Document | | |
| Stale cache | | |
| Missing receipt | | |
| Mismatched receipt | | |
| WPS failure | | |
| Verification timeout | | |
| Save failure | | |
| Explicit retry | | |
| Discard cancel and confirm | | |
| Return failure | | |

For every failed Document Identity Gate, record the visible failed state, absent
WPS object, disabled Save control, unchanged original hash, and zero delta in OfficeSave requests.

## CRX-only release boundary

| Requirement | Pass/fail | Evidence SHA-256 |
| --- | --- | --- |
| No Native Messaging | | |
| No local agent or background product service | | |
| No DEB or root setup | | |
| No product middleware | | |
| No system/browser/WPS repair or modification | | |

## Exceptions and approvals

Exceptions: none permitted. List any failed row here and leave status unaccepted.

| Role | Name | UTC approval | Signature/reference |
| --- | --- | --- | --- |
| Customer OA owner | | | |
| Customer Gateway owner | | | |
| Target-machine acceptance engineer | | | |
| Release owner | | | |

Final status: **NOT ACCEPTED**
