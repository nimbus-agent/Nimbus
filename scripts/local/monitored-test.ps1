# Run a scoped bun test while sampling CPU / memory / disk so we never blindly melt the box.
# Usage: pwsh -NoProfile -File monitored-test.ps1 -TestArgs "packages/gateway/test/.../foo.test.ts"
param(
  [Parameter(Mandatory = $true)][string]$TestArgs,
  [int]$SampleMs = 1500,
  [int]$AbortMemPct = 92   # if committed memory stays above this, abort the run to protect the box
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)  # repo root (scripts/local -> repo)
Push-Location $root

$totalMemKB = (Get-CimInstance Win32_OperatingSystem).TotalVisibleMemorySize
Write-Host "=== monitored-test: bun test $TestArgs ===" -ForegroundColor Cyan
Write-Host "Total RAM: $([math]::Round($totalMemKB/1MB,1)) GB  | abort if mem > $AbortMemPct% sustained" -ForegroundColor DarkGray

$bunArgs = @("test") + ($TestArgs -split '\s+' | Where-Object { $_ -ne "" })
$psi = Start-Process -FilePath "bun" -ArgumentList $bunArgs -PassThru -NoNewWindow
$startTime = Get-Date
$highMemStreak = 0
$peakMemPct = 0
$peakBunMB = 0

while (-not $psi.HasExited) {
  Start-Sleep -Milliseconds $SampleMs
  $os = Get-CimInstance Win32_OperatingSystem
  $usedPct = [math]::Round(100 * ($os.TotalVisibleMemorySize - $os.FreePhysicalMemory) / $os.TotalVisibleMemorySize, 1)
  $bun = (Get-Process bun -ErrorAction SilentlyContinue | Measure-Object WorkingSet64 -Sum).Sum
  $bunMB = if ($bun) { [math]::Round($bun / 1MB, 0) } else { 0 }
  $bunCount = (Get-Process bun -ErrorAction SilentlyContinue | Measure-Object).Count
  if ($usedPct -gt $peakMemPct) { $peakMemPct = $usedPct }
  if ($bunMB -gt $peakBunMB) { $peakBunMB = $bunMB }
  $elapsed = [math]::Round(((Get-Date) - $startTime).TotalSeconds, 0)
  Write-Host ("[{0,4}s] mem {1,5}% | bun procs {2,2} | bun RSS {3,6} MB" -f $elapsed, $usedPct, $bunCount, $bunMB)
  if ($usedPct -ge $AbortMemPct) {
    $highMemStreak++
    if ($highMemStreak -ge 4) {
      Write-Host "ABORT: memory above $AbortMemPct% for 4 samples — killing test to protect the machine." -ForegroundColor Red
      Stop-Process -Id $psi.Id -Force -ErrorAction SilentlyContinue
      Get-Process bun -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
      Pop-Location
      exit 99
    }
  } else { $highMemStreak = 0 }
}

$psi.WaitForExit()
$dur = [math]::Round(((Get-Date) - $startTime).TotalSeconds, 1)
Write-Host ("=== done in {0}s | exit {1} | peak mem {2}% | peak bun RSS {3} MB ===" -f $dur, $psi.ExitCode, $peakMemPct, $peakBunMB) -ForegroundColor Cyan
Pop-Location
exit $psi.ExitCode
