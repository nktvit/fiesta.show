#!/usr/bin/env bash
# Installs the /tidal/seg audio route on the Mac mini relay (ssh alias `mm`).
# Safe to re-run: backs relay.mjs up first and only patches it once.
#   bash tools/fiesta-proxy/install-tidal-seg.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
D=/Users/ms/Server/relay.fiesta.show
TS=$(date -u +%Y%m%dT%H%M%SZ)

scp -q "$HERE/tidal-seg.mjs" "mm:$D/tidal-seg.mjs"
ssh mm "cd $D && cp relay.mjs relay.mjs.bak-$TS && node -e \"
const fs=require('fs');let s=fs.readFileSync('relay.mjs','utf8');
if(!s.includes('tidal-seg.mjs')){
  s=s.replace(\\\"import { handleTidalToken } from './tidal-session.mjs';\\\",\\\"import { handleTidalToken } from './tidal-session.mjs';\\nimport { handleTidalSeg } from './tidal-seg.mjs';\\\");
  s=s.replace(\\\"    if (url.pathname === '/tidal/token') return await handleTidalToken(req, res, SECRET);\\\",\\\"    if (url.pathname === '/tidal/token') return await handleTidalToken(req, res, SECRET);\\n    if (url.pathname === '/tidal/seg') return await handleTidalSeg(req, res, url, SECRET, setCors);\\\");
  fs.writeFileSync('relay.mjs',s);
}
if(!s.includes('handleTidalSeg(req')){console.error('PATCH FAILED: relay.mjs layout changed');process.exit(1);}
console.log('relay.mjs patched');\" && node --check relay.mjs && node --check tidal-seg.mjs && echo SYNTAX_OK \
  && launchctl kickstart -k gui/\$(id -u)/show.fiesta.relay && sleep 3 \
  && curl -s -o /dev/null -w 'healthz %{http_code}\n' http://localhost:8787/healthz \
  && curl -s -w ' <- /tidal/seg without token (expect 403)\n' http://localhost:8787/tidal/seg"
echo "backup on the box: $D/relay.mjs.bak-$TS (restore + kickstart to roll back)"
