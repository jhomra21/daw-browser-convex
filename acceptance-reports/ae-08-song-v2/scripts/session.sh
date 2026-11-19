#!/bin/sh
# Drives one full v2 session in the open (new, empty) project. Every daw-control call must succeed.
set -eu
cd /Users/juan/Documents/daw-browser-convex
export DAW_DESKTOP_USER_DATA=/tmp/song/profile DAW_CONTROL_AUTH_PATH=/tmp/song/profile/control-auth.json
C="bun packages/control-cli/dist/daw-control.js"
log() { echo "[$(date +%H:%M:%S)] $*"; }
ok() { out=$("$@"); echo "$out" | grep -q '"ok":true' || { echo "FAILED: $* -> $out"; exit 1; }; }
shot() { AGENT_BROWSER_SESSION=song2 agent-browser screenshot "$OUT/shot-$1.png" >/dev/null; }
OUT="$1"; mkdir -p "$OUT"
log import samples
for n in kick rim snare clap hat shaker ohat crash riser-long riser-short swell impact bell texture voice; do ok $C host import --path /tmp/song2/samples/$n.wav; done
i=0; while [ "$(cd /tmp/song2 && bun check.ts | grep -o '\.wav' | wc -l | tr -d ' ')" -lt 15 ] && [ $i -lt 30 ]; do sleep 1; i=$((i+1)); done
shot 01-imported
log build tracks, instruments and patches
(cd /tmp/song2 && bun song2.ts setup instruments patches)
shot 02-tracks
log clips and devices while playing
ok $C host seek 0; ok $C host play
(cd /tmp/song2 && bun song2.ts clips clips-2)
sleep 4; shot 03-clips-playing
(cd /tmp/song2 && bun song2.ts effects tune)
sleep 3; shot 04-devices-playing
(cd /tmp/song2 && bun song2.ts mix automation polish)
sleep 3; shot 05-mixed-playing
ok $C host stop
log full playback from the top
ok $C host seek 0; ok $C host play
for t in 06 07 08 09 10 11; do sleep 5; shot $t-playback; done
ok $C host stop
log export
rm -f "$OUT/macros-coming-soon-score-v2.wav"
printf '%s' '{"mode":"mixdown","format":"wav","destination":{"kind":"file","path":"'"$OUT"'/macros-coming-soon-score-v2.wav"},"range":{"mode":"custom","startSec":0,"endSec":29},"render":{"sampleRate":48000,"channels":2,"normalization":{"mode":"none"},"tail":{"mode":"none"}},"encoding":{"wav":{"codec":"pcm-s24","dither":"none"}}}' > "$OUT/export-request.json"
ok $C host export --request "$OUT/export-request.json"
i=0; while :; do s=$($C host export-status); case "$s" in *'"running"'*|*'"queued"'*) sleep 1; i=$((i+1)); [ $i -lt 120 ] || { echo "export timeout"; exit 1; };; *) break;; esac; done
echo "$s" | grep -q '"completed"' || { echo "EXPORT FAILED: $s"; exit 1; }
shot 12-exported
log done
