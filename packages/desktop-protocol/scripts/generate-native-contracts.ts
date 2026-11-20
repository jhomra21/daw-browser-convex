import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  maximumRecordingSpoolBlockFrames,
  recordingSpoolBlockHeaderBytes,
  recordingSpoolSampleBytes,
} from "../src/index"
import * as host from "../src/native-audio-host"
import {
  maxPluginHostControlFrameBytes,
  maxVst3WorkerFrames,
  maxVst3WorkerSampleRateHz,
  maxVst3WorkerStateBytes,
  nativeVst3PluginFaultOrigins,
  nativeVst3WorkerArtifactId,
  nativeVst3WorkerArtifactVersion,
  nativeVst3WorkerControlProtocolVersion,
  nativeVst3WorkerFaultOrigins,
  nativeVst3WorkerManifestVersion,
  nativeVst3WorkerStartupProtocolVersion,
  nativeVst3WorkerTransportAbiVersion,
  nativeVst3ZeroDiagnosticFaultOrigin,
} from "@daw-browser/plugin-host-protocol"

const root = resolve(import.meta.dir, "../../..")
const faultOrigins = Object.entries(nativeVst3WorkerFaultOrigins)
const enumerator = (name: string) => `k${name.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("")}`

const enumClass = (name: string, table: Readonly<Record<string, number>>, comment?: string) => `${comment ? `// ${comment}\n` : ""}enum class ${name} : std::uint32_t {
${Object.entries(table).map(([entry, value]) => `  ${enumerator(entry)} = ${value},`).join("\n")}
};
`

const constant = (type: string, name: string, value: number | bigint, hex = false) => (
  `constexpr ${type} ${name} = ${hex ? `0x${value.toString(16).padStart(8, "0")}U` : `${value}`};`
)

const faultOriginName = (value: number) => {
  const entry = faultOrigins.find(([, origin]) => origin === value)

  if (!entry) throw new Error(`No worker fault origin is defined for ${value}.`)

  return enumerator(entry[0])
}

const pluginHostHeader = `#pragma once

#include <cstddef>
#include <cstdint>
#include <string_view>

namespace daw::plugin_host {

constexpr std::uint32_t kWorkerTransportAbiVersion = ${nativeVst3WorkerTransportAbiVersion};
constexpr std::uint32_t kWorkerManifestVersion = ${nativeVst3WorkerManifestVersion};
constexpr std::uint32_t kWorkerStartupProtocolVersion = ${nativeVst3WorkerStartupProtocolVersion};
constexpr std::uint32_t kWorkerControlProtocolVersion = ${nativeVst3WorkerControlProtocolVersion};
constexpr std::string_view kWorkerArtifactId = "${nativeVst3WorkerArtifactId}";
constexpr std::string_view kWorkerArtifactVersion = "${nativeVst3WorkerArtifactVersion}";
constexpr std::size_t kMaximumControlFrameBytes = ${maxPluginHostControlFrameBytes};
constexpr std::size_t kMaximumWorkerStateBytes = ${maxVst3WorkerStateBytes};
constexpr std::size_t kMaximumWorkerFrames = ${maxVst3WorkerFrames};
constexpr double kMaximumWorkerSampleRateHz = ${maxVst3WorkerSampleRateHz}.0;

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

#ifdef __cplusplus
#include <cstdint>

namespace daw::audio_host_macos {

${enumClass("SpoolState", host.nativeAudioHostSpoolStates).replace(" : std::uint32_t", "")}
}
#endif
`

const audioHostHeader = `#pragma once

#include <cstddef>
#include <cstdint>
#include <string_view>

namespace daw::audio_host_macos {

${constant("std::uint32_t", "kFrameMagic", host.nativeAudioHostMagic, true)}
${constant("std::uint32_t", "kControlProtocolVersion", host.nativeAudioHostProtocolVersion)}
constexpr std::string_view kArtifactId = "${host.nativeAudioHostArtifactId}";
${constant("std::uint32_t", "kHostCapabilities", host.nativeAudioHostRequiredCapabilities, true)}
${constant("std::size_t", "kControlFrameHeaderBytes", host.nativeAudioHostFrameHeaderBytes)}
${constant("std::size_t", "kNativeGraphFrameHeaderBytes", host.nativeAudioHostNativeGraphFrameHeaderBytes)}
${constant("std::size_t", "kMaximumControlPayloadBytes", host.nativeAudioHostMaximumPayloadBytes)}
${constant("std::size_t", "kMaximumSerializedPlanBytes", host.nativeAudioHostMaximumSerializedPlanBytes)}
${constant("std::size_t", "kMaximumDeviceIdBytes", host.nativeAudioHostMaximumDeviceIdBytes)}
${constant("std::uint32_t", "kMaximumAssetChannels", host.nativeAudioHostMaximumAssetChannels)}
${constant("std::uint32_t", "kMaximumAssetFrames", host.nativeAudioHostMaximumAssetFrames)}
${constant("std::size_t", "kMaximumInstalledAssets", host.nativeAudioHostMaximumInstalledAssets)}
${constant("std::size_t", "kAssetInstallHeaderBytes", host.nativeAudioHostAssetInstallHeaderBytes)}
${constant("std::size_t", "kMappedAssetPageHeaderBytes", host.nativeAudioHostMappedAssetPageHeaderBytes)}
${constant("std::size_t", "kMaximumMappedAssetWrittenRanges", host.nativeAudioHostMaximumMappedAssetRanges)}
${constant("std::size_t", "kHostPageBytes", host.nativeAudioHostPageBytes)}
${constant("std::size_t", "kMaximumMeterEntries", host.nativeAudioHostMaximumMeterEntries)}
${constant("std::size_t", "kMaximumSpectrumBins", host.nativeAudioHostMaximumSpectrumBins)}
${constant("std::size_t", "kMaximumVstStringBytes", host.nativeAudioHostMaximumVstStringBytes)}
${constant("std::size_t", "kMaximumVstPathBytes", host.nativeAudioHostMaximumVstPathBytes)}
${constant("std::size_t", "kVstAttachFingerprintBytes", host.nativeAudioHostVstAttachFingerprintBytes)}
${constant("std::size_t", "kMaximumScheduleChunks", host.nativeAudioHostMaximumScheduleChunks)}
${constant("std::size_t", "kMaximumScheduleRecords", host.nativeAudioHostMaximumScheduleRecords)}
${constant("std::size_t", "kMaximumScheduleAutomationSegments", host.nativeAudioHostMaximumScheduleAutomationSegments)}
${constant("std::size_t", "kMaximumProcessorEvents", host.nativeAudioHostMaximumProcessorEvents)}
${constant("std::size_t", "kMaximumInstrumentEvents", host.nativeAudioHostMaximumInstrumentEvents)}
${constant("std::size_t", "kMaximumSourceEvents", host.nativeAudioHostMaximumSourceEvents)}
${constant("std::size_t", "kMaximumScheduleInstanceIdBytes", host.nativeAudioHostMaximumScheduleInstanceIdBytes)}
${constant("std::size_t", "kScheduleProgressBytes", host.nativeAudioHostScheduleProgressBytes)}
${constant("std::size_t", "kProcessorPatchStatusBytes", host.nativeAudioHostProcessorPatchStatusBytes)}

${enumClass("ControlType", host.nativeAudioHostControlTypes)}
${enumClass("ControlAckStatus", host.nativeAudioHostAckStatus, "The status word of a ControlType::kAck; the ACK text is for people and is never classified.")}
${enumClass("LifecycleState", host.nativeAudioHostLifecycleStates)}
${enumClass("DeviceReadinessReason", host.nativeAudioHostReadinessReasons)}
${enumClass("RejectedBlockReason", host.nativeAudioHostRejectedBlockReasons)}
${enumClass("GraphRevisionStatusCode", host.nativeAudioHostRevisionStatusCodes)}
${enumClass("GraphRevisionContinuity", host.nativeAudioHostRevisionContinuities)}
${enumClass("WorkerNotificationKind", host.nativeAudioHostNotificationKinds)}
${enumClass("ProcessorPatchOutcome", host.nativeAudioHostPatchOutcomes)}
${enumClass("ProcessorPatchRefusal", host.nativeAudioHostPatchRefusals)}
}
`

const generated = [
  {
    path: resolve(root, "native/plugin-host/src/plugin-host-contract-generated.h"),
    contents: pluginHostHeader,
  },
  {
    path: resolve(root, "native/audio-host-macos/include/daw/audio_host_protocol_generated.h"),
    contents: audioHostHeader,
  },
  {
    path: resolve(root, "native/audio-core/include/daw/recording_spool_contract_generated.h"),
    contents: spoolHeader,
  },
]

if (process.argv.includes("--check")) {
  for (const file of generated) {
    if (existsSync(file.path) && readFileSync(file.path, "utf8") === file.contents) continue
    console.error(`${file.path} is stale. Run: bun run --filter @daw-browser/desktop-protocol generate`)
    process.exitCode = 1
  }
} else {
  for (const file of generated) writeFileSync(file.path, file.contents)
}
