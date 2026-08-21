#Requires -Version 7.0
[CmdletBinding()]
param(
  [switch]$Yes
)

$ErrorActionPreference = "Stop"
$InstallDir = Join-Path $env:LOCALAPPDATA "Programs\Nimbus\bin"

Write-Host "About to uninstall Nimbus:"
Write-Host "  Remove: $InstallDir\nimbus.exe"
Write-Host "  Remove: $InstallDir\nimbus-gateway.exe"
Write-Host "  Remove: $InstallDir\nimbus-sandbox-helper.exe"
Write-Host "  Remove $InstallDir from User PATH (registry: HKCU\Environment)"

if (-not $Yes) {
  $answer = Read-Host "Continue? [y/N]"
  if ($answer -notmatch '^(y|yes)$') { Write-Host "Aborted."; exit 1 }
}

Remove-Item -Path (Join-Path $InstallDir "nimbus.exe")                 -Force -ErrorAction SilentlyContinue
Remove-Item -Path (Join-Path $InstallDir "nimbus-gateway.exe")         -Force -ErrorAction SilentlyContinue
Remove-Item -Path (Join-Path $InstallDir "nimbus-sandbox-helper.exe")  -Force -ErrorAction SilentlyContinue

$pathChanged = $false
$currentPath = [Environment]::GetEnvironmentVariable("PATH", "User")
if ($null -ne $currentPath) {
  # Use case-insensitive equality against the exact install dir — not a glob.
  # A glob like -inotlike "*Nimbus\bin" would false-positive on unrelated PATH
  # entries such as C:\Tools\NimbusTeam\nimbus\bin or D:\Custom\Nimbus\bin.
  $newSegments = $currentPath -split ";" | Where-Object { $_ -ne "" -and $_ -ine $InstallDir }
  $newPath = $newSegments -join ";"
  if ($newPath -ne $currentPath) {
    [Environment]::SetEnvironmentVariable("PATH", $newPath, "User")
    $pathChanged = $true
  }
}

if ($pathChanged) {
  # Broadcast WM_SETTINGCHANGE so already-open Explorer / shells pick up the change.
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
    Write-Warning "Could not broadcast environment change (likely Constrained Language Mode). PATH was updated successfully — open a new shell to pick it up."
  }
}

Write-Host "✓ Nimbus uninstalled."
