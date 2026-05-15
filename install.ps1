# FindInTosh — Windows Installer
# Paste this in PowerShell (run as Administrator for auto-start setup):
#
#   irm https://findintosh-production.up.railway.app/install.ps1 | iex
#
# Or download & run:
#   powershell -ExecutionPolicy Bypass -File install.ps1

param(
  [string]$RelayUrl = "wss://gracious-enthusiasm-production-fb7b.up.railway.app"
)

$ErrorActionPreference = "Continue"
$BaseUrl     = $RelayUrl -replace '^wss://', 'https://' -replace '^ws://', 'http://'
$InstallDir  = "$env:APPDATA\FindInTosh"
$NodeVersion = "20.17.0"

Write-Host ""
Write-Host "  +========================================+"
Write-Host "  |    FindInTosh -- Installation Windows  |"
Write-Host "  +========================================+"
Write-Host ""

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

# ── 1. Node.js ────────────────────────────────────────────────────────────────

Write-Host "  [1/3] Verification de Node.js..."
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue

if (-not $nodeCmd) {
  Write-Host "        Node.js introuvable. Telechargement de v$NodeVersion..."
  $msiUrl  = "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-x64.msi"
  $msiPath = "$env:TEMP\node-setup.msi"
  try {
    Invoke-WebRequest -Uri $msiUrl -OutFile $msiPath -UseBasicParsing
    Write-Host "        Installation en cours (~30 secondes)..."
    Start-Process msiexec.exe -Wait -ArgumentList "/i `"$msiPath`" /quiet /norestart ADDLOCAL=ALL"
    Remove-Item $msiPath -ErrorAction SilentlyContinue
    # Refresh PATH
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
                [System.Environment]::GetEnvironmentVariable("Path", "User")
    Write-Host "  [1/3] Node.js v$NodeVersion installe OK"
  } catch {
    Write-Host "  [!] Impossible d'installer Node.js automatiquement."
    Write-Host "      Installez-le manuellement depuis : https://nodejs.org"
    exit 1
  }
} else {
  $ver = & node --version 2>$null
  Write-Host "  [1/3] Node.js $ver detecte OK"
}

# ── 2. Download agent ─────────────────────────────────────────────────────────

Write-Host "  [2/3] Telechargement de l'agent FindInTosh..."
try {
  Invoke-WebRequest -Uri "$BaseUrl/agent-windows.js" -OutFile "$InstallDir\agent.js"  -UseBasicParsing
  Invoke-WebRequest -Uri "$BaseUrl/package.json"     -OutFile "$InstallDir\package.json" -UseBasicParsing

  $npmPath = (Get-Command npm -ErrorAction SilentlyContinue)?.Source
  if (-not $npmPath) {
    $nodePath = (Get-Command node).Source
    $npmPath  = Join-Path (Split-Path $nodePath) "npm.cmd"
  }
  Push-Location $InstallDir
  & $npmPath install --omit=dev --silent 2>$null
  Pop-Location
  Write-Host "  [2/3] Agent telecharge OK"
} catch {
  Write-Host "  [!] Echec du telechargement : $_"
  exit 1
}

# ── 3. Task Scheduler (auto-start at login) ───────────────────────────────────

Write-Host "  [3/3] Configuration du demarrage automatique..."
try {
  $nodeExe  = (Get-Command node).Source
  $agentJs  = "$InstallDir\agent.js"
  $logFile  = "$InstallDir\agent.log"
  $taskName = "FindInTosh Agent"

  $envVar   = New-ScheduledTaskAction -Execute $nodeExe `
    -Argument "`"$agentJs`"" `
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
    -Action    $envVar `
    -Trigger   $trigger `
    -Settings  $settings `
    -Principal $principal `
    -Force | Out-Null
  Write-Host "  [3/3] Demarrage automatique configure OK"
} catch {
  Write-Host "  [!] Demarrage automatique non configure (lancez en tant qu'Administrateur)."
  Write-Host "      L'agent fonctionne quand meme, il faudra le relancer manuellement."
}

# ── Launch now ────────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "  OK  Installation terminee ! Lancement de l'agent..."
Write-Host ""
Write-Host "  Pour voir les logs : Get-Content `"$InstallDir\agent.log`" -Wait"
Write-Host ""

$env:RELAY_URL = $RelayUrl
$nodeExe = (Get-Command node).Source
Start-Process $nodeExe `
  -ArgumentList "`"$InstallDir\agent.js`"" `
  -WorkingDirectory $InstallDir `
  -WindowStyle Normal
