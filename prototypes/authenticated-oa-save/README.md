# Authenticated OA Save Probe

PROTOTYPE: this answers one question on the designated Kylin ARM64 machine:
can a packaged `chrome-extension://` WPS NPAPI editor reuse the current browser
OA session for a protected Document GET and the RoadFlow-style overwrite-save
POST?

Run the whole probe with one command:

```bash
bash prototypes/authenticated-oa-save/run.sh
```

The command starts a cookie-protected Demo OA, launches Qaxbrowser with an
isolated profile and this unpacked extension, establishes a normal OA browser
session, and runs three cases:

1. open the protected `/UploadFiles/2026/contract.docx` and try to save it;
2. open an anonymous control Document and POST it to the protected
   `/RoadFlow/uploadfiles/OfficeSave?fileurl=<sourcePath>` endpoint;
3. when possible, reopen the protected source, edit it again, and overwrite it.

Evidence is written to `evidence/`. The Demo OA cookie is a fixed, throwaway
value so the exact request headers can be recorded safely.

The code is intentionally disposable. It is not a production OA server or CRX.
