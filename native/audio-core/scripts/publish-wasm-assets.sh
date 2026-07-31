#!/bin/sh
set -eu

if [ "$#" -ne 2 ]; then
  echo "Usage: sh publish-wasm-assets.sh <staging-dir> <public-artifact-dir>" >&2
  exit 2
fi

staging_dir=$1
public_artifact_dir=$2
public_parent=$(dirname "$public_artifact_dir")
backup_dir=
old_move_started=0
old_moved=0
new_move_started=0
new_moved=0

remove_known_assets() {
  directory=$1
  for asset in \
    daw-audio-core.wasm \
    daw-audio-core.manifest.json \
    daw-audio-core-wasm-harness.wasm \
    daw-audio-core-wasm-harness.manifest.json
  do
    asset_path="$directory/$asset"
    if [ -f "$asset_path" ] || [ -L "$asset_path" ]; then
      rm -f "$asset_path"
    fi
  done
}

cleanup() {
  status=$?
  trap - EXIT HUP INT TERM

  if [ "$status" -ne 0 ]; then
    if [ "$new_move_started" -eq 1 ] && [ ! -e "$staging_dir" ] && [ -e "$public_artifact_dir" ]; then
      new_moved=1
    fi
    if [ "$old_move_started" -eq 1 ] && [ ! -e "$public_artifact_dir" ] && [ -e "$backup_dir" ]; then
      old_moved=1
    fi
    if [ "$new_moved" -eq 1 ] && [ -e "$public_artifact_dir" ] && [ ! -e "$staging_dir" ]; then
      mv "$public_artifact_dir" "$staging_dir" || true
    fi
    if [ "$old_moved" -eq 1 ] && [ ! -e "$public_artifact_dir" ] && [ -e "$backup_dir" ]; then
      mv "$backup_dir" "$public_artifact_dir" || true
    fi
  elif [ -n "$backup_dir" ] && [ -e "$backup_dir" ]; then
    remove_known_assets "$backup_dir"
    rmdir "$backup_dir" 2>/dev/null || true
  fi

  if [ -e "$staging_dir" ]; then
    remove_known_assets "$staging_dir"
    rmdir "$staging_dir" 2>/dev/null || true
  fi
  exit "$status"
}

trap cleanup EXIT
trap 'exit 1' HUP INT TERM

if [ ! -d "$staging_dir" ]; then
  echo "Wasm staging directory is unavailable: $staging_dir" >&2
  exit 1
fi
if [ ! -f "$staging_dir/daw-audio-core.wasm" ] \
  || [ ! -f "$staging_dir/daw-audio-core.manifest.json" ]; then
  echo "Wasm staging directory is incomplete: $staging_dir" >&2
  exit 1
fi
if [ -e "$public_artifact_dir" ] && [ ! -d "$public_artifact_dir" ]; then
  echo "Public Wasm asset path is not a directory: $public_artifact_dir" >&2
  exit 1
fi

mkdir -p "$public_parent"
backup_dir=$(mktemp -d "$public_parent/.audio-core-backup.XXXXXX")
rmdir "$backup_dir"

if [ -e "$public_artifact_dir" ]; then
  old_move_started=1
  mv "$public_artifact_dir" "$backup_dir"
  old_moved=1
fi

new_move_started=1
mv "$staging_dir" "$public_artifact_dir"
new_moved=1
