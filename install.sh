#!/usr/bin/env bash
# FindInTosh — Mac agent installer
# Usage:  curl -fsSL https://your-relay.up.railway.app/install.sh | bash

set -e

RELAY_URL="${RELAY_URL:-wss://findintosh.up.railway.app}"
INSTALL_DIR="$HOME/.findintosh"
AGENT_FILE="$INSTALL_DIR/agent.js"
PLIST="$HOME/Library/LaunchAgents/app.findintosh.agent.plist"

echo ""
echo "  FindInTosh — installing Mac agent"
echo ""

# ── 1. Homebrew ────────────────────────────────────────────────────────────────
if ! command -v brew &>/dev/null; then
  echo "  Installing Homebrew…"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi

# ── 2. Node.js ────────────────────────────────────────────────────────────────
if ! command -v node &>/dev/null; then
  echo "  Installing Node.js…"
  brew install node
fi

# ── 3. Create install dir ─────────────────────────────────────────────────────
mkdir -p "$INSTALL_DIR"

# ── 4. Download agent.js ──────────────────────────────────────────────────────
echo "  Downloading agent…"
curl -fsSL "${RELAY_URL/wss:\/\//https://}/agent.js" -o "$AGENT_FILE"
curl -fsSL "${RELAY_URL/wss:\/\//https://}/package.json" -o "$INSTALL_DIR/package.json"

cd "$INSTALL_DIR"
npm install --omit=dev --silent

# ── 5. LaunchAgent (auto-start at login) ──────────────────────────────────────
NODE_BIN="$(command -v node)"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>             <string>app.findintosh.agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${AGENT_FILE}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>RELAY_URL</key> <string>${RELAY_URL}</string>
  </dict>
  <key>RunAtLoad</key>         <true/>
  <key>KeepAlive</key>         <true/>
  <key>StandardOutPath</key>   <string>${INSTALL_DIR}/agent.log</string>
  <key>StandardErrorPath</key> <string>${INSTALL_DIR}/agent.log</string>
</dict>
</plist>
EOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load -w "$PLIST"

echo ""
echo "  ✅  Agent installed and running!"
echo ""
echo "  Your Room ID will appear in:  tail -f ~/.findintosh/agent.log"
echo ""
