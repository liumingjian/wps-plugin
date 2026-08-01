# Document Identity Gate target-machine prototype

PROTOTYPE: this disposable artifact answers whether the designated Kylin V10
ARM64 + Qaxbrowser + WPS machine can enforce the production Document Identity
Gate before exposing editing or overwrite. It is not production code.

The prototype keeps all flow state in memory and renders the complete state in
the editor footer. The originating Demo OA tab remains open so its extension
content script can repeat an authenticated, same-Origin source read on every
fresh attempt. That new-tab shell is deliberately inherited from the earlier
Gateway prototype; production V1's already-decided current-tab navigation is
not being re-evaluated here.

Run it interactively with one command:

```bash
bash prototypes/document-identity-gate/run.sh
```

Run the complete target-machine evidence matrix with:

```bash
bash prototypes/document-identity-gate/run.sh --capture
```

The capture covers success, missing OA session, a 200 HTML error page, stale
Gateway caching, a different valid DOCX, no receipt, a falsified receipt,
receipt timeout, and a successful retry with a fresh Editor Handoff. Evidence
is written to `evidence/`.

The server scenarios are prototype fault injection. In the real integration,
the OA source endpoint and customer-owned WPS Document Gateway are independent
systems.
