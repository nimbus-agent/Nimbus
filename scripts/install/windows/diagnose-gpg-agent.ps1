<#
.SYNOPSIS
  TEMPORARY diagnostic for the `windows-2022 documented one-liner` failure.

.DESCRIPTION
  install.ps1 runs its keyring import as

      & gpg --homedir $sigHomeName --quiet --import $keyPath *>$null

  so when gpg fails, the ONLY thing CI ever sees is the generic PowerShell
  NativeCommandError wrapper:

      gpg.exe : gpg: error running '/usr/bin/gpg-agent': exit status 2

  The agent's own message -- the part that actually names the cause -- is
  swallowed by `*>$null`. This script exists to make the runner say it out
  loud, once, so a root cause can be proven instead of guessed.

  It is deliberately READ-ONLY with respect to the installed product: it never
  edits install.ps1 on disk and never changes what gets installed. It only
  observes, plus (optionally) re-runs the published installer with the output
  redirection removed in memory.

  EVERY native probe goes through Invoke-Probe, which runs the command via
  Start-Process with both streams redirected to FILES and a hard timeout.
  That is not defensive padding, it is required: `gpg-agent --daemon` forks
  and the daemon child INHERITS the parent's stdout/stderr pipe, so the
  ordinary PowerShell form

      & gpg-agent --homedir X --daemon 2>&1

  blocks until the daemon itself dies -- i.e. forever on the success path.
  Verified by hanging exactly that way on a local Windows box while writing
  this. In CI it would eat the job's 20-minute timeout and emit nothing,
  which is the opposite of the point.

  DELETE THIS FILE, its workflow steps, and the `diagnostics` /
  `skip_harden_runner` dispatch inputs once the cause is proven. It is not a
  product surface and nothing may come to depend on it.

.PARAMETER Label
  Free-text tag printed in every section header, so several invocations of
  this script in one job (one per shell) are trivially distinguishable.

.PARAMETER RunPatchedInstaller
  Re-run the PUBLISHED install.ps1 with the `*>$null` on the import line
  removed in memory, so gpg's real stderr reaches the log on the true code
  path rather than a hand-built approximation of it.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Label,
  [switch]$RunPatchedInstaller
)

# Never abort the diagnostic on the first failing probe -- a probe FAILING is
# the evidence we came for. Every section reports its own exit code instead.
$ErrorActionPreference = "Continue"
$ProgressPreference = "SilentlyContinue"

$script:ProbeDir = Join-Path ([System.IO.Path]::GetTempPath()) ("diagprobe-" + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $script:ProbeDir -Force | Out-Null
$script:ProbeSeq = 0

function Write-Section {
  param([string]$Title)
  Write-Host ""
  Write-Host "===== [$Label] $Title ====="
}

function Read-ProbeFile {
  # The redirect targets can still be held open by a daemonised child, so a
  # plain Get-Content (which opens for exclusive-ish read) can fail. Open with
  # a fully permissive share mode instead.
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return @() }
  try {
    $fs = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    try {
      $sr = New-Object System.IO.StreamReader($fs)
      try { return ($sr.ReadToEnd() -split "`r?`n") } finally { $sr.Dispose() }
    } finally { $fs.Dispose() }
  } catch {
    return @("<could not read $Path : $($_.Exception.Message)>")
  }
}

function Invoke-Probe {
  <#
    Runs a native command with a hard timeout, printing both streams. Returns
    nothing useful -- it is here to make the runner talk, not to be composed.
  #>
  param(
    [string]$Exe,
    [string[]]$Arguments,
    [int]$TimeoutSeconds = 25,
    [string]$WorkingDirectory
  )
  $script:ProbeSeq++
  $outFile = Join-Path $script:ProbeDir "p$($script:ProbeSeq).out"
  $errFile = Join-Path $script:ProbeDir "p$($script:ProbeSeq).err"
  Write-Host "`$ $Exe $($Arguments -join ' ')"

  $startArgs = @{
    FilePath               = $Exe
    NoNewWindow            = $true
    PassThru               = $true
    RedirectStandardOutput = $outFile
    RedirectStandardError  = $errFile
  }
  if ($Arguments -and $Arguments.Count -gt 0) { $startArgs.ArgumentList = $Arguments }
  if ($WorkingDirectory) { $startArgs.WorkingDirectory = $WorkingDirectory }

  $proc = $null
  try {
    $proc = Start-Process @startArgs
  } catch {
    Write-Host "  !! could not start '$Exe': $($_.Exception.Message)"
    return
  }
  # Touching .Handle caches the native handle in the Process object. Without
  # it, .ExitCode reads back EMPTY once the process has gone -- observed
  # exactly that on the first local run of this script, where every probe
  # printed a bare "exit=".
  try { $null = $proc.Handle } catch { }
  $exited = $proc.WaitForExit($TimeoutSeconds * 1000)
  if (-not $exited) {
    # Reaching here on `gpg-agent --daemon --no-detach` means the agent
    # STARTED FINE and is now serving -- a success signal, not a fault.
    Write-Host "  (still running after ${TimeoutSeconds}s -- killing; for a --no-detach agent this means it started OK)"
    try { $proc.Kill() } catch { }
  }
  foreach ($line in (Read-ProbeFile $outFile)) { if ($line -ne "") { Write-Host "  | $line" } }
  foreach ($line in (Read-ProbeFile $errFile)) { if ($line -ne "") { Write-Host "  ! $line" } }
  if ($exited) { Write-Host "  -> exit=$($proc.ExitCode)" } else { Write-Host "  -> exit=<timeout>" }
}

function Show-AgentProcesses {
  param([string]$When)
  Write-Host "-- gpg-agent processes ($When) --"
  # Win32_Process gives the COMMAND LINE, which is what identifies which
  # --homedir a lingering agent belongs to. Get-Process cannot show that, and
  # the homedir is the whole question here.
  $procs = @(Get-CimInstance Win32_Process -Filter "Name='gpg-agent.exe'" -ErrorAction SilentlyContinue)
  if ($procs.Count -eq 0) {
    Write-Host "  (none)"
    return
  }
  foreach ($p in $procs) { Write-Host "  pid=$($p.ProcessId) cmd=$($p.CommandLine)" }
}

function New-InstallerShapedWorkDir {
  # Identical construction to install.ps1's `$work` (Join-Path GetTempPath()
  # "nimbus-<guid>") and its `$sigHome` ($work\gnupg-sig), so every path length
  # printed is the REAL one rather than an approximation. Reconstructing this
  # shape by hand is how an earlier pass mis-measured the socket length.
  $w = Join-Path ([System.IO.Path]::GetTempPath()) ("nimbus-" + [Guid]::NewGuid())
  New-Item -ItemType Directory -Path $w -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $w "gnupg-sig") -Force | Out-Null
  return $w
}

$sigHomeName = "gnupg-sig"

Write-Section "shell + environment"
Write-Host "PSVersion        = $($PSVersionTable.PSVersion)"
Write-Host "PSEdition        = $($PSVersionTable.PSEdition)"
Write-Host "GetTempPath()    = [$([System.IO.Path]::GetTempPath())]"
Write-Host "env:TEMP         = [$env:TEMP]"
Write-Host "env:TMP          = [$env:TMP]"
Write-Host "env:RUNNER_TEMP  = [$env:RUNNER_TEMP]"
Write-Host "env:GNUPGHOME    = [$env:GNUPGHOME]"
Write-Host "env:USERPROFILE  = [$env:USERPROFILE]"
Write-Host "Get-Location     = $((Get-Location).Path)"
Write-Host "Environment.CurrentDirectory = $([Environment]::CurrentDirectory)"

Write-Section "which gpg wins on PATH"
foreach ($c in @(Get-Command gpg -All -ErrorAction SilentlyContinue)) { Write-Host "  gpg       -> $($c.Source)" }
foreach ($c in @(Get-Command gpg-agent -All -ErrorAction SilentlyContinue)) { Write-Host "  gpg-agent -> $($c.Source)" }
foreach ($c in @(Get-Command gpgconf -All -ErrorAction SilentlyContinue)) { Write-Host "  gpgconf   -> $($c.Source)" }
Invoke-Probe -Exe "gpg" -Arguments @("--version")
# socketdir decides whether two different --homedir values can collide on one
# agent socket. It is the most load-bearing line in this whole dump.
Invoke-Probe -Exe "gpgconf" -Arguments @("--list-dirs")

Write-Section "pre-existing state"
Show-AgentProcesses -When "before"
Write-Host "-- leftover installer work dirs in temp --"
# Match install.ps1's guid shape specifically. A `nimbus-*` filter -- even
# `nimbus-*-*-*-*-*` -- also sweeps up this repo's own test scratch dirs
# (nimbus-hitl-e2e-iac-tf-XXXX has five dashes too) and buries the signal in
# hundreds of lines; measured locally before tightening this.
$leftovers = @(Get-ChildItem -Path ([System.IO.Path]::GetTempPath()) -Directory -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match '^nimbus-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' })
if ($leftovers.Count -eq 0) { Write-Host "  (none)" }
foreach ($d in $leftovers) { Write-Host "  $($d.FullName)" }

Write-Section "work dir + socket path (install.ps1's exact shape)"
$work = New-InstallerShapedWorkDir
$sigHome = Join-Path $work $sigHomeName
Write-Host "workdir  = $work (len=$($work.Length))"
Write-Host "homedir  = $sigHome (len=$($sigHome.Length))"
$cygpath = Get-Command cygpath -ErrorAction SilentlyContinue
if ($cygpath) {
  $posix = [string](& $cygpath.Source -u $sigHome 2>&1 | Select-Object -First 1)
  Write-Host "cygpath -u homedir = $posix (len=$($posix.Length))"
  $sock = "$posix/S.gpg-agent"
  # AF_UNIX sun_path is 108 bytes including the NUL, so the practical ceiling
  # is 107 characters. Print the number; do not assert a guess about it.
  Write-Host "agent socket       = $sock (len=$($sock.Length), sun_path limit ~107)"
} else {
  Write-Host "cygpath not on PATH -- cannot show the MSYS-translated socket path"
}

Write-Section "spawn gpg-agent DIRECTLY (this is what install.ps1 hides)"
# --no-detach keeps the agent in the foreground so its startup diagnostics
# land in the redirect files; Invoke-Probe's timeout then reaps it. The
# relative homedir + WorkingDirectory pairing mirrors install.ps1's
# Push-Location trick (see its $sigHomeName comment and #1175).
Invoke-Probe -Exe "gpg-agent" -Arguments @("--homedir", $sigHomeName, "--daemon", "--no-detach", "--verbose") -WorkingDirectory $work -TimeoutSeconds 20
Write-Host "-- and the keyring op gpg itself performs --"
Invoke-Probe -Exe "gpg" -Arguments @("--homedir", $sigHomeName, "--list-keys") -WorkingDirectory $work
Show-AgentProcesses -When "after direct spawn"

Write-Section 'control: same spawn after "gpgconf --kill all"'
# If this succeeds where the probe above failed, a LINGERING agent from an
# earlier step is the cause and the fix belongs in install.ps1's cleanup.
Invoke-Probe -Exe "gpgconf" -Arguments @("--kill", "all")
$work2 = New-InstallerShapedWorkDir
Invoke-Probe -Exe "gpg-agent" -Arguments @("--homedir", $sigHomeName, "--daemon", "--no-detach", "--verbose") -WorkingDirectory $work2 -TimeoutSeconds 20
Invoke-Probe -Exe "gpg" -Arguments @("--homedir", $sigHomeName, "--list-keys") -WorkingDirectory $work2

if ($RunPatchedInstaller) {
  Write-Section "published install.ps1, with the *>`$null swallow removed"
  $url = "https://github.com/nimbus-agent/Nimbus/releases/latest/download/install.ps1"
  $src = (Invoke-WebRequest -Uri $url -UseBasicParsing).Content
  # Literal, non-regex replacement of the two redirections that hide gpg's
  # stderr. The Contains() check is not decoration: a silent no-op patch would
  # produce a run that looks clean and proves nothing, which is precisely the
  # failure mode this whole exercise exists to avoid.
  $importOld = '--import $keyPath *>$null'
  $importNew = '--import $keyPath'
  $verifyOld = '--verify $ascPath (Join-Path $Dir "SHA256SUMS") 2>$null'
  $verifyNew = '--verify $ascPath (Join-Path $Dir "SHA256SUMS")'
  if (-not $src.Contains($importOld)) {
    Write-Host "!! published install.ps1 no longer contains the expected import line -- the run below is UNPATCHED and proves nothing about gpg's stderr"
  }
  $patched = $src.Replace($importOld, $importNew).Replace($verifyOld, $verifyNew)
  Write-Host "patched = $($patched -ne $src)"
  try {
    & ([scriptblock]::Create($patched)) -Yes 2>&1 | ForEach-Object { Write-Host "  | $_" }
  } catch {
    Write-Host "  !! installer threw: $($_.Exception.Message)"
  }
  Show-AgentProcesses -When "after patched installer"
}

Write-Section "cleanup"
foreach ($d in @($work, $work2, $script:ProbeDir)) {
  if (-not $d) { continue }
  try {
    Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction Stop
    Write-Host "removed $d"
  } catch {
    # A failure HERE is itself a finding: it means a live gpg-agent still
    # holds a handle inside the work dir, which install.ps1's own `finally`
    # would also trip over.
    Write-Host "!! could NOT remove $d -- $($_.Exception.Message)"
  }
}
Write-Host ""
Write-Host "===== [$Label] diagnostic complete ====="
