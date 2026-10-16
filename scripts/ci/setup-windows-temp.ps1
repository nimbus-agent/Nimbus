# Windows CI only: put TEMP/TMP on the runner's local temporary disk, and stop Defender from
# scanning the paths the test suite hammers.
#
# Why: the Windows legs are dominated by temp-dir SQLite fixtures and gateway boots, and on a
# windows-2025 runner the system volume C: is the slow disk. Measured in one job (run 38961969858,
# 2026-10-16), two repetitions each:
#
#   location                        commit latency   fresh index migration   10 disk-heavy test files
#   C: default TEMP                 16 ms            1.6 s                   113 s / 105 s
#   Dev Drive VHDX on C: (#1649)    16-20 ms         1.5-1.9 s               139 s / 153 s
#   Dev Drive VHDX on D:            2.7-3.0 ms       0.3 s                   128 s / 140 s
#   plain NTFS directory on D:      1.4 ms           0.2 s                   93 s / 96 s
#
# D: is the runner's "Temporary Storage" volume and holds the checkout (`D:\a\…`). The Dev Drive
# that #1649 added lived in a VHDX on C:, so it inherited C:'s flush latency and added a virtual-disk
# layer on top: the slowest of the four for the real tests. A plain directory on the workspace's
# drive is the fastest and the simplest. The drive is DERIVED from GITHUB_WORKSPACE rather than
# hard-coded, so an image that moves the workspace keeps TEMP beside it.
#
# Defender real-time protection was OFF on the runners measured (logged below on every run), so
# the exclusions are insurance against an image that turns it on, not a measured win.
#
# FAIL-SOFT BY DESIGN. This is a performance change, not a correctness one: if any half fails, it
# emits a ::warning:: annotation and the job carries on with the default TEMP. It must never be the
# reason a job goes red.

$ErrorActionPreference = 'Stop'

function Write-CiWarning([string]$Title, [string]$Message) {
  # Annotation text must be single-line.
  $flat = ($Message -replace "`r?`n", ' ')
  Write-Output "::warning title=$Title::$flat"
}

# ── Diagnostic: is Defender real-time protection even on? ─────────────────────────────────────
try {
  $mp = Get-MpComputerStatus
  Write-Output "Defender: RealTimeProtectionEnabled=$($mp.RealTimeProtectionEnabled) AMRunningMode=$($mp.AMRunningMode)"
} catch {
  Write-Output "Defender status unavailable: $($_.Exception.Message)"
}

$drive = Split-Path -Qualifier $env:GITHUB_WORKSPACE

# ── 1. TEMP/TMP on the workspace's (local) drive ──────────────────────────────────────────────
$tmp = $null
try {
  $tmp = Join-Path "$drive\" 'nimbus-tmp'
  New-Item -ItemType Directory -Path $tmp -Force | Out-Null
  # Takes effect for every LATER step in the job, not this one.
  Add-Content -Path $env:GITHUB_ENV -Value "TEMP=$tmp"
  Add-Content -Path $env:GITHUB_ENV -Value "TMP=$tmp"
  Write-Output "TEMP/TMP -> $tmp for later steps."
} catch {
  $tmp = $null
  Write-CiWarning 'TEMP relocation skipped' "Could not create the temp directory on ${drive}: $($_.Exception.Message). TEMP stays on the default volume."
}

# ── 2. Defender exclusions ────────────────────────────────────────────────────────────────────
try {
  # The Bun package download cache sits on the workspace's drive (`<drive>:\bun-install-cache`,
  # set by .github/actions/setup-nimbus-ci so node_modules can hard-link out of it); bun.exe itself
  # is still installed under the profile's `.bun`.
  $paths = @($env:GITHUB_WORKSPACE, (Join-Path $env:USERPROFILE '.bun'), "$drive\bun-install-cache")
  if ($null -ne $tmp) { $paths += $tmp }
  Add-MpPreference -ExclusionPath $paths
  Add-MpPreference -ExclusionProcess 'bun.exe'
  Write-Output "Defender exclusions added: $($paths -join ', '), process bun.exe"
} catch {
  Write-CiWarning 'Defender exclusions skipped' "Add-MpPreference failed: $($_.Exception.Message)"
}

exit 0
