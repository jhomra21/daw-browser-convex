import type { NativeHostTransport } from "@daw-browser/audio-engine/native-host-wire"
import type { AudioCoreGraphSnapshot } from "@daw-browser/audio-core-contract"
import type { LivePlaybackSnapshot, LivePlaybackTransport } from "~/lib/live-playback-snapshot"

export const nativeTransportFor = (
  snapshot: LivePlaybackSnapshot,
  epoch: number,
  running: boolean,
  frame: number,
  transitionId: bigint,
): NativeHostTransport => {
  const transport: NativeHostTransport = {
    epoch,
    running,
    frame,
    bpm: snapshot.bpm,
    timeSignatureNumerator: snapshot.timeSignature?.numerator ?? 4,
    timeSignatureDenominator: snapshot.timeSignature?.denominator ?? 4,
    cycleActive: snapshot.transport.loopEnabled,
    transitionId,
  }

  if (snapshot.transport.loopEnabled) {
    transport.cycleStartSec = snapshot.transport.loopStartSec
    transport.cycleEndSec = snapshot.transport.loopEndSec
  }

  return transport
}

export const hasEquivalentTransportScheduling = (
  previous: LivePlaybackTransport,
  next: LivePlaybackTransport,
) => previous.loopEnabled === next.loopEnabled
  && previous.loopStartSec === next.loopStartSec
  && previous.loopEndSec === next.loopEndSec

const planarPageBytes = (
  planes: readonly Float32Array[],
  startFrame: number,
  frameCount: number,
) => {
  const bytesPerPlane = frameCount * Float32Array.BYTES_PER_ELEMENT
  const output = new Uint8Array(planes.length * bytesPerPlane)
  planes.forEach((plane, index) => {
    output.set(
      new Uint8Array(
        plane.buffer,
        plane.byteOffset + startFrame * Float32Array.BYTES_PER_ELEMENT,
        bytesPerPlane,
      ),
      index * bytesPerPlane,
    )
  })

  return output
}

export const planarBytes = (planes: readonly Float32Array[]) => planarPageBytes(
  planes,
  0,
  planes[0]?.length ?? 0,
)

export const nativeVstParameterEventsForSnapshot = (
  snapshot: LivePlaybackSnapshot,
  includeCurrent = true,
) => {
  const plan = snapshot.nativeExternalAttachmentPlan

  if (!plan) return []

  return plan.attachments.filter((attachment) => !attachment.bypassed).flatMap((attachment) => {
    const descriptors = new Map((attachment.parameters ?? []).map((parameter) => [parameter.id, parameter]))
    const events = new Map<string, { id: number; value: number; sampleOffset: number }>()

    for (const [rawId, value] of Object.entries(attachment.parameterOverrides ?? {})) {
      const id = Number(rawId)

      if (!descriptors.has(id) || !Number.isFinite(value)) continue

      if (includeCurrent) events.set(`${id}:0`, { id, value: Math.min(1, Math.max(0, value)), sampleOffset: 0 })
    }

    const eventsInBlock = [...events.values()]
      .sort((left, right) => left.sampleOffset - right.sampleOffset || left.id - right.id)
      .slice(0, attachment.workerTransport.maximumEventsPerBlock)

    return eventsInBlock.length > 0 ? [{ instanceId: attachment.instanceId, events: eventsInBlock }] : []
  })
}

// What the native graph does not support yet, by design (E6). A live edit that hits one is a limitation, not a defect.
// Each names the elements its routing belongs to, which carry the notice: the mapped device, or the track holding
// a mapping that targets no device; the device whose sidechain input is set.
export const nativeSnapshotLimitations = (snapshot: LivePlaybackSnapshot) => [
  { reason: "Native VST3 playback does not support MIDI expression automation yet.",
    carriers: snapshot.tracks.flatMap((track) => track.clips.flatMap((clip) =>
      (clip.midi?.mappings ?? []).map((mapping) => mapping.target.effectInstanceId ?? track.id))) },
  { reason: "The native VST3 graph cannot activate with the current sidechain routing.",
    carriers: snapshot.mixer.sidechainRoutes.map((route) => route.effectInstanceId) },
].filter((limitation) => limitation.carriers.length > 0)

export const nativeSnapshotSupportError = (snapshot: LivePlaybackSnapshot): string | undefined => {
  const limitation = nativeSnapshotLimitations(snapshot)[0]

  if (limitation) return limitation.reason

  if (snapshot.requiresNativePlayback && !snapshot.nativeExternalAttachmentPlan)
    return "The active VST3 attachment plan is unavailable."
}

// The host locks sample memory in whole pages.
export const pageRoundedBytes = (bytes: number) => Math.ceil(bytes / 16_384) * 16_384

export const validateInstrumentAssetBudget = (
  assets: readonly AudioCoreGraphSnapshot["assets"][number][],
  instruments: readonly NonNullable<AudioCoreGraphSnapshot["nodes"][number]["instrument"]>[],
  maximumBytes: number,
  errorMessage = "Instrument sample memory budget exceeded (1 GiB per device).",
) => {
  const bytesById = new Map(assets.map((asset) =>
    [asset.assetId, asset.frameCount * asset.channelCount * Float32Array.BYTES_PER_ELEMENT]))

  for (const instrument of instruments) {
    if (instrument.kind === "synth") continue

    const assetIds = new Set(instrument.kind === "granular"
      ? [instrument.assetId]
      : instrument.zones.map((zone) => zone.assetId))

    let bytes = 0

    for (const assetId of assetIds) bytes += bytesById.get(assetId) ?? 0

    if (bytes > maximumBytes) throw new Error(errorMessage)
  }
}

type AttachmentPlan = NonNullable<LivePlaybackSnapshot["nativeExternalAttachmentPlan"]>

// A compile carries the plan's default worker block size; the session runs every worker at the device's.
export const planWithWorkerFrames = (plan: AttachmentPlan, maximumFrames: number): AttachmentPlan => ({
  ...plan,
  attachments: plan.attachments.map((attachment) => ({
    ...attachment, workerTransport: { ...attachment.workerTransport, maximumFrames } })),
})

// What the host must be told about for a graph. A declared latency is not one: it reaches native through
// `publishAttachmentLatency`.
export const attachmentsChanged = (previous: LivePlaybackSnapshot, snapshot: LivePlaybackSnapshot, maximumFrames: number) => {
  const bindings = (candidate: LivePlaybackSnapshot) => JSON.stringify({
    attachments: candidate.nativeExternalAttachmentPlan
      && planWithWorkerFrames(candidate.nativeExternalAttachmentPlan, maximumFrames).attachments
        .map(({ declaredLatencyFrames: _latency, ...attachment }) => attachment),
    states: candidate.nativeExternalAttachmentStates,
    requirements: candidate.nativeExternalAttachmentStateRequirements,
  })

  return bindings(snapshot) !== bindings(previous)
}
