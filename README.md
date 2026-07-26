# Editing Task work-copy development setup

This slice sends task metadata through Native Messaging. DOCX content is transferred over HTTP, written to a task-specific Work Copy, baselined with SHA-256, and opened in WPS through macOS Launch Services.

## Build and register the Native Messaging Host

Requirements: Go 1.22+, Qaxbrowser on macOS, and this repository at a stable absolute path.

```sh
go build -o native-host/native-host ./cmd/native-host
chmod +x native-host/native-host native-host/run-host.sh
```

Copy `native-host/com.liumingjian.wps_edit_agent.json`, replace its `path` with the absolute path to `native-host/run-host.sh`, and initially leave the origin placeholder. Register that manifest in Qaxbrowser's Native Messaging Hosts directory. Qaxbrowser builds may use either Chromium location; inspect `chrome://version` for the profile/product identity, then use the matching directory:

```sh
mkdir -p "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
cp native-host/com.liumingjian.wps_edit_agent.json "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/"
```

If Qaxbrowser uses its own application-support product directory, create its `NativeMessagingHosts` child and copy the manifest there instead.

## Load the fixed-ID development extension

1. Open `chrome://extensions` in Qaxbrowser and enable Developer mode.
2. Select **Load unpacked** and choose the repository's `extension` directory.
3. Copy the displayed extension ID.
4. Replace `REPLACE_WITH_ID_FROM_CHROME_EXTENSIONS` in the installed Native Messaging Host manifest with that ID, preserving `chrome-extension://<id>/`.
5. Restart Qaxbrowser after changing the host manifest.

Do not remove or regenerate the `key` in `extension/manifest.json`: it preserves the extension's development ID across machines and reloads. The extension has access only to `http://127.0.0.1:4317/*`.

## Start and verify

```sh
go run ./cmd/demo
```

Open <http://127.0.0.1:4317/> in Qaxbrowser. The page shows the server's current document version and provides one **Edit locally in WPS** button. Each click creates a unique Editing Task ID for Document `doc-001`, then sends protocol version 1 `{type: "task-start"}` metadata containing the current Document content and Submission URLs. The local agent downloads the current DOCX into a task-specific directory under `$TMPDIR/wps-edit-agent`, records its SHA-256 baseline, and asks Launch Services to open that absolute path with WPS (`wpsoffice`). Save a visible edit in WPS; after the Submission succeeds, the page refreshes to the new current version. Clicking the same button again opens that submitted version in a new task-specific Work Copy.

Designated-Mac smoke check: with WPS (`wpsoffice`) installed, start the Demo and verify both normal endings. First, open the current version and close the WPS document without saving; the page must restore the button, report that the version is unchanged, and the next edit must open the same server version. Then edit and save a unique visible change; the page must advance to the next version and show the updated preview. Saving and immediately closing must still submit the final persisted content.

Run the real framed boundary contract tests, including invalid length, malformed JSON, and unsupported version cases:

```sh
go test ./...
```
