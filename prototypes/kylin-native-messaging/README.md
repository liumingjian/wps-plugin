# PROTOTYPE - Kylin Native Messaging boundary

This throwaway prototype answers one question: can the fixed-ID Manifest V3
extension in the designated Kylin Qaxbrowser invoke an ARM64 protocol-v1 Native
Messaging host for both `ping` and an Editing Task probe, and is
`~/.config/qaxbrowser/NativeMessagingHosts` the manifest directory Qaxbrowser
actually discovers?

The browser starts the probe host once per message. Each request and response is
appended to `~/.local/share/wps-edit-native-messaging-prototype/logs/native-host.jsonl`.
No WPS launch or Document content transfer is part of this prototype.

Run the setup from any directory:

```sh
bash ./prototypes/kylin-native-messaging/setup.sh
```

Then load the unpacked extension path printed by the setup command in
`chrome://extensions`. The expected fixed extension ID is
`mbkblmlopgjhdlandbjhpemifinfllim`.

Remove only the prototype installation and manifest with:

```sh
bash ./prototypes/kylin-native-messaging/uninstall.sh
```
