# Add a Kylin ARM64 development adaptation

The designated Kylin V10 ARM64 route uses `/usr/bin/wps` and an exact canonical
Work Copy path held by command `wps` as its Editing Session signal. The agent
observes stable Persisted Versions while a single FIFO submitter processes
immutable Snapshots, and it completes only after WPS closes and the final queue
drains. A non-blocking user-state file lock permits only one active Editing Task.

Delivery is a fixed-ID unpacked extension, a prebuilt Linux ARM64 host, and
user-level setup/uninstall scripts. Setup installs below XDG data/config roots;
Work Copies and retained Snapshots live separately below the XDG state root and
survive uninstall. This is a development adaptation for the designated machine,
not a production DEB, update channel, enterprise policy, or claim of general
Linux compatibility. It extends rather than rewrites the completed macOS
feasibility decision in ADR 0003.
