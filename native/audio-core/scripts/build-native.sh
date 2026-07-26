#!/bin/sh
set -eu

if ! command -v cmake >/dev/null 2>&1; then
  echo "cmake is required for the audio-core native build. Install CMake 3.20 or newer and rerun." >&2
  exit 127
fi

cmake -S native -B native/build/audio-core-debug -DDAW_BUILD_PLUGIN_HOST=OFF -DBUILD_TESTING=ON
cmake --build native/build/audio-core-debug
