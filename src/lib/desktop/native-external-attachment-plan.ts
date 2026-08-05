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
  stageIndex: number
  sourceIndex?: number
  catalogIdentity: {
    format: "vst3"
    classId: string
    vendorId: string
    architecture: "arm64"
    scannerCatalogVersion: 2
  }
  bundleFingerprint: string
  binaryFingerprint: string
  role: "effect" | "instrument"
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
  parameters: ExternalProcessor["manifest"]["parameters"]
  parameterOverrides: ExternalProcessor["parameterOverrides"]
}

type NativeExternalEditorPlanInput = {
  processor: ExternalProcessor
  targetId: string
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

export type NativeExternalEditorPlanCompilation = NativeExternalAttachmentPlanCompilation

const stateRevision = (updatedAt: number) => updatedAt % 0x8000_0000

const layoutChannels = (layout: "mono" | "stereo") => layout === "mono" ? 1 : 2
const layoutForChannels = (channels: number): "mono" | "stereo" | undefined => (
  channels === 1 ? "mono" : channels === 2 ? "stereo" : undefined
)

const compileProcessor = (
  processor: ExternalProcessor,
  node: {
    channel: {
      id: string
      kind?: ResolvedMixerGraph["channels"][number]["channel"]["kind"]
    }
    inputLayout: "mono" | "stereo"
    outputLayout: "mono" | "stereo"
  },
  workerTransport: NativeExternalWorkerTransport,
): NativeExternalAttachmentProjection | string => {
  if (processor.manifest.sidechainInputs.length > 0) {
    return `External processor "${processor.instanceId}" has unsupported sidechain buses.`
  }
  const inputs = processor.manifest.audioInputs.filter((bus) => bus.enabled)
  const outputs = processor.manifest.audioOutputs.filter((bus) => bus.enabled)
  const instrument = processor.manifest.role === "instrument"
  if ((!instrument && inputs.length !== 1)
    || (instrument && (inputs.length !== 0 || node.channel.kind !== "instrument"))
    || outputs.length !== 1) {
    return instrument
      ? `External instrument "${processor.instanceId}" requires an instrument mixer node and exactly one enabled output bus.`
      : `External processor "${processor.instanceId}" must have exactly one enabled input and output bus.`
  }
  const input = inputs[0]
  const output = outputs[0]
  if (!output || (!instrument && !input)) {
    return `External processor "${processor.instanceId}" has incomplete enabled bus metadata.`
  }
  if (
    (!instrument && input?.channels !== layoutChannels(node.inputLayout))
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
    stageIndex: processor.index,
    catalogIdentity: {
      format: "vst3",
      classId: reference.classId,
      vendorId: reference.vendorId,
      architecture: reference.architecture,
      scannerCatalogVersion: reference.scannerCatalogVersion,
    },
    bundleFingerprint: reference.bundleFingerprint,
    binaryFingerprint: reference.binaryFingerprint,
    role: processor.manifest.role,
    inputBuses: processor.manifest.audioInputs,
    outputBuses: processor.manifest.audioOutputs,
    workerTransport: {
      ...workerTransport,
      inputChannels: instrument ? 0 : input?.channels ?? 0,
      outputChannels: output.channels,
    },
    declaredLatencyFrames: processor.latencyFrames,
    declaredTailFrames: processor.tailFrames,
    bypassed: processor.bypassed,
    parameters: processor.manifest.parameters,
    parameterOverrides: processor.parameterOverrides,
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
  const attachments: NativeExternalAttachmentProjection[] = []
  const processorsByNode = new Map<string, ExternalProcessor[]>()
  for (const processor of input.processors) {
    if (processor.health.state === "degraded") {
      reasons.push(`External plugin "${processor.instanceId}" is degraded and cannot participate in native playback.`)
      continue
    }
    const processors = processorsByNode.get(processor.targetId) ?? []
    processors.push(processor)
    processorsByNode.set(processor.targetId, processors)
  }
  for (const [targetId, processors] of processorsByNode) {
    const node = nodes.get(targetId)
    if (!node) {
      for (const processor of processors) {
        reasons.push(`External processor "${processor.instanceId}" targets missing mixer node "${targetId}".`)
      }
      continue
    }
    const ordered = [...processors].sort((left, right) => (
      left.index - right.index || left.instanceId.localeCompare(right.instanceId)
    ))
    if (ordered.some((processor, index) => processor.index === ordered[index - 1]?.index)) {
      reasons.push(`External processors on mixer node "${targetId}" must have unique persisted indexes.`)
      continue
    }
    let inputLayout = node.inputLayout
    for (const [index, processor] of ordered.entries()) {
      if (index > 0 && processor.manifest.role === "instrument") {
        reasons.push(`External instrument "${processor.instanceId}" must be the first processor in mixer node "${targetId}".`)
      }
      const outputBuses = processor.manifest.audioOutputs.filter((bus) => bus.enabled)
      const outputLayout = outputBuses.length === 1 ? layoutForChannels(outputBuses[0].channels) : undefined
      if (outputLayout !== undefined && outputLayout !== node.outputLayout) {
        reasons.push(`External processor "${processor.instanceId}" must preserve mixer node "${targetId}" output layout.`)
      }
      const attachment = compileProcessor(processor, {
        channel: node.channel,
        inputLayout,
        outputLayout: outputLayout ?? node.outputLayout,
      }, input.workerTransport)
      if (typeof attachment === "string") {
        reasons.push(attachment)
      } else {
        attachments.push({
          ...attachment,
          stageIndex: processor.manifest.role === "instrument" ? 0 : processor.index,
          ...(processor.manifest.role === "instrument" ? { sourceIndex: 0 } : {}),
        })
        inputLayout = outputLayout ?? inputLayout
      }
    }
    if (inputLayout !== node.outputLayout) {
      reasons.push(`External processor chain on mixer node "${targetId}" does not produce the node output layout.`)
    }
  }
  if (reasons.length > 0) return { supported: false, reasons }
  return {
    supported: true,
    attachments: attachments.sort((left, right) => (
      left.graphNodeId.localeCompare(right.graphNodeId)
      || left.stageIndex - right.stageIndex
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
  return compileAttachmentPlan(snapshot.attachments, "External attachment plan is invalid.")
}

const compileAttachmentPlan = (
  attachments: readonly NativeExternalAttachmentProjection[],
  fallbackMessage: string,
): NativeExternalAttachmentPlanCompilation => {
  try {
    return {
      supported: true,
      plan: nativeExternalAttachmentPlanSchema.parse({
        version: 2,
        attachments,
      }),
    }
  } catch (error) {
    return {
      supported: false,
      reasons: [error instanceof Error ? error.message : fallbackMessage],
    }
  }
}

export const compileNativeExternalEditorPlan = (
  input: NativeExternalEditorPlanInput,
): NativeExternalEditorPlanCompilation => {
  const instrument = input.processor.manifest.role === "instrument"
  const inputs = input.processor.manifest.audioInputs.filter((bus) => bus.enabled)
  const outputs = input.processor.manifest.audioOutputs.filter((bus) => bus.enabled)
  const inputLayout = instrument
    ? "stereo"
    : inputs[0] ? layoutForChannels(inputs[0].channels) : undefined
  const outputLayout = outputs[0] ? layoutForChannels(outputs[0].channels) : undefined
  if (input.processor.targetId !== input.targetId) {
    return { supported: false, reasons: [`External processor "${input.processor.instanceId}" targets an invalid editor node.`] }
  }
  if (
    (!instrument && inputs.length !== 1)
    || (instrument && inputs.length !== 0)
    || outputs.length !== 1
    || !inputLayout
    || !outputLayout
  ) {
    return {
      supported: false,
      reasons: [instrument
        ? `External instrument "${input.processor.instanceId}" must have zero enabled input buses and exactly one enabled mono or stereo output bus.`
        : `External processor "${input.processor.instanceId}" must have exactly one enabled mono or stereo input and output bus.`],
    }
  }
  const attachment = compileProcessor(input.processor, {
    channel: { id: input.targetId, kind: instrument ? "instrument" : "audio" },
    inputLayout,
    outputLayout,
  }, {
    slotCount: 2,
    maximumFrames: 8_192,
    maximumEventsPerBlock: 128,
  })
  if (typeof attachment === "string") return { supported: false, reasons: [attachment] }
  return compileAttachmentPlan([{
    ...attachment,
    stageIndex: 0,
    ...(instrument ? { sourceIndex: 0 } : {}),
  }], "External editor attachment plan is invalid.")
}
