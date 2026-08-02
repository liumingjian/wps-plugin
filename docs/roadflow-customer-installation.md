# RoadFlow WPS Editor CRX

This delivery is the browser-hosted RoadFlow route. Install the supplier-signed
`roadflow-wps-editor-<version>.crx` in the designated Qaxbrowser profile. Its
fixed extension ID is `bojjhibgkhknccepabkojdjodhhgdjfd`. This is separate
from the historical extension identity, so both routes can coexist in one profile.

No DEB, root access, background service, product middleware, or separate local
installation is part of this route. The historical Local WPS Editing extension
and its native delivery remain documented separately in
[`customer-installation.md`](customer-installation.md).

## Configure the browser profile

Open the extension details in `chrome://extensions`, then open **Extension
options**. Configuration is stored in the browser profile and can be changed
without rebuilding or re-signing the CRX.

Set exactly one **Trusted OA Origin**. It must be the HTTP or HTTPS Origin of the
RoadFlow deployment, with no path, query, fragment, or credentials. For example:

```text
https://oa.example.internal
```

Set exactly one **Gateway URL template** containing exactly one `{sourcePath}`
placeholder. For example:

```text
https://wps-gateway.example.internal/wps/document?fileurl={sourcePath}
```

Saving asks Qaxbrowser to grant access to the exact OA and Gateway Origins. If
either Origin is changed later, obsolete grants are removed after the replacement
configuration is active. The extension does not register its link interceptor
on other Origins.

The customer-operated WPS Document Gateway must be read-only, byte-preserving,
and reachable only on the trusted office network. It must not convert, retain,
or modify the Document. After fully writing and flushing a successful Document
response, the Gateway records a metadata-only Gateway Delivery Receipt for at most 30
seconds. The editor reads that receipt from the `delivery-receipt` sibling of
the configured Gateway path, using the fresh `_wpsHandoff` value and the exact
decoded source path. Gateway Delivery Receipt lookup must allow the fixed CRX Origin and must
return a conflict response rather than choosing between duplicate records.

## DOCX source validation policy

Before an Editor Handoff is issued, the extension reads the exact same-Origin
DOCX source with the current OA browser session and rejects redirects and
non-success responses. The packaged parser is `@zip.js/zip.js 2.8.34`; its
BSD-3-Clause license is included as `zip-js.LICENSE`.

Validation permits at most 25 MiB of compressed source data, 2,048 archive members,
a 100:1 aggregate expansion ratio, and 100 MiB of aggregate
uncompressed data. The limits are checked from ZIP central-directory metadata
before any OOXML member is expanded. The required content-types, package
relationship, and main WordprocessingML Document parts must be well-formed and
consistent with a DOCX path. Only the exact source path, actual format, byte
count, and SHA-256 identity are placed in session-scoped Editor Handoff state;
the source Document bytes are not retained.

## Check readiness

Select the extension toolbar icon after configuration. The popup reports one of
three states:

- **Configuration required**: open settings and save both required values.
- **WPS or browser plugin unavailable**: verify the designated WPS installation,
  enable its browser plugin and NPAPI support in Qaxbrowser, then restart the browser.
- **Environment ready**: the profile configuration and native editor surface
  are available for the RoadFlow route.

Readiness does not claim that an individual Document is safe to edit. The
Document Identity Gate performs that check for each Editor Handoff.

## Implement the OA overwrite endpoint

The customer OA must expose exactly
`POST /RoadFlow/uploadfiles/OfficeSave?fileurl=<sourcePath>` under the configured
Trusted OA Origin. The request uses the current OA browser session. Its multipart
body must contain one `filedata`, one lowercase MD5 `md5sum` matching those exact
bytes, and one `filename` compatibility value equal to `formId:formeditor`.
`fileurl` is the sole Overwrite Target; multipart names, filenames, and metadata
must never select or alter a server path.

Decode and normalize `fileurl`, reject traversal, then authorize the current OA
user against an exact server-managed Document mapping before reading the body.
A DOCX target accepts only a bounded, structurally valid DOCX/OOXML package.
Write the validated bytes to a temporary file in the target directory, flush it,
and atomically rename it over an existing original. Any authentication,
authorization, multipart, checksum, format, missing-original, or commit failure
must leave the original bytes unchanged.

Only a completed atomic rename returns HTTP 200 with `Success:true`, Code
`overwrite_committed`, and `Data` containing the exact `fileurl`, stored
`md5sum`, `format` (`docx`), and stored `bytes`. Failures return `Success:false`,
a stable `Code`, a user-safe `Message`, and `Data:null`, using HTTP 400, 401, 403,
404, or 500 as appropriate. Never encode a business failure in HTTP 2xx.

The Go package `roadflowoa` is the executable reference for this endpoint. A
customer OA implemented on another stack must pass the same HTTP and atomicity
contract; it does not require or permit separate product middleware.

## Supplier packaging

Unsigned staging is deterministic for a version and fails rather than replacing
an existing output directory:

```sh
OUTPUT=/tmp/roadflow-extension VERSION=1.0.0 bash ./scripts/stage-roadflow-extension.sh
```

The signed release requires the supplier-held encrypted key and the designated
Qaxbrowser packer:

```sh
ROADFLOW_CRX_RELEASE_KEY=/secure/roadflow-crx-release.pem bash ./scripts/package-roadflow-crx.sh
```
