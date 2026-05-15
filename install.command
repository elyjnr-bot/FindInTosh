#!/usr/bin/env bash
# FindInTosh — Mac agent installer
# Double-click this file in Finder to install.

set -e

RELAY_URL="${RELAY_URL:-wss://gracious-enthusiasm-production-fb7b.up.railway.app}"
INSTALL_DIR="$HOME/.findintosh"
AGENT_FILE="$INSTALL_DIR/agent.js"
PKG_FILE="$INSTALL_DIR/package.json"
PLIST="$HOME/Library/LaunchAgents/app.findintosh.agent.plist"
BASE_URL="${RELAY_URL/wss:\/\//https://}"
BASE_URL="${BASE_URL/ws:\/\//http://}"

clear
echo ""
echo "  ╔══════════════════════════════════════╗"
echo "  ║       FindInTosh — Installing        ║"
echo "  ╚══════════════════════════════════════╝"
echo ""

# ── 1. Homebrew ────────────────────────────────────────────────────────────────
if ! command -v brew &>/dev/null; then
  echo "  [1/4] Installing Homebrew (this may take a few minutes)…"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  # Add brew to PATH for Apple Silicon
  if [[ -f /opt/homebrew/bin/brew ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  fi
else
  echo "  [1/4] Homebrew — already installed ✓"
fi

# ── 2. Node.js ────────────────────────────────────────────────────────────────
if ! command -v node &>/dev/null; then
  echo "  [2/4] Installing Node.js…"
  brew install node
else
  echo "  [2/4] Node.js — already installed ✓"
fi

# ── 3. Download agent ─────────────────────────────────────────────────────────
echo "  [3/4] Downloading FindInTosh agent…"
mkdir -p "$INSTALL_DIR"
curl -fsSL "${BASE_URL}/agent.js"      -o "$AGENT_FILE"
curl -fsSL "${BASE_URL}/package.json"  -o "$PKG_FILE"
cd "$INSTALL_DIR"
npm install --omit=dev --silent

# ── 4. LaunchAgent (auto-start at login) ──────────────────────────────────────
echo "  [4/4] Setting up auto-start at login…"
NODE_BIN="$(command -v node)"

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
echo "  Your Mac app will open in your browser in a few seconds…"
echo "  (If it doesn't, check: tail -f ~/.findintosh/agent.log)"
echo ""
echo "  You can close this window."
echo ""

# Keep window open briefly so user can read it
sleep 4
