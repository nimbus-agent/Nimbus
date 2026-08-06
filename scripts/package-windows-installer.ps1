#Requires -Version 7.0
<#
.SYNOPSIS
  Build the per-user Nimbus .msi with WiX v5. Run on a Windows runner.
.PARAMETER BinDir
  Directory containing nimbus.exe + nimbus-gateway.exe.
.PARAMETER Version
  Release version (tag with/without leading 'v'; prerelease suffix is stripped —
  MSI ProductVersion must be numeric x.y.z).
.PARAMETER Out
  Output .msi path.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$BinDir,
  [Parameter(Mandatory = $true)][string]$Version,
  [Parameter(Mandatory = $true)][string]$Out
)
$ErrorActionPreference = "Stop"

# Normalize to a 3-field numeric ProductVersion (strip leading v + any -prerelease).
$pv = ($Version -replace '^v', '') -replace '-.*$', ''
if ($pv -notmatch '^\d+\.\d+\.\d+$') { throw "Invalid MSI version '$Version' -> '$pv' (need x.y.z)." }

# vec0.dll is a required MSI payload (nimbus.wxs has a Component for it), so a missing sidecar
# must fail here with a readable message rather than as a WiX file-not-found.
foreach ($f in @("nimbus.exe", "nimbus-gateway.exe", "vec0.dll")) {
  if (-not (Test-Path (Join-Path $BinDir $f))) { throw "Missing $f in $BinDir" }
}

# WiX v5 is bootstrapped by the CI job via `dotnet tool install --global wix`.
if (-not (Get-Command wix -ErrorAction SilentlyContinue)) {
  throw "wix not found on PATH. CI bootstraps it via 'dotnet tool install --global wix --version <pinned>'."
}

$wxs = Join-Path $PSScriptRoot "windows\nimbus.wxs"
# Split-Path -Parent is empty for a filename-only $Out; default to the cwd.
$outDir = Split-Path -Parent $Out
if ([string]::IsNullOrWhiteSpace($outDir)) { $outDir = "." }
New-Item -ItemType Directory -Path $outDir -Force | Out-Null

& wix build $wxs -arch x64 -d "Version=$pv" -d "BinDir=$BinDir" -o $Out
if ($LASTEXITCODE -ne 0) { throw "wix build failed ($LASTEXITCODE)." }
if (-not (Test-Path $Out)) { throw "wix reported success but $Out is missing." }

Write-Host "✓ Built $Out (ProductVersion $pv)"
