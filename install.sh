#!/usr/bin/env bash
# FindInTosh — Mac agent installer
# Works on any Mac (macOS 12+), no Homebrew or prior Node.js needed.

set -e

RELAY_URL="${RELAY_URL:-wss://findintosh-production.up.railway.app}"
INSTALL_DIR="$HOME/.findintosh"
NODE_DIR="$INSTALL_DIR/node"
AGENT_FILE="$INSTALL_DIR/agent.js"
PLIST="$HOME/Library/LaunchAgents/app.findintosh.agent.plist"
BASE_URL="${RELAY_URL/wss:\/\//https://}"
BASE_URL="${BASE_URL/ws:\/\//http://}"
NODE_VERSION="20.17.0"

clear
echo ""
echo "  ╔══════════════════════════════════════╗"
echo "  ║       FindInTosh — Installing        ║"
echo "  ╚══════════════════════════════════════╝"
echo ""

mkdir -p "$INSTALL_DIR"

# ── 1. Node.js ────────────────────────────────────────────────────────────────

# Check if a usable node already exists (system or bundled)
NODE_BIN=""
for candidate in \
    "$NODE_DIR/bin/node" \
    "$(command -v node 2>/dev/null)" \
    /usr/local/bin/node \
    /opt/homebrew/bin/node; do
  if [[ -x "$candidate" ]]; then
    NODE_BIN="$candidate"
    break
  fi
done

if [[ -z "$NODE_BIN" ]]; then
  echo "  [1/3] Installing Node.js ${NODE_VERSION}…"

  # Detect chip
  ARCH=$(uname -m)
  [[ "$ARCH" == "arm64" ]] && NODE_ARCH="arm64" || NODE_ARCH="x64"

  NODE_TAR="node-v${NODE_VERSION}-darwin-${NODE_ARCH}.tar.gz"
  NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_TAR}"

  echo "        Downloading (this may take ~30 seconds)…"
  curl -fsSL "$NODE_URL" -o "/tmp/$NODE_TAR"
  mkdir -p "$NODE_DIR"
  tar -xzf "/tmp/$NODE_TAR" -C "$NODE_DIR" --strip-components 1
  rm -f "/tmp/$NODE_TAR"

  NODE_BIN="$NODE_DIR/bin/node"
  echo "  [1/3] Node.js installed ✓"
else
  echo "  [1/3] Node.js found ✓"
fi

NPM_BIN="$(dirname "$NODE_BIN")/npm"

# ── 2. Download agent ─────────────────────────────────────────────────────────
echo "  [2/3] Downloading FindInTosh agent…"
curl -fsSL "${BASE_URL}/agent.js"     -o "$AGENT_FILE"
curl -fsSL "${BASE_URL}/package.json" -o "$INSTALL_DIR/package.json"
cd "$INSTALL_DIR"
"$NPM_BIN" install --omit=dev --silent
echo "  [2/3] Agent downloaded ✓"

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

echo "  [3/3] Auto-start configured ✓"
echo ""
echo "  ✅  Done! Your browser will open in a few seconds."
echo ""
echo "  To check status:  tail -f ~/.findintosh/agent.log"
echo ""
