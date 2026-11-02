#!/usr/bin/env bash
# Installs the torrent box + the /torrent/* relay routes on the Mac mini (ssh alias `mm`).
# Safe to re-run: backs relay.mjs up first, patches it once, keeps an existing token.
#   bash tools/fiesta-proxy/install-torrent.sh
# Downloads go to /Volumes/Monster/Torrents ONLY: the box refuses to start unless that is an
# external, non-SSD disk (tools/torrent-box/disk-guard.mjs).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
BOX_SRC="$HERE/../torrent-box"
R=/Users/ms/Server/relay.fiesta.show
B=/Users/ms/Server/torrent-box
NODE_DIR=/Users/ms/.nvm/versions/node/v22.17.0/bin
TS=$(date -u +%Y%m%dT%H%M%SZ)
LABEL=show.fiesta.torrent

# 1. box files (no node_modules), deps installed on the box
ssh mm "mkdir -p $B"
rsync -a --delete --exclude node_modules --exclude .gitignore "$BOX_SRC/" "mm:$B/"
ssh mm "cd $B && PATH=$NODE_DIR:\$PATH npm install --omit=dev --no-audit --no-fund --silent"

# 2. token shared by the box and the relay (generated once)
TOKEN=$(ssh mm "grep -s '^TORRENT_TOKEN=' $R/.env.local | cut -d= -f2-" || true)
if [ -z "$TOKEN" ]; then
  TOKEN=$(openssl rand -hex 24)
  ssh mm "cp -n $R/.env.local $R/.env.local.bak-$TS; printf '\nTORRENT_TOKEN=%s\n' '$TOKEN' >> $R/.env.local"
fi

# 3. launchd service for the box (127.0.0.1 only)
ssh mm "cat > ~/Library/LaunchAgents/$LABEL.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$NODE_DIR/node</string><string>$B/server.mjs</string></array>
  <key>WorkingDirectory</key><string>$B</string>
  <key>EnvironmentVariables</key><dict>
    <key>TORRENT_TOKEN</key><string>$TOKEN</string>
    <key>TORRENT_DIR</key><string>/Volumes/Monster/Torrents</string>
    <key>PORT</key><string>8790</string>
    <key>HOST</key><string>127.0.0.1</string>
    <key>FFMPEG</key><string>/opt/homebrew/bin/ffmpeg</string>
    <key>FFPROBE</key><string>/opt/homebrew/bin/ffprobe</string>
  </dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$B/box.log</string>
  <key>StandardErrorPath</key><string>$B/box.log</string>
</dict></plist>
PLIST
ssh mm "chmod 600 ~/Library/LaunchAgents/$LABEL.plist; launchctl bootout gui/\$(id -u)/$LABEL 2>/dev/null; launchctl bootstrap gui/\$(id -u) ~/Library/LaunchAgents/$LABEL.plist"

# 4. relay: module + one import + one route line
scp -q "$HERE/torrent-routes.mjs" "mm:$R/torrent-routes.mjs"
ssh mm "cd $R && cp relay.mjs relay.mjs.bak-$TS && $NODE_DIR/node -e \"
const fs=require('fs');let s=fs.readFileSync('relay.mjs','utf8');
if(!s.includes('torrent-routes.mjs')){
  s=s.replace(\\\"import { handleTidalSeg } from './tidal-seg.mjs';\\\",\\\"import { handleTidalSeg } from './tidal-seg.mjs';\\nimport { handleTorrent } from './torrent-routes.mjs';\\\");
  s=s.replace(\\\"    if (url.pathname === '/tidal/token')\\\",\\\"    if (url.pathname.startsWith('/torrent/')) return await handleTorrent(req, res, url, { SECRET, PUBLIC_URL, setCors, mintToken, verifyToken });\\n    if (url.pathname === '/tidal/token')\\\");
  fs.writeFileSync('relay.mjs',s);
}
if(!s.includes('handleTorrent(req')){console.error('PATCH FAILED: relay.mjs layout changed');process.exit(1);}
console.log('relay.mjs patched');\" && $NODE_DIR/node --check relay.mjs && $NODE_DIR/node --check torrent-routes.mjs && echo SYNTAX_OK \
  && launchctl kickstart -k gui/\$(id -u)/show.fiesta.relay && sleep 3 \
  && curl -s -o /dev/null -w 'healthz %{http_code}\n' http://localhost:8787/healthz \
  && curl -s -o /dev/null -w '/torrent/x without secret %{http_code} (expect 401)\n' http://localhost:8787/torrent/x"
sleep 2
ssh mm "tail -5 $B/box.log"
echo "relay backup: $R/relay.mjs.bak-$TS (restore + kickstart to roll back)"
