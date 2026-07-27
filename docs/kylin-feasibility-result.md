# Kylin V10 ARM64 development acceptance result

Date: 2026-07-27

## Designated environment

- Kylin V10 SP1 (`KYLIN_RELEASE_ID=2503`), AArch64, kernel
  `5.4.18-142-generic`.
- Qaxbrowser `1.0.46371.2-1` ARM64.
- WPS Office `12.1.2.26885.AK.preread.sw` ARM64.
- Go `go1.23.2 linux/arm64` at `/home/xiaohu/.local/bin/go`.
- Fixed extension ID: `mbkblmlopgjhdlandbjhpemifinfllim`.
- Base commit: `21bc7b36cb59460d8751ac64e6801d8db917004d`, plus the
  Native Messaging origin-argument fix in this working tree.
- Acceptance started at `2026-07-27T03:46:52Z`.

## Verdict

**Not yet accepted on the designated Kylin machine.** The browser, local
agent, WPS lifecycle, ordered Snapshot pipeline, failure reporting, and
user-level delivery boundaries passed. The required visible-marker check did
not pass because the installed WPS 365 package was logged out and displayed
`请登录后对文档进行编辑`; attempted text remained in the input-method pre-edit
window and was not committed to the Document. Authentication or a licensed
editing-capable WPS package is required and was not bypassed.

The ordered pipeline was still exercised with two distinct WPS-persisted DOCX
structure changes. This proves ordering and final byte equality, but it is not
substitute evidence for `KYLIN-ACCEPTANCE-FIRST` and
`KYLIN-ACCEPTANCE-SECOND` appearing in the Document.

## Acceptance matrix

| Boundary | Result | Evidence |
| --- | --- | --- |
| Automated suite | Passed | `go test ./...` passed on the designated machine after the acceptance fix. |
| ARM64 build | Passed | `bash ./scripts/build-kylin-arm64.sh`; static AArch64 ELF SHA-256 `4fc5accb7eec08dd653f8603bf7f90dad98494f0692272e3ba8962ca4a3b2867`. |
| Repeatable setup | Passed | Two setup runs printed the same extension, host, manifest, and state paths; the installed host hash equalled the build hash. |
| Fixed-ID extension and Native Messaging | Passed after fix | Qaxbrowser loaded `/home/xiaohu/.local/share/wps-edit-demo/extension` as `mbkblmlopgjhdlandbjhpemifinfllim`; a correlated protocol-v1 ping returned `pong` with `status: accepted`. |
| Unchanged close | Passed | Work Copy `edit-doc-001-c8bd6978-5659-4908-b6fb-7343a3e2eb8f/doc-001.docx` closed at Version 1 without a `snapshots` directory; the page reported that Version 1 remained current. |
| Two ordered distinct saves through close | Partially passed | Task `edit-doc-001-216149da-714e-4bca-8e2b-72f67b89a620` created `000001` then `000002`, reached Version 3 only after WPS close, and retained the host while WPS remained open. The required visible markers were not committed because WPS required login. |
| Final byte equality | Passed | Final Work Copy, `000002`, and `/documents/doc-001/content` all had SHA-256 `1ed75b33e263913de4be41c53ec713eea75a31cefb2a792b3e7d609657700e31`. |
| Concurrent Editing Task | Passed | While an Editing Task held the process-wide lock, a second request failed with `another Editing Task is active` and created no task directory. |
| Agent unavailable | Passed | With the product manifest moved aside and Qaxbrowser restarted, the page reported `Local agent unavailable: Specified native messaging host not found.` |
| Submission failure retention | Passed | With the Demo stopped before persistence, the page reported the retained Snapshot path; Work Copy and mode-`0400` Snapshot both hashed to `565a9ac9b6a980c8defb37ef980c2c55d444c82c6b82aae5bbeafef37e01bce4`. |
| Uninstall | Passed | The unpacked extension was removed, then `bash ./scripts/uninstall-kylin.sh` removed the install root and product manifest while retaining Work Copies and Snapshots below the state root. |

## Ordered Submission evidence

The successful ordering task used these immutable Snapshots:

| Sequence | Size | SHA-256 |
| --- | ---: | --- |
| `000001` | 9759 | `fadc23f84a85c9971b71c7bf498b772e0daae8d618c5da8034268081ff3df618` |
| `000002` | 9823 | `1ed75b33e263913de4be41c53ec713eea75a31cefb2a792b3e7d609657700e31` |

The page reached Version 2 after the first Submission and Version 3 after the
second. The Native Messaging host remained active until WPS closed, after
which the page reported `Version 3 is current. You can edit it again in WPS.`

## Acceptance defect fixed

The first product ping exposed a real Qaxbrowser compatibility defect.
Qaxbrowser passes the invoking extension origin as the Native Messaging host's
first argument. The product host treated every first argument as a CLI command
and exited with:

```text
unknown command "chrome-extension://mbkblmlopgjhdlandbjhpemifinfllim/"
```

The host now reserves `manifest` for its explicit CLI subcommand, accepts a
`chrome-extension://` first argument as the browser invocation, and retains the
unknown-command error for other arguments. A protocol regression test launches
the host with Qaxbrowser's exact origin argument and requires a correlated
`pong`. The real browser ping passed after rebuild and setup.

## Installed and retained paths

- Installed extension before uninstall:
  `/home/xiaohu/.local/share/wps-edit-demo/extension`
- Installed host before uninstall:
  `/home/xiaohu/.local/share/wps-edit-demo/native-host/native-host`
- Qaxbrowser manifest before uninstall:
  `/home/xiaohu/.config/qaxbrowser/NativeMessagingHosts/com.liumingjian.wps_edit_agent.json`
- Retained state after uninstall:
  `/home/xiaohu/.local/state/wps-edit-demo`
- Retained failed-Submission Snapshot:
  `/home/xiaohu/.local/state/wps-edit-demo/tasks/edit-doc-001-13367c4c-30ec-4fe8-a164-e92b874342cf/snapshots/000001-565a9ac9b6a980c8defb37ef980c2c55d444c82c6b82aae5bbeafef37e01bce4.docx`

## Remaining acceptance action

Provide either an operator-authorized WPS 365 login or a formally licensed
editing-capable ARM64 WPS package, rerun setup, and repeat the two-save task
with `KYLIN-ACCEPTANCE-FIRST` and `KYLIN-ACCEPTANCE-SECOND`. Acceptance
requires both markers in the WPS UI, server preview, and final DOCX, plus the
already-proven ordered Snapshot and final-hash checks. No other boundary needs
redesign based on this run.

## Follow-up licensing diagnosis

A follow-up run reset the per-user WPS profile and briefly allowed an unsigned
local edit. That result was not durable: a fresh browser-to-WPS Editing Task
again displayed `请登录后对文档进行编辑` before either acceptance marker was
written. The installed package metadata identifies the product as `WPS365`, so
profile reset is not a valid removal of the product's authorization boundary.

The Kylin repository's ARM64 alternative
`12.1.2.1128.AK.preload.sw` was downloaded and run from an isolated extraction
without replacing the system package. Its package metadata identifies the
product as `Professional`; it accepted and persisted an offline DOCX edit, but
the UI displayed `剩余30天试用`. It is therefore evidence that an editing-capable
package solves the technical boundary, not a permanent unlicensed substitute.

## Scope disclaimer

This result applies only to the designated Kylin V10 ARM64 machine and named
Qaxbrowser and WPS versions. It makes no claim about production packaging,
enterprise deployment, customer-system integration, other Linux
distributions, or other office applications.
