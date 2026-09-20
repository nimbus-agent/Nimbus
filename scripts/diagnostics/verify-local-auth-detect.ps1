<#
.SYNOPSIS
  Acceptance check for `nimbus connector detect` (PR #1554, `gcloud` source PR #1557) — the
  interactive numbered pick and the consent-prompt handoff that no automated test covers.

.DESCRIPTION
  Runs the parts a script can verify on its own, then hands you the one part that needs a real
  terminal, then checks what actually landed. Prints SUCCESS or FAILURE with the specific issue.

  It uses a synthetic two-context kubeconfig in your temp directory, and only ever touches the
  `kubernetes` connector — never gh, aws or gcloud, so your GitHub token, AWS profile and gcloud
  login are not involved. No cluster is contacted: detection runs `kubectl config …` against the
  fixture file, and adoption stores a path plus a context name.

  VAULT WRITE — READ BEFORE RUNNING: this script writes `kubernetes.kubeconfig` /
  `kubernetes.context` into your REAL vault. Nimbus's configDir (which holds the vault) is
  `%APPDATA%\Nimbus`, and NO environment variable relocates it: overriding `LOCALAPPDATA` moves the
  database, logs and extensions, but NOT credentials, so that looks like a sandbox and is not one —
  there is no isolated place to run this. `nimbus --demo` is not a substitute either: a demo-rooted
  gateway refuses every `connector.*` method with `ERR_DEMO_FORBIDDEN` (invariant I41), so
  detect/adopt cannot run under it at all — do not spend an hour finding that out.

  Because of that Vault write, this script:
    - REFUSES to run at all when the `kubernetes` connector is already configured (checked via the
      detect finding's own `alreadyConfigured` flag, the same one `adopt-local-auth.ts` gates on),
      naming what is on file and telling you to remove it first. Clobbering a real credential is
      worse than not running.
    - guarantees cleanup — fixture removal, the started gateway (if any), the moved-aside dist
      binary, and (by default) the adopted connector — via a try/finally around the whole run, so
      it fires on a failed check, an unhandled error, and Ctrl-C, not only the happy path.

  `gcloud` is a fourth detect source (PR #1557, statuses `available` / `needs_project` /
  `not_logged_in` / `cli_not_found`), but most machines running this script will not have `gcloud`
  installed. A check that cannot fail must not report success: when `gcloud` is absent, this script
  SKIPS the paths it cannot exercise instead of passing them, and says so by name.

.PARAMETER Worktree
  The checkout to run the CLI from. Defaults to this repo's own root, derived from the script's own
  location ($PSScriptRoot) rather than one developer's worktree, so it works from any clone.

.PARAMETER SkipInteractive
  Run only the automated checks (detection, shapes, no-token, gcloud). Skips the pick and consent,
  which is the whole point of the manual run — useful for a quick re-check.

.PARAMETER KeepConnector
  Do not remove the kubernetes connector at the end.

.EXAMPLE
  .\verify-local-auth-detect.ps1
.EXAMPLE
  .\verify-local-auth-detect.ps1 -Worktree C:\gitrep\Nimbus -SkipInteractive
#>
#Requires -Version 5.1

[CmdletBinding()]
param(
    [string] $Worktree = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
    [switch] $SkipInteractive,
    [switch] $KeepConnector
)

$ErrorActionPreference = 'Stop'

# --- reporting -------------------------------------------------------------------------------

$script:Failures = @()
$script:Skips = @()
$script:Checks = 0
$script:AdoptionAttempted = $false
$script:Refused = $false

function Write-Head([string] $Text) {
    Write-Host ''
    Write-Host $Text -ForegroundColor Cyan
}

function Pass([string] $Step, [string] $Detail = '') {
    $script:Checks++
    Write-Host "  [PASS] $Step" -ForegroundColor Green
    if ($Detail) { Write-Host "         $Detail" -ForegroundColor DarkGray }
}

function Fail([string] $Step, [string] $Why, [string] $Fix = '') {
    $script:Checks++
    $script:Failures += [pscustomobject]@{ Step = $Step; Why = $Why; Fix = $Fix }
    Write-Host "  [FAIL] $Step" -ForegroundColor Red
    Write-Host "         $Why" -ForegroundColor Red
    if ($Fix) { Write-Host "         fix: $Fix" -ForegroundColor Yellow }
}

# For a check this machine cannot exercise (e.g. gcloud is not installed) rather than one that ran
# and failed. Counted separately in the final summary so a SKIP can never read as a PASS — a check
# that cannot fail must not report success.
function Skip([string] $Step, [string] $Why, [string] $Note = '') {
    $script:Checks++
    $script:Skips += [pscustomobject]@{ Step = $Step; Why = $Why; Note = $Note }
    Write-Host "  [SKIP] $Step" -ForegroundColor Yellow
    Write-Host "         $Why" -ForegroundColor Yellow
    if ($Note) { Write-Host "         note: $Note" -ForegroundColor DarkGray }
}

# Runs the Nimbus CLI from source and captures its output. Returns @{ Ok; Text }.
function Invoke-Nimbus([string[]] $CliArgs) {
    Push-Location $Worktree
    # PowerShell 5.1 turns a native command's stderr output — merged in via `2>&1` — into
    # ErrorRecords, and with `$ErrorActionPreference = 'Stop'` (set at script scope above) the
    # FIRST such record throws a terminating exception before `Out-String` ever runs. Left alone,
    # a single harmless warning line from `bun`/`nimbus` on stderr would turn into an unhandled
    # crash instead of the @{Ok; Text} result every caller here checks explicitly — so the merge
    # runs under a LOCAL 'Continue' override, scoped to just this one native call.
    $previousEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $text = & bun 'packages/cli/src/index.ts' @CliArgs 2>&1 | Out-String
        return @{ Ok = ($LASTEXITCODE -eq 0); Text = $text }
    } finally {
        $ErrorActionPreference = $previousEap
        Pop-Location
    }
}

# --- state we must put back ------------------------------------------------------------------

$movedDist = $null
$fixtureDir = $null
$startedGateway = $false
$previousKubeconfig = $env:KUBECONFIG

try {
    Write-Head 'Preconditions'

    if (-not (Test-Path -LiteralPath $Worktree)) {
        Fail 'worktree present' "No checkout at $Worktree" 'Pass -Worktree <path> pointing at the local-auth-detect branch.'
        throw 'preconditions'
    }
    Pass 'worktree present' $Worktree

    foreach ($bin in @('bun', 'kubectl')) {
        if (-not (Get-Command $bin -ErrorAction SilentlyContinue)) {
            Fail "$bin on PATH" "$bin was not found." "Install $bin, or open a shell where it resolves."
            throw 'preconditions'
        }
        Pass "$bin on PATH" (Get-Command $bin).Source
    }

    # A previously built binary wins over source, so a stale one would test last week's code.
    $distPath = Join-Path $Worktree 'dist\nimbus-gateway.exe'
    if (Test-Path -LiteralPath $distPath) {
        $movedDist = "$distPath.verify-aside"
        Move-Item -LiteralPath $distPath -Destination $movedDist -Force
        Pass 'stale dist binary moved aside' 'the CLI prefers dist/ over source; restored at the end'
    } else {
        Pass 'no stale dist binary' 'the CLI will run from source'
    }

    Write-Head 'Fixture'

    $fixtureDir = Join-Path $env:TEMP ('nimbus-detect-accept-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
    New-Item -ItemType Directory -Path $fixtureDir -Force | Out-Null
    $kubeconfig = Join-Path $fixtureDir 'kubeconfig.yaml'
    @'
apiVersion: v1
kind: Config
clusters:
  - name: acceptance-a
    cluster:
      server: https://127.0.0.1:6443
  - name: acceptance-b
    cluster:
      server: https://127.0.0.1:6444
users:
  - name: acceptance-user
    user: {}
contexts:
  - name: accept-alpha
    context:
      cluster: acceptance-a
      user: acceptance-user
  - name: accept-beta
    context:
      cluster: acceptance-b
      user: acceptance-user
current-context: accept-alpha
'@ | Set-Content -LiteralPath $kubeconfig -Encoding UTF8
    $env:KUBECONFIG = $kubeconfig
    Pass 'two-context kubeconfig written' $kubeconfig

    Write-Head 'Gateway'

    # Probe with the REAL call, not `nimbus status`: status prints "not running" and still exits 0,
    # so its exit code says nothing. A stale gateway.json (a pid that is no longer alive) looks
    # identical to a live gateway until something actually tries to talk to one.
    $detect = Invoke-Nimbus @('connector', 'detect', '--json', '--source', 'kubectl')

    if (-not $detect.Ok -and $detect.Text -match '(?i)gateway is not running|no state file') {
        Write-Host '  no gateway answered — starting one...' -ForegroundColor DarkGray
        $start = Invoke-Nimbus @('start')
        if (-not $start.Ok) {
            Fail 'gateway running' 'nimbus start failed.' ($start.Text.Trim())
            throw 'gateway'
        }
        $startedGateway = $true
        Pass 'gateway started' 'this script started it and will stop it at the end'
        $detect = Invoke-Nimbus @('connector', 'detect', '--json', '--source', 'kubectl')
    } else {
        Pass 'gateway answered' 'already running; left running at the end'
    }

    Write-Head 'Detection (automated)'

    if (-not $detect.Ok) {
        Fail 'detect --json runs' 'The command exited non-zero.' ($detect.Text.Trim())
        throw 'detect'
    }

    try {
        $findings = @($detect.Text | ConvertFrom-Json)
    } catch {
        Fail 'detect --json is valid JSON' 'Could not parse the output as JSON.' ($detect.Text.Trim())
        throw 'detect'
    }

    $k = $findings[0]

    # REFUSE before doing anything else that touches the connector. This script writes into the
    # REAL vault (see .DESCRIPTION) — clobbering a real credential is worse than not running, so an
    # already-configured `kubernetes` connector stops the run here rather than being overwritten.
    # `alreadyConfigured` is the same flag `adopt-local-auth.ts` itself refuses on
    # (ERR_LOCAL_AUTH_ALREADY_CONFIGURED without --replace) — this reuses that signal rather than
    # re-deriving "is it configured" independently.
    if ($k.alreadyConfigured) {
        Write-Head 'REFUSED — kubernetes connector is already configured'
        Write-Host '  Running this script would overwrite kubernetes.kubeconfig / kubernetes.context' -ForegroundColor Red
        Write-Host '  in your REAL vault. Refusing rather than clobbering a credential that might be real.' -ForegroundColor Red
        Write-Host ''
        $existing = Invoke-Nimbus @('vault', 'list', 'kubernetes')
        if ($existing.Ok -and $existing.Text.Trim()) {
            Write-Host '  Currently on file:' -ForegroundColor Yellow
            foreach ($line in ($existing.Text -split '\r?\n' | Where-Object { $_ })) {
                Write-Host "    $line" -ForegroundColor Yellow
            }
            Write-Host ''
        }
        Write-Host '  Remove it first, then re-run this script:' -ForegroundColor White
        Write-Host "      cd $Worktree; bun packages/cli/src/index.ts connector remove kubernetes --yes"
        $script:Refused = $true
        throw 'already-configured'
    }

    if ($findings.Count -ne 1 -or $findings[0].source -ne 'kubectl') {
        Fail '--source kubectl returns only kubectl' "Got $($findings.Count) finding(s): $(($findings | ForEach-Object { $_.source }) -join ', ')" 'The --source filter is not being applied.'
    } else {
        Pass '--source kubectl returns only kubectl'
    }

    if ($k.status -ne 'available') {
        Fail 'kubectl finding is available' "status=$($k.status); reason=$($k.reason)" 'kubectl could not read the fixture — check the KUBECONFIG path above.'
    } else {
        Pass 'kubectl finding is available'
    }

    $contexts = @($k.contexts)
    if ($contexts.Count -ne 2 -or $contexts -notcontains 'accept-alpha' -or $contexts -notcontains 'accept-beta') {
        Fail 'both fixture contexts detected' "contexts = [$($contexts -join ', ')]" 'Expected accept-alpha and accept-beta from the fixture.'
    } else {
        Pass 'both fixture contexts detected' 'accept-alpha, accept-beta'
    }

    if ($k.currentContext -ne 'accept-alpha') {
        Fail 'current context reported' "currentContext = $($k.currentContext)" 'Expected accept-alpha (the fixture default).'
    } else {
        Pass 'current context reported' 'accept-alpha — this is the one Enter selects'
    }

    if ($k.kubeconfig -ne $kubeconfig) {
        Fail 'kubeconfig stored verbatim' "finding said: $($k.kubeconfig)" 'The path must survive unmodified — the sync passes it straight through as KUBECONFIG.'
    } else {
        Pass 'kubeconfig path verbatim'
    }

    if ($detect.Text -match '(?i)token|secret|password') {
        Fail 'no credential material in findings' 'The JSON contains a credential-shaped word.' 'A finding must carry only names, paths and statuses.'
    } else {
        Pass 'no credential material in findings'
    }

    Write-Head 'gcloud (PR #1557 source)'

    # `gcloud` never touches the kubernetes connector or the vault-write hazard above — it is a
    # read-only `gcloud config list`. But most machines running this script (including the one this
    # was written on) do not have gcloud installed, so only ONE of its four documented statuses
    # (available / needs_project / not_logged_in / cli_not_found) is reachable here. The other three
    # are SKIPPED by name rather than silently omitted or, worse, reported as passing.
    $gcloudDetect = Invoke-Nimbus @('connector', 'detect', '--json', '--source', 'gcloud')
    if (-not $gcloudDetect.Ok) {
        Fail 'gcloud detect --json runs' 'The command exited non-zero.' ($gcloudDetect.Text.Trim())
    } else {
        $gcloudFinding = $null
        try {
            $gcloudFinding = @($gcloudDetect.Text | ConvertFrom-Json)[0]
        } catch {
            Fail 'gcloud --json is valid JSON' 'Could not parse the gcloud detect output.' ($gcloudDetect.Text.Trim())
        }

        if ($null -ne $gcloudFinding) {
            $knownStatuses = @('available', 'needs_project', 'not_logged_in', 'cli_not_found')
            if ($gcloudFinding.source -ne 'gcloud' -or $gcloudFinding.status -notin $knownStatuses) {
                Fail 'gcloud finding has a known shape' "source=$($gcloudFinding.source) status=$($gcloudFinding.status)" "Expected source=gcloud, status one of: $($knownStatuses -join ', ')"
            } else {
                Pass 'gcloud finding has a known shape' "status=$($gcloudFinding.status)"
            }

            if (-not (Get-Command gcloud -ErrorAction SilentlyContinue)) {
                if ($gcloudFinding.status -eq 'cli_not_found') {
                    Pass 'gcloud absence reports cli_not_found' 'gcloud is not on PATH on this machine'
                } else {
                    Fail 'gcloud absence reports cli_not_found' "Got status=$($gcloudFinding.status) with no gcloud on PATH." 'cli_not_found should be reported when gcloud cannot be found at all.'
                }
                Skip 'gcloud available / needs_project / not_logged_in' 'gcloud is not installed on this machine — cannot exercise the logged-in, project-selection or not-logged-in paths from here.' 'Install the gcloud CLI (and log in / out as needed) on a machine that has it, then re-run.'
            } else {
                # gcloud IS installed here: whichever of the other three statuses it reports is a
                # real exercise of that path, not a skip.
                Pass 'gcloud is installed — live status observed' "status=$($gcloudFinding.status)"
            }
        }
    }

    if ($SkipInteractive) {
        Write-Head 'Interactive step SKIPPED (-SkipInteractive)'
        Write-Host '  The numbered pick and consent prompt were not exercised.' -ForegroundColor Yellow
    } else {
        Write-Head 'Interactive step — this is the part that needs you'

        Write-Host '  A numbered list of two contexts should appear.' -ForegroundColor White
        Write-Host '  1. Type 2 and press Enter        (accept-beta — NOT the default, this matters)' -ForegroundColor White
        Write-Host '  2. Approve the consent prompt that follows' -ForegroundColor White
        Write-Host ''
        Write-Host '  Why 2 and not 1: accept-alpha is BOTH option 1 and the Enter default, so an' -ForegroundColor DarkGray
        Write-Host '  accept-alpha result proves nothing — it looks the same whether your keystroke' -ForegroundColor DarkGray
        Write-Host '  was read or silently dropped. Only a non-default pick tells them apart.' -ForegroundColor DarkGray
        Write-Host ''
        Write-Host '  What to watch for: the second prompt must accept your keystroke. If it swallows' -ForegroundColor DarkGray
        Write-Host '  the first character, hangs, or never appears, that is the defect this run exists' -ForegroundColor DarkGray
        Write-Host '  to find — note what happened; the script will still report what landed.' -ForegroundColor DarkGray
        Write-Host ''

        Push-Location $Worktree
        try {
            & bun 'packages/cli/src/index.ts' connector detect --source kubectl
            $interactiveOk = ($LASTEXITCODE -eq 0)
            $script:AdoptionAttempted = $true
        } finally {
            Pop-Location
        }

        if (-not $interactiveOk) {
            Fail 'interactive walk exits cleanly' "nimbus connector detect exited $LASTEXITCODE" 'Read the output above for the error it printed.'
        } else {
            Pass 'interactive walk exits cleanly'
        }

        # The load-bearing question: did YOUR pick take effect, or did the default win?
        # accept-alpha is both "option 1" and the Enter default, so an accept-alpha result cannot
        # distinguish "input captured" from "input ignored". Only a non-default pick can, which is
        # why this asks what the prompt actually said rather than trusting the instruction was
        # followed. Your answer is the assertion.
        Write-Host ''
        $seen = (Read-Host '  Which context did the consent prompt name? (alpha / beta)').Trim().ToLowerInvariant()
        if ($seen -like '*beta*') {
            Pass 'the non-default pick took effect' 'you chose 2 and the prompt named accept-beta'
        } elseif ($seen -like '*alpha*') {
            Fail 'the non-default pick took effect' 'The prompt named accept-alpha, which is also the Enter default.' 'If you typed 2, this is a real selector bug — report it. If you typed 1 or Enter, re-run and type 2: that is the case this check exists for.'
        } else {
            Fail 'the non-default pick took effect' "Unrecognised answer: '$seen'" 'Answer alpha or beta based on the context name in the consent prompt above.'
        }

        Write-Head 'What landed'

        $keys = Invoke-Nimbus @('vault', 'list', 'kubernetes')
        if (-not $keys.Ok) {
            Fail 'vault readable' 'nimbus vault list failed.' ($keys.Text.Trim())
        } else {
            foreach ($expected in @('kubernetes.kubeconfig', 'kubernetes.context')) {
                if ($keys.Text -match [regex]::Escape($expected)) {
                    Pass "$expected stored"
                } else {
                    Fail "$expected stored" 'The key is not in the vault.' 'Adoption did not complete — was the consent prompt approved?'
                }
            }
        }

        $after = Invoke-Nimbus @('connector', 'detect', '--json', '--source', 'kubectl')
        if ($after.Ok) {
            try {
                $afterFinding = @($after.Text | ConvertFrom-Json)[0]
                if ($afterFinding.alreadyConfigured) {
                    Pass 're-detect reports kubernetes as configured'
                } else {
                    Fail 're-detect reports kubernetes as configured' 'alreadyConfigured is still false.' 'The connector was not registered by the adoption.'
                }
            } catch {
                Fail 're-detect parses' 'Could not parse the second detect output.' ($after.Text.Trim())
            }
        }

        Write-Host ''
        Write-Host '  To confirm WHICH context was stored (the script cannot: `vault get` prompts' -ForegroundColor DarkGray
        Write-Host '  before echoing a secret), run this and expect accept-beta:' -ForegroundColor DarkGray
        Write-Host "      cd $Worktree; bun packages/cli/src/index.ts vault get kubernetes.context" -ForegroundColor DarkGray
    }
} catch {
    if ($_.Exception.Message -notin @('preconditions', 'gateway', 'detect', 'already-configured')) {
        Fail 'script completed' $_.Exception.Message 'Unexpected error — see above.'
    }
} finally {
    Write-Head 'Cleanup'

    # Only worth removing if the interactive walk actually ran — otherwise nothing was adopted and
    # a failed removal is noise that reads like a second problem.
    if ($script:AdoptionAttempted -and -not $KeepConnector) {
        $removed = Invoke-Nimbus @('connector', 'remove', 'kubernetes', '--yes')
        if ($removed.Ok) {
            Write-Host '  kubernetes connector removed (vault keys cleared)' -ForegroundColor DarkGray
        } else {
            Write-Host '  could not remove the kubernetes connector — remove it by hand:' -ForegroundColor Yellow
            Write-Host "      cd $Worktree; bun packages/cli/src/index.ts connector remove kubernetes --yes" -ForegroundColor Yellow
        }
    } elseif ($KeepConnector) {
        Write-Host '  kubernetes connector kept (-KeepConnector)' -ForegroundColor DarkGray
    }

    if ($startedGateway) {
        Invoke-Nimbus @('stop') | Out-Null
        Write-Host '  gateway stopped' -ForegroundColor DarkGray
    }

    if ($movedDist -and (Test-Path -LiteralPath $movedDist)) {
        Move-Item -LiteralPath $movedDist -Destination (Join-Path $Worktree 'dist\nimbus-gateway.exe') -Force
        Write-Host '  dist binary restored' -ForegroundColor DarkGray
    }

    if ($fixtureDir -and (Test-Path -LiteralPath $fixtureDir)) {
        Remove-Item -LiteralPath $fixtureDir -Recurse -Force -ErrorAction SilentlyContinue
        Write-Host '  fixture removed' -ForegroundColor DarkGray
    }

    $env:KUBECONFIG = $previousKubeconfig

    Write-Host ''

    if ($script:Refused) {
        Write-Host 'REFUSED — see above. Nothing was written, adopted or removed.' -ForegroundColor Red
        exit 2
    }

    # Passed / failed / skipped are reported separately so a SKIP (a check this machine cannot
    # exercise, e.g. gcloud not installed) can never be mistaken for a PASS in the headline count.
    $passedCount = $script:Checks - $script:Failures.Count - $script:Skips.Count

    if ($script:Failures.Count -eq 0) {
        Write-Host "SUCCESS — $passedCount passed, $($script:Skips.Count) skipped, 0 failed (of $($script:Checks))." -ForegroundColor Green
        if ($SkipInteractive) {
            Write-Host 'Note: the interactive pick and consent prompt were not exercised (-SkipInteractive).' -ForegroundColor Yellow
        }
        if ($script:Skips.Count -gt 0) {
            Write-Host ''
            Write-Host 'Skipped — not run, not asserted, not counted as passed:' -ForegroundColor Yellow
            foreach ($s in $script:Skips) {
                Write-Host ''
                Write-Host "  $($s.Step)" -ForegroundColor Yellow
                Write-Host "    why: $($s.Why)"
                if ($s.Note) { Write-Host "    note: $($s.Note)" }
            }
        }
        exit 0
    }

    Write-Host "FAILURE — $passedCount passed, $($script:Skips.Count) skipped, $($script:Failures.Count) failed (of $($script:Checks)):" -ForegroundColor Red
    foreach ($f in $script:Failures) {
        Write-Host ''
        Write-Host "  $($f.Step)" -ForegroundColor Red
        Write-Host "    what went wrong: $($f.Why)"
        if ($f.Fix) { Write-Host "    what to do:      $($f.Fix)" }
    }
    Write-Host ''
    exit 1
}
