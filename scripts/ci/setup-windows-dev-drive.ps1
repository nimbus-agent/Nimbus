# Windows CI only: move the I/O-heavy parts of the PR cross-platform leg off the runner's NTFS
# system volume, and stop Defender from scanning them on every open.
#
# Why: the windows-2025 leg is the PR critical path — ~31 min against ~10 on macOS for the SAME
# command (run 38050113596: 510 s of dependency setup, 1268 s of tests). The suite is dominated by
# temp-dir SQLite fixtures and gateway boots, i.e. many small file creates/opens, which is exactly
# the workload NTFS + real-time Defender scanning is slowest at.
#
# What it does:
#   1. Creates a dynamic VHDX, formats it as a Dev Drive (ReFS; plain ReFS if the -DevDrive switch
#      is refused), mounts it at <Letter>:, and points TEMP/TMP at it for every LATER step — so
#      `os.tmpdir()` fixtures land there. The workspace and node_modules stay where they are:
#      relocating the checkout would also move the local composite action and every relative path
#      the later steps assume.
#   2. Adds Defender exclusions for the workspace, the Bun install + its package cache, the Dev
#      Drive and bun.exe.
#
# FAIL-SOFT BY DESIGN. This is a performance change, not a correctness one: if any half fails, it
# emits a ::warning:: annotation and the job carries on exactly as it did before this script
# existed. It must never be the reason a PR goes red.

param(
  [string]$Letter = 'V',
  [int]$SizeGB = 30
)

$ErrorActionPreference = 'Stop'

function Write-CiWarning([string]$Title, [string]$Message) {
  # Annotation text must be single-line.
  $flat = ($Message -replace "`r?`n", ' ')
  Write-Output "::warning title=$Title::$flat"
}

# ── Diagnostic: is Defender real-time protection even on? ─────────────────────────────────────
# Logged so the experiment's result can be read from the job log rather than assumed.
try {
  $mp = Get-MpComputerStatus
  Write-Output "Defender: RealTimeProtectionEnabled=$($mp.RealTimeProtectionEnabled) AMRunningMode=$($mp.AMRunningMode)"
} catch {
  Write-Output "Defender status unavailable: $($_.Exception.Message)"
}

# ── 1. Dev Drive for TEMP/TMP ─────────────────────────────────────────────────────────────────
$devDriveRoot = $null
try {
  $vhdPath = 'C:\nimbus_dev_drive.vhdx'
  $partition = New-VHD -Path $vhdPath -SizeBytes ($SizeGB * 1GB) -Dynamic |
    Mount-VHD -Passthru |
    Initialize-Disk -PartitionStyle GPT -Passthru |
    New-Partition -DriveLetter $Letter -UseMaximumSize

  $kind = 'Dev Drive'
  try {
    $partition | Format-Volume -DevDrive -Confirm:$false -Force | Out-Null
  } catch {
    Write-Output "Format-Volume -DevDrive refused ($($_.Exception.Message)); falling back to plain ReFS."
    $partition | Format-Volume -FileSystem ReFS -Confirm:$false -Force | Out-Null
    $kind = 'ReFS (not a Dev Drive)'
  }

  $devDriveRoot = "${Letter}:\"
  $tmp = Join-Path $devDriveRoot 'tmp'
  New-Item -ItemType Directory -Path $tmp -Force | Out-Null

  # Takes effect for every LATER step in the job, not this one.
  Add-Content -Path $env:GITHUB_ENV -Value "TEMP=$tmp"
  Add-Content -Path $env:GITHUB_ENV -Value "TMP=$tmp"
  Write-Output "$kind mounted at $devDriveRoot; TEMP/TMP -> $tmp for later steps."
  try { fsutil devdrv query "${Letter}:" } catch { }
} catch {
  Write-CiWarning 'Dev Drive setup skipped' "Could not create the Dev Drive: $($_.Exception.Message). TEMP stays on the default volume."
}

# ── 2. Defender exclusions ────────────────────────────────────────────────────────────────────
try {
  # The Bun package download cache sits on the workspace's drive (`<drive>:\bun-install-cache`,
  # set by .github/actions/setup-nimbus-ci so node_modules can hard-link out of it); bun.exe itself
  # is still installed under the profile's `.bun`.
  $bunCache = (Split-Path -Qualifier $env:GITHUB_WORKSPACE) + '\bun-install-cache'
  $paths = @($env:GITHUB_WORKSPACE, (Join-Path $env:USERPROFILE '.bun'), $bunCache)
  if ($null -ne $devDriveRoot) { $paths += $devDriveRoot }
  Add-MpPreference -ExclusionPath $paths
  Add-MpPreference -ExclusionProcess 'bun.exe'
  Write-Output "Defender exclusions added: $($paths -join ', '), process bun.exe"
} catch {
  Write-CiWarning 'Defender exclusions skipped' "Add-MpPreference failed: $($_.Exception.Message)"
}

exit 0
