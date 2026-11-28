#!/bin/sh
# usage: export.sh request.json
set -eu
cd /Users/juan/Documents/daw-browser-convex
export DAW_DESKTOP_USER_DATA=/tmp/song/profile DAW_CONTROL_AUTH_PATH=/tmp/song/profile/control-auth.json
C="bun packages/control-cli/src/index.ts"
$C host export --request "$1" > /dev/null
i=0
while [ $i -lt 120 ]; do
  s=$($C host export-status)
  case "$s" in *'"running"'*|*'"queued"'*) sleep 2; i=$((i+1));; *) break;; esac
done
echo "$s" | head -c 1500; echo
