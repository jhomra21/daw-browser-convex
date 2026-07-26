#!/bin/sh
set -eu

sh native/audio-core/scripts/build-wasm.sh
sh native/audio-core/scripts/build-native.sh
bun test native/audio-core/tests/wasm_artifact.test.ts
