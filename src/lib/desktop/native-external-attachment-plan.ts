import {
  nativeExternalAttachmentPlanSchema,
  type NativeExternalAttachmentPlan,
} from "@daw-browser/plugin-host-protocol"
import type { ExternalProcessor } from "@daw-browser/external-plugins"
import type { resolveLiveMixerGraph } from "@daw-browser/audio-engine/live-mixer-runtime"
import { nativeGraphNodeId } from "@daw-browser/audio-engine/native-host-wire"

type ResolvedMixerGraph = ReturnType<typeof resolveLiveMixerGraph>

type NativeExternalWorkerTransport = {
  slotCount: number
  maximumFrames: number
  maximumEventsPerBlock: number
}

type NativeExternalAttachmentProjection = {
  instanceId: string
  graphNodeId: string
  nativeGraphNodeId: string
  chainIndex: number
  catalogIdentity: {
    format: "vst3"
    classId: string
    vendorId: string
    architecture: "arm64"
    scannerCatalogVersion: 2
  }
  bundleFingerprint: string
  binaryFingerprint: string
  role: "effect"
  inputBuses: ExternalProcessor["manifest"]["audioInputs"]
  outputBuses: ExternalProcessor["manifest"]["audioOutputs"]
  workerTransport: NativeExternalWorkerTransport & {
    inputChannels: number
    outputChannels: number
  }
  declaredLatencyFrames: number
  declaredTailFrames: number | null
  bypassed: boolean
  stateRevision: number
}

export type NativeExternalAttachmentSnapshotInput = {
  target: "native" | "browser"
  graph: ResolvedMixerGraph
  processors: readonly ExternalProcessor[]
  workerTransport: NativeExternalWorkerTransport
}

export type NativeExternalAttachmentSnapshotCompilation =
  | { supported: true; attachments: readonly NativeExternalAttachmentProjection[] }
  | { supported: false; reasons: readonly string[] }

export type NativeExternalAttachmentPlanCompilation =
  | { supported: true; plan: NativeExternalAttachmentPlan }
  | { supported: false; reasons: readonly string[] }

const stateRevision = (updatedAt: number) => updatedAt % 0x8000_0000

const layoutChannels = (layout: "mono" | "stereo") => layout === "mono" ? 1 : 2

const compileProcessor = (
  processor: ExternalProcessor,
  node: ResolvedMixerGraph["channels"][number],
  workerTransport: NativeExternalWorkerTransport,
): NativeExternalAttachmentProjection | string => {
  if (processor.manifest.role !== "effect") {
    return `External processor "${processor.instanceId}" has unsupported role "${processor.manifest.role}".`
  }
  if (processor.manifest.sidechainInputs.length > 0) {
    return `External processor "${processor.instanceId}" has unsupported sidechain buses.`
  }
  const inputs = processor.manifest.audioInputs.filter((bus) => bus.enabled)
  const outputs = processor.manifest.audioOutputs.filter((bus) => bus.enabled)
  if (inputs.length !== 1 || outputs.length !== 1) {
    return `External processor "${processor.instanceId}" must have exactly one enabled input and output bus.`
  }
  const input = inputs[0]
  const output = outputs[0]
  if (!input || !output) {
    return `External processor "${processor.instanceId}" has incomplete enabled bus metadata.`
  }
  if (
    input.channels !== layoutChannels(node.inputLayout)
    || output.channels !== layoutChannels(node.outputLayout)
  ) {
    return `External processor "${processor.instanceId}" has buses incompatible with mixer node "${node.channel.id}".`
  }
  const reference = processor.launchReference
  if (
    !reference
    || reference.version !== 1
    || reference.scannerCatalogVersion !== 2
    || reference.architecture !== "arm64"
    || reference.classId !== processor.manifest.identity.classId
    || reference.vendorId !== processor.manifest.identity.vendor
    || reference.binaryFingerprint !== processor.manifest.identity.binaryFingerprint
  ) {
    return `External processor "${processor.instanceId}" has stale native catalog identity.`
  }
  return {
    instanceId: processor.instanceId,
    graphNodeId: node.channel.id,
    nativeGraphNodeId: nativeGraphNodeId(node.channel.id).toString(),
    chainIndex: processor.chainIndex,
    catalogIdentity: {
      format: "vst3",
      classId: reference.classId,
      vendorId: reference.vendorId,
      architecture: reference.architecture,
      scannerCatalogVersion: reference.scannerCatalogVersion,
    },
    bundleFingerprint: reference.bundleFingerprint,
    binaryFingerprint: reference.binaryFingerprint,
    role: "effect",
    inputBuses: processor.manifest.audioInputs,
    outputBuses: processor.manifest.audioOutputs,
    workerTransport: {
      ...workerTransport,
      inputChannels: input.channels,
      outputChannels: output.channels,
    },
    declaredLatencyFrames: processor.latencyFrames,
    declaredTailFrames: processor.tailFrames,
    bypassed: processor.bypassed,
    // External processors persist no standalone state revision. updatedAt is
    // their canonical mutation version, reduced to the protocol's uint31 span.
    stateRevision: stateRevision(processor.updatedAt),
  }
}

/**
 * Keeps persisted external processors outside portable playback snapshots.
 * Browser targets must use a frozen or bypassed route, while native targets
 * receive a path-free projection keyed to the resolved mixer graph.
 */
export const compileNativeExternalAttachmentSnapshot = (
  input: NativeExternalAttachmentSnapshotInput,
): NativeExternalAttachmentSnapshotCompilation => {
  if (input.target === "browser") {
    const live = input.processors.find((processor) => !processor.bypassed)
    return live
      ? { supported: false, reasons: [`External plugin ${live.instanceId} must be frozen or bypassed before browser playback.`] }
      : { supported: true, attachments: [] }
  }

  const reasons: string[] = []
  const nodes = new Map(input.graph.channels.map((node) => [node.channel.id, node]))
  const attachedNodeIds = new Set<string>()
  const attachments: NativeExternalAttachmentProjection[] = []
  for (const processor of input.processors) {
    const node = nodes.get(processor.targetId)
    if (!node) {
      reasons.push(`External processor "${processor.instanceId}" targets missing mixer node "${processor.targetId}".`)
      continue
    }
    if (attachedNodeIds.has(node.channel.id)) {
      reasons.push(`Mixer node "${node.channel.id}" has multiple external processors, but the native graph protocol supports one attachment per node.`)
      continue
    }
    attachedNodeIds.add(node.channel.id)
    const attachment = compileProcessor(processor, node, input.workerTransport)
    if (typeof attachment === "string") reasons.push(attachment)
    else attachments.push(attachment)
  }
  if (reasons.length > 0) return { supported: false, reasons }
  return {
    supported: true,
    attachments: attachments.sort((left, right) => (
      left.graphNodeId.localeCompare(right.graphNodeId)
      || left.chainIndex - right.chainIndex
      || left.catalogIdentity.classId.localeCompare(right.catalogIdentity.classId)
      || left.instanceId.localeCompare(right.instanceId)
    )),
  }
}

export const compileNativeExternalAttachmentPlan = (
  input: NativeExternalAttachmentSnapshotInput,
): NativeExternalAttachmentPlanCompilation => {
  const snapshot = compileNativeExternalAttachmentSnapshot(input)
  if (!snapshot.supported) return { supported: false, reasons: snapshot.reasons }
  try {
    return {
      supported: true,
      plan: nativeExternalAttachmentPlanSchema.parse({
        version: 1,
        attachments: snapshot.attachments,
      }),
    }
  } catch (error) {
    return {
      supported: false,
      reasons: [error instanceof Error ? error.message : "External attachment plan is invalid."],
    }
  }
}
