$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$VbsPath = Join-Path $Root "run-workflow.vbs"
$TaskName = "TestImage Daily Workflow"
$UserId = "$env:USERDOMAIN\$env:USERNAME"

if (-not (Test-Path -LiteralPath $VbsPath)) {
  throw "VBS entry not found: $VbsPath"
}

$action = New-ScheduledTaskAction `
  -Execute "wscript.exe" `
  -Argument "`"$VbsPath`"" `
  -WorkingDirectory $Root

$trigger = New-ScheduledTaskTrigger -Daily -At "09:45"
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew

$principal = New-ScheduledTaskPrincipal `
  -UserId $UserId `
  -LogonType Interactive `
  -RunLevel Limited

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $principal `
  -Description "Run the local testimage workflow every day at 09:45." `
  -Force | Out-Null

Write-Host "Registered scheduled task: $TaskName"
Write-Host "Action: wscript.exe `"$VbsPath`""
