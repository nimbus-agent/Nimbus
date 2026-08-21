<#
.SYNOPSIS
  Decide whether a stored Google OAuth refresh token is rejected by Google itself,
  or only by Nimbus.

.DESCRIPTION
  Nimbus reports `Token exchange failed (invalid_grant: Bad Request)` on
  `nimbus connector sync gmail`, while `nimbus connector auth gmail` reports
  "Verified". Those two exercise different credentials: auth validates the
  freshly-exchanged ACCESS token in memory and never touches the refresh path.

  This script takes the stored REFRESH token and presents it to Google directly,
  outside Nimbus, with the same client credentials Nimbus would use. That
  separates two very different diagnoses:

    GOOGLE REJECTS IT  -> the stored credential genuinely cannot refresh. The
                          Nimbus bug is upstream: `connector auth` reported
                          success for a token that was never usable.
                          Remedy: revoke at https://myaccount.google.com/permissions
                          then re-run `nimbus connector auth gmail`.

    GOOGLE ACCEPTS IT  -> the credential is fine and Nimbus is sending something
                          different (wrong client_id, or resolving a different
                          vault key). That is a Nimbus bug worth instrumenting.

  SECRETS: no token, secret or client id is ever printed. Only lengths,
  fingerprints (SHA-256 prefix) and Google's verdict are shown.

.PARAMETER Key
  Vault key to test. Defaults to google_gmail.oauth (what `gmail` resolves to
  via GOOGLE_SERVICE_VAULT_KEYS in connectors/connector-vault.ts).

.PARAMETER RefreshToken
  Supply the refresh token directly and skip reading the vault. Use when the
  `nimbus vault get` confirm prompt cannot be automated.

.PARAMETER All
  Test every Google OAuth vault key, not just one. Useful because the shared
  `google.oauth` and the per-service keys can hold different payloads.

.EXAMPLE
  ./test-google-oauth-refresh.ps1
.EXAMPLE
  ./test-google-oauth-refresh.ps1 -All
.EXAMPLE
  ./test-google-oauth-refresh.ps1 -RefreshToken '1//0g...'
#>
[CmdletBinding()]
param(
  [string] $Key = 'google_gmail.oauth',
  [string] $RefreshToken,
  [switch] $All
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ALL_GOOGLE_KEYS = @(
  'google.oauth',
  'google_drive.oauth',
  'google_gmail.oauth',
  'google_photos.oauth',
  'google_meet.oauth'
)

function Write-Head([string] $Text) {
  Write-Host ''
  Write-Host $Text -ForegroundColor Cyan
  Write-Host ('-' * $Text.Length) -ForegroundColor DarkGray
}

# A stable, non-reversible handle so two payloads can be compared without
# either being displayed.
function Get-Fingerprint([string] $Value) {
  if ([string]::IsNullOrEmpty($Value)) { return '(empty)' }
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Value))
  } finally {
    $sha.Dispose()
  }
  return ([System.BitConverter]::ToString($bytes) -replace '-', '').Substring(0, 12).ToLower()
}

# `nimbus vault get` gates on a @clack/prompts confirm ("Secrets echo to this
# terminal. Continue?") with no --yes flag, so feed it a keypress. Clack reads
# raw input and a pipe does not always satisfy it; the caller can fall back to
# -RefreshToken. Returns $null rather than throwing so -All can continue.
function Read-VaultPayload([string] $VaultKey) {
  try {
    $raw = 'y' | & nimbus vault get $VaultKey 2>&1 | Out-String
  } catch {
    Write-Host "  could not invoke nimbus: $($_.Exception.Message)" -ForegroundColor Yellow
    return $null
  }
  if ([string]::IsNullOrWhiteSpace($raw)) { return $null }

  # The payload is a JSON object somewhere in clack's decorated output.
  $match = [regex]::Match($raw, '\{.*\}', [System.Text.RegularExpressions.RegexOptions]::Singleline)
  if (-not $match.Success) {
    if ($raw -match '\(not set\)') { Write-Host '  vault key is not set' -ForegroundColor Yellow }
    else { Write-Host '  could not read a JSON payload (confirm prompt may not have been satisfied)' -ForegroundColor Yellow }
    return $null
  }
  try {
    return $match.Value | ConvertFrom-Json
  } catch {
    Write-Host '  vault payload is not valid JSON' -ForegroundColor Yellow
    return $null
  }
}

function Show-PayloadFacts($Payload, [string] $VaultKey) {
  $hasRefresh = $false
  $refresh = ''
  if ($Payload.PSObject.Properties.Name -contains 'refreshToken') {
    $refresh = [string] $Payload.refreshToken
    $hasRefresh = -not [string]::IsNullOrEmpty($refresh)
  }

  $expiresAt = 0
  if ($Payload.PSObject.Properties.Name -contains 'expiresAt') {
    $expiresAt = [int64] $Payload.expiresAt
  }

  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $deltaMin = [math]::Round(($expiresAt - $now) / 60000, 1)

  Write-Host ("  key              : {0}" -f $VaultKey)
  Write-Host ("  refreshToken     : {0}{1}" -f `
    $(if ($hasRefresh) { 'present' } else { 'MISSING / EMPTY' }), `
    $(if ($hasRefresh) { " (len $($refresh.Length), fp $(Get-Fingerprint $refresh))" } else { '' })) `
    -ForegroundColor $(if ($hasRefresh) { 'Green' } else { 'Red' })

  if ($expiresAt -gt 0) {
    $state = if ($deltaMin -gt 2) { 'valid' } else { 'expired / inside the 120s refresh margin' }
    $colour = if ($deltaMin -gt 2) { 'Green' } else { 'Yellow' }
    Write-Host ("  expiresAt        : {0} ({1:+0.0;-0.0} min -> {2})" -f $expiresAt, $deltaMin, $state) -ForegroundColor $colour
    if ($deltaMin -gt 2) {
      Write-Host '                     Nimbus should NOT refresh with this expiry' -ForegroundColor DarkGray
      Write-Host '                     (oauth-registry.ts:615, REFRESH_MARGIN_MS = 120000)' -ForegroundColor DarkGray
    }
  } else {
    Write-Host '  expiresAt        : MISSING' -ForegroundColor Red
  }

  if ($Payload.PSObject.Properties.Name -contains 'scopes') {
    Write-Host ("  scopes           : {0}" -f ($Payload.scopes -join ', '))
  }
  return $refresh
}

# Presents the refresh token to Google exactly as a refresh_token grant.
# Returns a hashtable: Ok, Error, Description.
function Invoke-GoogleRefresh([string] $Refresh, [string] $ClientId, [string] $ClientSecret) {
  $form = @{
    client_id     = $ClientId
    grant_type    = 'refresh_token'
    refresh_token = $Refresh
  }
  if (-not [string]::IsNullOrEmpty($ClientSecret)) { $form['client_secret'] = $ClientSecret }

  $body = ($form.GetEnumerator() | ForEach-Object {
      '{0}={1}' -f [uri]::EscapeDataString($_.Key), [uri]::EscapeDataString([string] $_.Value)
    }) -join '&'

  try {
    $resp = Invoke-WebRequest -Uri 'https://oauth2.googleapis.com/token' `
      -Method Post -Body $body `
      -ContentType 'application/x-www-form-urlencoded' `
      -UseBasicParsing
    $json = $resp.Content | ConvertFrom-Json
    return @{ Ok = $true; Error = ''; Description = ''; ExpiresIn = $json.expires_in }
  } catch {
    # Google returns the error document in the response body on 4xx. Where it
    # is available PowerShell exposes it as ErrorDetails.Message.
    $detail = ''
    if ($_.PSObject.Properties.Name -contains 'ErrorDetails' -and $null -ne $_.ErrorDetails) {
      $detail = [string] $_.ErrorDetails.Message
    }
    if ([string]::IsNullOrWhiteSpace($detail) -and $null -ne $_.Exception.Response) {
      try {
        $stream = $_.Exception.Response.GetResponseStream()
        $reader = New-Object System.IO.StreamReader($stream)
        $detail = $reader.ReadToEnd()
        $reader.Dispose()
      } catch { $detail = '' }
    }
    $err = 'unknown'; $desc = ''
    if (-not [string]::IsNullOrWhiteSpace($detail)) {
      try {
        $j = $detail | ConvertFrom-Json
        if ($j.PSObject.Properties.Name -contains 'error') { $err = [string] $j.error }
        if ($j.PSObject.Properties.Name -contains 'error_description') { $desc = [string] $j.error_description }
      } catch { $desc = $detail.Trim() }
    } else {
      $desc = $_.Exception.Message
    }
    return @{ Ok = $false; Error = $err; Description = $desc; ExpiresIn = 0 }
  }
}

# ---------------------------------------------------------------------------

Write-Head 'Google OAuth refresh probe'
Write-Host 'Presents the STORED refresh token to Google directly, bypassing Nimbus.' -ForegroundColor DarkGray
Write-Host 'No secret is printed.' -ForegroundColor DarkGray

$clientId = $env:NIMBUS_OAUTH_GOOGLE_CLIENT_ID
$clientSecret = $env:NIMBUS_OAUTH_GOOGLE_CLIENT_SECRET

Write-Head 'Client credentials (from environment)'
if ([string]::IsNullOrEmpty($clientId)) {
  Write-Host '  NIMBUS_OAUTH_GOOGLE_CLIENT_ID : MISSING' -ForegroundColor Red
  Write-Host ''
  Write-Host 'Cannot probe without a client id. Set it and re-run.' -ForegroundColor Red
  exit 2
}
Write-Host ("  NIMBUS_OAUTH_GOOGLE_CLIENT_ID     : set (len {0}, fp {1})" -f $clientId.Length, (Get-Fingerprint $clientId)) -ForegroundColor Green
if ([string]::IsNullOrEmpty($clientSecret)) {
  Write-Host '  NIMBUS_OAUTH_GOOGLE_CLIENT_SECRET : not set' -ForegroundColor Yellow
  Write-Host '                                      Web OAuth clients REQUIRE this on refresh.' -ForegroundColor DarkGray
} else {
  Write-Host ("  NIMBUS_OAUTH_GOOGLE_CLIENT_SECRET : set (len {0}, fp {1})" -f $clientSecret.Length, (Get-Fingerprint $clientSecret)) -ForegroundColor Green
}

$keysToTest = if ($All) { $ALL_GOOGLE_KEYS } else { @($Key) }
$results = @()

foreach ($k in $keysToTest) {
  Write-Head ("Vault payload: {0}" -f $k)

  $refresh = ''
  if (-not [string]::IsNullOrEmpty($RefreshToken)) {
    Write-Host '  (using -RefreshToken; vault not read)' -ForegroundColor DarkGray
    $refresh = $RefreshToken
    Write-Host ("  refreshToken     : present (len {0}, fp {1})" -f $refresh.Length, (Get-Fingerprint $refresh)) -ForegroundColor Green
  } else {
    $payload = Read-VaultPayload $k
    if ($null -eq $payload) {
      Write-Host '  skipped' -ForegroundColor Yellow
      $results += [pscustomobject]@{ Key = $k; Verdict = 'unreadable'; Detail = 'vault payload not read' }
      continue
    }
    $refresh = Show-PayloadFacts $payload $k
  }

  if ([string]::IsNullOrEmpty($refresh)) {
    Write-Host '  -> no refresh token to probe' -ForegroundColor Red
    $results += [pscustomobject]@{ Key = $k; Verdict = 'no-refresh-token'; Detail = 'stored payload has an empty refreshToken' }
    continue
  }

  Write-Host ''
  Write-Host '  probing https://oauth2.googleapis.com/token ...' -ForegroundColor DarkGray
  $r = Invoke-GoogleRefresh -Refresh $refresh -ClientId $clientId -ClientSecret $clientSecret

  if ($r.Ok) {
    Write-Host ("  GOOGLE ACCEPTS IT — new access token issued (expires_in {0}s)" -f $r.ExpiresIn) -ForegroundColor Green
    $results += [pscustomobject]@{ Key = $k; Verdict = 'google-accepts'; Detail = "expires_in $($r.ExpiresIn)" }
  } else {
    $msg = if ([string]::IsNullOrWhiteSpace($r.Description)) { $r.Error } else { "$($r.Error): $($r.Description)" }
    Write-Host ("  GOOGLE REJECTS IT — {0}" -f $msg) -ForegroundColor Red
    $results += [pscustomobject]@{ Key = $k; Verdict = 'google-rejects'; Detail = $msg }
  }

  if (-not [string]::IsNullOrEmpty($RefreshToken)) { break }
}

Write-Head 'Verdict'
$results | Format-Table -AutoSize | Out-String | Write-Host

$accepted = @($results | Where-Object { $_.Verdict -eq 'google-accepts' })
$rejected = @($results | Where-Object { $_.Verdict -eq 'google-rejects' })

if ($accepted.Count -gt 0) {
  Write-Host 'Google ACCEPTS the stored refresh token.' -ForegroundColor Green
  Write-Host ''
  Write-Host 'The credential is fine — so Nimbus is sending something different:' -ForegroundColor White
  Write-Host '  * a different client_id than the one in this environment, or'
  Write-Host '  * a different vault key than the one probed here, or'
  Write-Host '  * a refresh it should not be running at all (a valid expiresAt should'
  Write-Host '    short-circuit at oauth-registry.ts:615).'
  Write-Host ''
  Write-Host 'This is a Nimbus bug. Next step is to instrument the refresh call —' -ForegroundColor White
  Write-Host 'the OAuth path currently logs nothing (audit finding F10).'
  exit 0
}

if ($rejected.Count -gt 0) {
  Write-Host 'Google REJECTS the stored refresh token.' -ForegroundColor Red
  Write-Host ''
  Write-Host 'The stored credential genuinely cannot refresh. `nimbus connector auth`' -ForegroundColor White
  Write-Host 'reported "Verified" for a token that was never usable — it validates the'
  Write-Host 'freshly-exchanged ACCESS token in memory and never exercises the refresh path.'
  Write-Host ''
  Write-Host 'Remedy:' -ForegroundColor White
  Write-Host '  1. https://myaccount.google.com/permissions  ->  Nimbus  ->  Remove access'
  Write-Host '  2. nimbus connector auth gmail'
  Write-Host '  3. nimbus connector sync gmail --force'
  Write-Host ''
  Write-Host 'A plain re-auth without the revoke usually reuses the existing grant and'
  Write-Host 'does not mint a fresh refresh token, which is why re-running auth alone'
  Write-Host 'has not helped.'
  exit 1
}

Write-Host 'Inconclusive — no payload could be read.' -ForegroundColor Yellow
Write-Host ''
Write-Host 'The `nimbus vault get` confirm prompt likely was not satisfied by the piped'
Write-Host 'keypress. Read it manually and pass the token in:'
Write-Host ''
Write-Host '  nimbus vault get google_gmail.oauth'
Write-Host "  ./test-google-oauth-refresh.ps1 -RefreshToken '<refreshToken value>'"
exit 3
