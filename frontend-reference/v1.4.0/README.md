# Zero1Local v1.4.0 UI reference for the ix2 port

This directory contains an **exact frozen copy** of the upstream browser interface at commit `d672f653704737f6b0ce41603cf72b11512bf2ce` from `gigabytegrove/zero1local-source`. Do not hand-redesign the ix2 UI separately.

## Status

**Reference-only development branch. Not packaged, deployed or release-qualified.**

Files `web/app.js`, `web/app.css`, `web/index.html` and the authentic Zero1Local brand PNGs originate from the v1.4.0 source. These are browser resources and not credentials, privileged backend source or NAS configuration.

## Porting policy

1. Start from the real v1.4.0 shell, login design, menus, layout, typography, interaction and responsive behavior. Preserve the upstream UI aesthetics; no separate simplified "ix2" skin.
2. The ix2 has 256 MB RAM, ARMv5/Linux 2.6 and a Python compatibility backend. Every visible action must have a functioning, tested device API. Where impossible, remove or clearly mark unavailable capabilities (e.g., Docker on this hardware) without disrupting actual supported tasks.
3. Use correct authentication name for the actual ix2 web account, even if main Zero1Local defaults to `root`. Preserve working admin login, session and recovery.
4. Supply all required assets, including the application catalog artwork if the Apps UI is ever enabled on supported hardware.
5. In-app updates must verify the GitHub ZIP digest, install transactionally, verify new runtime health and rollback on failure; do not call an offline UI source copy a release.
6. Promote **only after** screenshot comparisons (desktop/tablet/mobile), browser and API integration tests, reboots, recovery, and updater rollback pass on the physical ix2.

The existing `v0.9.0-rc1` release has a modified legacy UI; it is not in v1.4 parity and must not be advertised as such. 
