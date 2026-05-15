// FindInTosh — Cloud relay server
// Deploys to Railway. Routes WebSocket messages between Mac agents and phones.
// Each Mac agent creates a "room"; phones/desktops join via ?room=ROOMID.

const http = require('http');
const fs   = require('fs');
const path = require('path');

let WebSocketServer;
try {
  ({ WebSocketServer } = require('ws'));
} catch {
  console.error('\n  Missing dependency. Run:  npm install\n');
  process.exit(1);
}

const PORT = process.env.PORT || 3000;
const DIR  = __dirname;

const MIME = {
  '.html':    'text/html',
  '.js':      'application/javascript',
  '.css':     'text/css',
  '.json':    'application/json',
  '.png':     'image/png',
  '.ico':     'image/x-icon',
  '.command': 'application/octet-stream',
  '.sh':      'text/plain',
};

// ─── Room state ───────────────────────────────────────────────────────────────
// rooms: roomId → { agent, desktop, phone, pairingCode, isPaired, dockApps }
const rooms = new Map();
// pairingCodes: code → roomId  (for no-room-param phone flow)
const pairingCodes = new Map();
// desktops waiting without a room — get claimed by next agent that connects
const waitingDesktops = new Set();

// Pending HTTP requests waiting for agent response
const pendingIcons = new Map();  // requestId → { res, timer }
const pendingApps  = new Map();  // requestId → { res, timer }

function randomDigits(n = 6) {
  return Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('');
}
function randomRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}
function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function getRoom(roomId) {
  return rooms.get(roomId);
}
function ensureRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      agent:       null,
      desktop:     null,
      phone:       null,
      pairingCode: randomDigits(),
      isPaired:    false,
      dockApps:    [],
    });
  }
  return rooms.get(roomId);
}
function cleanRoom(roomId) {
  const r = rooms.get(roomId);
  if (r && !r.agent && !r.desktop && !r.phone) {
    if (r.pairingCode) pairingCodes.delete(r.pairingCode);
    rooms.delete(roomId);
    console.log(`[~] room cleaned  ${roomId}`);
  }
}

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

// ─── HTTP server ──────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const url     = new URL(req.url, 'http://localhost');
  const urlPath = url.pathname;
  const roomId  = url.searchParams.get('room') || '';

  // ── GET /apps?room=XXX  → proxy to agent ─────────────────────────────────
  if (urlPath === '/apps') {
    const room = getRoom(roomId);
    if (!room || !room.agent) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end('[]');
      return;
    }
    const reqId = uid();
    const timer = setTimeout(() => {
      pendingApps.delete(reqId);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end('[]');
    }, 8000);
    pendingApps.set(reqId, { res, timer });
    send(room.agent, { type: 'get_apps', requestId: reqId });
    return;
  }

  // ── GET /icon/:name?room=XXX  → proxy to agent ───────────────────────────
  const iconMatch = urlPath.match(/^\/icon\/(.+)$/);
  if (iconMatch) {
    const appName = decodeURIComponent(iconMatch[1]);
    if (!/^[\w\s.\-()&+]+$/.test(appName)) { res.writeHead(400); res.end(); return; }
    const room = getRoom(roomId);
    if (!room || !room.agent) { res.writeHead(404); res.end(); return; }
    const reqId = uid();
    const timer = setTimeout(() => {
      pendingIcons.delete(reqId);
      res.writeHead(404); res.end();
    }, 8000);
    pendingIcons.set(reqId, { res, timer });
    send(room.agent, { type: 'get_icon', name: appName, requestId: reqId });
    return;
  }

  // ── Static files ──────────────────────────────────────────────────────────
  const staticMap = { '/': '/index.html', '/remote': '/app-mobile.html' };
  const filePath = path.join(DIR, staticMap[urlPath] || urlPath);
  if (!filePath.startsWith(DIR + path.sep) && filePath !== DIR) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath);
    const headers = { 'Content-Type': MIME[ext] || 'text/plain' };
    if (ext === '.command') {
      headers['Content-Disposition'] = 'attachment; filename="FindInTosh-install.command"';
    }
    res.writeHead(200, headers);
    res.end(data);
  });
});

// ─── WebSocket ────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const url    = new URL(req.url, 'http://localhost');
  let roomId   = url.searchParams.get('room') || null;
  let room     = null;

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    switch (msg.type) {

      // ── Agent starts up, creates or reclaims a room ──────────────────────
      case 'agent_register': {
        const savedId = msg.roomId;
        // If agent provides a saved room ID, always honour it (even after relay restart)
        if (savedId && /^[A-Z2-9]{4,8}$/.test(savedId)) {
          roomId = savedId;
          const existed = rooms.has(roomId);
          room   = ensureRoom(roomId); // creates with new pairing code if needed
          room.agent = ws;
          ws._roomId = roomId;
          ws._role   = 'agent';
          pairingCodes.set(room.pairingCode, roomId); // always update so find_and_pair works
          console.log(`[↩] agent reclaimed  room=${roomId}`);
        } else {
          // First time — generate a fresh room
          roomId     = randomRoomId();
          room       = ensureRoom(roomId);
          room.agent = ws;
          ws._roomId = roomId;
          ws._role   = 'agent';
          pairingCodes.set(room.pairingCode, roomId);
          console.log(`[+] agent  room=${roomId}`);
        }
        send(ws, { type: 'room_created', roomId, pairingCode: room.pairingCode });
        // Re-send init to desktop so it gets the current pairing code
        if (room.desktop) send(room.desktop, {
          type: 'init', code: room.pairingCode.split(''), roomId, paired: room.isPaired
        });
        // Claim any desktops that connected without a room
        for (const dws of waitingDesktops) {
          if (dws.readyState === 1) {
            room.desktop = dws;
            dws._roomId  = roomId;
            dws._role    = 'desktop';
            waitingDesktops.delete(dws);
            send(dws, { type: 'room_assigned', roomId, code: room.pairingCode.split(''), paired: room.isPaired });
            console.log(`    desktop claimed from waiting  room=${roomId}`);
            break; // one desktop per room
          }
        }
        break;
      }

      // ── Desktop or phone joins a room ─────────────────────────────────────
      case 'register': {
        if (!roomId && msg.role === 'desktop') {
          // Desktop with no room — put in waiting list, agent will claim it
          waitingDesktops.add(ws);
          ws._role = 'desktop_waiting';
          send(ws, { type: 'waiting_for_agent' });
          console.log(`    desktop waiting (no room)`);
          return;
        }
        if (!roomId) { send(ws, { type: 'error', message: 'Missing room ID' }); return; }
        room      = ensureRoom(roomId);
        ws._roomId = roomId;
        ws._role   = msg.role;

        if (msg.role === 'desktop') {
          room.desktop = ws;
          send(ws, {
            type: 'init',
            code:   room.pairingCode.split(''),
            roomId,
            paired: room.isPaired,
          });
          console.log(`    desktop  room=${roomId}`);
        } else if (msg.role === 'phone') {
          room.phone = ws;
          send(ws, { type: 'ready', paired: room.isPaired });
          console.log(`    phone    room=${roomId}`);
        }
        break;
      }

      // ── Phone submits pairing code ────────────────────────────────────────
      case 'pair': {
        if (!room) return;
        if (msg.code === room.pairingCode) {
          room.isPaired = true;
          send(room.phone,   { type: 'paired', device: `Mac (${roomId})`, osName: 'macOS', dockApps: room.dockApps });
          send(room.desktop, { type: 'phone_connected' });
          send(room.phone,   { type: 'dock_config', apps: room.dockApps });
          if (room.agent) send(room.agent, { type: 'phone_connected' });
          console.log(`[✓] paired  room=${roomId}`);
        } else {
          send(room.phone, { type: 'pair_error' });
        }
        break;
      }

      // ── Phone taps an icon → relay to agent ──────────────────────────────
      case 'launch': {
        if (!room || !room.isPaired) return;
        if (room.agent) send(room.agent, { type: 'launch', app: msg.app });
        send(room.desktop, { type: 'launching', app: msg.app, appName: msg.app });
        break;
      }

      // ── Agent reports launch result → relay to phone ──────────────────────
      case 'launch_result': {
        if (!room) return;
        send(room.phone, msg.success
          ? { type: 'launched',     app: msg.app }
          : { type: 'launch_error', app: msg.app });
        break;
      }

      // ── Agent responds to apps list request ───────────────────────────────
      case 'apps_response': {
        const pending = pendingApps.get(msg.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          pendingApps.delete(msg.requestId);
          pending.res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          pending.res.end(JSON.stringify(msg.apps || []));
        }
        break;
      }

      // ── Agent responds to icon request ────────────────────────────────────
      case 'icon_response': {
        const pending = pendingIcons.get(msg.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          pendingIcons.delete(msg.requestId);
          if (msg.data) {
            const buf = Buffer.from(msg.data, 'base64');
            pending.res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=86400' });
            pending.res.end(buf);
          } else {
            pending.res.writeHead(404); pending.res.end();
          }
        }
        break;
      }

      // ── Desktop saves dock config ─────────────────────────────────────────
      case 'save_dock': {
        if (!room) return;
        const incoming = (msg.apps || []).slice(0, 8).map(a =>
          (a && typeof a === 'string' && /^[\w\s.\-()&+]+$/.test(a)) ? a : null
        );
        room.dockApps = incoming;
        send(room.desktop, { type: 'dock_saved' });
        send(room.phone,   { type: 'dock_config', apps: room.dockApps });
        if (room.agent) send(room.agent, { type: 'dock_config', apps: room.dockApps });
        console.log(`[dock] room=${roomId}  ${room.dockApps.filter(Boolean).join(', ')}`);
        break;
      }

      // ── Phone joins by pairing code only (no room ID in URL) ────────────
      case 'find_and_pair': {
        const targetRoomId = pairingCodes.get(msg.code);
        if (!targetRoomId) { send(ws, { type: 'pair_error' }); return; }
        const targetRoom = rooms.get(targetRoomId);
        if (!targetRoom || !targetRoom.agent) { send(ws, { type: 'pair_error' }); return; }
        roomId          = targetRoomId;
        room            = targetRoom;
        room.phone      = ws;
        room.isPaired   = true;
        ws._roomId      = roomId;
        ws._role        = 'phone';
        send(ws, { type: 'paired', device: `Mac (${roomId})`, osName: 'macOS', dockApps: room.dockApps, roomId });
        send(room.desktop, { type: 'phone_connected' });
        if (room.agent) send(room.agent, { type: 'phone_connected' });
        console.log(`[✓] paired (find_and_pair)  room=${roomId}`);
        break;
      }

      // ── Desktop requests fresh pairing code ──────────────────────────────
      case 'refresh_code': {
        if (!room) return;
        pairingCodes.delete(room.pairingCode);
        room.pairingCode = randomDigits();
        pairingCodes.set(room.pairingCode, roomId);
        room.isPaired    = false;
        send(room.desktop, { type: 'init', code: room.pairingCode.split(''), roomId, paired: false });
        if (room.phone)  send(room.phone,  { type: 'code_refreshed' });
        if (room.agent)  send(room.agent,  { type: 'code_refreshed', pairingCode: room.pairingCode });
        console.log(`[↻] new code  room=${roomId}`);
        break;
      }
    }
  });

  ws.on('close', () => {
    waitingDesktops.delete(ws);
    if (!ws._roomId) return;
    const r = rooms.get(ws._roomId);
    if (!r) return;
    if (ws._role === 'agent') {
      r.agent = null;
      send(r.desktop, { type: 'agent_disconnected' });
      send(r.phone,   { type: 'agent_disconnected' });
      console.log(`[-] agent disconnected  room=${ws._roomId}`);
    } else if (ws._role === 'desktop') {
      r.desktop = null;
    } else if (ws._role === 'phone') {
      r.phone    = null;
      r.isPaired = false;
      send(r.desktop, { type: 'phone_disconnected' });
      if (r.agent) send(r.agent, { type: 'phone_disconnected' });
    }
    cleanRoom(ws._roomId);
  });

  ws.on('error', err => console.error('[!] ws error:', err.message));
});

// ─── Keep-alive: ping all clients every 25s ───────────────────────────────────
setInterval(() => {
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.ping();
  });
}, 25000);

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  FindInTosh Relay — port ${PORT}\n`);
});
