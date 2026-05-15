# FindInTosh — Windows Installer
# Paste this in PowerShell:
#
#   irm https://gracious-enthusiasm-production-fb7b.up.railway.app/install.ps1 | iex

param(
  [string]$RelayUrl = "wss://gracious-enthusiasm-production-fb7b.up.railway.app"
)

$ErrorActionPreference = "Continue"
$BaseUrl     = $RelayUrl -replace '^wss://', 'https://' -replace '^ws://', 'http://'
$InstallDir  = "$env:APPDATA\FindInTosh"
$NodeVersion = "20.17.0"
$NodeDir     = "$InstallDir\node"

Write-Host ""
Write-Host "  +========================================+"
Write-Host "  |    FindInTosh -- Installation Windows  |"
Write-Host "  +========================================+"
Write-Host ""

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

# ── 1. Node.js ────────────────────────────────────────────────────────────────

Write-Host "  [1/3] Verification de Node.js..."

# Find node: system PATH first, then our local portable copy
$nodeExe = $null
$npmExe  = $null

$sysNode = Get-Command node -ErrorAction SilentlyContinue
if ($sysNode) {
  $nodeExe = $sysNode.Source
  $npmExe  = Join-Path (Split-Path $nodeExe) "npm.cmd"
  $ver     = & $nodeExe --version 2>$null
  Write-Host "  [1/3] Node.js $ver detecte OK"
} else {
  # Check if we already downloaded a portable copy
  $portableNode = Get-ChildItem "$NodeDir" -Filter "node.exe" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($portableNode) {
    $nodeExe = $portableNode.FullName
    $npmExe  = Join-Path (Split-Path $nodeExe) "npm.cmd"
    $ver     = & $nodeExe --version 2>$null
    Write-Host "  [1/3] Node.js portable $ver OK"
  } else {
    # Download portable zip — no admin, no MSI, no UAC
    Write-Host "        Node.js introuvable. Telechargement de la version portable v$NodeVersion..."
    $arch   = if ([Environment]::Is64BitOperatingSystem) { "x64" } else { "x86" }
    $zipUrl = "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-$arch.zip"
    $zipTmp = "$env:TEMP\node-portable.zip"
    try {
      Write-Host "        Telechargement (~30 Mo)..."
      Invoke-WebRequest -Uri $zipUrl -OutFile $zipTmp -UseBasicParsing
      Write-Host "        Extraction..."
      New-Item -ItemType Directory -Force -Path $NodeDir | Out-Null
      Expand-Archive -Path $zipTmp -DestinationPath $NodeDir -Force
      Remove-Item $zipTmp -ErrorAction SilentlyContinue
      $portableNode = Get-ChildItem "$NodeDir" -Filter "node.exe" -Recurse | Select-Object -First 1
      if (-not $portableNode) { throw "node.exe introuvable apres extraction" }
      $nodeExe = $portableNode.FullName
      $npmExe  = Join-Path (Split-Path $nodeExe) "npm.cmd"
      # Add to PATH for this session
      $env:Path = (Split-Path $nodeExe) + ";$env:Path"
      $ver = & $nodeExe --version 2>$null
      Write-Host "  [1/3] Node.js portable $ver installe OK"
    } catch {
      Write-Host "  [!] Echec du telechargement de Node.js : $_"
      Write-Host "      Installez Node.js manuellement depuis https://nodejs.org puis relancez."
      Read-Host "  Appuyez sur Entree pour quitter"
      exit 1
    }
  }
}

# ── 2. Download agent ─────────────────────────────────────────────────────────

Write-Host "  [2/3] Telechargement de l'agent FindInTosh..."
try {
  Invoke-WebRequest -Uri "$BaseUrl/agent-windows.js" -OutFile "$InstallDir\agent.js"  -UseBasicParsing
  Invoke-WebRequest -Uri "$BaseUrl/package.json"     -OutFile "$InstallDir\package.json" -UseBasicParsing

  Push-Location $InstallDir
  & $npmExe install --omit=dev --silent 2>$null
  Pop-Location
  Write-Host "  [2/3] Agent telecharge OK"
} catch {
  Write-Host "  [!] Echec du telechargement : $_"
  Read-Host "  Appuyez sur Entree pour quitter"
  exit 1
}

# ── 3. Task Scheduler (auto-start at login) ───────────────────────────────────

Write-Host "  [3/3] Configuration du demarrage automatique..."
try {
  $taskName = "FindInTosh Agent"
  $action   = New-ScheduledTaskAction -Execute $nodeExe `
    -Argument "`"$InstallDir\agent.js`"" `
    -WorkingDirectory $InstallDir
  $trigger  = New-ScheduledTaskTrigger -AtLogOn
  $settings = New-ScheduledTaskSettingsSet `
    -RestartCount 10 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew `
    -StartWhenAvailable $true
  $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -RunLevel Limited

  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Register-ScheduledTask `
    -TaskName  $taskName `
    -Action    $action `
    -Trigger   $trigger `
    -Settings  $settings `
    -Principal $principal `
    -Force | Out-Null
  Write-Host "  [3/3] Demarrage automatique configure OK"
} catch {
  Write-Host "  [!] Demarrage automatique non configure."
  Write-Host "      L'agent fonctionne quand meme, il faudra le relancer manuellement."
}

# ── Launch now ────────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "  OK  Installation terminee ! Lancement de l'agent..."
Write-Host ""

$env:RELAY_URL = $RelayUrl
Start-Process $nodeExe `
  -ArgumentList "`"$InstallDir\agent.js`"" `
  -WorkingDirectory $InstallDir `
  -WindowStyle Normal
