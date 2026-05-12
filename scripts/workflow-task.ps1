$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$ServerUrl = "http://localhost:8787"
$OutLog = Join-Path $Root "server.log"
$ErrLog = Join-Path $Root "server.err.log"
$RunnerLog = Join-Path $Root "workflow-runner.last.log"
$TaskLog = Join-Path $Root "workflow-task.log"
$Today = Get-Date -Format "yyyy-MM-dd"
$TodayRunDir = Join-Path $Root ("runs\" + $Today)
$TodayFeedbackUrl = "$ServerUrl/workflow/feedback?run=$Today"

function Write-TaskLog {
  param([string]$Message)
  Add-Content -LiteralPath $TaskLog -Value "[$((Get-Date).ToString('s'))] $Message" -Encoding utf8
}

Write-TaskLog "workflow-task started"

function Test-Server {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri "$ServerUrl/api/config" -TimeoutSec 2
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

function Start-LocalServer {
  Start-Process `
    -FilePath "npm.cmd" `
    -ArgumentList "start" `
    -WorkingDirectory $Root `
    -RedirectStandardOutput $OutLog `
    -RedirectStandardError $ErrLog `
    -WindowStyle Hidden | Out-Null
}

if (-not (Test-Server)) {
  Write-TaskLog "server not ready, starting npm"
  Start-LocalServer
} else {
  Write-TaskLog "server already ready"
}

$ready = $false
for ($i = 0; $i -lt 60; $i++) {
  if (Test-Server) {
    $ready = $true
    break
  }
  Start-Sleep -Seconds 1
}

if (-not $ready) {
  $message = "Local server did not start within 60 seconds."
  Write-TaskLog $message
  Set-Content -LiteralPath $RunnerLog -Value $message -Encoding utf8
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "show-workflow-notification.ps1") `
    -Status "failed" `
    -RunDate $Today `
    -RunDir $TodayRunDir `
    -FeedbackUrl $TodayFeedbackUrl `
    -Message $message
  exit 1
}

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "show-workflow-notification.ps1") `
  -Status "running" `
  -RunDate $Today `
  -RunDir $TodayRunDir `
  -FeedbackUrl $TodayFeedbackUrl `
  -Message "Image workflow is running in the background." `
  -WaitSeconds 5

Write-TaskLog "server ready, starting workflow runner"
$runnerOutput = & node (Join-Path $PSScriptRoot "workflow-runner.js") 2>&1
$exitCode = $LASTEXITCODE
$runnerOutput | Set-Content -LiteralPath $RunnerLog -Encoding utf8
Write-TaskLog "workflow runner exited with code $exitCode"

$summary = $null
$lines = @($runnerOutput)
[array]::Reverse($lines)
foreach ($line in $lines) {
  try {
    $summary = $line | ConvertFrom-Json
    break
  } catch {
  }
}

if ($null -eq $summary) {
  $summary = [pscustomobject]@{
    status = if ($exitCode -eq 0) { "unknown" } else { "failed" }
    runDate = $Today
    runDir = $TodayRunDir
    feedbackUrl = $TodayFeedbackUrl
  }
}

$message = if ($summary.status -eq "success") {
  "Image workflow completed."
} elseif ($summary.status -eq "partial-failure") {
  "Image workflow partially completed. Some steps failed."
} else {
  "Image workflow failed or returned an unknown status."
}

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "show-workflow-notification.ps1") `
  -Status $summary.status `
  -RunDate $summary.runDate `
  -RunDir $summary.runDir `
  -FeedbackUrl $summary.feedbackUrl `
  -Message $message

Write-TaskLog "notification script completed"

if ($exitCode -ne 0) {
  exit $exitCode
}
