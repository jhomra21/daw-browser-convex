#!/bin/sh
set -eu

if ! command -v emcmake >/dev/null 2>&1; then
  echo "Emscripten is required for the audio-core Wasm build. Install and activate the Emscripten SDK so emcmake is on PATH, then rerun." >&2
  exit 127
fi

emcmake cmake -S native -B native/build/audio-core-wasm \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INTERPROCEDURAL_OPTIMIZATION=ON \
  -DDAW_BUILD_PLUGIN_HOST=OFF \
  -DBUILD_TESTING=OFF \
  -DDAW_AUDIO_CORE_BUILD_WASM=ON \
  -DDAW_AUDIO_CORE_BUILD_WASM_HARNESS=ON
cmake --build native/build/audio-core-wasm --target daw-audio-core-wasm daw-audio-core-wasm-harness

artifact_dir=native/build/audio-core-wasm/audio-core
artifact="$artifact_dir/daw-audio-core-wasm.wasm"
public_artifact_dir=public/audio-core
public_artifact="$public_artifact_dir/daw-audio-core.wasm"
public_manifest="$public_artifact_dir/daw-audio-core.manifest.json"
contract_hash=$(bun -e "import { processorContractHash } from './packages/audio-core-contract/src/generated/processor-contract-metadata'; console.log(processorContractHash)")
artifact_hash=$(shasum -a 256 "$artifact" | cut -d ' ' -f 1)
artifact_size=$(wc -c < "$artifact" | tr -d ' ')
maximum_bytes=524288

mkdir -p "$public_artifact_dir"
rm -f \
  "$public_artifact_dir/daw-audio-core-wasm-harness.wasm" \
  "$public_artifact_dir/daw-audio-core-wasm-harness.manifest.json"
cp "$artifact" "$public_artifact"

cat > "$public_manifest" <<EOF
{"version":1,"artifactKind":"production","abiVersion":1,"contractVersion":1,"contractHash":"$contract_hash","buildType":"Release","lto":true,"fixedMemory":true,"memoryBytes":184549376,"sizeBytes":$artifact_size,"maximumBytes":$maximum_bytes,"sha256":"$artifact_hash","wasmUrl":"/audio-core/daw-audio-core.wasm"}
EOF

cp "$public_manifest" "$artifact_dir/daw-audio-core.manifest.json"
bun native/audio-core/scripts/validate-wasm-artifact.ts "$artifact" "$artifact_dir/daw-audio-core.manifest.json"
bun native/audio-core/scripts/validate-wasm-artifact.ts "$public_artifact" "$public_manifest"
