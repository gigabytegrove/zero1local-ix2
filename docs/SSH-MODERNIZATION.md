# Zero1Local-ix2 — production SSH modernization (v1.4.0 backport)

Status: **locked product requirement; replacement not yet deployed** (October 19, 2026).

## Product requirement — password authentication, no prefix, no keys

**SSH password login is mandatory in the production ix2 release. SSH keys are not required, and key-only SSH is explicitly rejected as the product design.** A user signs in with their SSH-authorized account name and **the exact password the user set**, with no `soho` prefix, suffix, concatenation, intermediary secret, or vendor-specific password conversion.

The web administration UI must let authorized administrators set and change the applicable SSH account password securely. The backend must write and verify the real local authentication credential using the device's supported account/PAM mechanisms; the UI must clearly distinguish web-only versus SSH credentials, and provide explicit synchronization only if supported and selected. No private key provisioning or SSH key workflow is a prerequisite for ordinary user access. Do not replace one hidden password scheme with another.

Password security remains required: protected password storage, restricted account access, network exposure controls, authentication rate limiting, audit logging without secrets, modern compatible cryptography, and supported SFTP. Do not present unverified brute-force protection as implemented.

## Verified appliance starting point

- NAS1 runs Zero1Local-ix2 `0.8.14-runtime-ownership-hardening`, ARMv5 / Linux 2.6.31.8; the main Zero1Local v1.4.0 implementation is the UI/product reference.
- Installed SSH daemon is OpenSSH 7.8p1, linked with OpenSSL 1.0.2o; port 22 runs `sshd`.
- Current `/etc/ssh/sshd_config` permits root and uses PAM; it includes `AllowUsers root` and `AllowUsers root rsync`.
- The ix2 `server.py` exposes `/api/security/root-ssh-password` and web/root password synchronization; its actual credential behavior must be checked before changing it.
- The ix2 `runtime-service-supervisor.sh` can restart `/usr/sbin/sshd -D -p 22`. Cutover must update service ownership as well as binary/configuration.
- `/mnt/apps` is 99% inode-used and unsuitable for build staging. `/mnt/system` is writable and persistent with approximately 14 GB available.
- Existing ix2 application source did not contain a literal `soho` handler. **The vendor prefix mechanism is not yet proven to live in the binary, PAM, shadow/auth helpers, or other firmware path. Identify it through read-only inspection before modifying live authentication.**
- The SSH compatibility audit completed its substantive checks; a Windows CRLF artifact produced a terminal exit error after the results. No SSH settings were changed by that audit.

## Implementation requirements

1. **Password-first production SSH.** Authenticate with the user's exact configured password (including root when authorized by the device owner), no `soho` prefix and no required SSH keys. `PasswordAuthentication yes` alone is insufficient: validate the actual PAM/account auth chain and verify a real client login.
2. **Modern supported daemon.** Build/package off-NAS for ARMv5 and Linux 2.6; validate crypto/runtime dependencies, algorithms, PAM/login integration, SFTP, host keys, reboot persistence and memory footprint on real hardware. Never install unverified ARM64 binaries.
3. **Web account management.** Expose an accurate SSH Access UI: service state and version, enabled SSH accounts, password set/change/reset, explicit root-login policy, access restrictions, sign-in errors and rollback state. Require appropriate authorization; do not echo stored passwords or misleadingly claim changes are applied.
4. **Controlled access.** Restrict enabled accounts and permitted network ranges where supported; reject obsolete crypto; cap failed attempts using an on-device supported mechanism. Avoid unauthenticated WAN exposure by default.
5. **One owner of port 22.** Replace/coordinate SysV startup, the runtime supervisor, the legacy daemon and LifeLine recovery. Do not leave a second OEM listener that accepts prefix-based credentials.
6. **Persistence and safety.** Preserve credential database, host-key identity when secure, SFTP, saved data, RAID, network, web login and independent recovery. Keep a verified rollback if authentication or startup fails.
7. **Real acceptance tests.** From an independent Windows PowerShell SSH session, demonstrate chosen password **works without any prefix**; incorrect password and legacy prefixed password **fail**; SFTP works; the configured authentication behavior survives reboot; rollback restores prior access when deliberately triggered in a controlled test.

## Safe cutover order

**Read-only investigation of vendor/PAM prefix mechanism → build/package compatible candidate → stage candidate on alternate port with password authentication → verify exact configured password and SFTP → arm automatic rollback watchdog → cut port 22 over → verify a second connection → acknowledge success → reboot/recovery acceptance → retire vendor mechanism.**

Do not change SSH on the live NAS merely from this design document. Keep an existing working session open until the alternate listener and fallback have proven functional; on failed or unacknowledged cutover, automatically restore prior service and configuration. Never touch disks, RAID, partition tables, bootloader, data pool, or owner shares.

## Explicitly superseded advice

The previously proposed `Zero1Local-ix2-SSH-KeyOnly-Stage.zip` and any public-key-only / `authorized_keys` migration instructions **must not be deployed as the production solution**. They contradict the owner's requirement. SSH keys may exist as an optional future capability only if explicitly requested; they are not part of this locked acceptance scope.

No replacement daemon is yet installed or qualified on NAS1.
