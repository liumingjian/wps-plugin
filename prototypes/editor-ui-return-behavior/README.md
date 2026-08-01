# Editor UI and return behavior prototype

Throwaway UI prototype for
[Decide the editor UI and return behavior](https://github.com/liumingjian/wps-plugin/issues/37).

It compares three editor layouts on one route:

- `?variant=A` - compact document bar
- `?variant=B` - status-led command band
- `?variant=C` - side action rail

The prototype is read-only apart from simulated editor state. It does not load
the NPAPI plugin or call the OA save endpoint.

The reviewed behavior is represented in Variant A: Return is immediate from an
editable or successfully saved Document, while Return after a failed save asks
the user to explicitly discard the editor-local changes.

`wps-editor-surface.png` is a top-cropped copy of `references/wps-plugin.png`;
the crop removes the legacy OA toolbar while retaining the actual WPS surface.

Run from the repository root:

```bash
bash prototypes/editor-ui-return-behavior/run.sh
```

Then open `http://127.0.0.1:4173/prototypes/editor-ui-return-behavior/`.
