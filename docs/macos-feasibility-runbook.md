# macOS arm64 feasibility runbook

This runbook reproduces the development acceptance run for the local WPS Editing Demo. It validates only the designated Mac; it is not a production installation guide.

## Prerequisites

- Apple-silicon Mac (`uname -m` reports `arm64`).
- Qaxbrowser installed and started once.
- WPS for macOS installed as `/Applications/wpsoffice.app`.
- Go 1.22 or newer and Python 3 on `PATH`.
- This repository available at a stable absolute path.

Record versions before the run:

```sh
uname -m
defaults read /Applications/Qaxbrowser.app/Contents/Info CFBundleShortVersionString
defaults read /Applications/wpsoffice.app/Contents/Info CFBundleShortVersionString
git rev-parse HEAD
```

## Setup

First open `chrome://version` in Qaxbrowser. Confirm its Profile Path is under `~/Library/Application Support/Qaxbrowser`; this verifies the actual product directory instead of assuming an upstream Chrome location. If it differs, pass that product directory explicitly as `QAX_SUPPORT_DIR`.

```sh
QAX_SUPPORT_DIR="$HOME/Library/Application Support/Qaxbrowser" \
  ./scripts/setup-macos-arm64.sh
```

The setup builds the macOS arm64 Go binary, installs a host manifest in the verified Qaxbrowser `NativeMessagingHosts` directory, binds it to fixed extension ID `mbkblmlopgjhdlandbjhpemifinfllim`, and copies the unpacked extension. In `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select `~/Library/Application Support/WPSEditDemo/extension`. Confirm the displayed ID exactly matches the fixed ID above. Restart Qaxbrowser.

## Startup order

1. Complete setup and restart Qaxbrowser.
2. In the repository, run `go run ./cmd/demo`.
3. Open <http://127.0.0.1:4317/> in Qaxbrowser.
4. Activate **Edit locally in WPS** for Editing Task `task-doc-001`.
5. Wait for WPS Writer to open the intended `doc-001.docx` Work Copy.
6. Make a unique visible edit, save it in WPS, and wait for Submission to succeed.
7. Select **Latest submitted result**, open the downloaded DOCX, and verify the unique edit is present.

## Expected page states and evidence

Capture the page and relevant agent output at each boundary: task start, download, launch, stability observation, and Submission. The initial page is ready to activate the Edit Entry. During processing it identifies Editing Task `task-doc-001` and the current stage. After WPS persists a changed version, the final expected page state is `succeeded`.

The Work Copy is `$TMPDIR/wps-edit-agent/task-doc-001/doc-001.docx`. Immutable Snapshot files are in the same task directory and are the exact upload payloads. Record the submitted SHA-256 from the Submission-stage output. Download the server's current result through **Latest submitted result** and retain that DOCX as acceptance evidence.

## Troubleshooting

### Host failure

Confirm `chrome://extensions` shows ID `mbkblmlopgjhdlandbjhpemifinfllim`, inspect `chrome://version`, and verify the manifest exists in that Qaxbrowser product directory's `NativeMessagingHosts` child. Restart Qaxbrowser after manifest changes.

### Download failure

Confirm the Demo is running at `127.0.0.1:4317`, then open `/documents/doc-001/content` directly. Record the page stage and local-agent error before retrying.

### Launch failure

Confirm `/Applications/wpsoffice.app` exists and `open -a wpsoffice <absolute-work-copy-path>` succeeds. Do not substitute undocumented WPS internal binaries.

### Stability failure

Confirm WPS saved the intended Work Copy, not another DOCX. Inspect its size and modification time in `$TMPDIR/wps-edit-agent/task-doc-001`; the agent requires an actual content change and two seconds of stable metadata.

### Submission failure

Confirm the Demo is still running and the task URL targets `task-doc-001`. Preserve the immutable Snapshot and relevant stage log. A failed hash is eligible for retry; do not claim success until the server accepts it.

## Uninstall

Quit the Demo and unload the extension in Qaxbrowser, then run:

```sh
QAX_SUPPORT_DIR="$HOME/Library/Application Support/Qaxbrowser" \
  ./scripts/uninstall-macos.sh
```

This removes only `~/Library/Application Support/WPSEditDemo` and this Demo's Qaxbrowser host manifest. It does not remove user Documents or unrelated browser configuration.
