# RoadFlow production acceptance

This runbook is the release gate for the fixed-ID, CRX-only RoadFlow route on
the designated customer environment. It supplements automated tests; it does
not permit simulated OA, Gateway, browser, or WPS evidence to be recorded as a
production pass.

Do not record the route as accepted until every required row in the result
template passes for both DOCX and DOC. A failed or unexecuted row leaves the
release unaccepted.

## Evidence boundary

Use [`roadflow-production-acceptance-result.md`](roadflow-production-acceptance-result.md)
as the immutable result for one release candidate. Copy it outside the source
tree before the run so customer hostnames, user identifiers, cookies, and
Document content are not committed. Record UTC timestamps and SHA-256 hashes
for the signed CRX, every saved evidence file, and the completed result.

Evidence may contain opaque Document labels and redacted Origins. It must never
contain OA cookies, credentials, Gateway filesystem paths, or Document bytes.
Screenshots must be reviewed for customer data before retention.

Record these fixed facts before testing:

- repository commit and a clean RoadFlow diff;
- signed CRX SHA-256 and extension ID `bojjhibgkhknccepabkojdjodhhgdjfd`;
- Kylin release, architecture, kernel, Qaxbrowser package, and WPS package;
- Trusted OA Origin and Gateway Origin, redacted after reviewers confirm the
  exact values in person;
- OA and Gateway deployment revisions;
- two dedicated, recoverable test Documents, one DOCX and one DOC;
- Gateway receipt TTL and editor verification timeout.

Do not use production business Documents. Preserve server-side originals in a
customer-controlled recovery location before destructive failure injection.

## Automated release checks

Run from the exact commit used to stage the signed CRX:

```sh
go test ./...
npm ci
npx playwright install chromium
npm run test:browser
```

Then stage twice with the release version and compare both trees before signing:

```sh
OUTPUT=/tmp/roadflow-stage-a VERSION=<version> bash ./scripts/stage-roadflow-extension.sh
OUTPUT=/tmp/roadflow-stage-b VERSION=<version> bash ./scripts/stage-roadflow-extension.sh
diff -ru /tmp/roadflow-stage-a /tmp/roadflow-stage-b
```

The supplier signs with `scripts/package-roadflow-crx.sh`. Record the resulting
CRX hash. The automated browser uses a controlled WPS boundary and does not
replace the target-machine tests below.

## Gateway deployment checks

Confirm configuration and exercise each behavior against the real Gateway:

1. Receipt lookup accepts only the exact fixed CRX Origin. A missing Origin,
   OA Origin, another extension Origin, and an Origin suffix/prefix variant
   each receive a non-success response and no receipt data.
2. A successful lookup includes
   `Access-Control-Allow-Origin: chrome-extension://bojjhibgkhknccepabkojdjodhhgdjfd`
   and `Cache-Control: no-store`. No wildcard Origin or credential reflection
   is allowed.
3. A successful Document response is byte-for-byte equal to the current OA
   source, carries `Cache-Control: no-store`, and is fetched by WPS with the
   exact decoded `sourcePath` plus a fresh `_wpsHandoff` cache identity.
4. No receipt exists before delivery completes and flushes. Abort one delivery
   after headers and one during the body; both lookups must remain missing.
5. A receipt contains metadata only: exact handoff, decoded source path, actual
   format, byte count, SHA-256, and delivery time. It contains no Document bytes,
   cookie, credential, overwrite capability, or server path.
6. The configured retention is no more than 30 seconds. Lookup succeeds within
   the intended window, expires at the boundary, and cleanup removes expired
   records without operator action.
7. Reusing one handoff for conflicting identities yields a conflict response;
   the Gateway never chooses either record.
8. Delivery and receipt lookup complete early enough for the editor's bounded
   10-second verification timeout under the customer's normal and agreed
   worst-case network conditions. Record measured p50 and maximum timing.

Retain the Gateway access-log correlation IDs for each row and record only those
IDs in the result. The Gateway must be read-only and reachable only on the
trusted office network.

## Target-machine success flow

Repeat all steps once with DOCX and once with DOC.

1. Install the signed CRX into the designated Qaxbrowser profile. Confirm the
   fixed extension ID and that the manifest has no `nativeMessaging` permission.
2. At the fixed extension Origin, confirm `application/x-wps`, the Kingsoft WPS
   plugin, and the WPS `Application` object are available. Capture the browser
   plugin page and the embedded editor state.
3. Sign in to the real OA and normally click the eligible Document Link. Confirm
   the activation is intercepted and `editor.html?handoff=<opaque>` replaces the
   OA page in the same tab. The URL must expose no OA URL, source path, or cookie.
4. From OA and Gateway logs, confirm the source read used the authenticated OA
   session while the WPS DAV read used the Gateway URL and fresh handoff. Hash
   both response bodies at their owners and confirm identical format, bytes,
   and SHA-256 without exporting the bodies.
5. Before the matching receipt is observable, confirm the WPS surface is hidden,
   Save is disabled, and no OfficeSave request exists. After the receipt and
   `ActiveDocument` agree, confirm the WPS surface and Save become available.
6. Insert a unique non-sensitive marker in WPS and choose **保存**. Confirm one
   authenticated OfficeSave request targets only the original `sourcePath`, the
   OA atomically replaces the original, and its Overwrite Receipt matches path,
   MD5, actual format, and byte count.
7. Choose **返回 OA**. Confirm replacement navigation restores the exact OA URL
   in the same tab and Back does not reopen the consumed Editor Handoff.
8. Activate the same Document Link again. Confirm a different handoff/cache key,
   a fresh Gateway delivery and receipt, and the committed marker visible in WPS.

For DOCX, inspect the committed serialization independently and require a valid
DOCX/OOXML package. For DOC, require a valid CFB/OLE Word Document. A DOCX Edit
Entry that uploads CFB/OLE is a failure, even if WPS can reopen it.

## Failure matrix

Run every row for both formats unless the row explicitly concerns navigation.
Before each row record the OA original hash and total OfficeSave request count;
after it record the same values. Every Document Identity Gate failure must show
the verification-failed state, remove the WPS object, keep Save disabled, and
produce zero new OfficeSave requests.

| Case | Injection | Required observation |
| --- | --- | --- |
| Authentication loss | Expire the OA session before source read | OA page remains visible; no handoff, editor, WPS object, or overwrite is created |
| Wrong Document | Gateway maps the test path to the other-format fixture | Receipt/identity mismatch closes the gate; original unchanged |
| Stale cache | Prime WPS with the previous version, then start a fresh handoff | New cache key is requested; stale bytes cannot pass the gate |
| Missing receipt | Suppress receipt creation after delivery | Gate times out; WPS object removed; zero overwrite |
| Mismatched receipt | Alter exactly one of path, format, bytes, or SHA-256 | Gate fails for every altered field; zero overwrite |
| WPS failure | Make `openDocument` fail or remove NPAPI before entry | Visible failure; WPS object removed; zero overwrite |
| Timeout | Delay delivery/lookup beyond 10 seconds | Bounded visible failure; no later receipt unlocks the stale editor |
| Recoverable Overwrite Failure | Reject OfficeSave after a verified edit | Live WPS Document remains; status is **保存失败**; original unchanged |
| Retry | Restore authorization, then choose **重试保存** once | No automatic retry; exactly one new request commits atomically |
| Discard cancel | After save failure, choose Return then cancel | Editor and live WPS Document remain; no navigation or overwrite |
| Discard confirm | After save failure, choose Return then confirm | Exact OA return URL replaces editor; failed bytes remain uncommitted |
| Return failure | Block replacement navigation | Editor and WPS remain usable; status is **返回 OA 失败** |

Also exercise malformed, expired, duplicate-conflicting, and cross-handoff
receipt lookups at the Gateway boundary. For all atomic-save failures, compare
the complete original hash before and after, not only the response status.

## Release boundary

Inspect the staged CRX, installed profile, process list, network trace, and
customer deployment. Acceptance requires all of the following:

- no Native Messaging permission, host manifest, message, or process;
- no local agent, background product service, DEB dependency, or root setup;
- no product middleware between the CRX and customer OA/Gateway;
- no system repair, browser binary modification, WPS binary modification, or
  ad-hoc allowlist introduced during the run;
- only the fixed CRX, existing Qaxbrowser/WPS installation, configured OA, and
  customer-operated read-only Gateway participate in the route.

Any exception is a release failure and must be resolved in code or deployment,
then the affected format and failure matrix rerun from a fresh handoff.
