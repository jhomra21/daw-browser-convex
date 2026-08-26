import type {
  NativeVst3InsertionPreflightRequest,
  NativeVst3InsertionPreflightResult,
} from "@daw-browser/plugin-host-protocol"
import type { PluginCatalogData } from "./plugin-catalog"
import { resolveVst3Attachment } from "./vst3-attachment"
import { preflightNativeVst3Worker } from "./vst3-preflight"

const effectWorkerTransport = {
  slotCount: 2,
  maximumFrames: 512,
  inputChannels: 2,
  outputChannels: 2,
  maximumEventsPerBlock: 128,
}

const failure = (
  code: Extract<NativeVst3InsertionPreflightResult, { ok: false }>["code"],
  message: string,
): NativeVst3InsertionPreflightResult => ({ ok: false, code, message })

const hasStereoMainBus = (buses: readonly { channels: number; enabled: boolean }[]) => {
  const enabled = buses.filter((bus) => bus.enabled)
  return enabled.length === 1 && enabled[0]?.channels === 2
}

const hasNoEnabledAudioInputs = (buses: readonly { channels: number; enabled: boolean }[]) => (
  buses.every((bus) => !bus.enabled)
)

export const preflightVst3Insertion = async (input: {
  request: NativeVst3InsertionPreflightRequest
  catalog: PluginCatalogData
  workerPath: string
  sampleRateHz: number
  preflight?: typeof preflightNativeVst3Worker
}): Promise<NativeVst3InsertionPreflightResult> => {
  const classIsCataloged = input.catalog.entries.some((entry) => (
    entry.classes.some((candidate) => (
      candidate.classId === input.request.reference.classId
      && candidate.vendor === input.request.reference.vendorId
    ))
  ))
  if (!classIsCataloged) return failure("untrusted-catalog", "The selected VST3 class is not in the trusted native catalog.")
  const resolved = resolveVst3Attachment(input.catalog, input.request.reference)
  if (!resolved) return failure("stale-catalog", "The selected VST3 catalog identity is stale or no longer trusted.")
  const instrument = resolved.role === "instrument"
  const workerTransport = {
    ...effectWorkerTransport,
    inputChannels: instrument ? 0 : 2,
  }
  const result = await (input.preflight ?? preflightNativeVst3Worker)({
    workerPath: input.workerPath,
    sampleRateHz: input.sampleRateHz,
    attachment: {
      graphNodeId: 1n,
      stageIndex: 0,
      instanceId: input.request.instanceId,
      classId: resolved.classId,
      vendorId: resolved.vendorId,
      canonicalBundlePath: resolved.canonicalBundlePath,
      canonicalExecutablePath: resolved.canonicalExecutablePath,
      bundleFingerprint: resolved.bundleFingerprint,
      binaryFingerprint: resolved.binaryFingerprint,
      scannerProtocolVersion: resolved.scannerProtocolVersion,
      role: resolved.role,
      inputLayout: instrument ? "none" : "stereo",
      outputLayout: "stereo",
      declaredLatencyFrames: 0,
      transportLatencyFrames: workerTransport.maximumFrames,
      workerTransport,
      stateRevision: 0,
    },
  })
  if (result.status === "unavailable") return failure(result.code, result.message)
  if (
    result.hello.instanceId !== input.request.instanceId
    || result.hello.manifest.role !== resolved.role
    || (instrument
      ? !hasNoEnabledAudioInputs(result.hello.manifest.inputBuses)
      : !hasStereoMainBus(result.hello.manifest.inputBuses))
    || !hasStereoMainBus(result.hello.manifest.outputBuses)
  ) {
    return failure("unsupported-bus", instrument
      ? "The VST3 instrument does not expose no enabled audio inputs and one supported stereo output bus."
      : "The VST3 plug-in does not expose one supported stereo input and output bus.")
  }
  return {
    ok: true,
    manifest: {
      role: resolved.role,
      inputBuses: result.hello.manifest.inputBuses,
      outputBuses: result.hello.manifest.outputBuses,
      parameters: result.hello.manifest.parameters ?? [],
      latencyFrames: result.hello.manifest.latencyFrames,
      tailFrames: result.hello.manifest.tailFrames,
      supportsBypass: result.hello.manifest.supportsBypass === true,
      supportsEditor: result.hello.manifest.supportsEditor === true,
      supportsState: result.hello.manifest.supportsState === true,
    },
  }
}
