import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  maximumRecordingSpoolBlockFrames,
  recordingSpoolBlockHeaderBytes,
  recordingSpoolSampleBytes,
} from "../../../packages/desktop-protocol/src/index"
import {
  nativeVst3PluginFaultOrigins,
  nativeVst3WorkerArtifactId,
  nativeVst3WorkerArtifactVersion,
  nativeVst3WorkerControlProtocolVersion,
  nativeVst3WorkerFaultOrigins,
  nativeVst3WorkerManifestVersion,
  nativeVst3WorkerStartupProtocolVersion,
  nativeVst3WorkerTransportAbiVersion,
  nativeVst3ZeroDiagnosticFaultOrigin,
} from "../../../packages/plugin-host-protocol/src/index"

const root = resolve(import.meta.dir, "../../..")
const faultOrigins = Object.entries(nativeVst3WorkerFaultOrigins)
const enumerator = (name: string) => `k${name.charAt(0).toUpperCase()}${name.slice(1)}`
const faultOriginName = (value: number) => {
  const entry = faultOrigins.find(([, origin]) => origin === value)
  if (!entry) throw new Error(`No worker fault origin is defined for ${value}.`)
  return enumerator(entry[0])
}
const pluginHostHeader = `#pragma once

#include <cstdint>
#include <string_view>

namespace daw::plugin_host {

constexpr std::uint32_t kWorkerTransportAbiVersion = ${nativeVst3WorkerTransportAbiVersion};
constexpr std::uint32_t kWorkerManifestVersion = ${nativeVst3WorkerManifestVersion};
constexpr std::uint32_t kWorkerStartupProtocolVersion = ${nativeVst3WorkerStartupProtocolVersion};
constexpr std::uint32_t kWorkerControlProtocolVersion = ${nativeVst3WorkerControlProtocolVersion};
constexpr std::string_view kWorkerArtifactId = "${nativeVst3WorkerArtifactId}";
constexpr std::string_view kWorkerArtifactVersion = "${nativeVst3WorkerArtifactVersion}";

// Fault-only values in the existing diagnostic value field; non-fault values keep their meanings.
enum class WorkerFaultOrigin : std::uint32_t {
${faultOrigins.map(([name, value]) => `  ${enumerator(name)} = ${value},`).join("\n")}
};

// A worker fault without an origin is the plug-in's component callback.
inline constexpr WorkerFaultOrigin kZeroDiagnosticFaultOrigin = WorkerFaultOrigin::${faultOriginName(nativeVst3ZeroDiagnosticFaultOrigin)};

constexpr bool IsPluginFaultOrigin(const std::uint32_t faultValue) noexcept {
  switch (static_cast<WorkerFaultOrigin>(faultValue & 0xffU)) {
${[...nativeVst3PluginFaultOrigins].map((value) => `    case WorkerFaultOrigin::${faultOriginName(value)}:`).join("\n")}
      return true;
    default:
      return false;
  }
}

}
`
const spoolHeader = `#pragma once

#define DAW_RECORDING_SPOOL_BLOCK_HEADER_BYTES ${recordingSpoolBlockHeaderBytes}u
#define DAW_RECORDING_SPOOL_SAMPLE_BYTES ${recordingSpoolSampleBytes}u
#define DAW_RECORDING_SPOOL_MAX_BLOCK_FRAMES ${maximumRecordingSpoolBlockFrames}u
`
const generated = [
  {
    path: resolve(root, "native/plugin-host/src/plugin-host-contract-generated.h"),
    contents: pluginHostHeader,
  },
  {
    path: resolve(root, "native/audio-core/include/daw/recording_spool_contract_generated.h"),
    contents: spoolHeader,
  },
]

if (process.argv.includes("--check")) {
  for (const file of generated) {
    if (existsSync(file.path) && readFileSync(file.path, "utf8") === file.contents) continue
    console.error(`${file.path} is stale. Run: bun native/audio-core/scripts/generate-cross-language-contracts.ts`)
    process.exitCode = 1
  }
} else {
  for (const file of generated) writeFileSync(file.path, file.contents)
}
