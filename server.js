// FindInTosh — local WebSocket server
// Serves the HTML files and relays commands from phone → Mac app launcher.
//
// Usage:
//   npm install
//   node server.js
//
// Then open the URLs printed in the terminal.

const http = require('http');
const fs   = require('fs');
const path = require('path');
const { exec, execSync } = require('child_process');
const os   = require('os');

let WebSocketServer;
try {
  ({ WebSocketServer } = require('ws'));
} catch {
  console.error('\n  Missing dependency. Run:  npm install\n');
  process.exit(1);
}

// ─── Config ────────────────────────────────────────────────────────────────

const PORT = 7342;
const DIR  = __dirname;

// Whitelist — prevents any command injection via app ID
const APP_MAP = {
  launchpad: 'Launchpad',
  finder:    'Finder',
  siri:      'Siri',
  compass:   'Compass',
  music:     'Music',
  messages:  'Messages',
  discord:   'Discord',
  telegram:  'Telegram',
  figma:     'Figma',
  vscode:    'Visual Studio Code',
  chrome:    'Google Chrome',
  safari:    'Safari',
  notion:    'Notion',
  slack:     'Slack',
  spotify:   'Spotify',
  terminal:  'Terminal',
  mail:      'Mail',
  calendar:  'Calendar',
  notes:     'Notes',
  xcode:     'Xcode',
  photoshop: 'Adobe Photoshop 2024',
};

const MIME = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.jsx':  'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
};

// ─── Helpers ───────────────────────────────────────────────────────────────

function getLocalIP() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return '127.0.0.1';
}

function randomCode() {
  return Array.from({ length: 6 }, () => Math.floor(Math.random() * 10)).join('');
}

// ─── HTTP — API + static files ────────────────────────────────────────────

const ICON_CACHE = new Map(); // appName → tmpPngPath

function findIconPath(appPath) {
  // Read CFBundleIconFile from Info.plist
  try {
    const plist = `${appPath}/Contents/Info.plist`;
    let name = execSync(`/usr/libexec/PlistBuddy -c "Print CFBundleIconFile" "${plist}" 2>/dev/null`).toString().trim();
    if (!name.endsWith('.icns')) name += '.icns';
    const p = `${appPath}/Contents/Resources/${name}`;
    if (fs.existsSync(p)) return p;
  } catch {}
  // Fallback: any .icns in Resources
  try {
    const found = execSync(`find "${appPath}/Contents/Resources" -maxdepth 1 -name "*.icns" 2>/dev/null | head -1`).toString().trim();
    if (found && fs.existsSync(found)) return found;
  } catch {}
  return null;
}

const SEARCH_DIRS = ['/Applications', '/Applications/Utilities', '/System/Applications', '/System/Applications/Utilities', '/System/Library/CoreServices'];

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

const server = http.createServer((req, res) => {
  const urlPath = new URL(req.url, 'http://localhost').pathname;

  // ── GET /apps  → list of installed app names ──────────────────────────
  if (urlPath === '/apps') {
    const apps = listInstalledApps();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(apps));
    return;
  }

  // ── GET /icon/:name  → real app icon as PNG ───────────────────────────
  const iconMatch = urlPath.match(/^\/icon\/(.+)$/);
  if (iconMatch) {
    const appName = decodeURIComponent(iconMatch[1]);
    // Safety: only allow safe characters
    if (!/^[\w\s.\-()&]+$/.test(appName)) { res.writeHead(400); res.end(); return; }

    const safe = appName.replace(/[^\w]/g, '_');
    const tmpPng = `/tmp/ft_icon_${safe}.png`;

    const serve = () => {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=86400' });
      fs.createReadStream(tmpPng).pipe(res);
    };

    if (fs.existsSync(tmpPng)) { serve(); return; }

    const appPath = resolveAppPath(appName);
    if (!appPath) { res.writeHead(404); res.end(); return; }

    const icns = findIconPath(appPath);
    if (!icns) { res.writeHead(404); res.end(); return; }

    exec(`sips -s format png "${icns}" --out "${tmpPng}" 2>/dev/null`, err => {
      if (err || !fs.existsSync(tmpPng)) { res.writeHead(500); res.end(); return; }
      serve();
    });
    return;
  }

  // ── Static files ───────────────────────────────────────────────────────
  const filePath = path.join(DIR, urlPath === '/' ? '/app-desktop.html' : urlPath);
  if (!filePath.startsWith(DIR + path.sep) && filePath !== DIR) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'text/plain' });
    res.end(data);
  });
});

// ─── WebSocket ─────────────────────────────────────────────────────────────

const wss = new WebSocketServer({ server });

let pairingCode = randomCode();
let desktop     = null;
let phone       = null;
let isPaired    = false;
let dockApps    = ['launchpad','finder','siri','compass','music','messages','discord','telegram'];

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

wss.on('connection', (ws, req) => {
  const clientIP = req.socket.remoteAddress;
  console.log(`[+] connect  ${clientIP}`);

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    switch (msg.type) {

      // Both clients announce themselves on connect
      case 'register':
        if (msg.role === 'desktop') {
          desktop = ws;
          send(ws, {
            type: 'init',
            code: pairingCode.split(''),
            ip:   getLocalIP(),
            port: PORT,
            paired: isPaired,
          });
          console.log('    desktop registered');
        } else if (msg.role === 'phone') {
          phone = ws;
          send(ws, { type: 'ready', paired: isPaired });
          console.log('    phone registered');
        }
        break;

      // Phone submits the 6-char code
      case 'pair':
        if (ws !== phone) return;
        if (msg.code === pairingCode) {
          isPaired = true;
          send(phone,   { type: 'paired', device: os.hostname(), osName: 'macOS 15.4', dockApps });
          send(desktop, { type: 'phone_connected', ip: clientIP });
          // Send current dock config to phone immediately after pairing
          send(phone, { type: 'dock_config', apps: dockApps });
          console.log(`[✓] paired   phone ${clientIP}`);
        } else {
          send(phone, { type: 'pair_error' });
          console.log(`[✗] pair_fail  "${msg.code}" ≠ "${pairingCode}"`);
        }
        break;

      // Phone taps an app icon → launch on Mac
      case 'launch': {
        if (ws !== phone || !isPaired) return;
        // Accept both legacy ID (e.g. "spotify") and name string (e.g. "Spotify")
        const appName = APP_MAP[msg.app] || (typeof msg.app === 'string' && /^[\w\s.\-()&+]+$/.test(msg.app) ? msg.app : null);
        if (!appName) { console.warn(`[!] unknown app: ${msg.app}`); return; }
        console.log(`[→] launch   ${appName}`);
        send(desktop, { type: 'launching', app: msg.app, appName });
        exec(`open -a "${appName}"`, err => {
          if (err) {
            console.error(`[!] failed   ${appName}: ${err.message}`);
            send(phone, { type: 'launch_error', app: msg.app });
          } else {
            send(phone, { type: 'launched', app: msg.app });
          }
        });
        break;
      }

      // Desktop saves dock config
      case 'save_dock': {
        if (ws !== desktop) return;
        // Accept any safe app name string or null; strip anything unsafe
        const incoming = (msg.apps || []).slice(0, 8).map(a =>
          (a && typeof a === 'string' && /^[\w\s.\-()&+]+$/.test(a)) ? a : null
        );
        dockApps = incoming;
        send(desktop, { type: 'dock_saved' });
        send(phone,   { type: 'dock_config', apps: dockApps });
        console.log(`[dock] saved: ${dockApps.filter(Boolean).join(', ')}`);
        break;
      }

      case 'refresh_code':
        if (ws !== desktop) return;
        pairingCode = randomCode();
        isPaired    = false;
        send(desktop, {
          type: 'init',
          code: pairingCode.split(''),
          ip:   getLocalIP(),
          port: PORT,
          paired: false,
        });
        if (phone) send(phone, { type: 'code_refreshed' });
        console.log(`[↻] new code  ${pairingCode}`);
        break;
    }
  });

  ws.on('close', () => {
    console.log(`[-] disconnect ${clientIP}`);
    if (ws === desktop) { desktop = null; }
    if (ws === phone)   {
      phone    = null;
      isPaired = false;
      send(desktop, { type: 'phone_disconnected' });
    }
  });

  ws.on('error', err => console.error('[!] ws error:', err.message));
});

// ─── Start ─────────────────────────────────────────────────────────────────

const localIP = getLocalIP();

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  FindInTosh — server running');
  console.log('');
  console.log(`  Mac   →  http://localhost:${PORT}/app-desktop.html`);
  console.log(`  iPhone →  http://${localIP}:${PORT}/app-mobile.html`);
  console.log('');
  console.log(`  Code de pairing : ${pairingCode}`);
  console.log('');
});
