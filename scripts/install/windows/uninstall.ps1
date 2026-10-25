#Requires -Version 5.1
<#
.SYNOPSIS
  Nimbus uninstaller for Windows (per-user, no admin).
.DESCRIPTION
  Stops any Nimbus process running from the install directory, removes the
  installed binaries and the install directory's User PATH entry. Your data
  (%LOCALAPPDATA%\Nimbus) and config (%APPDATA%\Nimbus) are kept.
.PARAMETER Yes
  Skip the confirmation prompt.
#>
[CmdletBinding()]
param(
  [switch]$Yes
)

$ErrorActionPreference = "Stop"

# `#Requires` above is INERT under `irm | iex` (the text is evaluated, not run as
# a file), so this runtime check is the one that fires there.
if ($PSVersionTable.PSVersion -lt [Version]"5.1") {
  throw "Nimbus requires Windows PowerShell 5.1 or later. Found $($PSVersionTable.PSVersion)."
}

$InstallDir = Join-Path $env:LOCALAPPDATA "Programs\Nimbus\bin"
# Everything install.ps1 copies into $InstallDir, vec0.dll included.
$InstalledFiles = @("nimbus.exe", "nimbus-gateway.exe", "nimbus-sandbox-helper.exe", "vec0.dll")
$ProcessNames = @("nimbus", "nimbus-gateway", "nimbus-sandbox-helper")

Write-Host "About to uninstall Nimbus:"
Write-Host "  Stop:   any Nimbus process running from $InstallDir"
foreach ($name in $InstalledFiles) {
  Write-Host "  Remove: $InstallDir\$name"
}
Write-Host "  Remove $InstallDir from User PATH (registry: HKCU\Environment)"
Write-Host "  Keep:   your data ($env:LOCALAPPDATA\Nimbus) and config ($env:APPDATA\Nimbus)"

if (-not $Yes) {
  $answer = Read-Host "Continue? [y/N]"
  if ($answer -notmatch '^(y|yes)$') {
    Write-Host "Aborted."
    # Run as a file: exit 1, like uninstall.sh. Run from text (`irm | iex`, the scriptblock
    # one-liner): `return`, because an `exit` there would close the user's shell.
    if ($PSCommandPath) { exit 1 } else { return }
  }
}

# Only processes whose executable lives in THIS install directory. A gateway run
# from anywhere else (a source checkout, another install) is not ours to stop.
function Get-InstalledNimbusProcess {
  $prefix = $InstallDir.TrimEnd('\') + '\'
  @(Get-Process -Name $ProcessNames -ErrorAction SilentlyContinue | Where-Object {
      # Reading .Path can throw (another user's or an elevated process, or one that just
      # exited). Such a process is not ours, and under EAP=Stop it must not end the script.
      try {
        $p = $_.Path
        $p -and $p.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)
      } catch { $false }
    })
}

# A running .exe cannot be deleted on Windows, so stop ours first.
$running = Get-InstalledNimbusProcess
if ($running.Count -gt 0) {
  $ids = @($running | ForEach-Object { $_.Id })
  Write-Host "Stopping $($running.Count) running Nimbus process(es): $($ids -join ', ')"
  # `nimbus stop` also clears the gateway state file, but it signals whatever pid
  # that file names. Use it only when that pid is one of OUR processes.
  $statePath = Join-Path $env:LOCALAPPDATA "Nimbus\data\gateway.json"
  $cli = Join-Path $InstallDir "nimbus.exe"
  $statePid = $null
  try {
    if (Test-Path -LiteralPath $statePath) {
      $statePid = [int](Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json).pid
    }
  } catch { $statePid = $null }
  if ($statePid -and ($ids -contains $statePid) -and (Test-Path -LiteralPath $cli)) {
    # 5.1 turns native stderr into a terminating error under EAP=Stop.
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try { & $cli stop *> $null } catch { } finally { $ErrorActionPreference = $prevEap }
  }
  foreach ($proc in Get-InstalledNimbusProcess) {
    try { Stop-Process -Id $proc.Id -Force -ErrorAction Stop } catch { }
  }
  $deadline = (Get-Date).AddSeconds(10)
  while (((Get-InstalledNimbusProcess).Count -gt 0) -and ((Get-Date) -lt $deadline)) {
    Start-Sleep -Milliseconds 200
  }
  $left = Get-InstalledNimbusProcess
  if ($left.Count -gt 0) {
    Write-Warning ("Still running after 10 s: " + (($left | ForEach-Object { "$($_.Name) (pid $($_.Id))" }) -join ', '))
  }
}

$failed = @()
foreach ($name in $InstalledFiles) {
  $p = Join-Path $InstallDir $name
  if (Test-Path -LiteralPath $p) {
    try {
      Remove-Item -LiteralPath $p -Force -ErrorAction Stop
    } catch {
      $failed += $p
      Write-Warning "Could not remove ${p}: $($_.Exception.Message)"
    }
  }
}

# Remove the install directory (and its Programs\Nimbus parent) only once empty,
# so nothing the user put there is deleted.
foreach ($dir in @($InstallDir, (Split-Path -Parent $InstallDir))) {
  if ((Test-Path -LiteralPath $dir) -and (@(Get-ChildItem -LiteralPath $dir -Force).Count -eq 0)) {
    try { Remove-Item -LiteralPath $dir -Force -ErrorAction Stop } catch { }
  }
}

$pathChanged = $false
$currentPath = [Environment]::GetEnvironmentVariable("PATH", "User")
if ($null -ne $currentPath) {
  # Case-insensitive equality against the exact install dir -- not a glob.
  # A glob like -inotlike "*Nimbus\bin" would false-positive on unrelated PATH
  # entries such as C:\Tools\NimbusTeam\nimbus\bin or D:\Custom\Nimbus\bin.
  $segments = $currentPath -split ";"
  $isOurs = { param($s) $s.TrimEnd('\') -ieq $InstallDir.TrimEnd('\') }
  # Write PATH only when our entry is actually there; otherwise leave the user's
  # PATH exactly as it is (no normalising of empty segments behind their back).
  if (@($segments | Where-Object { & $isOurs $_ }).Count -gt 0) {
    $newPath = ($segments | Where-Object { $_ -ne "" -and -not (& $isOurs $_) }) -join ";"
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
    Write-Warning "Could not broadcast environment change (likely Constrained Language Mode). PATH was updated successfully - open a new shell to pick it up."
  }
}

if ($failed.Count -gt 0) {
  # `throw`, not `exit 1`: a non-zero exit when run as a file, and under `irm | iex`
  # it does not close the user's shell.
  throw ("Nimbus was only partly uninstalled. Could not remove: " + ($failed -join ', ') +
    ". Close anything using these files (or sign out and back in) and run the uninstaller again.")
}

Write-Host "Nimbus uninstalled. Your data ($env:LOCALAPPDATA\Nimbus) and config ($env:APPDATA\Nimbus) were kept; delete them yourself for a complete removal."
