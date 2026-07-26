# Kylin V10 ARM64 development runbook

This runbook installs and accepts the development adaptation on the designated
Kylin V10 SP1 ARM64 machine. It is not a production package or fleet-deployment
procedure.

## Designated environment

- Kylin V10 SP1 (`KYLIN_RELEASE_ID=2503`), AArch64, kernel `5.4.18-142-generic`.
- Qaxbrowser `1.0.46371.2-1` ARM64, started once so `~/.config/qaxbrowser` exists.
- WPS Office `12.1.2.26885.AK.preread.sw` ARM64 with `/usr/bin/wps` available.
- Go 1.23.2 is required only to build and test. Setup and runtime do not use Go.

Record `uname -a`, the Kylin release, Qaxbrowser and WPS package versions, Go
version, commit, and UTC timestamp before acceptance.

## Build and test

From the repository root:

```sh
go test ./...
bash ./scripts/build-kylin-arm64.sh
file ./dist/kylin-arm64/native-host
```

The artifact must be an AArch64 ELF. Runtime setup consumes this existing
artifact and does not rebuild it.

## Setup and Native Messaging check

Run setup explicitly with Bash. Repeating the command must succeed and print
the same paths:

```sh
bash ./scripts/setup-kylin-arm64.sh
bash ./scripts/setup-kylin-arm64.sh
```

Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and
select `~/.local/share/wps-edit-demo/extension`. Confirm the displayed extension
ID is `mbkblmlopgjhdlandbjhpemifinfllim`, then restart Qaxbrowser.

At `http://127.0.0.1:4317/`, open DevTools Console and run:

```js
window.addEventListener('message', event => {
  if (event.data?.source === 'wps-edit-extension') console.log(event.data);
});
window.postMessage({source: 'wps-edit-demo', version: 1, type: 'ping'}, location.origin);
```

Capture the correlated protocol-v1 `pong`. Also record the installed direct
host path and fixed origin from
`~/.config/qaxbrowser/NativeMessagingHosts/com.liumingjian.wps_edit_agent.json`.

## Demo startup

Start the Demo from the repository in a terminal and leave its output visible:

```sh
go run ./cmd/demo
```

Open `http://127.0.0.1:4317/` in Qaxbrowser. The human performs Qaxbrowser and
WPS actions below one step at a time; the operator terminal records paths,
hashes, logs, and timestamps.

## Unchanged close

1. Activate **Edit locally in WPS**.
2. Confirm WPS opens the task-specific Work Copy below
   `~/.local/state/wps-edit-demo/tasks/`.
3. Make no edit and close that WPS document.
4. Confirm the page reports that Version 1 remains current and no Snapshot was
   created for that Editing Task.

## Two ordered saves through close

1. Start one new Editing Task and add the unique marker
   `KYLIN-ACCEPTANCE-FIRST`, then save without closing WPS.
2. Wait at least three seconds. Record the Work Copy SHA-256 and the first
   immutable Snapshot path and SHA-256.
3. Add `KYLIN-ACCEPTANCE-SECOND`, save again, and wait at least three seconds.
4. Confirm a second Snapshot exists and its filename sequence follows the first.
5. Confirm the browser remains in the active Editing Task until the Work Copy is
   closed, then close the document.
6. Confirm the page reaches Version 3 and its preview contains both markers.
7. Download `/documents/doc-001/content`; its SHA-256 must equal the final Work Copy
   and second Snapshot SHA-256. Record server version order and all hashes.

## Failure evidence

### Agent unavailable

With no Editing Task active, move this product's Qaxbrowser manifest aside,
restart Qaxbrowser, reload the Demo, and activate the Edit Entry. Confirm the
page presents a clear `Local agent unavailable` error. Restore setup before the
next check.

### Concurrent Editing Task

Start an Editing Task in one Demo tab and leave its Work Copy open. In a second
tab, activate the Edit Entry. Confirm it fails immediately with `task_active` or
the message `another Editing Task is active`; the first task must remain active.

### Submission failure and retained Snapshot

Start an Editing Task and wait for WPS to open the Work Copy. Stop the Demo
before saving, make a unique edit, save, and close WPS. Confirm the page reports
a Submission failure containing the retained Snapshot path. Verify the Snapshot
still exists, is mode `0400`, and has the same SHA-256 as the saved Work Copy.
Do not delete the task state while collecting evidence.

## Uninstall

Remove the unpacked extension in `chrome://extensions`, then run:

```sh
bash ./scripts/uninstall-kylin.sh
```

Confirm the product install root and its Qaxbrowser manifest are gone, unrelated
browser manifests remain, and `~/.local/state/wps-edit-demo/` still contains the
Work Copies and Snapshots. Record those checks in the versioned Kylin result.
