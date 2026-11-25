#!/bin/zsh
# Detects the "backend migration" resolve-failure signature (the SAME structural
# error across multiple different titles) in relay.log and, if found, invokes a
# scoped headless Claude Code agent to diagnose and patch relay.mjs live.
#
# Runs on a launchd StartInterval (not tail -f) so there's no persistent process
# to leak across restarts. A flock prevents overlapping runs; a cooldown file
# prevents re-triggering while a just-deployed fix is still stabilizing.
set -euo pipefail

DIR="/Users/ms/Server/relay.fiesta.show"
LOG="$DIR/relay.log"
STATE_DIR="$DIR/.autofix"
CHECKPOINT="$STATE_DIR/checkpoint"
COOLDOWN="$STATE_DIR/cooldown"
LOCKDIR="$STATE_DIR/lock.d"
AUTOFIX_LOG="$STATE_DIR/autofix.log"
MIN_DISTINCT_TITLES=3
COOLDOWN_SECONDS=1200
STALE_LOCK_SECONDS=1200   # longer than any expected claude -p run; recovers from a crashed prior run

mkdir -p "$STATE_DIR"

# macOS has no flock(1); use an atomic mkdir as the lock, with stale-lock recovery.
if ! mkdir "$LOCKDIR" 2>/dev/null; then
  if [[ -f "$LOCKDIR/started" ]]; then
    STARTED=$(cat "$LOCKDIR/started")
    NOW=$(date +%s)
    if (( NOW - STARTED > STALE_LOCK_SECONDS )); then
      rm -rf "$LOCKDIR"
      mkdir "$LOCKDIR" 2>/dev/null || exit 0
    else
      exit 0   # a fix is already in progress
    fi
  else
    exit 0
  fi
fi
date +%s > "$LOCKDIR/started"
trap 'rm -rf "$LOCKDIR"' EXIT

TOTAL=$(wc -l < "$LOG" | tr -d ' ')

if [[ ! -f "$CHECKPOINT" ]]; then
  echo "$TOTAL" > "$CHECKPOINT"
  exit 0   # first run: establish baseline, don't reprocess history
fi

LAST=$(cat "$CHECKPOINT")
if (( TOTAL <= LAST )); then
  echo "$TOTAL" > "$CHECKPOINT"   # log rotated/truncated — reset
  exit 0
fi

NEW_LINES=$(tail -n "+$((LAST + 1))" "$LOG")
echo "$TOTAL" > "$CHECKPOINT"

if [[ -f "$COOLDOWN" ]]; then
  LAST_TRIGGER=$(cat "$COOLDOWN")
  NOW=$(date +%s)
  if (( NOW - LAST_TRIGGER < COOLDOWN_SECONDS )); then
    exit 0
  fi
fi

# Candidates: resolve failures, excluding known-benign 404s (title just isn't on
# source) and Turnstile timeouts (IP-reputation issue, not a code bug — no fix
# to write).
# relay.mjs now prefixes every console line with an ISO-8601 timestamp, so the
# anchor and the awk field offsets below both shifted by one field. Kept anchored
# (not a bare \[resolve\]) so a message that merely CONTAINS the word still cannot
# masquerade as a log line.
CANDIDATES=$(printf '%s\n' "$NEW_LINES" | grep -E '^[^ ]+ \[resolve\] tt[0-9]+ srv=[0-9]+ ' | grep -v 'status_code 404' | grep -vi 'turnstile' || true)

# Passive playback monitor (2026-11-19): relay.mjs writes `[health] TRIGGER ...` when 3 real /hls requests of one kind fail in a row
# across >= 2 movies (playlist unusable, upstream 4xx/5xx, a 'segment' that is really HTML/JSON). It fires the agent directly.
HEALTH=$(printf '%s\n' "$NEW_LINES" | grep -E '^[^ ]+ \[health\] TRIGGER ' | tail -1 || true)

if [[ -z "$CANDIDATES" && -z "$HEALTH" ]]; then
  exit 0
fi

# Group by message text, count distinct title ids per message; trigger only if
# the SAME message hit >= MIN_DISTINCT_TITLES different titles (the migration
# signature — a single title's own quirk should never trigger this).
RESULT=$(printf '%s\n' "$CANDIDATES" | awk -v min="$MIN_DISTINCT_TITLES" '
  {
    id = $3
    msg = ""
    for (i = 5; i <= NF; i++) msg = msg $i (i < NF ? " " : "")
    # Normalise what differs per title/host/second but is not the signature: the stream host and the cooldown countdown
    # ("generate cooling 113s for https://x.space"). Without this every line was its own message and a 6-day outage
    # (2026-11-07..13, 5 distinct titles failing inside ten minutes) never reached 3 identical ones (it never fired).
    gsub(/https?:\/\/[^ )]+/, "<host>", msg)
    gsub(/[0-9]+s( |$)/, "Ns ", msg)
    combo = msg SUBSEP id
    if (!(combo in seen)) { seen[combo] = 1; count[msg]++ }
  }
  END {
    best = 0; bestmsg = ""
    for (m in count) { if (count[m] > best) { best = count[m]; bestmsg = m } }
    if (best >= min) print best "\t" bestmsg
  }
')

if [[ -z "$RESULT" && -z "$HEALTH" ]]; then
  exit 0
fi

COUNT=$(printf '%s' "$RESULT" | cut -f1)
MSG=$(printf '%s' "$RESULT" | cut -f2)
if [[ -n "$HEALTH" ]]; then
  COUNT=3
  MSG="${HEALTH#* }"
fi

date +%s > "$COOLDOWN"
{
  echo ""
  echo "===== $(date '+%Y-%m-%d %H:%M:%S %Z') ====="
  if [[ -n "$HEALTH" ]]; then echo "TRIGGER (playback health): $MSG"; else echo "TRIGGER: $COUNT distinct titles failing /resolve with identical error: $MSG"; fi
} >> "$AUTOFIX_LOG"

PROMPT=$(cat <<PROMPTEOF
You are maintaining a production Node.js HLS relay server at $DIR (relay.mjs, launchd service 'show.fiesta.relay', log at $LOG).

AUTOMATED ALERT: relay.log shows $COUNT distinct titles failing /resolve with the IDENTICAL error: "$MSG"

This exact signature — the SAME structural error across MULTIPLE DIFFERENT titles — means the upstream video-source site (accessed via fronts vidsrc.me/vsembed.ru -> vidsrcme.ru -> cloudorchestranova.com -> data.vidsrcme.ru) has changed its markup/API again, breaking the relay's embed-chain resolver for everyone. This has happened before (2026-08-19: cloudnestra.com -> cloudorchestranova.com full migration; 2026-08-24: #player_iframe lost its static src=, replaced by a data-api="/vs_src.php?..." gate endpoint returning {"src": "..."}) — both times root-caused by manually curling the chain step by step and diffing the actual HTML/JSON against what relay.mjs's resolver code expects.

Do this, in order:
1. Read relay.mjs to understand the current resolver chain (fetchText, walkFromEmbed, walkFromLayer2, resolveMasterOnce, resolveMasterBrowser, extractPlayerIframeApi, extractInlineJSON, decryptStreamUrls, getHostToken).
2. Reproduce the failure by manually curling a known-good title (tt1375666 movie, or tt0944947 s1e1 tv) through each hop of the chain with a realistic desktop User-Agent, correctly chaining Referer as each hop's POST-REDIRECT url (not the pre-redirect one — that mismatch has caused false 403s before). Find exactly which hop now returns something the code doesn't expect.
3. Diff the real response against what the code parses. Make the MINIMAL code change in relay.mjs to handle the new shape — do not rewrite unrelated working code. If the changed step is shared by both the plain-fetch path (walkFromEmbed) and the Playwright browser-fallback path (resolveMasterBrowser), patch both — grep for the relevant function/logic to find all call sites.
4. Verify: run "node --check relay.mjs", then restart the service with "launchctl kickstart -k gui/\$(id -u)/show.fiesta.relay", wait 2 seconds, then make live test calls:
   SECRET=\$(grep '^RELAY_SECRET=' $DIR/.env.local | cut -d= -f2- | sed 's/^"//;s/"\$//')
   curl -s -H "Authorization: Bearer \$SECRET" "http://127.0.0.1:8787/resolve?type=movie&id=tt1375666"
   curl -s -H "Authorization: Bearer \$SECRET" "http://127.0.0.1:8787/resolve?type=tv&id=tt0944947&s=1&e=1"
   Both must return {"master": "https://relay.fiesta.show/hls?..."} with no error field. Then curl the returned master URL and confirm it returns a real "#EXTM3U" playlist body.
5. Tail the last ~20 lines of $LOG after your test calls and confirm no new resolve errors for your test titles.
6. Append a dated summary to $AUTOFIX_LOG (use >> to append, never overwrite) describing: what broke, what you changed (file:line), and the verification result (PASS/FAIL). If you could NOT fix it confidently — the failure isn't a simple markup/shape change, or it needs a decision only a human should make, or your fix didn't verify clean — revert your edit (restore the original code, re-run node --check, restart the service again so the box is left in its prior working state) and append "NEEDS HUMAN: <why>" to $AUTOFIX_LOG instead.

Constraints: only touch files under $DIR. There is no git here — do not attempt to init one. Do not delete or rewrite working parts of the resolver unrelated to this specific failure. You have one focused attempt — if your fix doesn't verify clean in step 4-5, revert it and report NEEDS HUMAN rather than iterating indefinitely.
PROMPTEOF
)

if [[ -n "$HEALTH" ]]; then
PROMPT=$(cat <<HEALTHEOF
You are maintaining a production Node.js HLS relay server at $DIR (relay.mjs, launchd service 'show.fiesta.relay', log at $LOG).

AUTOMATED ALERT (playback health monitor): real viewers' requests are failing. relay.mjs reported: "$MSG"

Meaning: 3 real /hls requests of that kind (playlist or segment) failed in a row, across at least 2 different movies, with no success of that kind in between. "/resolve" may still work fine; the break is at playback time (playlist rewriting, upstream token, upstream response shape, or a segment that is not media). The log has one "[health] fail kind=... key=... detail=..." line per failing request, just before the TRIGGER line: read them first.

Known precedent (2026-11-19): the provider started serving playlists as text/plain at /pl/<id> (no .m3u8) with 200, and only the master URL carried ?token=. relay.mjs served the playlist unrewritten (no error logged) and, after the first fix, child URLs lacked the token and got 403. Fixed in handleHls (sniff #EXTM3U in text/plain) and rewritePlaylist (carry the parent token). The provider changes things often; expect something similar but different.

Do this, in order:
1. Read the "[health] fail" lines and the last ~100 lines of $LOG. Then read relay.mjs: handleHls, rewritePlaylist, refetchWithFreshToken, getHostToken, fetchUpstream, noteHealth.
2. Reproduce through the relay itself (do NOT hammer the provider, do NOT spoof browser identities against its endpoints):
   SECRET=\$(grep '^RELAY_SECRET=' $DIR/.env.local | cut -d= -f2- | sed 's/^"//;s/"\$//')
   M=\$(curl -s -H "Authorization: Bearer \$SECRET" "http://127.0.0.1:8787/resolve?type=movie&id=tt0111161" | python3 -c "import json,sys; print(json.load(sys.stdin)['master'])")
   Then walk master -> first variant line -> first segment (relative lines are /hls?u=... on http://127.0.0.1:8787; decode the u= parameter, base64url, to see the real upstream URL). At every hop print status, content-type and the first 120 bytes.
3. Find the step where the real answer differs from what the code expects (content-type, missing #EXTM3U, missing token, new redirect, new path shape, non-media segment bytes) and make the MINIMAL change in relay.mjs. Before editing: cp relay.mjs relay.mjs.bak-autofix-\$(date +%Y%m%d-%H%M%S). Do not rewrite unrelated working code.
4. Verify: node --check relay.mjs; launchctl kickstart -k gui/\$(id -u)/show.fiesta.relay; sleep 3; then repeat step 2 for tt0111161 and tt0068646: master 200 with #EXTM3U and /hls?u= lines, variant 200, first segment 200 and not HTML/JSON.
5. Tail the last 20 lines of $LOG and confirm no new "[health] fail" lines from your test requests.
6. Append a dated summary to $AUTOFIX_LOG (>> only): what broke, what you changed (file:line), verification result (PASS/FAIL). If you could not fix it confidently, restore the backup, restart, and say exactly what you found and what a human must decide.

Constraints: only touch files under $DIR. There is no git here. One focused attempt. Never print or log RELAY_SECRET or any token.
HEALTHEOF
)
fi

claude -p "$PROMPT" \
  --allowedTools "Read" "Edit" "Bash" \
  --output-format text \
  --max-budget-usd 3 \
  --add-dir "$DIR" \
  >> "$AUTOFIX_LOG" 2>&1 || echo "claude -p exited non-zero" >> "$AUTOFIX_LOG"

echo "===== done $(date '+%Y-%m-%d %H:%M:%S %Z') =====" >> "$AUTOFIX_LOG"

osascript -e 'display notification "Autofix agent ran for relay.fiesta.show — check .autofix/autofix.log" with title "relay.fiesta.show" sound name "Glass"' >/dev/null 2>&1 || true
