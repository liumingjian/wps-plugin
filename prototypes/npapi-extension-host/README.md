# WPS NPAPI Extension Host Probe

This is a throwaway prototype for one question: can Qaxbrowser instantiate and
script `<object type="application/x-wps">` from a `chrome-extension://` page?

Run on the target Kylin ARM64 machine with Qaxbrowser and WPS installed:

```bash
bash prototypes/npapi-extension-host/run.sh
```

The command launches an isolated Qaxbrowser profile, loads this directory as an
unpacked extension, opens the probe page, and writes JSON plus a screenshot to
`prototypes/npapi-extension-host/evidence/`.

The extension page is a viable V1 editor host only when all of these are true:

- `mimeTypeExposed` is `true`;
- `applicationType` is `function` or `object`;
- `applicationName` identifies WPS.

This probe intentionally does not test document transfer or saving. Those are
separate contract decisions after the editor-page host is chosen.
