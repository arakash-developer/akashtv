# Adds "Send to AKASH TV" to the right-click menu of every file (current user only, no admin needed).
# Remove it again with:  .\add-context-menu.ps1 -Remove
param([switch]$Remove)

$key = 'HKCU:\Software\Classes\*\shell\AkashTV'

if ($Remove) {
  Remove-Item -LiteralPath $key -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host 'Removed "Send to AKASH TV" from the right-click menu.' -ForegroundColor Yellow
  exit 0
}

$root = $PSScriptRoot
$vbs  = Join-Path $root 'send-to-akashtv.vbs'
$icon = Join-Path $root 'assets\icon.ico'

New-Item -Path $key -Force | Out-Null
Set-ItemProperty -LiteralPath $key -Name '(default)' -Value 'Send to AKASH TV'
Set-ItemProperty -LiteralPath $key -Name 'Icon' -Value $icon
New-Item -Path "$key\command" -Force | Out-Null
Set-ItemProperty -LiteralPath "$key\command" -Name '(default)' -Value ('wscript.exe "' + $vbs + '" "%1"')

Write-Host 'Added "Send to AKASH TV" to the right-click menu.' -ForegroundColor Green
Write-Host 'On Windows 11 it is under "Show more options" (or Shift + right-click).'
