# Zero1Local-ix2 v0.9.0-rc1 — Beta release publication

**Status:** publisher script prepared; **GitHub Release asset must be uploaded and verified separately**. A repository commit alone does not activate the in-app updater feed.

## GitHub release contract

- Repository: `gigabytegrove/zero1local-ix2`
- Tag: `v0.9.0-rc1`
- Channel: **Beta prerelease** (`prerelease=true`, `draft=false`)
- Asset: `Zero1Local-ix2-0.9.0-rc1-update.zip`
- Exact ZIP SHA-256: `d59748e47cc3f8ea6baea677cb03848748c40a457671fd21293e79b2825653b6`
- Hardware: `lenovo-iomega-ix2-ng-armel`, ARMv5 / Linux 2.6.31
- Installed baseline: v0.8.14-runtime-ownership-hardening; candidate: v0.9.0-rc1

The existing ix2 update checker uses the public `https://api.github.com/repos/gigabytegrove/zero1local-ix2/releases?per_page=20` API and only offers a release when the tag is published, it has a matching `Zero1Local-ix2-<version>-update.zip` asset with a GitHub SHA-256 digest, the version is newer than the installed backend, and the user has opted into the appropriate update channel. **An unqualified candidate is not a stable release.**

Run `tools/Publish-0.9.0-RC1.ps1` from Windows PowerShell with the exact downloaded ZIP in Downloads. Script checks local SHA before calling `gh release create`, verifies `prerelease=true` and compares the published GitHub asset digest and size to the ZIP. It does **not** modify a NAS or overwrite an existing conflicting release.

## Included

- Boot reconciliation, guarded temporary directory, bounded UI logs.
- Dedicated Updates page, improved navigation.
- Transactional installer with ZIP safety and per-file SHA-256, hardware/space preflight, previous runtime/init backup, post-activation status checks and simulated rollback tests.

## Not yet qualified

- Hardware deployment, cold reboot, full data/recovery validation or actual in-app update.
- Full Zero1Local v1.4.0 API parity.
- SSH daemon replacement and removal of vendor `soho` password behavior.

**Safety:** Do not automatically install the Beta package on production ix2 units; manually check it first and retain independent recovery. No UI should label an update successful before verified backend, runtime supervisor, recovery proxy, and LifeLine handoff checks pass.
