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

const unavailable = (
  code: NativeVst3InsertionFailureCode,
  message: string,
): NativeVst3InsertionAvailability => ({ enabled: false, code, message })

export const nativeVst3InsertionAvailability = (input: {
  selection: NativeVst3CatalogSelection
  projectId: string
  targetId: Track["id"] | "master"
  canWrite: boolean
  bridgeAvailable: boolean
  busy: boolean
}): NativeVst3InsertionAvailability => {
  if (!input.bridgeAvailable) return unavailable("browser", "Native VST3 insertion is available only in the macOS desktop app.")
  if (!isLocalId("project", input.projectId)) return unavailable("project-unavailable", "Native VST3 insertion requires a local desktop project.")
  if (input.targetId === "master") return unavailable("unsupported-bus", "Native VST3 insertion currently requires a stereo track target.")
  if (!input.canWrite) return unavailable("project-unavailable", "The selected track is read-only.")
  if (input.busy) return unavailable("host-unavailable", "Native VST3 preflight is already running.")
  if (input.selection.pluginClass.role !== "effect") return unavailable("unsupported-role", "Native VST3 instruments are not supported.")
  if (input.selection.entry.scanHealth === "scan-failed") return unavailable("stale-catalog", "The VST3 scan failed and must be refreshed.")
  if (
    input.selection.entry.scanHealth !== "scanned"
    || !input.selection.entry.catalogReference
  ) return unavailable("untrusted-catalog", "The VST3 plug-in has not passed trusted native scanning.")
  return {
    enabled: true,
    message: "Preflight and insert this VST3 effect as bypassed metadata.",
  }
}

export const insertNativeVst3Effect = async (input: {
  projectId: string
  targetId: Track["id"]
  selection: NativeVst3CatalogSelection
  bridge: {
    preflightInsertion: (request: NativeVst3InsertionPreflightRequest) => Promise<NativeVst3InsertionPreflightResult>
  }
  now?: () => number
  createInstanceId?: () => string
  validateBeforePersist?: () => boolean
  persist?: typeof appendLocalExternalProcessor
}): Promise<NativeVst3InsertionResult> => {
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
      role: "effect",
      audioInputs: preflight.manifest.inputBuses,
      audioOutputs: preflight.manifest.outputBuses,
      sidechainInputs: [],
      parameters: [],
      latencyFrames: preflight.manifest.latencyFrames,
      tailFrames: preflight.manifest.tailFrames,
      supportsBypass: false,
      supportsEditor: false,
      supportsState: false,
    },
    parameterOverrides: {},
    latencyFrames: preflight.manifest.latencyFrames,
    tailFrames: preflight.manifest.tailFrames,
    bypassed: true,
    launchReference: {
      ...catalogReference,
      classId: input.selection.pluginClass.classId,
      vendorId: input.selection.pluginClass.vendor,
    },
    health: {
      state: "degraded",
      reason: "Native graph activation is gated pending end-to-end VST3 playback validation.",
      updatedAt,
    },
    updatedAt,
  })
  return { ok: true, processor }
}
