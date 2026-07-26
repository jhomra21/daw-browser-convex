import type {
  NativeVst3InsertionPreflightRequest,
  NativeVst3InsertionPreflightResult,
} from "@daw-browser/plugin-host-protocol"
import type { PluginCatalogData } from "./plugin-catalog"
import { resolveVst3Attachment } from "./vst3-attachment"
import { preflightNativeVst3Worker } from "./vst3-preflight"

const workerTransport = {
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
  if (resolved.role !== "effect") {
    return failure("unsupported-role", "Native VST3 instrument insertion is not supported.")
  }
  const result = await (input.preflight ?? preflightNativeVst3Worker)({
    workerPath: input.workerPath,
    sampleRateHz: input.sampleRateHz,
    attachment: {
      graphNodeId: 1n,
      instanceId: input.request.instanceId,
      classId: resolved.classId,
      vendorId: resolved.vendorId,
      canonicalBundlePath: resolved.canonicalBundlePath,
      canonicalExecutablePath: resolved.canonicalExecutablePath,
      bundleFingerprint: resolved.bundleFingerprint,
      binaryFingerprint: resolved.binaryFingerprint,
      scannerProtocolVersion: resolved.scannerProtocolVersion,
      role: "effect",
      inputLayout: "stereo",
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
    || result.hello.manifest.role !== "effect"
    || !hasStereoMainBus(result.hello.manifest.inputBuses)
    || !hasStereoMainBus(result.hello.manifest.outputBuses)
  ) {
    return failure("unsupported-bus", "The VST3 plug-in does not expose one supported stereo input and output bus.")
  }
  return {
    ok: true,
    manifest: {
      role: "effect",
      inputBuses: result.hello.manifest.inputBuses,
      outputBuses: result.hello.manifest.outputBuses,
      latencyFrames: result.hello.manifest.latencyFrames,
      tailFrames: result.hello.manifest.tailFrames,
    },
  }
}
