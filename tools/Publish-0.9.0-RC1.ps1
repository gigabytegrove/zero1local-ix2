# Publish the byte-verified ix2 beta update to the exact GitHub Releases feed
# used by the Zero1Local-ix2 built-in updater. Does NOT touch any NAS.
param(
    [string]$Archive = (Join-Path $env:USERPROFILE 'Downloads\Zero1Local-ix2-0.9.0-rc1-update.zip')
)
$ErrorActionPreference = 'Stop'
$Repo = 'gigabytegrove/zero1local-ix2'
$Tag = 'v0.9.0-rc1'
$AssetName = 'Zero1Local-ix2-0.9.0-rc1-update.zip'
$ExpectedSHA256 = 'd59748e47cc3f8ea6baea677cb03848748c40a457671fd21293e79b2825653b6'

if (!(Test-Path -LiteralPath $Archive -PathType Leaf)) {
    throw "Release ZIP not found: $Archive. Save the update ZIP to Downloads first."
}
$Archive = (Resolve-Path -LiteralPath $Archive).Path
if ([IO.Path]::GetFileName($Archive) -cne $AssetName) {
    throw "Unexpected filename. Expected $AssetName."
}
$ActualSHA256 = (Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($ActualSHA256 -ne $ExpectedSHA256) {
    throw "LOCAL ZIP SHA-256 MISMATCH. Expected $ExpectedSHA256; got $ActualSHA256. Nothing published."
}
Write-Host "PASS: exact release asset SHA-256 $ActualSHA256"

$ghcmd = Get-Command gh -ErrorAction SilentlyContinue
if ($ghcmd) {
    $gh = $ghcmd.Source
} else {
    Write-Host "GitHub CLI is not installed; attempting Windows package installation..."
    if (!(Get-Command winget -ErrorAction SilentlyContinue)) {
        throw "Install GitHub CLI from https://cli.github.com/ and rerun."
    }
    & winget install --id GitHub.cli --exact --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) { throw "GitHub CLI installation failed." }
    $candidates = @(
        (Join-Path $env:ProgramFiles 'GitHub CLI\gh.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'GitHub CLI\gh.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\GitHub CLI\gh.exe')
    )
    $gh = $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
    if (!$gh) { throw "GitHub CLI installed, but gh.exe isn't in the current PATH. Reopen PowerShell and rerun." }
}
$previousErrorMode = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
& $gh auth status -h github.com
$authFailed = $LASTEXITCODE -ne 0
$ErrorActionPreference = $previousErrorMode
if ($authFailed) {
    Write-Host "Authenticate to GitHub in your browser (no token or password pasted here)."
    & $gh auth login --hostname github.com --git-protocol https --web
    if ($LASTEXITCODE -ne 0) { throw "GitHub authentication failed." }
}
$notes = @'
## Zero1Local-ix2 v0.9.0-rc1 — Beta / hardware qualification pending

**Hardware:** Lenovo/Iomega ix2-ng ARMv5, Linux 2.6.31.x. **Product:** Zero1Local-ix2, not main ARM64 Zero1Local.

This is an incremental compatibility candidate toward Zero1Local v1.4.0, **not** full feature/UI parity or a production-qualified/stable release.

- Improves boot reconciliation after a LifeLine/Zero1Local port-80 handoff.
- Adds a dedicated Updates navigation page, better log bounds, managed temporary storage.
- Adds per-file package checksums, hardware preflight, preserved previous application and a post-activation health/rollback transaction.
- Existing NAS shares, user data, RAID configuration, credentials and independent LifeLine recovery must remain preserved.
- SSH daemon modernization, elimination of the OEM "soho" prefix, and full v1.4.0 backend parity are **not** included.

Offline package and transaction tests passed; real-device cold boot, update, rollback and recovery acceptance **have not been completed**. Review backups and recovery access before installing. Use the **Beta** channel in the ix2 Updates UI. Automatic installation is not recommended.

The built-in updater recognizes the exact asset `Zero1Local-ix2-0.9.0-rc1-update.zip` and requires its GitHub-computed SHA-256 digest.
'@
$notesPath = Join-Path $env:TEMP ('ix2-v090-rc1-release-' + [guid]::NewGuid().ToString('N') + '.md')
[IO.File]::WriteAllText($notesPath, $notes, (New-Object System.Text.UTF8Encoding($false)))
try {
    # Only create the release when the tag does not already have one. Never overwrite existing assets.
    $previousErrorMode = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $view = & $gh release view $Tag --repo $Repo --json tagName 2>$null
    $exists = $LASTEXITCODE -eq 0
    $ErrorActionPreference = $previousErrorMode
    if (!$exists) {
        Write-Host "Publishing GitHub prerelease $Tag ..."
        & $gh release create $Tag $Archive --repo $Repo --target main --title 'Zero1Local-ix2 v0.9.0-rc1 (Beta)' --notes-file $notesPath --prerelease --latest=false
        if ($LASTEXITCODE -ne 0) { throw "GitHub prerelease publication failed." }
    } else {
        Write-Host "Release $Tag already exists. Checking the existing asset without overwriting it..."
    }
    $raw = & $gh api "repos/$Repo/releases/tags/$Tag"
    if ($LASTEXITCODE -ne 0) { throw "Unable to fetch published GitHub release." }
    $release = ($raw -join "`n") | ConvertFrom-Json
    if ($release.draft -or !$release.prerelease) { throw "Release exists but is not a published Beta prerelease." }
    $asset = @($release.assets | Where-Object { $_.name -ceq $AssetName }) | Select-Object -First 1
    if (!$asset) { throw "Release exists but update ZIP asset was not found; UI will not discover it." }
    if ($asset.digest -cne ('sha256:' + $ExpectedSHA256)) {
        throw "GitHub asset digest does not match packaged ZIP. Expected sha256:$ExpectedSHA256; got $($asset.digest)."
    }
    if ([int64]$asset.size -ne (Get-Item -LiteralPath $Archive).Length) {
        throw "GitHub update ZIP size does not match local asset."
    }
    Write-Host ""
    Write-Host "PUBLISHED AND VERIFIED: $($release.html_url)"
    Write-Host "Asset: $($asset.name)"
    Write-Host "SHA-256: $($asset.digest)"
    Write-Host "NAS update channel: BETA (manual install recommended)"
    Write-Host "The GitHub release is now eligible for discovery; actual NAS updater access still needs an on-device check."
} finally {
    Remove-Item -LiteralPath $notesPath -Force -ErrorAction SilentlyContinue
}
