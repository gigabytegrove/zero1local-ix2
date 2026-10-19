# Zero1Local-ix2 — SSH modernization (v1.4.0 backport)

Status: **locked target; not yet deployed** (October 19, 2026).

## Target

Replace the legacy Lenovo/Iomega ix2 SSH stack and the `root` / `soho` password-access workflow with a maintained, ARMv5-compatible, properly managed SSH implementation. Preserve NAS storage, LifeLine recovery, SFTP, and authenticated administrator access. Do not silently change credentials or risk an unrecoverable lockout.

## Verified starting point

- NAS1 currently runs Zero1Local-ix2 `0.8.14-runtime-ownership-hardening`, Python 2.7, ARMv5 and Linux 2.6.31.8. v1.4.0 of the primary Zero1Local project is the feature/UI source of truth.
- In the installed ix2 `server.py`, `/api/security/root-ssh-password` can enable password login and synchronize root credentials with the web account.
- `rc17_write_compat.py` defaults SSH public keys to `/root/.ssh/authorized_keys`. The root filesystem on NAS1 is temporary; keys need explicit persistent storage.
- `runtime-service-supervisor.sh` can restart `/usr/sbin/sshd -D -p 22`; replacement requires changing supervisor behavior, not just writing a new SSH config.
- The application source contains no literal `soho` handler. The OEM password behavior must be verified at the firmware/authentication boundary, and denied at every active SSH listener after migration.
- The active SSH daemon version, linked crypto libraries, key algorithms and replacement compatibility are not yet verified on the appliance.

## Mandatory requirements

1. Compile and package the replacement **off-NAS** for ARMv5/Linux 2.6; verify dynamic/static dependencies, kernel support, secure ciphers, authentication, host-key identity and SFTP on-device. Do not use the almost-inode-full `/mnt/apps` filesystem as a build/install target.
2. Default to **public-key-only SSH**, with root-owned persistent authorized keys under `/mnt/system/zero1local-ix2/ssh/`. Validate public-key blobs and supported algorithms. Keep private keys off-device.
3. Reject password and keyboard-interactive authentication and verify those authentication methods are unusable from a new Windows SSH connection. After proving a dedicated administrator account with escalation and recovery, prohibit root interactive SSH entirely.
4. Replace the password SSH toggle with a proper **SSH Access** UI: connection status, service identity, key management, account access, errors, and migration/rollback status. Never silently restore legacy `soho` access.
5. Integrate one intentionally managed SSH daemon into SysV startup, the ix2 runtime supervisor, stock LifeLine quarantine and failback. Detect accidental reappearance of vendor port-22 listeners.
6. Preserve functional SFTP, host-key continuity where secure, the web administrator credential separation, and existing user data.
7. Ship a versioned, integrity-verified ix2 update; validate existing daemon backup, release rollback and fresh SSH access after a real reboot.

## Cutover sequence

**Audit (read-only) → stage on another port → verify key-only + SFTP from Windows → arm rollback watchdog → switch port 22 → verify new session → acknowledge cutover → cold-boot and recovery acceptance → retire old root-password controls.**

Do not alter live SSH settings in response to a code review alone. An unacknowledged cutover must automatically revert. Keep the current working SSH session open during validation. Factory reset, RAID, partition, LVM, bootloader, and owner-data modifications are out of scope.

## Qualification blockers

No release is qualified if old `soho` credentials still allow SSH, root password login remains exposed, persistent keys are lost at reboot, the supervisor respawns the vendor daemon, insecure legacy crypto is required, SFTP regresses, recovery cannot restore access, or the web/storage subsystems change unexpectedly.

A strictly read-only inventory script and more detailed engineering plan are provided in the local SSH modernization preflight package. No new SSH daemon has yet been deployed or proven on NAS1.
