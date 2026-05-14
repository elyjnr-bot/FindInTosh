# FindInTosh

> Your phone, but for your computer.

Turn your iPhone into a one-tap app launcher for your Mac. Works over local Wi-Fi or from anywhere via the cloud relay.

---

## Cloud setup (recommended)

### 1. Deploy the relay to Railway

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app)

1. Fork this repo
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Railway auto-detects `railway.json` and runs `node relay.js`
4. Go to **Settings → Networking → Generate Domain**

### 2. Install the Mac agent

```bash
RELAY_URL=wss://your-app.up.railway.app \
  curl -fsSL https://your-app.up.railway.app/install.sh | bash
```

The agent starts automatically at login and prints your **Room ID**.

### 3. Open the apps

| Device | URL |
|--------|-----|
| Mac    | `https://your-app.up.railway.app/app-desktop.html?room=XXXXXX` |
| iPhone | `https://your-app.up.railway.app/app-mobile.html?room=XXXXXX` |

---

## Local setup (same Wi-Fi only)

```bash
npm install
npm run local        # starts server on port 7342
```

- Mac  → `http://localhost:7342/app-desktop.html`
- iPhone → `http://<mac-ip>:7342/app-mobile.html`

---

## Stack

- **relay.js** — Node.js WebSocket relay (Railway)
- **agent.js** — Local Mac agent (launches apps via `open -a`)
- **server.js** — All-in-one local server (no cloud needed)
- **app-desktop.html** — Mac dock manager (React + Babel CDN)
- **app-mobile.html** — iPhone remote (React + Babel CDN)
