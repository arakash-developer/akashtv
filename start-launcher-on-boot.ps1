# Makes the AKASH TV launcher start hidden every time Windows starts.
# Also allows the phone to reach it through Windows Firewall (asks for admin once).
$root = $PSScriptRoot
$vbs  = Join-Path $root 'launcher-hidden.vbs'
$node = (Get-Command node).Source

Set-Content -Encoding ASCII $vbs @"
CreateObject("WScript.Shell").Run """$node"" ""$root\launcher.js""", 0, False
"@

$startup = [Environment]::GetFolderPath('Startup')
$sc = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $startup 'AKASH TV Launcher.lnk'))
$sc.TargetPath = 'wscript.exe'
$sc.Arguments  = '"' + $vbs + '"'
$sc.WorkingDirectory = $root
$sc.IconLocation = (Join-Path $root 'assets\icon.ico') + ',0'
$sc.Save()
Write-Host 'Launcher will start with Windows.' -ForegroundColor Green

Start-Process powershell -Verb RunAs -ArgumentList "-NoProfile -Command `"New-NetFirewallRule -DisplayName 'AKASH TV Launcher' -Direction Inbound -Protocol TCP -LocalPort 8765 -Profile Any -Action Allow`""

Start-Process wscript.exe -ArgumentList "`"$vbs`""
Write-Host 'Launcher started now. Phone link: run "npm run launcher-link"' -ForegroundColor Green
