#Requires -Version 7.0
<#
.SYNOPSIS
  Sign a Windows artifact (.msi/.exe) with signtool. Convention matches
  sign-linux-gpg.sh: cert secrets present -> sign; else warn + exit 0.
.DESCRIPTION
  Required env when signing:
    WINDOWS_CERT_PFX_BASE64, WINDOWS_CERT_PASSWORD
  Optional: WINDOWS_CERT_TIMESTAMP_URL (default: http://timestamp.digicert.com)
#>
[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$Target)
$ErrorActionPreference = "Stop"

if (-not (Test-Path $Target)) { Write-Error "sign-windows: target not found: $Target"; exit 1 }

if (-not $env:WINDOWS_CERT_PFX_BASE64 -or -not $env:WINDOWS_CERT_PASSWORD) {
  Write-Host "signing skipped: WINDOWS_CERT_PFX_BASE64 / WINDOWS_CERT_PASSWORD not set"
  exit 0
}

$signtool = Get-Command signtool -ErrorAction SilentlyContinue
if (-not $signtool) {
  Write-Error "sign-windows: signtool not found on PATH (install the Windows SDK)."; exit 1
}

$pfx = Join-Path ([System.IO.Path]::GetTempPath()) "nimbus-cert.pfx"
try {
  [System.IO.File]::WriteAllBytes($pfx, [Convert]::FromBase64String($env:WINDOWS_CERT_PFX_BASE64))
  $ts = if ($env:WINDOWS_CERT_TIMESTAMP_URL) { $env:WINDOWS_CERT_TIMESTAMP_URL } else { "http://timestamp.digicert.com" }
  & signtool sign /fd SHA256 /td SHA256 /tr $ts /f $pfx /p $env:WINDOWS_CERT_PASSWORD $Target
  if ($LASTEXITCODE -ne 0) { Write-Error "signtool failed ($LASTEXITCODE)"; exit 1 }
  Write-Host "signed: $Target"
} finally {
  if (Test-Path $pfx) { Remove-Item $pfx -Force }
}
