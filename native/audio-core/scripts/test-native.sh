#!/bin/sh
set -eu

if ! command -v cmake >/dev/null 2>&1; then
  echo "cmake is required for audio-core native tests. Install CMake 3.20 or newer and rerun." >&2
  exit 127
fi

bun native/audio-core/scripts/generate-compiled-processors.ts --check
sh native/audio-core/scripts/build-native.sh

ctest --test-dir native/build/audio-core-debug --output-on-failure
