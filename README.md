# Editing Task control-path development setup

This slice sends JSON control messages only. It does not transfer DOCX bytes or invoke WPS.

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

Open <http://127.0.0.1:4317/> in Qaxbrowser and activate **Edit locally in WPS**, not the ordinary Document Link. The page creates stable identifiers `task-doc-001` and `doc-001`, then shows `connected` while relaying protocol version 1 `{type: "task-probe"}` JSON. A correctly registered host returns `accepted` with the same identifiers and “Editing Task reached the local agent.” Registration, extension, or protocol errors appear as `failed` with an actionable message.

Run the real framed boundary contract tests, including invalid length, malformed JSON, and unsupported version cases:

```sh
go test ./...
```
