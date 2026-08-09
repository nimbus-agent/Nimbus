<#
.SYNOPSIS
  Verify a WINGET_PAT candidate has the scopes the winget publish path actually needs.

.DESCRIPTION
  WINGET_PAT is the one human-owned classic PAT in the release path (see
  docs/ci-secrets.md). It must carry BOTH `public_repo` and `workflow`:

    public_repo  fork microsoft/winget-pkgs, push to the fork, open the PR
    workflow     replay upstream commits that touch .github/workflows/ when
                 syncing the fork — GitHub refuses those writes without it

  A `public_repo`-only token authenticates fine, probes healthy, and publishes
  correctly right up until winget-pkgs next commits a workflow file, after which
  EVERY release fails with wingetcreate's opaque "The forked repository could not
  be synced with the upstream commits". That is what froze the published winget
  manifest at 1.19.1 from v1.20.0 through v1.26.0 in 2026-08.

  This script checks the token BEFORE you find out the hard way. It is read-only
  unless you pass -Sync. It never prints the token and never puts it in a URL.

.PARAMETER Token
  The PAT. Omit it and the script reads $env:WINGET_PAT, or prompts (no echo).

.PARAMETER Sync
  Also sync the token owner's winget-pkgs fork with upstream — the exact
  operation that fails when `workflow` is missing, and the manual remediation
  when it has already failed. This is the only write this script performs.

.PARAMETER Upstream
  Upstream repo to compare/sync against (default: microsoft/winget-pkgs).

.NOTES
  Exit codes:
    0  token authenticates and holds every required scope
    1  token is dead, or a required scope is missing
    2  usage error / network unreachable

  Store a good token with:  gh secret set WINGET_PAT --repo nimbus-agent/Nimbus
  (no value argument — gh prompts, keeping it out of your shell history).
#>
[CmdletBinding()]
param(
  [string]$Token = "",
  [switch]$Sync,
  [string]$Upstream = "microsoft/winget-pkgs"
)

$ErrorActionPreference = "Stop"

# ---- Token intake (never echoed, never interpolated into a URL) -------------
if (-not $Token) { $Token = $env:WINGET_PAT }
if (-not $Token) {
  $secure = Read-Host -AsSecureString "Paste the WINGET_PAT candidate"
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { $Token = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}
if (-not $Token) {
  Write-Output "usage: no token supplied (-Token, `$env:WINGET_PAT, or the prompt)"
  exit 2
}

function Invoke-GhApi {
  param(
    [Parameter(Mandatory)][string]$Path,
    [string]$Method = "GET",
    [hashtable]$Body = $null
  )
  $params = @{
    Uri              = "https://api.github.com$Path"
    Method           = $Method
    Headers          = @{
      Authorization          = "Bearer $Token"
      Accept                 = "application/vnd.github+json"
      "X-GitHub-Api-Version" = "2022-11-28"
      "User-Agent"           = "nimbus-check-winget-pat"
    }
    UseBasicParsing  = $true
    ErrorAction      = "Stop"
  }
  if ($null -ne $Body) {
    $params.Body = ($Body | ConvertTo-Json -Compress)
    $params.ContentType = "application/json"
  }
  try {
    $r = Invoke-WebRequest @params
    return [pscustomobject]@{
      Ok      = $true
      Status  = [int]$r.StatusCode
      Headers = $r.Headers
      Json    = ($r.Content | ConvertFrom-Json)
    }
  } catch {
    $resp = $_.Exception.Response
    $status = if ($null -ne $resp) { [int]$resp.StatusCode } else { 0 }
    return [pscustomobject]@{ Ok = $false; Status = $status; Headers = $null; Json = $null }
  }
}

# ---- 1. Does it authenticate at all? ---------------------------------------
$me = Invoke-GhApi -Path "/user"
if (-not $me.Ok) {
  if ($me.Status -eq 401) {
    Write-Output "FAIL  the API rejected this token (401) — it is revoked, expired, or mistyped."
    exit 1
  }
  Write-Output "ERROR could not reach api.github.com (status $($me.Status)). Network or proxy problem, token unproven."
  exit 2
}
$login = $me.Json.login
Write-Output "authenticates as: $login"

# ---- 2. Scopes -------------------------------------------------------------
# x-oauth-scopes reports what was literally ticked. `repo` SUBSUMES `public_repo`
# but is reported as `repo` alone, so it is functionally sufficient while failing
# a literal-membership check — called out below rather than silently accepted.
$raw = $me.Headers["x-oauth-scopes"]
if ($raw -is [array]) { $raw = $raw -join "," }
$have = @($raw -split "," | ForEach-Object { $_.Trim() } | Where-Object { $_ })
Write-Output "scopes: $(if ($have.Count) { $have -join ', ' } else { '(none — this is a fine-grained token, not a classic PAT)' })"

$hasWorkflow = $have -contains "workflow"
$hasPublic = $have -contains "public_repo"
$hasRepo = $have -contains "repo"
$failed = $false

if ($hasPublic) {
  Write-Output "  OK    public_repo — can fork winget-pkgs and open the PR"
} elseif ($hasRepo) {
  Write-Output "  WARN  repo (not public_repo) — functionally sufficient, but BROADER than needed, and"
  Write-Output "        scripts/release/check-secret-health.ts matches the literal string 'public_repo',"
  Write-Output "        so the weekly health report will call this token 'insufficient'. Prefer re-issuing"
  Write-Output "        with public_repo only."
} else {
  Write-Output "  FAIL  no public_repo (nor repo) — cannot fork winget-pkgs or open the submission PR"
  $failed = $true
}

if ($hasWorkflow) {
  Write-Output "  OK    workflow — can sync the fork across upstream .github/workflows/ commits"
} else {
  Write-Output "  FAIL  no workflow — THIS is the scope that broke winget publishing. The token will"
  Write-Output "        work until winget-pkgs next commits a workflow file, then fail every release."
  $failed = $true
}

$extra = @($have | Where-Object { $_ -notin @("public_repo", "repo", "workflow") })
if ($extra.Count) {
  Write-Output "  NOTE  also grants: $($extra -join ', ') — broader than this credential needs."
}

# ---- 3. Fork reachability (and, with -Sync, the real thing) -----------------
$fork = "$login/winget-pkgs"
$forkRes = Invoke-GhApi -Path "/repos/$fork"
if (-not $forkRes.Ok) {
  Write-Output "fork: none at $fork — wingetcreate creates it on the first-ever submission. Not an error."
} else {
  $branch = $forkRes.Json.default_branch
  $cmp = Invoke-GhApi -Path "/repos/$Upstream/compare/master...${login}:winget-pkgs:${branch}?per_page=1"
  if ($cmp.Ok) {
    Write-Output "fork: $fork ($branch) is $($cmp.Json.status) — $($cmp.Json.behind_by) behind, $($cmp.Json.ahead_by) ahead of $Upstream"
    if ($cmp.Json.ahead_by -gt 0) {
      Write-Output "  NOTE  the fork carries commits upstream does not have; a fast-forward sync will not apply."
    }
  }
  if ($Sync) {
    $merge = Invoke-GhApi -Path "/repos/$fork/merge-upstream" -Method "POST" -Body @{ branch = $branch }
    if ($merge.Ok) {
      Write-Output "sync: $($merge.Json.message)"
    } else {
      Write-Output "sync: FAILED (status $($merge.Status)) — with 'workflow' absent this is the expected"
      Write-Output "      outcome once the pending delta contains a .github/workflows/ change."
      $failed = $true
    }
  }
}

if ($failed) {
  Write-Output ""
  Write-Output "VERDICT: unusable as WINGET_PAT. Re-issue a CLASSIC token with public_repo + workflow"
  Write-Output "         at https://github.com/settings/tokens/new (see docs/ci-secrets.md)."
  exit 1
}
Write-Output ""
Write-Output "VERDICT: usable as WINGET_PAT."
exit 0
