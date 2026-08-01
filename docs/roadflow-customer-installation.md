# RoadFlow WPS Editor CRX

This delivery is the browser-hosted RoadFlow route. Install the supplier-signed
`roadflow-wps-editor-<version>.crx` in the designated Qaxbrowser profile. Its
fixed extension ID is `mjjoapeohdfkepmocpahbimmmenlfdcb`.

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

Saving asks Qaxbrowser to grant access to that exact OA Origin. If the Origin is
changed later, the old grant is removed after the replacement configuration is
active. The extension does not register its link interceptor on other Origins.

The customer-operated WPS Document Gateway must be read-only, byte-preserving,
and reachable only on the trusted office network. It must not convert, retain,
or modify the Document. Gateway Delivery Receipt behavior is configured with the full
Document Identity Gate integration rather than by this CRX packaging step.

## Check readiness

Select the extension toolbar icon after configuration. The popup reports one of
four states:

- **Configuration required**: open settings and save both required values.
- **WPS unavailable**: install the designated WPS build with its browser
  component, then restart Qaxbrowser.
- **WPS browser plugin unavailable**: enable the WPS browser plugin and NPAPI
  support in Qaxbrowser, then restart the browser.
- **Environment ready**: the profile configuration and native editor surface
  are available for the RoadFlow route.

Readiness does not claim that an individual Document is safe to edit. The
Document Identity Gate performs that check for each Editor Handoff.

## Supplier packaging

Unsigned staging is deterministic for a version and fails rather than replacing
an existing output directory:

```sh
OUTPUT=/tmp/roadflow-extension VERSION=1.0.0 bash ./scripts/stage-roadflow-extension.sh
```

The signed release requires the supplier-held encrypted key and the designated
Qaxbrowser packer:

```sh
CRX_RELEASE_KEY=/secure/crx-release.pem bash ./scripts/package-roadflow-crx.sh
```
