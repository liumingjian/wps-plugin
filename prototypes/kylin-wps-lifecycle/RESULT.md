# Kylin WPS lifecycle prototype result

Date: 2026-07-26

Environment: designated Kylin V10 ARM64 machine with WPS Office
`12.1.2.26885.AK.preread.sw`.

## Verdict

`/usr/bin/wps <absolute-docx-path>` opened the exact Work Copy. The WPS
document process had command name `wps` and held that exact path while the
document was open. Closing only the document released the path even though the
launcher and WPS processes remained alive and still contained the path in their
command lines.

The Kylin launcher should therefore canonicalize the Work Copy path, invoke
`/usr/bin/wps` with that path as one argument, and model the Editing Session
around an exact-path holder whose command is `wps`. It should require a positive
held observation before treating consecutive absent observations over a short
release window as closed. Process exit, PID identity, and command-line presence
are not lifecycle signals. The sibling WPS lock file and exact document window
title corroborated the result but are not required as primary signals.

Unsaved memory edits did not change size, mtime, or SHA-256. Each explicit save
produced a valid, stable DOCX with a distinct hash:

| State | Size | SHA-256 |
| --- | ---: | --- |
| Baseline and first unsaved edit | 1417 | `c96c3cfa11fa0e723f0c1869d9fe9c58209ecddd782287266535c3d2dfdc20b1` |
| First Persisted Version | 9860 | `d711f0b2861a16b47c51dcbbbca2fa14b3c74bb476cfc994188e608eb3f9a1aa` |
| Second Persisted Version | 9938 | `9588749871cc5dfe7bcde85138af0af278d5d136ee2a7e89e3cf6a1a9999d486` |

The final DOCX passed `unzip -t` and contained both visible markers:
`UNSAVED-KYLIN-20260726-A` and `SECOND-KYLIN-20260726-B`.

## Lifecycle evidence

- Launch request: `/usr/bin/wps /tmp/wps-kylin-lifecycle.fLIUYu/Kylin-WPS-Work-Copy.docx`.
- Open: `wps` PID 556804 held file descriptor 77 for the exact Work Copy;
  WPS also created `.~lin-WPS-Work-Copy.docx`.
- First save: stable file state observed at 22:20:51 +0800.
- Second save: stable file state observed at 22:24:36 +0800.
- Close: WPS deleted the lock file at 22:25:40 +0800; by 22:25:41 the
  exact-path holder was absent and the window title had returned to `WPS Office`.
- After close, the `wps` and `wpsoffice` processes remained alive. Their command
  lines still contained the Work Copy path, demonstrating process reuse.

The raw local evidence for this run was retained outside the repository under
`/tmp/wps-kylin-lifecycle-evidence.qKRjOj/` while this result was recorded.
