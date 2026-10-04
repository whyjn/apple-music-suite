' ============================================================
'  Apple Music Desktop Ball - silent launcher (no console flash)
'  Double-click the desktop shortcut that points to this file.
' ============================================================
Option Explicit

Dim fso, sh, baseDir, ps1Path, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")

baseDir = fso.GetParentFolderName(WScript.ScriptFullName)
ps1Path = baseDir & "\ball.ps1"

If Not fso.FileExists(ps1Path) Then
    MsgBox "ball.ps1 not found next to this launcher:" & vbCrLf & ps1Path, 16, "Apple Music Ball"
    WScript.Quit 1
End If

cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps1Path & """"

' 0 = hidden window, False = do not wait
sh.Run cmd, 0, False
