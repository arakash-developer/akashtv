' Right-click "Send to AKASH TV": hands the selected file(s) to the launcher,
' which lists them on the phone's Files tab. Runs without any window.
Option Explicit
Dim fso, root, keyFile, json, re, m, key, paths, i, http

Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
keyFile = root & "\pairings\launcher.json"

If Not fso.FileExists(keyFile) Then
  MsgBox "AKASH TV launcher is not set up yet.", vbExclamation, "AKASH TV"
  WScript.Quit 1
End If

json = fso.OpenTextFile(keyFile, 1).ReadAll
Set re = New RegExp
re.Pattern = """key""\s*:\s*""([^""]+)"""
Set m = re.Execute(json)
If m.Count = 0 Then WScript.Quit 1
key = m(0).SubMatches(0)

paths = ""
For i = 0 To WScript.Arguments.Count - 1
  paths = paths & WScript.Arguments(i) & vbLf
Next
If paths = "" Then WScript.Quit 0

On Error Resume Next
Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
http.open "POST", "http://127.0.0.1:8765/share?key=" & key, False
http.setRequestHeader "Content-Type", "text/plain; charset=utf-8"
http.send paths
If Err.Number <> 0 Or http.status <> 200 Then
  MsgBox "Could not send to AKASH TV. Is the launcher running?", vbExclamation, "AKASH TV"
End If
