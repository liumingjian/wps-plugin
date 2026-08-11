# RoadFlow direct-OA production acceptance

Production acceptance must run on the designated customer Kylin workstation,
Qaxbrowser, WPS build, OA Origin, and a disposable customer test Document.
Local simulation is not customer acceptance.

Record no cookies, tokens, Document bytes, or unredacted business data.

## Preconditions

- Record the signed CRX SHA-256 and confirm extension ID
  `bojjhibgkhknccepabkojdjodhhgdjfd`.
- Configure the exact Trusted OA Origin and no Gateway.
- Confirm the readiness popup reports **Environment ready**.
- Confirm the customer link is a same-Origin `.doc`, `.docx`, `.wps`, `.xls`, or
  `.xlsx` `<a>` URL.
- Confirm WPS can read the original link directly without a browser-only
  redirect or authentication challenge.
- Confirm the existing OfficeSave route is enabled for the logged-in user.

## Required workflow

Run once for each Writer format in use (`DOCX`, `DOC`, `.wps`) and once for
each spreadsheet format in use (`.xls`/`.xlsx`):

1. Click the ordinary OA Document link and confirm the browser does not download
   the file, opens the editor in a second tab, and leaves the original OA tab
   open.
2. Confirm WPS opens the exact original OA URL.
3. Confirm revision tracking and revision display are enabled before editing.
4. Insert a unique marker and confirm `ActiveDocument.Revisions.Count` grows.
5. Save through OfficeSave, click **返回**, and confirm the editor tab closes
   back to the original OA tab.
6. Reopen through a fresh click and confirm the marker and revision persist.
7. Reject the test revision, save, and reopen to confirm cleanup.

For a spreadsheet run, verify `Application.ActiveWorkbook` is the opened file,
`MultiUserEditing` is `true`, `KeepChangeHistory` is `true`,
`HighlightChangesOptions(3, "Everyone")` was requested,
`HighlightChangesOnScreen` is `true`, and `ListChangesOnNewSheet` is `false`.
For an originally exclusive workbook, verify that the local WPS copy was first
saved with `SaveAs(..., accessMode=2)` before the change-history settings were
applied.

For an OA form loaded in an iframe, repeat the workflow from the iframe link
and confirm **返回** restores the original OA tab with the iframe still on its
editing page.

## Failure checks

- A malformed or wrong-format source must not open WPS or call OfficeSave.
- Cross-Origin, unsupported, modified, middle-button, or modifier-key clicks must
  retain normal browser behavior.
- An unavailable WPS revision interface must keep editing and save locked.
- An OfficeSave failure must retain the live WPS editor and allow one explicit
  retry; returning after a failure requires discard confirmation.
- Loss of the OA session must cause OfficeSave to fail without reporting saved.

Direct OA mode deliberately has no Gateway receipt. Record this limitation in
the customer result: pre-validation proves what the browser read, while the OA
must keep the original URL stable for WPS's subsequent direct read.
