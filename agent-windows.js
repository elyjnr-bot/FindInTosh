#!/usr/bin/env node
// FindInTosh — Windows Agent
// Connects to the cloud relay and launches apps on this Windows PC.

const { exec } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

let WebSocket;
try {
  ({ WebSocket } = require('ws'));
} catch {
  console.error('\n  Missing dependency. Run:  npm install\n');
  process.exit(1);
}

// ─── Config ───────────────────────────────────────────────────────────────────

const RELAY_URL   = process.env.RELAY_URL || 'wss://gracious-enthusiasm-production-fb7b.up.railway.app';
const CONFIG_DIR  = path.join(os.homedir(), 'AppData', 'Roaming', 'FindInTosh');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const ICON_CACHE  = path.join(os.tmpdir(), 'ft_icons');

let config = {};
try { config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch {}
fs.mkdirSync(ICON_CACHE, { recursive: true });

// name.toLowerCase() → { name, path }
let appIndex = {};

// ─── PowerShell helper ────────────────────────────────────────────────────────

function ps(script, opts = {}) {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    exec(
      `powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`,
      { timeout: opts.timeout || 15000, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message));
        else resolve(stdout.trim());
      }
    );
  });
}

// ─── App discovery ────────────────────────────────────────────────────────────

async function buildAppIndex() {
  const script = `
$reg = @(
  'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\SOFTWARE\\Wow6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
)
$skip = 'Microsoft Visual C|Microsoft .NET|Windows SDK|Redistributable|Update for Windows|Security Update'
$apps = $reg | ForEach-Object {
  Get-ItemProperty $_ -ErrorAction SilentlyContinue
} | Where-Object {
  $_.DisplayName -and -not $_.SystemComponent -and $_.UninstallString -and
  $_.DisplayName -notmatch $skip
} | ForEach-Object {
  $exePath = ''
  if ($_.DisplayIcon) {
    $raw = ($_.DisplayIcon -split ',')[0].Trim('"').Trim()
    if ($raw -match '\\.exe$' -and (Test-Path $raw -ErrorAction SilentlyContinue)) {
      $exePath = $raw
    }
  }
  if (-not $exePath -and $_.InstallLocation -and (Test-Path $_.InstallLocation -ErrorAction SilentlyContinue)) {
    $exes = Get-ChildItem -Path $_.InstallLocation -Filter '*.exe' -Depth 1 -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -notmatch '(uninstall|setup|update|crash|helper)' -and $_.Length -gt 50KB } |
      Sort-Object Length -Descending | Select-Object -First 1
    if ($exes) { $exePath = $exes.FullName }
  }
  [PSCustomObject]@{ name = $_.DisplayName; path = $exePath }
} | Where-Object { $_.name } | Sort-Object name -Unique
ConvertTo-Json -InputObject @($apps) -Compress -Depth 2
`;
  try {
    const raw  = await ps(script, { timeout: 20000 });
    const list = JSON.parse(raw || '[]');
    appIndex = {};
    for (const a of (Array.isArray(list) ? list : [])) {
      if (a && a.name) appIndex[a.name.toLowerCase()] = a;
    }
    return Object.values(appIndex);
  } catch (e) {
    console.error('[!] app index error:', e.message);
    return [];
  }
}

function listInstalledApps() {
  return Object.values(appIndex).map(a => ({
    name: a.name,
    dir:  a.path ? path.dirname(a.path) : '',
  }));
}

// ─── Launch ───────────────────────────────────────────────────────────────────

async function launchApp(name) {
  const entry   = appIndex[name.toLowerCase()];
  const exePath = entry && entry.path;

  if (exePath && fs.existsSync(exePath)) {
    return new Promise((resolve, reject) => {
      exec(`"${exePath}"`, err => err ? reject(err) : resolve());
    });
  }

  // Fallback: PowerShell Start-Process by name (handles UWP + PATH apps)
  try {
    await ps(`Start-Process '${name.replace(/'/g, "''")}'`);
    return;
  } catch {}

  // Last resort: cmd /c start
  return new Promise((resolve, reject) => {
    exec(`cmd /c start "" "${name}"`, err => err ? reject(err) : resolve());
  });
}

// ─── Icon extraction ─────────────────────────────────────────────────────────

async function getIconBase64(name) {
  const entry   = appIndex[name.toLowerCase()];
  const exePath = entry && entry.path;
  if (!exePath || !fs.existsSync(exePath)) return null;

  const safe   = name.replace(/[^\w]/g, '_');
  const outPng = path.join(ICON_CACHE, `${safe}.png`);

  if (fs.existsSync(outPng)) {
    return fs.readFileSync(outPng).toString('base64');
  }

  const escapedExe = exePath.replace(/\\/g, '\\\\').replace(/'/g, "''");
  const escapedOut = outPng.replace(/\\/g,  '\\\\');

  const script = `
Add-Type -AssemblyName System.Drawing
try {
  $icon = [System.Drawing.Icon]::ExtractAssociatedIcon('${escapedExe}')
  if ($icon) {
    $bmp = $icon.ToBitmap()
    $bmp.Save('${escapedOut}', [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose(); $icon.Dispose()
  }
} catch {}
`;
  try {
    await ps(script);
    if (fs.existsSync(outPng)) return fs.readFileSync(outPng).toString('base64');
  } catch {}
  return null;
}

// ─── WebSocket ────────────────────────────────────────────────────────────────

let ws, reconnectTimer, pingInterval;
let hasOpenedBrowser = false;

function saveConfig() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function openBrowser(url) {
  exec(`cmd /c start "" "${url}"`, () => {});
}

function connect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  console.log(`  Connecting to ${RELAY_URL} ...`);
  ws = new WebSocket(RELAY_URL);

  ws.on('open', () => {
    console.log('  Connected.\n');
    ws.send(JSON.stringify({ type: 'agent_register', roomId: config.roomId || null, osType: 'windows' }));
    pingInterval = setInterval(() => {
      if (ws && ws.readyState === 1) ws.ping();
    }, 25000);
    buildAppIndex().then(apps => {
      console.log(`  App index: ${apps.length} apps found.\n`);
    });
  });

  ws.on('message', async raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    switch (msg.type) {

      case 'room_created': {
        config.roomId = msg.roomId;
        saveConfig();
        const base    = RELAY_URL.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
        const desktop = `${base}/app-desktop.html?room=${msg.roomId}`;
        const mobile  = `${base}/app-mobile.html?room=${msg.roomId}`;
        console.log('+-------------------------------------------------+');
        console.log(`|  Room ID  :  ${msg.roomId.padEnd(35)} |`);
        console.log(`|  Desktop  :  ${desktop.slice(0, 35).padEnd(35)} |`);
        console.log(`|  Mobile   :  ${mobile.slice(0, 35).padEnd(35)} |`);
        console.log('+-------------------------------------------------+\n');
        if (!hasOpenedBrowser) {
          hasOpenedBrowser = true;
          openBrowser(desktop);
          console.log('  Browser opened automatically.\n');
        }
        break;
      }

      case 'launch': {
        const name = msg.app;
        if (typeof name !== 'string' || !/^[\w\s.\-()À-ɏ&+]+$/.test(name)) {
          ws.send(JSON.stringify({ type: 'launch_result', app: name, success: false }));
          return;
        }
        console.log(`[->] launch  ${name}`);
        launchApp(name)
          .then(() => ws.send(JSON.stringify({ type: 'launch_result', app: name, success: true })))
          .catch(e  => {
            console.error(`[!]  failed   ${name}: ${e.message}`);
            ws.send(JSON.stringify({ type: 'launch_result', app: name, success: false, error: e.message }));
          });
        break;
      }

      case 'get_apps': {
        const apps = listInstalledApps();
        ws.send(JSON.stringify({ type: 'apps_response', requestId: msg.requestId, apps }));
        break;
      }

      case 'get_icon': {
        const data = await getIconBase64(msg.name);
        ws.send(JSON.stringify({ type: 'icon_response', requestId: msg.requestId, name: msg.name, data }));
        break;
      }

      case 'phone_connected':    console.log('[+] Phone connected');    break;
      case 'phone_disconnected': console.log('[-] Phone disconnected'); break;
      case 'dock_config':
        console.log(`[dock] ${(msg.apps || []).filter(Boolean).join(', ')}`);
        break;
    }
  });

  ws.on('close', () => {
    if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
    console.log('  Disconnected. Reconnecting in 5 s...');
    reconnectTimer = setTimeout(connect, 5000);
  });

  ws.on('error', err => console.error('  WS error:', err.message));
}

// ─── Start ────────────────────────────────────────────────────────────────────

console.log('\n  FindInTosh Agent (Windows)\n');
connect();
