# Kylin WPS lifecycle prototype

THROWAWAY PROTOTYPE: this probe exists only to determine how the designated
Kylin WPS build opens, persists, and closes one exact DOCX Work Copy.

Run it once from the repository root:

```sh
./prototypes/kylin-wps-lifecycle/run.sh
```

The probe creates an isolated Work Copy below `/tmp`, launches it with
`/usr/bin/wps <absolute-path>`, and prints only observable state changes. It
records exact-path file holders, WPS windows, directory events, file metadata,
and SHA-256 changes. Press Ctrl-C only after the guided edit/save/close sequence
is complete. The final output names the evidence log and Work Copy paths.
