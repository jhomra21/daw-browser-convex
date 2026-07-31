import type { Track } from "@daw-browser/timeline-core/types"
import { isLocalId } from "@daw-browser/shared"
import type {
  NativeVst3InsertionFailureCode,
  NativeVst3InsertionPreflightRequest,
  NativeVst3InsertionPreflightResult,
} from "@daw-browser/plugin-host-protocol"
import type { ExternalProcessor } from "@daw-browser/external-plugins"
import type { DesktopPluginCatalogEntry } from "~/lib/desktop/attached-host-controller"
import { appendLocalExternalProcessor } from "~/lib/external-plugins"

export type NativeVst3CatalogSelection = {
  entry: DesktopPluginCatalogEntry
  pluginClass: DesktopPluginCatalogEntry["classes"][number]
}

export type NativeVst3InsertionAvailability =
  | { enabled: true; message: string }
  | { enabled: false; code: NativeVst3InsertionFailureCode; message: string }

export type NativeVst3InsertionResult =
  | { ok: true; processor: ExternalProcessor }
  | Extract<NativeVst3InsertionPreflightResult, { ok: false }>

type NativeVst3TargetTrack = Pick<
  Track,
  "id" | "kind" | "channelRole" | "groupId" | "outputTargetId" | "sends"
>
type NativeVst3InsertionUnavailable = Extract<NativeVst3InsertionAvailability, { enabled: false }>

const unavailable = (
  code: NativeVst3InsertionFailureCode,
  message: string,
): NativeVst3InsertionUnavailable => ({ enabled: false, code, message })

const validateTargetTrack = (
  targetId: Track["id"] | "master",
  targetTrack: NativeVst3TargetTrack | undefined,
): NativeVst3InsertionUnavailable | undefined => {
  if (targetId === "master") return unavailable("unsupported-bus", "Native VST3 insertion currently requires a directly routed stereo track target.")
  if (!targetTrack || targetTrack.id !== targetId) return unavailable("project-unavailable", "The selected track is no longer available.")
  if (
    (targetTrack.channelRole !== undefined && targetTrack.channelRole !== "track")
    || targetTrack.groupId !== undefined
    || targetTrack.outputTargetId !== undefined
    || (targetTrack.sends?.length ?? 0) > 0
  ) {
    return unavailable("unsupported-bus", "Native VST3 plug-ins require a directly routed stereo track.")
  }
  return undefined
}

export const nativeVst3InsertionAvailability = (input: {
  selection: NativeVst3CatalogSelection
  projectId: string
  targetId: Track["id"] | "master"
  targetTrack: NativeVst3TargetTrack | undefined
  canWrite: boolean
  bridgeAvailable: boolean
  busy: boolean
}): NativeVst3InsertionAvailability => {
  if (!input.bridgeAvailable) return unavailable("browser", "Native VST3 insertion is available only in the macOS desktop app.")
  if (!isLocalId("project", input.projectId)) return unavailable("project-unavailable", "Native VST3 insertion requires a local desktop project.")
  const targetError = validateTargetTrack(input.targetId, input.targetTrack)
  if (targetError) return targetError
  if (input.selection.pluginClass.role === "instrument" && input.targetTrack?.kind !== "instrument") {
    return unavailable("unsupported-role", "Native VST3 instruments require a directly routed instrument track.")
  }
  if (!input.canWrite) return unavailable("project-unavailable", "The selected track is read-only.")
  if (input.busy) return unavailable("host-unavailable", "Native VST3 preflight is already running.")
  if (input.selection.entry.scanHealth === "scan-failed") return unavailable("stale-catalog", "The VST3 scan failed and must be refreshed.")
  if (
    input.selection.entry.scanHealth !== "scanned"
    || !input.selection.entry.catalogReference
  ) return unavailable("untrusted-catalog", "The VST3 plug-in has not passed trusted native scanning.")
  return {
    enabled: true,
    message: input.selection.pluginClass.role === "instrument"
      ? "Preflight and activate this VST3 instrument on the native graph."
      : "Preflight and activate this VST3 effect on the native graph.",
  }
}

export const insertNativeVst3Effect = async (input: {
  projectId: string
  targetId: Track["id"]
  targetTrack: NativeVst3TargetTrack | undefined
  selection: NativeVst3CatalogSelection
  bridge: {
    preflightInsertion: (request: NativeVst3InsertionPreflightRequest) => Promise<NativeVst3InsertionPreflightResult>
  }
  now?: () => number
  createInstanceId?: () => string
  validateBeforePersist?: () => boolean
  persist?: typeof appendLocalExternalProcessor
}): Promise<NativeVst3InsertionResult> => {
  const targetError = validateTargetTrack(input.targetId, input.targetTrack)
  if (targetError) return { ok: false, code: targetError.code, message: targetError.message }
  if (input.selection.pluginClass.role === "instrument" && input.targetTrack?.kind !== "instrument") {
    return { ok: false, code: "unsupported-role", message: "Native VST3 instruments require a directly routed instrument track." }
  }
  const catalogReference = input.selection.entry.catalogReference
  if (!catalogReference) {
    return { ok: false, code: "untrusted-catalog", message: "The VST3 plug-in has no trusted native catalog reference." }
  }
  const instanceId = input.createInstanceId?.() ?? crypto.randomUUID()
  const preflight = await input.bridge.preflightInsertion({
    instanceId,
    reference: {
      ...catalogReference,
      classId: input.selection.pluginClass.classId,
      vendorId: input.selection.pluginClass.vendor,
    },
  })
  if (!preflight.ok) return preflight
  if (preflight.manifest.role !== input.selection.pluginClass.role) {
    return { ok: false, code: "unsupported-role", message: "The native VST3 worker role does not match the selected plug-in." }
  }
  if (input.validateBeforePersist && !input.validateBeforePersist()) {
    return { ok: false, code: "project-unavailable", message: "The selected project or track changed during VST3 preflight." }
  }
  const updatedAt = (input.now ?? Date.now)()
  const processor = await (input.persist ?? appendLocalExternalProcessor)(input.projectId, {
    instanceId,
    targetId: input.targetId,
    manifest: {
      identity: {
        format: "vst3",
        classId: input.selection.pluginClass.classId,
        vendor: input.selection.pluginClass.vendor,
        name: input.selection.pluginClass.name,
        version: input.selection.pluginClass.version,
        architecture: catalogReference.architecture,
        binaryFingerprint: catalogReference.binaryFingerprint,
      },
      role: preflight.manifest.role,
      audioInputs: preflight.manifest.inputBuses,
      audioOutputs: preflight.manifest.outputBuses,
      sidechainInputs: [],
      parameters: preflight.manifest.parameters,
      latencyFrames: preflight.manifest.latencyFrames,
      tailFrames: preflight.manifest.tailFrames,
      supportsBypass: preflight.manifest.supportsBypass,
      supportsEditor: preflight.manifest.supportsEditor,
      supportsState: preflight.manifest.supportsState,
    },
    parameterOverrides: {},
    latencyFrames: preflight.manifest.latencyFrames,
    tailFrames: preflight.manifest.tailFrames,
    bypassed: false,
    launchReference: {
      ...catalogReference,
      classId: input.selection.pluginClass.classId,
      vendorId: input.selection.pluginClass.vendor,
    },
    health: {
      state: "ready",
      reason: "Native VST3 preflight passed; playback uses the native graph on compatible directly routed stereo tracks, including synth MIDI tracks.",
      updatedAt,
    },
    updatedAt,
  })
  return { ok: true, processor }
}
