#!/usr/bin/env bash
# FindInTosh — Mac agent installer

set -e

RELAY_URL="${RELAY_URL:-wss://findintosh-production.up.railway.app}"
INSTALL_DIR="$HOME/.findintosh"
AGENT_FILE="$INSTALL_DIR/agent.js"
PLIST="$HOME/Library/LaunchAgents/app.findintosh.agent.plist"
BASE_URL="${RELAY_URL/wss:\/\//https://}"
BASE_URL="${BASE_URL/ws:\/\//http://}"

clear
echo ""
echo "  ╔══════════════════════════════════════╗"
echo "  ║       FindInTosh — Installing        ║"
echo "  ╚══════════════════════════════════════╝"
echo ""

# ── 1. Node.js ────────────────────────────────────────────────────────────────
NODE_BIN=""

# Check common locations
for candidate in \
    "$(command -v node 2>/dev/null)" \
    /usr/local/bin/node \
    /opt/homebrew/bin/node \
    "$HOME/.nvm/versions/node/$(ls "$HOME/.nvm/versions/node/" 2>/dev/null | sort -V | tail -1)/bin/node" \
    /usr/local/opt/node/bin/node; do
  if [[ -x "$candidate" ]]; then
    NODE_BIN="$candidate"
    break
  fi
done

if [[ -z "$NODE_BIN" ]]; then
  echo "  [!] Node.js not found."
  echo ""
  echo "  Install it from https://nodejs.org (LTS version)"
  echo "  then re-run this script."
  echo ""
  exit 1
fi

echo "  [1/3] Node.js found: $NODE_BIN ✓"
NPM_BIN="$(dirname "$NODE_BIN")/npm"

# ── 2. Download agent ─────────────────────────────────────────────────────────
echo "  [2/3] Downloading FindInTosh agent…"
mkdir -p "$INSTALL_DIR"
curl -fsSL "${BASE_URL}/agent.js"     -o "$AGENT_FILE"
curl -fsSL "${BASE_URL}/package.json" -o "$INSTALL_DIR/package.json"
cd "$INSTALL_DIR"
"$NPM_BIN" install --omit=dev --silent

# ── 3. LaunchAgent (auto-start at login) ──────────────────────────────────────
echo "  [3/3] Setting up auto-start at login…"

cat > "$PLIST" <<PLISTEOF
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
PLISTEOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load -w "$PLIST"

echo ""
echo "  ✅  FindInTosh installed and running!"
echo ""
echo "  Your browser will open in a few seconds…"
echo "  (If not: tail -f ~/.findintosh/agent.log)"
echo ""
