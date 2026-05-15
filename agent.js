#!/usr/bin/env node
// FindInTosh — Local Mac agent
// Connects to the cloud relay and launches apps on this Mac.
//
// Usage:
//   RELAY_URL=wss://your-app.up.railway.app node agent.js

const { exec, execSync } = require('child_process');
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
const CONFIG_DIR  = path.join(os.homedir(), '.findintosh');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

let config = {};
try { config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch {}

const SEARCH_DIRS = [
  '/Applications',
  '/Applications/Utilities',
  '/System/Applications',
  '/System/Applications/Utilities',
  '/System/Library/CoreServices',
];

// ─── App utilities ────────────────────────────────────────────────────────────

function listInstalledApps() {
  const apps = [];
  for (const dir of SEARCH_DIRS) {
    try {
      fs.readdirSync(dir)
        .filter(f => f.endsWith('.app') && !f.startsWith('.'))
        .forEach(f => apps.push({ name: f.replace('.app', ''), dir }));
    } catch {}
  }
  return apps.sort((a, b) => a.name.localeCompare(b.name));
}

function resolveAppPath(name) {
  for (const dir of SEARCH_DIRS) {
    const p = path.join(dir, `${name}.app`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function findIconPath(appPath) {
  try {
    const plist = `${appPath}/Contents/Info.plist`;
    let name = execSync(
      `/usr/libexec/PlistBuddy -c "Print CFBundleIconFile" "${plist}" 2>/dev/null`
    ).toString().trim();
    if (!name.endsWith('.icns')) name += '.icns';
    const p = `${appPath}/Contents/Resources/${name}`;
    if (fs.existsSync(p)) return p;
  } catch {}
  try {
    const found = execSync(
      `find "${appPath}/Contents/Resources" -maxdepth 1 -name "*.icns" 2>/dev/null | head -1`
    ).toString().trim();
    if (found && fs.existsSync(found)) return found;
  } catch {}
  return null;
}

function getIconBase64(appName) {
  return new Promise(resolve => {
    const appPath = resolveAppPath(appName);
    if (!appPath) { resolve(null); return; }
    const icns = findIconPath(appPath);
    if (!icns) { resolve(null); return; }
    const safe   = appName.replace(/[^\w]/g, '_');
    const tmpPng = path.join(os.tmpdir(), `ft_agent_${safe}.png`);
    if (fs.existsSync(tmpPng)) {
      resolve(fs.readFileSync(tmpPng).toString('base64'));
      return;
    }
    exec(`sips -s format png "${icns}" --out "${tmpPng}" 2>/dev/null`, err => {
      if (err || !fs.existsSync(tmpPng)) { resolve(null); return; }
      resolve(fs.readFileSync(tmpPng).toString('base64'));
    });
  });
}

// ─── WebSocket connection ─────────────────────────────────────────────────────

let ws              = null;
let reconnectTimer  = null;
let pingInterval    = null;
let roomId          = null;
let hasOpenedBrowser = false;

function saveConfig() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function connect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

  const url = RELAY_URL;
  console.log(`  Connecting to ${url} …`);
  ws = new WebSocket(url);

  ws.on('open', () => {
    console.log('  Connected.\n');
    // Send saved roomId so relay can reuse the same room on reconnect
    ws.send(JSON.stringify({ type: 'agent_register', roomId: config.roomId || null }));
    // Ping every 25s to prevent Railway from dropping the idle connection
    pingInterval = setInterval(() => {
      if (ws && ws.readyState === 1) ws.ping();
    }, 25000);
  });

  ws.on('message', async raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    switch (msg.type) {

      case 'room_created': {
        roomId         = msg.roomId;
        config.roomId  = roomId;
        saveConfig();

        const base    = RELAY_URL.replace(/^ws/, 'http');
        const desktop = `${base}/app-desktop.html?room=${roomId}`;
        const mobile  = `${base}/app-mobile.html?room=${roomId}`;

        console.log('┌─────────────────────────────────────────────────┐');
        console.log(`│  Room ID  :  ${roomId.padEnd(35)} │`);
        console.log(`│  Desktop  :  ${desktop.slice(0, 35).padEnd(35)} │`);
        console.log(`│  Mobile   :  ${mobile.slice(0, 35).padEnd(35)} │`);
        console.log('│                                                 │');
        console.log('│  Open the Desktop URL on this Mac.              │');
        console.log('│  Open the Mobile URL on the iPhone.             │');
        console.log('└─────────────────────────────────────────────────┘\n');

        if (!hasOpenedBrowser) {
          hasOpenedBrowser = true;
          exec(`open "${desktop}"`, () => {});
          console.log('  Browser opened automatically.\n');
        }
        break;
      }

      case 'launch': {
        const raw = msg.app;
        const appName = (typeof raw === 'string' && /^[\w\s.\-()&+]+$/.test(raw)) ? raw : null;
        if (!appName) {
          ws.send(JSON.stringify({ type: 'launch_result', app: raw, success: false }));
          return;
        }
        console.log(`[→] launch  ${appName}`);
        exec(`open -a "${appName}"`, err => {
          ws.send(JSON.stringify({
            type:    'launch_result',
            app:     raw,
            success: !err,
            error:   err ? err.message : null,
          }));
          if (err) console.error(`[!] failed  ${appName}: ${err.message}`);
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

      case 'phone_connected':
        console.log('[✓] Phone connected');
        break;

      case 'phone_disconnected':
        console.log('[-] Phone disconnected');
        break;

      case 'dock_config':
        console.log(`[dock] ${(msg.apps || []).filter(Boolean).join(', ')}`);
        break;
    }
  });

  ws.on('close', () => {
    if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
    console.log('  Disconnected. Reconnecting in 5 s…');
    reconnectTimer = setTimeout(connect, 5000);
  });

  ws.on('error', err => {
    console.error('  WS error:', err.message);
  });
}

// ─── Start ────────────────────────────────────────────────────────────────────

console.log('\n  FindInTosh Agent\n');
connect();
