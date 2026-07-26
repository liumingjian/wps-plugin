# macOS feasibility acceptance result

Date: 2026-07-25

## Designated environment

- macOS 26.5.2, arm64
- Qaxbrowser 1.2.46005.7, Chromium 102.0.5005.200
- WPS for macOS 12.1.26035
- Fixed extension ID: `mbkblmlopgjhdlandbjhpemifinfllim`
- Local-agent base commit: `a2c254a6789812f93cecb614a4c26fef07076c5c`, plus the acceptance fixes in this working tree
- Go toolchain: `go1.23.2 darwin/arm64`
- Editing Task ID: `task-doc-001`
- Unique visible edit: `WPS-E2E-20260725-2358-MJ`
- Submitted SHA-256: `8780cc486448c7b462a869d050336bf14a61763a6908edcc3cb86732c6f64b7f`

## Acceptance status

**Accepted on the designated Mac.** The full real-application path completed after adding the required `nativeMessaging` extension permission and making the setup build independent of the invoking directory.

The automated suite passed with `go test ./...`. The real run used Qaxbrowser to load the fixed-ID unpacked extension and trigger Editing Task `task-doc-001`. Native Messaging launched the arm64 local agent, which downloaded the Work Copy and opened the exact path in WPS. macOS accessibility automation appended and saved the unique visible edit. The page reached `succeeded`, the Demo returned the latest Submission with HTTP 200, and the downloaded DOCX was byte-for-byte identical to the WPS-saved Work Copy. Its `word/document.xml` contains the unique edit.

| Boundary | Result | Evidence |
| --- | --- | --- |
| Qaxbrowser loads the unpacked fixed-ID extension | Passed | Service worker URL used fixed ID `mbkblmlopgjhdlandbjhpemifinfllim` |
| Qaxbrowser Native Messaging reaches the local agent | Passed | Native host launched and created the task Work Copy |
| Local agent downloads the valid DOCX Work Copy | Passed | `$TMPDIR/wps-edit-agent/task-doc-001/doc-001.docx` |
| WPS opens the intended Work Copy | Passed | `wpsoffice` held the exact task Work Copy path open |
| WPS disk-write observation yields a stable changed version | Passed | WPS save changed the Work Copy from 996 to 10079 bytes; page later reached `succeeded` |
| Submission succeeds and records SHA-256 | Passed | Submitted SHA-256 `8780cc486448c7b462a869d050336bf14a61763a6908edcc3cb86732c6f64b7f` |
| Latest server result contains the unique edit | Passed | HTTP 200 DOCX matched the Work Copy byte-for-byte and contained `WPS-E2E-20260725-2358-MJ` in `word/document.xml` |

Detailed local evidence is retained under `.acceptance-evidence/2026-07-25-local-e2e/fixed-run/` and is intentionally not part of the product deliverable.

## Required conclusion

Qaxbrowser Native Messaging was **proven** on the designated Mac. WPS disk-write observation was **proven** on the designated Mac. The end-to-end Editing Task is accepted for this feasibility environment.

## Observed PoC result and fallback rule

The first real attempt exposed a concrete product defect: the delivered extension lacked the `nativeMessaging` permission, so Qaxbrowser reported that `chrome.runtime.sendNativeMessage` was not a function. The minimal manifest fix was applied and covered by an acceptance regression test. No fallback architecture is required for this boundary.

The setup script also depended on the caller's current directory when building the Go host. It now changes to its computed repository root before running `go build`, and the acceptance test invokes it from outside the repository.

## Scope disclaimer

This result explicitly makes no claim about Galaxy Kylin, Linux ARM64, customer-system integration, production durability, or production deployment compatibility. It applies only to feasibility work on the designated macOS arm64 machine and named application versions.
