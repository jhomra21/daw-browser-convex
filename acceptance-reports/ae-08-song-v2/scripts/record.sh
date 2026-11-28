#!/bin/sh
# usage: record.sh outdir  -> screen recording of one complete v2 session, the export, and the scored trailer
set -u
OUT="$1"; mkdir -p "$OUT"
TRAILER=/Users/juan/.t3/worktrees/cal-macro-tracker/trailer-transitions/build/marketing/trailer/coming-soon.mp4
ffmpeg -hide_banner -loglevel warning -f avfoundation -capture_cursor 1 -framerate 15 -i "Capture screen 0:none" -vf "scale=1512:-2" -c:v h264_videotoolbox -b:v 3500k -pix_fmt yuv420p "$OUT/screen-recording.mkv" > "$OUT/ffmpeg.log" 2>&1 &
FPID=$!
sleep 3
osascript -e 'tell application "System Events" to tell (first process whose name contains "daw-browser") to set frontmost to true' >/dev/null
sleep 1
osascript -e 'tell application "System Events" to tell (first process whose name contains "daw-browser") to click menu item "New Project" of menu "File" of menu bar 1' >/dev/null
sleep 3
AGENT_BROWSER_SESSION=song2 agent-browser console --clear >/dev/null 2>&1
sh /tmp/song2/session.sh "$OUT" > "$OUT/session.log" 2>&1
STATUS=$?
sleep 2
kill -INT $FPID; wait $FPID
echo "session exit $STATUS"
AGENT_BROWSER_SESSION=song2 agent-browser console > "$OUT/renderer-console.log" 2>&1
AGENT_BROWSER_SESSION=song2 agent-browser errors > "$OUT/renderer-errors.log" 2>&1
[ $STATUS -eq 0 ] && ffmpeg -hide_banner -loglevel error -y -i "$TRAILER" -i "$OUT/macros-coming-soon-score-v2.wav" -map 0:v -map 1:a -c:v copy -c:a aac -b:a 256k -shortest "$OUT/coming-soon-scored-v2.mp4"
exit $STATUS
