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

# Signature verification is added in a later task. For now these are working
# stubs: they print the skip notice and always succeed, so remote installs are
# not blocked on a check that does not exist yet.
function Write-SignatureSkipNotice {
  Write-Warning "SIGNATURE NOT CHECKED -- publisher verification is not implemented yet."
}

function Test-NimbusSignature {
  param([string]$Dir, [string]$Base)
  Write-SignatureSkipNotice
  return $true
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
# extracted directory. Throws on any failure -- the caller's try/finally is
# responsible for removing the parent temp tree this creates.
function Get-NimbusRelease {
  param([string]$Version)

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

  $work = Join-Path ([System.IO.Path]::GetTempPath()) ("nimbus-" + [Guid]::NewGuid())
  New-Item -ItemType Directory -Path $work -Force | Out-Null
  $zip = Join-Path $work $Asset
  $sumsPath = Join-Path $work "SHA256SUMS"

  Write-Host "Downloading $Asset ($tag)..."
  Invoke-WebRequest -Uri "$base/$Asset"     -OutFile $zip      -UseBasicParsing
  Invoke-WebRequest -Uri "$base/SHA256SUMS" -OutFile $sumsPath -UseBasicParsing

  $actual = (Get-FileHash -Path $zip -Algorithm SHA256).Hash.ToLowerInvariant()

  # Exact field match, never a regex/substring match -- the asset name
  # contains literal dots that a pattern match would treat as "any
  # character", letting an unrelated line satisfy the match. The real
  # SHA256SUMS format is "<64-hex-hash><two spaces><filename>", no "*" marker.
  $expected = $null
  foreach ($line in Get-Content -Path $sumsPath) {
    $fields = $line -split '\s+', 2
    if ($fields.Length -eq 2 -and $fields[1] -eq $Asset) {
      $expected = $fields[0].ToLowerInvariant()
      break
    }
  }
  if (-not $expected -or $expected -ne $actual) {
    Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
    throw "sha256 checksum mismatch for $Asset - refusing to install."
  }
  Write-Host "OK: sha256 verified."

  Test-NimbusSignature -Dir $work -Base $base | Out-Null

  $dest = Join-Path $work "extracted"
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

$NeedFetch = (-not $HaveLocal) -and (-not $Local)

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

# $work is the top-level temp tree Get-NimbusRelease creates via its own
# New-Item call. It is the ONLY thing this finally block removes -- never a
# path or environment variable inherited from the caller. (install.sh's
# cleanup trap had exactly this class of bug: an earlier version also
# removed $GNUPGHOME, an INHERITED env var the script never sets, which
# destroyed real user GPG keyrings whenever one was exported. Fixed there by
# deleting that arm entirely; never reintroduced here.)
$work = $null
try {
  if ($NeedFetch) {
    $dest = Get-NimbusRelease -Version $FromRelease
    $work = Split-Path -Parent $dest
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
