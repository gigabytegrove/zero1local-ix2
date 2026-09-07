# Zero1Local-ix2

**Zero1Local-ix2** is a local-first replacement management environment for the Lenovo/Iomega ix2 NAS.

The project ports the established Zero1Local management UI and appliance model to the older Marvell Kirkwood / ARMv5 ix2 hardware while removing features that do not fit the platform, such as Docker and heavyweight container applications.

## Current development status

Current qualification release: **v0.8.5**

The project is still under active qualification. Current work focuses on replacing the stock Lenovo LifeLine management environment with Zero1Local while preserving a safe recovery path.

### Current management layout

During the current qualification phase:

- Zero1Local is intended to become the primary LAN UI on **HTTP port 80**.
- HTTPS is optional and is **not required** for LAN-only operation.
- Lenovo LifeLine is retained only as a recovery environment on port **8088**.
- No U-Boot, partition table, RAID membership, LVM, filesystem, or data-pool changes are performed by the v0.8.x UI qualification releases.

## Target hardware

Primary target:

- Lenovo/Iomega ix2
- Marvell Kirkwood
- ARMv5 / armel
- hardware profile: `lenovo-iomega-ix2-ng-armel`

The ix2 fork is intentionally separate from the main IronCow Zero1Local product.

## Update repository

Official update source:

`https://github.com/gigabytegrove/zero1local-ix2`

Zero1Local-ix2 checks GitHub Releases for hardware-gated update packages named:

`Zero1Local-ix2-<version>-update.zip`

Update packages must identify:

- product: `Zero1Local-ix2`
- hardware: `lenovo-iomega-ix2-ng-armel`

The updater verifies the release asset SHA-256 digest before staging an installation.

## Release channels

- **Stable** — production releases only
- **Beta** — beta, RC, and GitHub prerelease builds
- **Alpha** — all channels

Qualification builds such as v0.8.5 should be treated as Beta/prerelease builds.

## Update workflow

For normal releases:

1. Create the release tag.
2. Publish `Zero1Local-ix2-<version>-update.zip` as a GitHub Release asset.
3. Publish the SHA-256 checksum.
4. A Zero1Local-ix2 appliance on an eligible channel checks the GitHub Releases feed.
5. The appliance verifies product, hardware profile, version, release policy, and asset digest.
6. The update may then be installed from the Zero1Local Updates interface or automatically when automatic installation is enabled.

## Safety model

The current qualification branch intentionally blocks destructive storage and bootloader operations.

The v0.8.x releases do **not**:

- repartition disks
- format filesystems
- change RAID membership
- modify LVM
- overwrite the data pool
- modify U-Boot

The existing LifeLine environment is being pushed into a recovery-only role until the native Zero1Local kernel/rootfs path is fully validated.

## Project direction

The final product goal is for Zero1Local-ix2 to own the appliance experience:

- management UI
- authentication
- users/groups
- shares and ACLs
- SMB/NFS/SFTP/FTP where supported
- storage and health management
- networking
- firewall
- updates
- notifications
- backup/replication
- reboot/shutdown
- recovery and appliance lifecycle

Lenovo LifeLine is transitional and is not intended to remain part of normal day-to-day administration.

## License

License information will be published with the public project.
