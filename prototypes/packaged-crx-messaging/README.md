# PROTOTYPE - packaged CRX messaging and notifications

This throwaway prototype answers the question in
[`Verify packaged CRX messaging and notifications on Kylin`](https://github.com/liumingjian/wps-plugin/issues/21).
It is not a customer build.

It packages the production signing identity into three versions of one MV3 CRX,
installs a production-ID Native Messaging probe, injects a narrow explicit
bridge into ordinary HTTP/HTTPS pages without reading their DOM, keeps a native
Port open for the complete WPS Editing Task, and issues fixed browser desktop
notifications. Every page reply includes the extension version and the native
channel start/end timestamps. Host process lifetime is recorded in
`~/.local/share/wps-edit-packaged-crx-prototype/native-channel.jsonl`.

## One-command run

On the designated Kylin AArch64 machine, from any directory:

```sh
bash /home/xiaohu/lmj/repo/wps-plugin-crx-prototype/prototypes/packaged-crx-messaging/run.sh
```

The command asks OpenSSL for the supplier release-key passphrase, builds CRX
versions `0.1.0`, `0.1.1`, and `0.1.2`, installs the prototype Native Messaging host, and
starts the Demo at `http://127.0.0.1:4317/`. The passphrase is not passed to the
script or browser. A decrypted key exists only in a mode-`0700` temporary
directory and is removed by the script's exit trap.

## Human checks

1. In Qaxbrowser, manually install `dist/wps-edit-packaged-prototype-0.1.0.crx`.
   Record the displayed ID, version, permission prompt, and any warning. The ID
   must be `mjjoapeohdfkepmocpahbimmmenlfdcb`.
2. Manually install `dist/wps-edit-packaged-prototype-0.1.1.crx` as an upgrade,
   then install `dist/wps-edit-packaged-prototype-0.1.2.crx`, which fixes the
   Qaxbrowser notification icon format discovered during automated acceptance.
   Record whether the ID stays fixed, each version changes in place, and settings
   are preserved rather than creating a second extension.
3. Open any ordinary HTTP/HTTPS page, register the reply logger below in its
   DevTools console, then issue the ping. Record the full reply.
4. Open the local Demo and activate its Edit Entry. Keep DevTools open. Confirm
   WPS opens, edit and save the Work Copy, leave WPS open for at least ten
   seconds, then close the document. Record the page result and the channel log.
5. With any WPS window foregrounded, run each notification probe from a browser
   page and immediately switch to WPS. Each probe waits three seconds. Record
   whether the fixed success and failure notifications are visible over WPS,
   their exact text, and any desktop permission prompt.

Register the reply logger:

```js
window.addEventListener('message', event => {
  if (event.data?.source === 'wps-edit-extension-prototype') {
    console.log('WPS CRX prototype reply', event.data);
  }
});
```

Issue a Native Messaging ping:

```js
window.postMessage({
  source: 'wps-edit-sdk-prototype',
  version: 1,
  type: 'ping'
}, location.origin);
```

Issue the two fixed notification probes, one at a time:

```js
window.postMessage({source: 'wps-edit-sdk-prototype', version: 1, type: 'notification-probe', outcome: 'success'}, location.origin);
window.postMessage({source: 'wps-edit-sdk-prototype', version: 1, type: 'notification-probe', outcome: 'failure'}, location.origin);
```

The bridge rejects arbitrary operations, malformed identifiers, non-HTTP(S)
pages, credentials in URLs, and cross-origin download/upload endpoints. The
notification probe accepts no page-provided title or message.

With `playwright-cli` attached to the Qaxbrowser instance, run the automated
page bridge, Native Messaging ping, and notification assertions with:

```sh
PLAYWRIGHT_CLI_SESSION=qax-fixed bash ./prototypes/packaged-crx-messaging/verify-browser.sh
```

## Cleanup

Remove the CRX in `chrome://extensions`, stop the Demo, then run:

```sh
bash /home/xiaohu/lmj/repo/wps-plugin-crx-prototype/prototypes/packaged-crx-messaging/uninstall.sh
```

The cleanup restores the Native Messaging manifest that was present before the
prototype and removes only the prototype host installation. Existing Editing
Task state and Snapshots are left untouched.
