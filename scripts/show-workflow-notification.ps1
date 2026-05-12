param(
  [string]$Status = "unknown",
  [string]$RunDate = "",
  [string]$RunDir = "",
  [string]$FeedbackUrl = "http://localhost:8787/workflow/feedback",
  [string]$Message = "Image workflow completed.",
  [int]$WaitSeconds = 45
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = [System.Drawing.SystemIcons]::Information
$notify.Visible = $true
$notify.Text = "Image Workflow"

$title = if ($Status -eq "success") {
  "Generation completed"
} elseif ($Status -eq "partial-failure") {
  "Partially completed"
} elseif ($Status -eq "running") {
  "Workflow started"
} else {
  "Workflow notice"
}

$body = "$Message`nDate: $RunDate`nClick to open the feedback page."
$clicked = $false

$openFeedback = {
  $script:clicked = $true
  if ($FeedbackUrl) {
    Start-Process $FeedbackUrl
  }
}

$notify.add_BalloonTipClicked($openFeedback)
$notify.add_Click($openFeedback)
$durationMs = [Math]::Max(1, $WaitSeconds) * 1000
$notify.ShowBalloonTip($durationMs, $title, $body, [System.Windows.Forms.ToolTipIcon]::Info)

$deadline = (Get-Date).AddSeconds([Math]::Max(1, $WaitSeconds))
while ((Get-Date) -lt $deadline -and -not $clicked) {
  [System.Windows.Forms.Application]::DoEvents()
  Start-Sleep -Milliseconds 200
}

$notify.Visible = $false
$notify.Dispose()
