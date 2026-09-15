<#
.SYNOPSIS
  Verify one deployed dsh-interconnect instance on a Windows host.

.DESCRIPTION
  Windows counterpart to scripts/verify-deployment.sh: the same checks, run on
  the host itself because Windows has no POSIX shell over ssh. Copy this file
  and scripts/probe-deployed-link.cjs to the host, then run it there.

  Checks: credential read, installed version, profile layer list, `GET /` and
  `/interconnect/link` responses, the five-frame protocol probe, the tunnel
  task, this instance's outbound peer links, and the artifact hash chain.

  Prints one PASS/FAIL line per check and exits 1 when any check fails. The
  hash chain is printed for the caller to compare with the repository build,
  because those values change every release.

.EXAMPLE
  powershell -NoProfile -File C:\dsh\verify-deployment.ps1 -ExpectedVersion 0.11.20

.EXAMPLE
  powershell -NoProfile -File C:\dsh\verify-deployment.ps1 -ExpectedVersion 0.11.20 -CrossPort 19001
#>
param(
  [int]$Port = 3080,
  [string]$WsPath = 'C:\dsh\node_modules\.pnpm\ws@8.21.0\node_modules\ws',
  [string]$ExpectedVersion = '',
  [string]$ProbePath = 'C:\dsh\probe-deployed-link.cjs',
  [int]$CrossPort = 0,
  [string]$ProfileDir = "$env:USERPROFILE\.dsh\profiles\web"
)

$ErrorActionPreference = 'Stop'
$script:fails = 0
function Pass([string]$message) { Write-Output "PASS  $message" }
function Fail([string]$message) { Write-Output "FAIL  $message"; $script:fails++ }

function Get-Status([string]$url, [string[]]$headers) {
  $curlArgs = @('-s', '-o', 'NUL', '-w', '%{http_code}', '--max-time', '8')
  foreach ($h in $headers) { $curlArgs += @('-H', $h) }
  $curlArgs += $url
  try { return (& curl.exe @curlArgs | Out-String).Trim() } catch { return '000' }
}

# 1. Credential. The value sits under `refs:` with two leading spaces; never echo it.
$token = ''
$credentialFile = "$env:USERPROFILE\.dsh\.credentials.yaml"
if (Test-Path $credentialFile) {
  $match = Select-String -Path $credentialFile -Pattern '^\s+DSH_INTERCONNECT_TOKEN:\s*(.+)$' | Select-Object -First 1
  if ($match) { $token = $match.Matches[0].Groups[1].Value.Trim().Trim('"').Trim("'") }
}
if ($token) { Pass 'token read from the host credential store' } else { Fail 'token read from the host credential store' }

# 2. Installed version.
$manifest = Join-Path $ProfileDir 'node_modules\dsh-interconnect\dsh.plugin.json'
$version = if (Test-Path $manifest) { (Get-Content $manifest -Raw | ConvertFrom-Json).version } else { '' }
if ($ExpectedVersion -and $version -eq $ExpectedVersion) {
  Pass "installed plugin version matches the checkout ($version)"
} elseif (-not $ExpectedVersion -and $version) {
  Pass "installed plugin version $version (no expected version given)"
} else {
  Fail "installed plugin version '$version' != expected '$ExpectedVersion'"
}

# 3. Profile layers.
$layers = @()
$profileManifest = Join-Path $ProfileDir 'package.json'
if (Test-Path $profileManifest) { $layers = @((Get-Content $profileManifest -Raw | ConvertFrom-Json).dsh.profile.bundles) }
if ($layers -match 'dsh-interconnect|interconnect-profile') {
  Pass "profile layers: $($layers -join ',')"
} else {
  Fail "profile layers look wrong: $($layers -join ',')"
}

# 4. `/` returns 404 while the tree composes, so poll for the settled 401.
$rootCode = '000'
for ($i = 0; $i -lt 10; $i++) {
  $rootCode = Get-Status "http://127.0.0.1:$Port/"
  if ($rootCode -eq '401') { break }
  Start-Sleep -Seconds 3
}
if ($rootCode -eq '401') { Pass 'GET / -> 401 (unauthenticated)' } else { Fail "GET / -> $rootCode (want 401)" }

# 5. The link route refuses an unauthenticated upgrade.
$linkCode = Get-Status "http://127.0.0.1:$Port/interconnect/link" @(
  'Connection: Upgrade', 'Upgrade: websocket', 'Sec-WebSocket-Version: 13',
  'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ=='
)
if ($linkCode -eq '401') { Pass 'WS /interconnect/link without a token -> 401' } else { Fail "WS /interconnect/link -> $linkCode (want 401)" }

# 6./7. Protocol probes.
function Invoke-Probe([int]$probePort) {
  if (-not (Test-Path $ProbePath)) { return "probe script missing at $ProbePath" }
  $env:IC_TOKEN = $token
  $env:IC_PORT = "$probePort"
  $env:IC_WS = $WsPath
  # A failing probe writes its reason to stderr; under $ErrorActionPreference
  # 'Stop' PowerShell turns native stderr into a terminating error, which would
  # abort the script on exactly the failure this check exists to report.
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    return (& node $ProbePath 2>&1 | Out-String)
  } catch {
    return $_.Exception.Message
  } finally {
    $ErrorActionPreference = $previous
  }
}
function Probe-Reason([string]$text) {
  # Node's failure line is the useful part; PowerShell wraps native stderr in
  # NativeCommandError decoration that would otherwise swamp the report.
  $match = [regex]::Match($text, '(WS-ERR|HTTP-STATUS|TIMEOUT)[^\r\n]*')
  if ($match.Success) { return $match.Value.Trim() }
  return ($text -replace '\s+', ' ').Trim()
}

$self = Invoke-Probe $Port
if ($self -match 'hello from: ') {
  Pass "five-frame probe on ${Port}: $(($self -split "`n")[0].Trim())"
} else {
  Fail "five-frame probe on ${Port}: $(Probe-Reason $self)"
}
if ($CrossPort -gt 0) {
  $leg = Invoke-Probe $CrossPort
  if ($leg -match 'hello from: ') {
    Pass "five-frame probe through the tunnel on ${CrossPort}: $(($leg -split "`n")[0].Trim())"
  } else {
    Fail "five-frame probe through the tunnel on ${CrossPort}: $(Probe-Reason $leg)"
  }
}

# 8. Tunnel task and this instance's outbound peer links.
$task = Get-ScheduledTask -TaskName 'DSH-IC-Tunnels' -ErrorAction SilentlyContinue
$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($task -and $task.State -eq 'Running' -and $listener) {
  $peers = Get-NetTCPConnection -OwningProcess $listener.OwningProcess -ErrorAction SilentlyContinue |
    Where-Object { $_.State -eq 'Established' -and ($_.RemotePort -eq 19001 -or $_.RemotePort -eq 13080) } |
    Select-Object -ExpandProperty RemotePort | Sort-Object -Unique
  Pass "tunnel task Running; outbound peer ports: $($peers -join ',')"
} else {
  Fail "tunnel task state '$($task.State)'; listener pid $($listener.OwningProcess)"
}

# 9. Artifact hash chain, printed for comparison with the repository build.
$chain = @(
  'lib\index.js', 'lib\interconnect\index.js', 'lib\tool-interconnect\index.js',
  'lib\skill-interconnect\index.js', 'assets\dsh-interconnect.md', 'cordis.patch.yml', 'dsh.plugin.json'
)
Write-Output 'artifact hash chain (compare with the repository build):'
foreach ($relative in $chain) {
  $file = Join-Path $ProfileDir "node_modules\dsh-interconnect\$relative"
  if (Test-Path $file) {
    $hash = (Get-FileHash $file -Algorithm SHA256).Hash.ToLower().Substring(0, 16)
    Write-Output "  $hash  $relative"
  } else {
    Write-Output "  MISSING           $relative"
    $script:fails++
  }
}

if ($script:fails -eq 0) { Write-Output 'windows host: all checks passed' } else { Write-Output "windows host: $($script:fails) check(s) failed" }
exit $([int]($script:fails -gt 0))
