# Zero1Local-ix2 — production SSH modernization

Status: **locked requirements; replacement daemon not yet built or deployed**.

## Installer-owner choice (locked)

Zero1Local-ix2 is a redistributable product for compatible Lenovo/Iomega ix2 appliances. Every administrator may configure **password authentication, SSH public-key authentication, or both**.

- **Passwords are allowed and work exactly as set by the account owner.** No `soho` prefix, suffix, concatenation, hidden transformation, or OEM-specific requirement.
- **SSH keys are optional** and must never be an enrollment prerequisite. Key-only mode is an opt-in choice with working-key and recovery verification.
- A fresh install allows an ordinary approved account to sign in with a password without requiring public keys.
- Authorized administrators can configure authentication modes, permitted accounts, root-login policy, password reset/change, SSH public keys, network restrictions, and the SSH service from the Zero1Local UI.
- Password security, audit logging, supported encryption, SFTP, brute-force controls when verified, recovery, and host key security remain mandatory.

## Verified NAS1 evidence

- ARMv5 / Linux 2.6.31.8 with OpenSSH 7.8p1 and OpenSSL 1.0.2o.
- Live `sshd` on port 22, config permits root access with PAM and `AllowUsers root` / `root rsync`.
- The installed `runtime-service-supervisor.sh` may restart `/usr/sbin/sshd`, so cutover must update service ownership and SysV boot integration.
- `/mnt/apps` is nearly out of inodes; use `/mnt/system` for staging. Do not alter disks, RAID, LifeLine recovery, or user storage.
- The exact location of the `soho` transformation **has not been established**; existing ix2 Python server source does not contain a literal `soho` handler. Investigate the true daemon/PAM/account path before changing the production service.

## Replacement gates

1. Build a compatible SSH stack off the NAS and validate ARMv5/Linux 2.6 runtime and crypto dependencies.
2. Inspect and explain the actual OEM password authentication chain.
3. Stage a new listener on a separate test port supporting both password and optional key authentication.
4. Prove a chosen password works **without prefix**, and wrong or prefixed passwords fail. Prove keys work when opted into and password-only mode works without keys. Verify SFTP.
5. Confirm browser-based SSH configuration, persistence after reboot, correct service ownership, disabled legacy second listener, and independent recovery.
6. Cut over port 22 only with a tested rollback watchdog and a second successful client session.
7. Ship a versioned, checksummed, hardware-validated installer/update for other ix2 owners. No NAS1-specific credentials, names or IP addresses in the release.

**Do not run the earlier Key-Only Stage ZIP.** It does not satisfy the product's authentication-choice requirement.

## Parity release boundary

The `0.9.0-rc1` updater/boot-recovery candidate is **not** the SSH modernization release and does **not** remove `soho`. It must not be represented as full Zero1Local v1.4.0 hardware parity.
