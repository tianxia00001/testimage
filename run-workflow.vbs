Option Explicit

Dim shell, fso, scriptDir, psScript, logFile, command, exitCode

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
psScript = fso.BuildPath(scriptDir, "scripts\workflow-task.ps1")
logFile = fso.BuildPath(scriptDir, "workflow-vbs.log")

AppendLog "VBS started. Script=" & psScript

If Not fso.FileExists(psScript) Then
  AppendLog "Missing workflow-task.ps1"
  MsgBox "Workflow script not found:" & vbCrLf & psScript, vbExclamation, "Image Workflow"
  WScript.Quit 1
End If

command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File " & Chr(34) & psScript & Chr(34)
AppendLog "Command=" & command
exitCode = shell.Run(command, 0, False)
AppendLog "PowerShell launch returned " & CStr(exitCode)

Sub AppendLog(message)
  Dim file
  Set file = fso.OpenTextFile(logFile, 8, True)
  file.WriteLine Now & " " & message
  file.Close
End Sub
