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
artifact_manifest="$artifact_dir/daw-audio-core.manifest.json"
public_artifact_dir=public/audio-core
contract_hash=$(bun -e "import { processorContractHash } from './packages/audio-core-contract/src/generated/processor-contract-metadata'; console.log(processorContractHash)")
maximum_bytes=524288
source_hash=$(bun native/audio-core/scripts/portable-wasm-source-hash.ts)

artifact_hash=$(shasum -a 256 "$artifact" | cut -d ' ' -f 1)
artifact_size=$(wc -c < "$artifact" | tr -d ' ')

cat > "$artifact_manifest" <<EOF
{"version":2,"artifactKind":"production","abiVersion":2,"contractVersion":1,"contractHash":"$contract_hash","buildType":"Release","lto":true,"fixedMemory":true,"memoryBytes":184549376,"sizeBytes":$artifact_size,"maximumBytes":$maximum_bytes,"sha256":"$artifact_hash","sourceHash":"$source_hash","wasmUrl":"/audio-core/daw-audio-core.wasm"}
EOF

bun native/audio-core/scripts/validate-wasm-artifact.ts "$artifact" "$artifact_manifest"

public_parent=$(dirname "$public_artifact_dir")
mkdir -p "$public_parent"
staging_dir=$(mktemp -d "$public_parent/.audio-core-staging.XXXXXX")
cleanup_staging() {
  status=$?
  trap - EXIT HUP INT TERM
  rm -rf "$staging_dir"
  exit "$status"
}
trap cleanup_staging EXIT
cp "$artifact" "$staging_dir/daw-audio-core.wasm"
cp "$artifact_manifest" "$staging_dir/daw-audio-core.manifest.json"
bun native/audio-core/scripts/validate-wasm-artifact.ts \
  "$staging_dir/daw-audio-core.wasm" \
  "$staging_dir/daw-audio-core.manifest.json"

sh native/audio-core/scripts/publish-wasm-assets.sh "$staging_dir" "$public_artifact_dir"
