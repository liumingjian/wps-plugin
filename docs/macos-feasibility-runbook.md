# macOS arm64 feasibility runbook

This runbook verifies the current-document workflow on the designated Mac. It is a development acceptance procedure, not a production installation guide.

## Prerequisites

- Apple-silicon Mac (`uname -m` reports `arm64`).
- Qaxbrowser installed and started once.
- WPS for macOS installed as `/Applications/wpsoffice.app`.
- Go 1.23.2 and Python 3 on `PATH`.
- This repository available at a stable absolute path.

Record the machine, Qaxbrowser, WPS, Go, and commit versions before the run.

## Setup

Open `chrome://version` in Qaxbrowser and verify that its Profile Path is under `~/Library/Application Support/Qaxbrowser`. If it differs, use the actual product directory as `QAX_SUPPORT_DIR`.

```sh
QAX_SUPPORT_DIR="$HOME/Library/Application Support/Qaxbrowser" ./scripts/setup-macos-arm64.sh
```

In `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select `~/Library/Application Support/WPSEditDemo/extension`. Confirm the displayed ID is `mbkblmlopgjhdlandbjhpemifinfllim`, then restart Qaxbrowser.

## Startup order

1. Complete setup and restart Qaxbrowser.
2. Run `go run ./cmd/demo` in the repository.
3. Open <http://127.0.0.1:4317/> in Qaxbrowser.
4. Confirm the page shows Version 1 and the initial current-document preview.
5. Activate the single **Edit locally in WPS** button, make no changes, and close the WPS document without saving.
6. Confirm the page restores the button and reports that Version 1 is unchanged.
7. Activate the button again and confirm WPS opens the same server content in a new task-specific Work Copy.
8. Add a unique visible edit, save it in WPS, and wait for the page to advance to Version 2 and show the edit in its preview.
9. Activate the same button again. Confirm WPS opens a different task-specific path whose initial content already contains the first edit.
10. Add and save a second unique edit. Confirm the page advances to Version 3 and shows both edits.

## Expected states and evidence

Each activation creates a unique Editing Task ID and Work Copy below `$TMPDIR/wps-edit-agent`. Capture the page version, preview, task-specific Work Copy path, WPS window, and saved file hash for both rounds.

During an edit, the button is disabled while the page waits for WPS to save and the agent to submit. After a successful Submission, the server replaces its current document atomically, and the page reloads that server state before enabling the button again.

The acceptance result is successful only when the second WPS session starts from the first submitted content and the page reaches Version 3 with both unique edits.

## Troubleshooting

### Host failure

Confirm the fixed extension ID, the `nativeMessaging` permission, and the manifest under Qaxbrowser's actual `NativeMessagingHosts` directory. Restart Qaxbrowser after manifest changes.

### Download or launch failure

Confirm the Demo is running at `127.0.0.1:4317`, open `/documents/doc-001/content` directly, and verify `/Applications/wpsoffice.app` exists. Preserve the page error before retrying.

### Stability or Submission failure

Confirm WPS saved the task-specific Work Copy shown by `lsof`, not another DOCX. Inspect that task directory's file size and modification time. Preserve any immutable Snapshot and the page error. Do not claim success until the page advances to the next version.

### Preview does not update

Fetch `/documents/doc-001` directly. Its `version` and `previewText` are the server's current state. If they are stale after a successful WPS save, preserve the Work Copy and Demo output before restarting anything.

## Uninstall

Quit the Demo, remove the unpacked extension from Qaxbrowser, then run:

```sh
QAX_SUPPORT_DIR="$HOME/Library/Application Support/Qaxbrowser" ./scripts/uninstall-macos.sh
```

This removes only this Demo's install root and Native Messaging manifest. It does not remove user Documents or unrelated browser configuration.
