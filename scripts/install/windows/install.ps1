#Requires -Version 5.1
<#
.SYNOPSIS
  Nimbus installer for Windows (per-user, no admin).
.PARAMETER Yes
  Skip confirmation prompts.
.PARAMETER DryRun
  Print planned actions and exit without writing.
.PARAMETER FromRelease
  Download a release build (latest, or a specific version, e.g. "2.2.0")
  instead of using binaries staged beside this script.
.PARAMETER Local
  Require binaries staged beside this script (or under bin\); never fetch a
  release, even if none are found here.
#>
[CmdletBinding()]
param(
  [switch]$Yes,
  [switch]$DryRun,
  [string]$FromRelease,
  [switch]$Local
)

$ErrorActionPreference = "Stop"

# `#Requires -Version 5.1` above is INERT under `irm | iex` -- verified: on
# 5.1.26100.9168, `Invoke-Expression "#Requires -Version 7.0\`nWrite-Host RAN-ANYWAY"`
# still prints RAN-ANYWAY. This runtime check is the one that actually fires
# under iex. 5.1 is the floor because it's the version we support.
if ($PSVersionTable.PSVersion -lt [Version]"5.1") {
  throw "Nimbus requires Windows PowerShell 5.1 or later. Found $($PSVersionTable.PSVersion)."
}

# 5.1 does not reliably negotiate TLS 1.2 by default, and GitHub requires it.
# Guarded to PS < 6: PS 6+ negotiates TLS 1.2 itself, and
# [Net.ServicePointManager]::SecurityProtocol is a no-op / deprecated there.
if ($PSVersionTable.PSVersion.Major -lt 6) {
  [Net.ServicePointManager]::SecurityProtocol =
    [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
}

# Under `irm | iex` there is no script file, so every script-path variable is
# null. That is REMOTE mode, not an error -- the null-deref here was #1167.
$ScriptDir = if ($PSScriptRoot) { $PSScriptRoot }
             elseif ($PSCommandPath) { Split-Path -Parent $PSCommandPath }
             else { $null }

$InstallDir = Join-Path $env:LOCALAPPDATA "Programs\Nimbus\bin"
$Repo = "nimbus-agent/Nimbus"
$Asset = "nimbus-headless-windows-x64.zip"

# Pinned fingerprint of the PRIMARY Nimbus release-signing key. Embedded so no
# keyserver is contacted at install time. NOTE: this is a RELIABILITY
# measure, not a stronger trust root -- an attacker who can swap this script
# can swap this key too. It defends a tampered release asset given an
# authentic script; scripts/release/nimbus-verify.sh --version <ver> is the
# real, out-of-band publisher-authenticity check.
$NimbusSigningFpr = "5A20457CCD8B53FFAA945240886ADA6B487CAB6E"
$NimbusSigningKey = @'
-----BEGIN PGP PUBLIC KEY BLOCK-----

mDMEafo5vhYJKwYBBAHaRw8BAQdAJ5GZYXl/HDGCuEDLnHgVMTuRJXhZ5fceSCmK
Qi6Jj8G0N05pbWJ1cyBBZ2VudCBSZWxlYXNlIFNpZ25pbmcgPHJlbGVhc2VAbmlt
YnVzLWFnZW50LmRldj6IkwQTFgoAOxYhBFogRXzNi1P/qpRSQIhq2mtIfKtuBQJp
+jm+AhsBBQsJCAcCAiICBhUKCQgLAgQWAgMBAh4HAheAAAoJEIhq2mtIfKtuwjIA
/2wheC2uO3pTNCKKwilgaMsU8GRzs0ujJzkWoankadqjAP9VWiYFI2isRbhZaWbD
v4twRB0VYQaD9dl4LBmZC+BBALgzBGn6Oc4WCSsGAQQB2kcPAQEHQB/G7FMHaU10
cf031erCIP4kVrwf+FhuTRAh3uDL7X/LiPUEGBYKACYWIQRaIEV8zYtT/6qUUkCI
atprSHyrbgUCafo5zgIbAgUJA8JnAACBCRCIatprSHyrbnYgBBkWCgAdFiEExPMx
6Rgnz4l8bEfvFWVUZU9KBjkFAmn6Oc4ACgkQFWVUZU9KBjnhLgEAiaC4VLnPq7F/
zlB+dF7ziR+F/OgB1glw+h9PrFzyMqYBAKRBn7vmY1bu6Y3PBmF6/7GDn3C6hDT4
q5uKE64QVrQLbtEA/AqKCepCe7jvFFZCdYtOzm7vnZJGUeeKrionBzqtSQSmAQDG
GZj8E1UHHwDCVM+4vVet/0q+U2Lgczx9nmZ2fjKlDw==
=4lgY
-----END PGP PUBLIC KEY BLOCK-----
'@

# WARNING: the call site below does `if (-not (Test-NimbusSignature ...))`.
# PowerShell functions implicitly return every unsuppressed pipeline output as
# a single (possibly multi-element) array. PowerShell only coerces a
# SINGLE-element array to bool by looking at that one element's own
# truthiness (so `-not @($false)` is `$true`, as expected) -- but an array of
# TWO OR MORE elements coerces to $true UNCONDITIONALLY, regardless of what
# those elements are, so `-not` on it is ALWAYS $false. That means a single
# stray unsuppressed write inside this function (a bare expression,
# `Write-Output`, an un-`| Out-Null`'d cmdlet call, etc.) ahead of the real
# `return $false` turns the pipeline output into a 2-element array, silently
# flips its truthiness, and the "if signature invalid, refuse to install"
# gate goes fail-OPEN. Keep every intermediate step suppressed (`| Out-Null`,
# or `[void]`) and end the function with exactly one bare `return
# $true`/`return $false`.
# Write-Warning/Write-Host write to the Warning/host streams, not the success
# (pipeline-output) stream, so they are safe to use unsuppressed for
# human-facing text without risking the array-coercion trap above.
function Write-SignatureSkipNotice {
  param([string]$Reason)
  # Say exactly what was and was not established. The sha256 manifest came
  # down the same channel as the archive, so it proves integrity, NOT
  # publisher authenticity -- do not let the output imply otherwise.
  Write-Warning $Reason
  Write-Warning "  Installed after SHA-256 verification only. The checksum manifest was"
  Write-Warning "  fetched over the same channel as the archive, so this proves the file"
  Write-Warning "  arrived intact -- NOT that Nimbus published it."
  Write-Warning "  To verify the publisher signature: scripts/release/nimbus-verify.sh --version <ver>"
}

# Pure decision function over `gpg --status-fd 1 --verify` output lines: no
# gpg invocation, no network, no filesystem access. Exists so the VALIDSIG
# PARSING (which field is the primary fingerprint vs. the signing-subkey
# fingerprint) and the EXPKEYSIG/REVKEYSIG rejection can be unit-tested
# against canned/realistic gpg status lines -- including a real capture from
# `gpg --status-fd 1 --verify` against the actual published v2.3.0
# SHA256SUMS.asc and the real Nimbus signing key -- without ever running gpg
# and without any caller-suppliable trust anchor: $ExpectedFingerprint is
# always the module-private $NimbusSigningFpr constant at the one production
# call site below, never something a test (or an env var) can override. A
# fingerprint-override seam was deliberately refused elsewhere in this file
# for exactly that reason (it would compose with $env:NIMBUS_INSTALL_BASE_URL
# into a full verification bypass) -- this function does not reopen that; it
# only tests the PARSING half.
#
# VALIDSIG line layout (GPG 1.4+):
#   [GNUPG:] VALIDSIG <signing-fp> <date> <ts> <expire> <ver> <reserved>
#                     <pubkey-algo> <hash-algo> <sig-class> <primary-fp>
# Field 3 is the signing SUBKEY's fingerprint; the LAST field is the PRIMARY
# fingerprint, which is what $ExpectedFingerprint pins. The real Nimbus
# release key signs via a dedicated signing subkey, so a naive
# `-match "VALIDSIG $ExpectedFingerprint"` substring test anchors field 3 and
# would NEVER match a genuine signature -- mirrors
# scripts/release/nimbus-verify.ps1's field-extraction approach, not a
# substring match.
#
# Returns exactly one PSCustomObject (never zero, never more than one) --
# same array-coercion discipline as the rest of this file: Valid / Reason /
# PrimaryFingerprint, no intermediate unsuppressed pipeline output.
function Resolve-SignatureVerdict {
  param([string[]]$StatusLines, [string]$ExpectedFingerprint)

  $validsigLine = $StatusLines | Where-Object { $_ -match '^\[GNUPG:\] VALIDSIG' } | Select-Object -First 1
  $primaryFp = $null
  if ($validsigLine) {
    $fields = -split $validsigLine
    $primaryFp = $fields[$fields.Length - 1]
  }

  if ($primaryFp -and $primaryFp -eq $ExpectedFingerprint) {
    # GPG emits EXPKEYSIG/REVKEYSIG ALONGSIDE VALIDSIG, not instead of it, so
    # this must be checked independently of the fingerprint match above --
    # mirrors scripts/release/nimbus-verify.ps1's own expired/revoked guard
    # (`$out -match '\[GNUPG:\] (EXPKEYSIG|REVKEYSIG)'`) verbatim.
    if ($StatusLines -match '\[GNUPG:\] (EXPKEYSIG|REVKEYSIG)') {
      return [pscustomobject]@{ Valid = $false; Reason = "expired-or-revoked"; PrimaryFingerprint = $primaryFp }
    }
    return [pscustomobject]@{ Valid = $true; Reason = $null; PrimaryFingerprint = $primaryFp }
  }
  return [pscustomobject]@{ Valid = $false; Reason = "no-match"; PrimaryFingerprint = $primaryFp }
}

function Test-NimbusSignature {
  param([string]$Dir, [string]$Base)

  # Get-Command succeeds for a stub or broken shim; require that it actually runs.
  $gpgCmd = Get-Command gpg -ErrorAction SilentlyContinue
  if (-not $gpgCmd) {
    Write-SignatureSkipNotice "gpg not found -- SIGNATURE NOT CHECKED."
    return $true
  }
  try {
    & gpg --version *>$null
    if ($LASTEXITCODE -ne 0) { throw "gpg exited $LASTEXITCODE" }
  } catch {
    Write-SignatureSkipNotice "gpg is present but not runnable -- SIGNATURE NOT CHECKED."
    return $true
  }

  $ascPath = Join-Path $Dir "SHA256SUMS.asc"
  try {
    Invoke-WebRequest -Uri "$Base/SHA256SUMS.asc" -OutFile $ascPath -UseBasicParsing
  } catch {
    Write-SignatureSkipNotice "SHA256SUMS.asc unavailable -- SIGNATURE NOT CHECKED."
    return $true
  }

  # A dedicated GNUPGHOME nested inside $Dir (the caller's already-tracked
  # $WorkDir) -- never $env:GNUPGHOME, which this function never reads or
  # sets. `--homedir` is used on every gpg invocation below instead of
  # exporting the environment variable, so the caller's inherited
  # $env:GNUPGHOME (if any) is never touched. Nesting under $Dir means the
  # top-level `finally { Remove-Item -Recurse -Force $work }` cleans this up
  # automatically -- no separate tracked path or cleanup arm needed. See the
  # comment on that `finally` block for why an inherited GNUPGHOME must never
  # be touched (install.sh had exactly this bug in an earlier draft).
  #
  # $sigHomeName is deliberately a bare, RELATIVE leaf name, never the full
  # $sigHome path, when it reaches --homedir below. Root cause of a real
  # windows-2022 CI failure against the published v2.3.0 assets (run
  # 31735428461): Git for Windows bundles an MSYS2-compiled gpg.exe, and
  # THAT gpg's own "is this --homedir absolute" check only recognizes a
  # leading "/" (POSIX form) -- confirmed empirically against real
  # Git-for-Windows gpg 2.4.8, both slash directions ("C:\Users\...\gnupg-sig"
  # and "C:/Users/...\gnupg-sig") fail identically. Not recognized as
  # absolute, gpg silently treats it as RELATIVE and prepends its own
  # (MSYS-translated) cwd, producing a nonexistent keyring resource.
  # `--import` then fails ("no writable keyring found"), which the `*>$null`
  # below silently swallows, so `--verify` runs against an unreachable
  # keyring, the pinned key is never imported, VALIDSIG never appears, and
  # this function returns $false -- exactly the observed
  # "signature verification failed - refusing to install." abort against a
  # genuinely valid signature. A native (non-MSYS) gpg build (e.g. Gpg4win)
  # has no such bug and resolves a Windows-style --homedir path fine either
  # way. The fix that works for BOTH gpg flavors without detecting which one
  # is installed: run gpg with $Dir as its working directory and pass a
  # RELATIVE homedir name -- ordinary relative-path resolution against the
  # real process cwd is correct under a native Win32 gpg.exe and an
  # MSYS-translated one alike, since it never exercises the broken
  # "is this string absolute" heuristic at all. Every other gpg argument
  # below (key/asc/sums paths) already works fine as an absolute Windows
  # path under both flavors -- confirmed empirically -- so only --homedir
  # needs this treatment.
  $sigHomeName = "gnupg-sig"
  $sigHome = Join-Path $Dir $sigHomeName
  New-Item -ItemType Directory -Path $sigHome -Force | Out-Null
  $keyPath = Join-Path $Dir "nimbus-signing-key.asc"
  # UTF8Encoding($false) == no BOM. Measured: PS 5.1 `Out-File`/`-Encoding
  # utf8` both emit a BOM (or UTF-16LE for plain Out-File) that `gpg --import`
  # cannot parse. Do not simplify this to Out-File, `>`, or a gpg pipeline.
  [System.IO.File]::WriteAllText($keyPath, $NimbusSigningKey, [System.Text.UTF8Encoding]::new($false))

  Push-Location -LiteralPath $Dir
  try {
    & gpg --homedir $sigHomeName --quiet --import $keyPath *>$null
    $out = & gpg --homedir $sigHomeName --quiet --status-fd 1 --verify $ascPath (Join-Path $Dir "SHA256SUMS") 2>$null
  } finally {
    Pop-Location
  }

  # Parsing + trust decision both live in Resolve-SignatureVerdict now (see
  # its own doc comment for the VALIDSIG field layout and why the LAST field,
  # not field 3, is the primary fingerprint). $NimbusSigningFpr is the sole,
  # hardcoded, non-overridable expected fingerprint passed in here.
  $verdict = Resolve-SignatureVerdict -StatusLines $out -ExpectedFingerprint $NimbusSigningFpr

  if ($verdict.Valid) {
    Write-Host "OK: GPG signature verified ($NimbusSigningFpr)."
    return $true
  }
  if ($verdict.Reason -eq "expired-or-revoked") {
    Write-Warning "SHA256SUMS.asc signing key is expired or revoked -- refusing to install."
    return $false
  }
  Write-Warning "SHA256SUMS.asc did not verify against the pinned Nimbus key -- refusing to install."
  return $false
}

# Preflight a cmdlet this script depends on, with an actionable message --
# mirrors install.sh's require_cmd. Do not let the user see a raw
# "term not recognized" error.
function Assert-NimbusCommand {
  param([string]$Name)
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "'$Name' is required to download a release but is unavailable in this PowerShell session. Download the release manually and run install.ps1 -Local from inside it instead."
  }
}

function Resolve-LatestTag {
  # Follow the /releases/latest redirect. No GitHub API: unauthenticated it is
  # 60 req/hour per IP, shared across CI runners.
  param([string]$Repo)
  $r = Invoke-WebRequest -Uri "https://github.com/$Repo/releases/latest" `
                          -MaximumRedirection 5 -UseBasicParsing
  # 5.1 exposes ResponseUri on BaseResponse (a System.Net.HttpWebResponse);
  # 7+ exposes RequestMessage.RequestUri instead (BaseResponse is a
  # System.Net.Http.HttpResponseMessage there, with no ResponseUri property).
  # Probe both -- reaching for RequestMessage unconditionally null-derefs on
  # 5.1, the same bug class this task exists to fix.
  $uri = if ($r.BaseResponse.PSObject.Properties.Name -contains 'ResponseUri') {
    $r.BaseResponse.ResponseUri
  } elseif ($r.BaseResponse.RequestMessage) {
    $r.BaseResponse.RequestMessage.RequestUri
  } else {
    $null
  }
  if (-not $uri) { throw "Could not resolve the redirected release URL." }
  return ($uri.ToString().TrimEnd('/') -split '/')[-1]
}

# Downloads, sha256-verifies, and extracts a release build. Returns the
# extracted directory. Throws on any failure.
#
# $WorkDir is created by the CALLER (via its own New-Item), before this
# function is invoked -- never inside here. That is deliberate: this
# function can throw at several points (a failed download, a checksum
# mismatch, a future failed signature check), and if the temp dir were only
# assigned to the caller's cleanup variable on a SUCCESSFUL return, every one
# of those throw paths would leak it (the caller's `finally` would find its
# tracking variable still $null and remove nothing). Assigning it in the
# caller immediately after creation means the `finally` always knows what to
# remove, regardless of where inside this function things go wrong.
function Get-NimbusRelease {
  param([string]$Version, [string]$WorkDir)

  Assert-NimbusCommand -Name "Invoke-WebRequest"
  Assert-NimbusCommand -Name "Expand-Archive"
  Assert-NimbusCommand -Name "Get-FileHash"

  $tag = if ($Version) {
    "v" + $Version.TrimStart('v')
  } else {
    # Resolution is the one network step with no fallback, so its failure
    # message must name the escape hatch: -FromRelease skips resolution
    # entirely, which is what a proxied or policy-restricted machine needs.
    try {
      Resolve-LatestTag -Repo $Repo
    } catch {
      throw "Could not resolve the latest release tag (network, proxy or firewall). Re-run with an explicit version to skip resolution: -FromRelease 2.2.0"
    }
  }
  $base = if ($env:NIMBUS_INSTALL_BASE_URL) { $env:NIMBUS_INSTALL_BASE_URL }
          else { "https://github.com/$Repo/releases/download/$tag" }

  $zip = Join-Path $WorkDir $Asset
  $sumsPath = Join-Path $WorkDir "SHA256SUMS"

  Write-Host "Downloading $Asset ($tag)..."
  # Windows PowerShell 5.1's Invoke-WebRequest renders a console progress bar
  # PER CHUNK by default -- a well-documented, severe throughput bottleneck on
  # larger files (measured directly: an ~80 MB download over a local server
  # took ~23s with the default progress rendering vs. ~0.1s with it
  # suppressed -- roughly 180x). This is a real fix for a real user on this
  # supported runtime fetching a ~50-80 MB release archive, not a CI-only
  # workaround: PS7's Invoke-WebRequest does not render progress the same
  # way, so this is a no-op there, harmless either way, and always restored
  # afterward so it never leaks into anything the caller does next.
  $previousProgressPreference = $ProgressPreference
  $ProgressPreference = "SilentlyContinue"
  try {
    Invoke-WebRequest -Uri "$base/$Asset"     -OutFile $zip      -UseBasicParsing
    Invoke-WebRequest -Uri "$base/SHA256SUMS" -OutFile $sumsPath -UseBasicParsing
  } finally {
    $ProgressPreference = $previousProgressPreference
  }

  $actual = (Get-FileHash -Path $zip -Algorithm SHA256).Hash.ToLowerInvariant()

  # Exact, CASE-SENSITIVE field match on BOTH the hash and the filename --
  # never a regex/substring match, and never PowerShell's default `-eq`
  # (which is case-INSENSITIVE for strings: "ABC.ZIP" -eq "abc.zip" is
  # $true). A checksum manifest with a case-varied duplicate entry is never
  # legitimate, so more than one matching line is a REJECTION, not a
  # first-match-wins race -- an attacker who controls a mirror/proxy could
  # otherwise prepend a shadow line (e.g. an uppercase-named entry hashing a
  # tampered archive) ahead of the genuine line and have the tampered build
  # "verify". The real SHA256SUMS format is
  # "<64-hex-hash><two spaces><filename>", no "*" marker.
  # Named $checksumMatches, deliberately NOT $matches: PowerShell variable
  # names are case-insensitive, and $Matches is the automatic variable that
  # -match/-notmatch populate as a side effect -- reusing that name here
  # would have the -notmatch check below silently clobber our own result
  # before it's read on the next line.
  $checksumMatches = @(Get-Content -Path $sumsPath | ForEach-Object {
    $fields = $_ -split '\s+', 2
    if ($fields.Length -eq 2 -and $fields[1] -ceq $Asset) { $fields[0].ToLowerInvariant() }
  })
  if ($checksumMatches.Length -ne 1 -or $checksumMatches[0] -notmatch '^[0-9a-f]{64}$') {
    throw "sha256 checksum mismatch for $Asset - refusing to install."
  }
  if ($checksumMatches[0] -ne $actual) {
    throw "sha256 checksum mismatch for $Asset - refusing to install."
  }
  Write-Host "OK: sha256 verified."

  if (-not (Test-NimbusSignature -Dir $WorkDir -Base $base)) {
    throw "signature verification failed - refusing to install."
  }

  $dest = Join-Path $WorkDir "extracted"
  Expand-Archive -Path $zip -DestinationPath $dest -Force
  return $dest
}

# Locate binaries staged beside this script (or under bin\, for tarball-style
# layouts). $BinaryRoot also doubles as the base for the sqlite-vec lookup
# below, and is re-pointed at the extracted release directory in remote mode.
$NimbusSrc  = $null
$GatewaySrc = $null
$BinaryRoot = $ScriptDir
$HaveLocal  = $false
if ($ScriptDir) {
  $NimbusSrc  = Join-Path $ScriptDir "nimbus.exe"
  $GatewaySrc = Join-Path $ScriptDir "nimbus-gateway.exe"
  if (-not (Test-Path $NimbusSrc) -or -not (Test-Path $GatewaySrc)) {
    $NimbusSrc  = Join-Path $ScriptDir "bin\nimbus.exe"
    $GatewaySrc = Join-Path $ScriptDir "bin\nimbus-gateway.exe"
  }
  $HaveLocal = (Test-Path $NimbusSrc) -and (Test-Path $GatewaySrc)
}

if ($Local -and $FromRelease) {
  throw "-Local and -FromRelease are mutually exclusive."
}

# An explicit -FromRelease always forces remote mode, even when binaries are
# staged beside the script -- release.yml ships install.ps1 INSIDE
# nimbus-headless-windows-x64.zip alongside the binaries it unpacks with, so
# without this a user who extracts 2.2.0 and runs
# `.\install.ps1 -FromRelease 2.3.0` would silently install 2.2.0 instead.
$NeedFetch = $FromRelease -or ((-not $HaveLocal) -and (-not $Local))

# -DryRun must "print planned actions and exit" -- touching nothing,
# including the network. Handle the remote-fetch case here, before
# Get-NimbusRelease (which downloads, verifies, and extracts) ever runs.
if ($DryRun -and $NeedFetch) {
  Write-Host "About to install Nimbus (dry run):"
  if ($FromRelease) {
    $tag = "v" + $FromRelease.TrimStart('v')
    $base = if ($env:NIMBUS_INSTALL_BASE_URL) { $env:NIMBUS_INSTALL_BASE_URL }
            else { "https://github.com/$Repo/releases/download/$tag" }
    Write-Host "  Would download:  $base/$Asset"
    Write-Host "  Would verify against: $base/SHA256SUMS"
  } else {
    Write-Host "  Would resolve the latest release tag from https://github.com/$Repo/releases/latest,"
    Write-Host "  then download and sha256-verify the matching release asset."
  }
  Write-Host "(-DryRun; no changes made, no network request performed)"
  exit 0
}

# $work is the top-level temp tree this script creates via its own New-Item
# call -- assigned HERE, immediately after creation, and BEFORE
# Get-NimbusRelease (which can throw at several points: a failed download, a
# checksum mismatch, a failed signature check) is ever invoked. That
# ordering matters: if $work were instead only assigned from
# Get-NimbusRelease's return value (i.e. after it succeeds), any throw
# inside that function would leave $work still $null here and the `finally`
# below would remove nothing, leaking the directory on every failure path
# but the happy one. It is the ONLY thing this finally block removes --
# never a path or environment variable inherited from the caller.
# (install.sh's cleanup trap had exactly this class of bug in a different
# form: an earlier version also removed $GNUPGHOME, an INHERITED env var the
# script never sets, which destroyed real user GPG keyrings whenever one was
# exported. Fixed there by deleting that arm entirely; never reintroduced
# here.)
$work = $null
try {
  if ($NeedFetch) {
    $work = Join-Path ([System.IO.Path]::GetTempPath()) ("nimbus-" + [Guid]::NewGuid())
    New-Item -ItemType Directory -Path $work -Force | Out-Null
    $dest = Get-NimbusRelease -Version $FromRelease -WorkDir $work
    $BinaryRoot = $dest
    $NimbusSrc  = Join-Path $BinaryRoot "nimbus.exe"
    $GatewaySrc = Join-Path $BinaryRoot "nimbus-gateway.exe"
    if (-not (Test-Path $NimbusSrc) -or -not (Test-Path $GatewaySrc)) {
      $NimbusSrc  = Join-Path $BinaryRoot "bin\nimbus.exe"
      $GatewaySrc = Join-Path $BinaryRoot "bin\nimbus-gateway.exe"
    }
  }

  if (-not $NimbusSrc -or -not $GatewaySrc -or -not (Test-Path $NimbusSrc) -or -not (Test-Path $GatewaySrc)) {
    throw "Cannot locate 'nimbus.exe' or 'nimbus-gateway.exe' beside this script, and no release could be fetched."
  }

  Write-Host "About to install Nimbus:"
  Write-Host "  Binaries: $NimbusSrc, $GatewaySrc"
  Write-Host "  -> into:  $InstallDir"
  Write-Host "  Update User PATH (registry: HKCU\Environment)"

  if ($DryRun) {
    Write-Host "(--DryRun; no changes made)"
    exit 0
  }

  if (-not $Yes) {
    $answer = Read-Host "Continue? [y/N]"
    if ($answer -notmatch '^(y|yes)$') { Write-Host "Aborted."; exit 1 }
  }

  if (-not (Test-Path $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
  }

  if ((Test-Path (Join-Path $InstallDir "nimbus.exe")) -and -not $Yes) {
    $answer2 = Read-Host "Existing install detected. Overwrite? [y/N]"
    if ($answer2 -notmatch '^(y|yes)$') { Write-Host "Aborted."; exit 1 }
  }

  Copy-Item -Path $NimbusSrc  -Destination (Join-Path $InstallDir "nimbus.exe")  -Force
  Copy-Item -Path $GatewaySrc -Destination (Join-Path $InstallDir "nimbus-gateway.exe") -Force

  # sqlite-vec loadable extension. The gateway looks for it beside its own executable, so it has to
  # be installed into the same directory. Optional: absent on an unsupported platform, which
  # disables semantic memory and nothing else.
  $Vec0Src = @(
    (Join-Path $BinaryRoot "vec0.dll"),
    (Join-Path $BinaryRoot "bin\vec0.dll")
  ) | Where-Object { Test-Path $_ } | Select-Object -First 1
  if ($Vec0Src) {
    Copy-Item -Path $Vec0Src -Destination (Join-Path $InstallDir "vec0.dll") -Force
  }

  # Update User PATH via .NET API (avoids setx 1024-char truncation bug).
  $currentPath = [Environment]::GetEnvironmentVariable("PATH", "User")
  if ($null -eq $currentPath) { $currentPath = "" }

  # Idempotent: only add if not already present (case-insensitive on Windows).
  $pathSegments = $currentPath -split ";" | Where-Object { $_ -ne "" }
  $alreadyPresent = $pathSegments | Where-Object { $_ -ieq $InstallDir }
  if (-not $alreadyPresent) {
    $newPath = if ($currentPath -eq "") { $InstallDir } else { "$currentPath;$InstallDir" }
    [Environment]::SetEnvironmentVariable("PATH", $newPath, "User")

    # Broadcast WM_SETTINGCHANGE so already-open Explorer / shells pick up the new value.
    # Wrapped in try/catch: Add-Type is blocked under Constrained Language Mode (WDAC/AppLocker).
    # PATH is already written to the registry; only the live-session refresh is missing on failure.
    try {
      $signature = @'
[DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Auto)]
public static extern IntPtr SendMessageTimeout(
  IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam,
  uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
'@
      $type = Add-Type -MemberDefinition $signature -Name 'NimbusEnvBroadcast' -Namespace Win32 -PassThru
      [UIntPtr]$result = [UIntPtr]::Zero
      $HWND_BROADCAST = [IntPtr]0xffff
      $WM_SETTINGCHANGE = 0x001A
      $SMTO_ABORTIFHUNG = 0x0002
      $type::SendMessageTimeout($HWND_BROADCAST, $WM_SETTINGCHANGE, [UIntPtr]::Zero, "Environment", $SMTO_ABORTIFHUNG, 5000, [ref]$result) | Out-Null
    } catch {
      Write-Warning "Could not broadcast environment change (likely Constrained Language Mode). PATH was updated successfully -- open a new shell to pick it up."
    }
  }

  Write-Host ""
  Write-Host "OK: Nimbus installed."
  Write-Host "  Open a new shell, then run: nimbus --version"
} finally {
  if ($work -and (Test-Path $work)) {
    Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
  }
}
