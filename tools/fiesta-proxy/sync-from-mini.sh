#!/bin/bash
# Refresh tools/fiesta-proxy/deployed/ from the live relay on the Mac mini (`ssh mm`).
# The relay directory there is NOT a git repo, so this snapshot is how changes get into version control.
# Copies code only: never .env*, tidal-session.json, .relayctl.json, relay.log, .autofix state or node_modules.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REMOTE=/Users/ms/Server/relay.fiesta.show
mkdir -p "$HERE/deployed/scripts"
for f in relay.mjs tidal-seg.mjs tidal-session.mjs torrent-routes.mjs package.json; do
  scp -q "mm:$REMOTE/$f" "$HERE/deployed/$f"
done
for f in autofix-watchdog.sh show.fiesta.relay.autofix.plist; do
  scp -q "mm:$REMOTE/scripts/$f" "$HERE/deployed/scripts/$f"
done
echo "synced:"; wc -c "$HERE"/deployed/*.mjs "$HERE"/deployed/scripts/* | sed 's#.*/tools/#tools/#'
