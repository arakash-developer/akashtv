# Creates an "AKASH TV" shortcut on the Desktop that launches the app with its logo.
$ErrorActionPreference = 'Stop'
$root     = $PSScriptRoot
$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
$icon     = Join-Path $root 'assets\icon.ico'

if (-not (Test-Path $electron)) {
  Write-Host 'Electron not found. Run "npm install" in this folder first.' -ForegroundColor Red
  exit 1
}

$desktop = [Environment]::GetFolderPath('Desktop')
$lnk = Join-Path $desktop 'AKASH TV.lnk'

$sc = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
$sc.TargetPath       = $electron
$sc.Arguments        = '"' + $root + '"'
$sc.WorkingDirectory = $root
$sc.IconLocation     = "$icon,0"
$sc.Description      = 'AKASH TV'
$sc.Save()

Write-Host "Shortcut created: $lnk" -ForegroundColor Green
