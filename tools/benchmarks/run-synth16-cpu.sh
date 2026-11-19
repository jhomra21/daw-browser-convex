#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
build_dir=${SYNTH16_BUILD_DIR:-/tmp/synth16-cpu-benchmark}
result_path=${1:-"$repo_root/acceptance-reports/synth-16-voice-cpu-2026-10-18/raw-results.json"}

cmake -S "$repo_root/tools/benchmarks" -B "$build_dir" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_CXX_FLAGS_RELEASE="-O3 -DNDEBUG"
cmake --build "$build_dir" --target synth16-cpu --parallel
mkdir -p "$(dirname "$result_path")"
"$build_dir/synth16-cpu" > "$result_path"
printf 'Wrote %s\n' "$result_path"
