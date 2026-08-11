# RoadFlow WPS Editor installation

The signed CRX integrates directly with the customer OA. No Gateway, No DEB,
Native Messaging host, local agent, or OA source-code change is required.

## Requirements

- The designated Kylin workstation, Qaxbrowser, WPS installation, and the
  `application/x-wps` browser plugin must already be available.
- Existing document links must be ordinary same-Origin HTTP or HTTPS `<a>` links
  whose path ends in `.doc`, `.docx`, `.wps`, `.xls`, or `.xlsx`.
- The extension also observes matching document links inside OA `iframe` forms,
  including nested same-origin frames. The frame and top-level OA page must both
  be within the configured Origin in scoped mode.
- The linked Document URL must be directly readable by WPS. A URL that only
  works after a browser-only redirect or challenge is not compatible with
  direct OA mode.
- The OA must retain its existing authenticated endpoint:
  `POST /RoadFlow/uploadfiles/OfficeSave?fileurl=...`.

## Install and configure

Install the signed `roadflow-wps-editor-<version>.crx`. Confirm that its fixed
extension ID is `bojjhibgkhknccepabkojdjodhhgdjfd`.

Open extension settings and enter the exact **Trusted OA Origin**, or leave it
blank to enable all-origin mode. In scoped mode it must contain the scheme,
host, and optional port without a path, query, credentials, or fragment.
Example:

```text
http://ywsh.yn.srrc.org.cn
```

Saving a blank value requests HTTP/HTTPS permissions for all origins; saving an
Origin requests permission only for that Origin. The readiness states are
**Configuration required**, **WPS or browser plugin unavailable**, and
**Environment ready**. The last state is required before testing a Document
link.

All-origin mode intercepts every HTTP/HTTPS supported document link visible to
the browser extension. For production, prefer the exact OA Origin when the
customer host is known.

## Direct editing route

For a customer link such as:

```text
http://ywsh.yn.srrc.org.cn/Attachment/UploadFiles/202608/03//测试文档20260803_NHZP84.docx
```

the extension:

1. intercepts the click instead of allowing the download (same-Origin in
   scoped mode, any HTTP/HTTPS source in all-origin mode);
2. opens a new editor tab while preserving the original OA tab;
3. reads and validates the source serialization within the authenticated OA
   page;
4. opens the original OA URL directly in WPS;
5. enables and displays revision tracking for Writer documents before editing
   is unlocked; spreadsheet files use the WPS ET workbook change-history APIs
   and request all-change highlighting before editing is unlocked;
6. saves to the existing OfficeSave endpoint on the configured Origin, or on
   the document source Origin in all-origin mode.

WPS ET applies on-screen change highlighting to shared workbooks. When a normal
exclusive workbook is opened, the extension converts the local WPS copy to
shared revision mode before enabling change-history retention and on-screen
highlighting. The OA source is overwritten only after the user clicks **保存**.

Clicking **返回** closes the editor tab and returns to the OA tab that launched
it. When the click originated inside an iframe, the original OA tab and its
iframe remain intact.

The logical `fileurl` is decoded exactly once. Customer path structure,
including repeated slashes, is preserved when OfficeSave is called.

## Security scope

The extension validates the file selected by the browser before opening WPS,
with a 25 MiB compressed limit, 2,048 archive-member limit, 100:1 expansion
limit, and 100 MiB expanded limit. Writer `.doc`, `.docx`, and `.wps` files plus
Excel `.xls` and `.xlsx` files are supported. DOCX and XLSX use
`@zip.js/zip.js 2.8.34`; CFB 1.2.2 files use maintained mscfb v1.0.7-compatible
structural stream, `WordDocument`, and FIB checks. Document bytes are not retained
after validation. WPS `saveURL_FormData` may serialize a saved `.docx` or `.xlsx`
as the corresponding legacy CFB Word or Excel container; those same-family
serializations are accepted on the next open and by OfficeSave. Cross-family,
malformed, and structurally invalid payloads remain rejected.

Direct OA mode has no second-download receipt. The customer OA is responsible
for serving the same stable Document bytes when WPS opens the original URL.
