# Package the production Kylin delivery as a fixed-ID CRX and system DEB

The production Kylin delivery is a supplier-signed, fixed-ID MV3 CRX plus a system-level ARM64 DEB. The DEB installs one on-demand Native Messaging Host and a GTK User Setup application; it installs no service, listener, login startup, or home-directory files. User Setup owns per-account registration, checks, repair, deactivation, and redacted diagnostics.

This supersedes the delivery boundary in ADR 0004 without removing its designated-machine feasibility evidence. An unpacked extension, user-level setup script, or raw ELF cannot provide a stable customer upgrade identity or a novice-oriented package lifecycle. A resident daemon would simplify retry scheduling but expands the attack and operations surface, so recovery remains browser-triggered and durable on disk.
