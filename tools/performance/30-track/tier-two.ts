import {
  controlApprovalResultSchemaV1,
  controlCommitResultSchemaV1,
  controlPreviewResultSchemaV1,
  parseControlApprovalRequestV1,
  parseControlCommitRequestV1,
  parseControlPreviewRequestV1,
  projectSnapshotSchemaV2,
  type ControlPreviewRequestV1,
  type ProjectSnapshotV2,
} from "@daw-browser/control"
import {
  createLocalControlService,
  LocalControlServiceError,
} from "../../../src/lib/local-control/local-control-service"
import { serializeJsonValue } from "../../../src/lib/json"
import { thirtyTrackSemanticManifest } from "./spec"

const trackClientRef = "tier2-track"
const clipClientRef = "tier2-midi-clip"
const saturatorClientRef = "tier2-saturator"
const utilityClientRef = "tier2-utility"

export const tierTwoRequiredActionKinds = [
  "track.create",
  "track.mix.set",
  "clip.midi.create",
  "instrument.set",
  "effect.upsert",
  "effect.reorder",
  "automation.set",
]

const localResult = async <Value>(operation: () => Promise<Value>): Promise<Value> => {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof LocalControlServiceError) throw new Error(error.data.message)
    throw error
  }
}

export const createTierTwoControlClient = (projectId: string) => {
  const local = createLocalControlService({
    actor: { subject: "local:00000000-0000-4000-8000-000000000000" },
  })
  return {
    snapshotV2: async () => projectSnapshotSchemaV2.parse(await localResult(() => local.snapshotV2({ projectId }))),
    previewV1: async (request: Parameters<typeof parseControlPreviewRequestV1>[0]) => controlPreviewResultSchemaV1.parse(
      await localResult(() => local.preview(serializeJsonValue(parseControlPreviewRequestV1(request)))),
    ),
    requestApprovalV1: async (request: Parameters<typeof parseControlApprovalRequestV1>[0]) => controlApprovalResultSchemaV1.parse(
      await localResult(() => local.requestApproval(serializeJsonValue(parseControlApprovalRequestV1(request)))),
    ),
    commitV1: async (request: Parameters<typeof parseControlCommitRequestV1>[0]) => controlCommitResultSchemaV1.parse(
      await localResult(() => local.commit(serializeJsonValue(parseControlCommitRequestV1(request)))),
    ),
  }
}

export const createTierTwoControlRequest = (
  projectId: string,
  expectedRevision: number,
): ControlPreviewRequestV1 => ({
  version: "v1",
  projectId,
  expectedRevision,
  actions: [
    {
      kind: "track.create",
      clientRef: trackClientRef,
      name: thirtyTrackSemanticManifest.tier2.track.name,
      index: thirtyTrackSemanticManifest.tier2.track.index,
      trackKind: "instrument",
    },
    {
      kind: "clip.midi.create",
      clientRef: clipClientRef,
      track: { source: "client", clientRef: trackClientRef },
      name: thirtyTrackSemanticManifest.tier2.midiClip.name,
      startSec: thirtyTrackSemanticManifest.tier2.midiClip.startSec,
      duration: thirtyTrackSemanticManifest.tier2.midiClip.durationSec,
      wave: thirtyTrackSemanticManifest.tier2.midiClip.wave,
      notes: [...thirtyTrackSemanticManifest.tier2.midiClip.notes],
    },
    {
      kind: "track.mix.set",
      track: { source: "client", clientRef: trackClientRef },
      volume: thirtyTrackSemanticManifest.tier2.track.volume,
    },
    {
      kind: "instrument.set",
      target: { kind: "track", track: { source: "client", clientRef: trackClientRef } },
      instrumentKind: "synth",
      params: thirtyTrackSemanticManifest.tier2.instrument.params,
    },
    {
      kind: "effect.upsert",
      clientRef: saturatorClientRef,
      target: { kind: "track", track: { source: "client", clientRef: trackClientRef } },
      effectKind: "saturator",
      params: thirtyTrackSemanticManifest.tier2.effects[0].params,
    },
    {
      kind: "effect.upsert",
      clientRef: utilityClientRef,
      target: { kind: "track", track: { source: "client", clientRef: trackClientRef } },
      effectKind: "utility",
      params: thirtyTrackSemanticManifest.tier2.effects[1].params,
    },
    {
      kind: "effect.reorder",
      target: { kind: "track", track: { source: "client", clientRef: trackClientRef } },
      order: [
        { effect: { source: "client", clientRef: saturatorClientRef }, kind: "saturator" },
        { effect: { source: "client", clientRef: utilityClientRef }, kind: "utility" },
      ],
    },
    {
      kind: "automation.set",
      target: { kind: "track", track: { source: "client", clientRef: trackClientRef } },
      effect: { source: "client", clientRef: saturatorClientRef },
      parameterId: thirtyTrackSemanticManifest.tier2.automation.parameterId,
      enabled: thirtyTrackSemanticManifest.tier2.automation.enabled,
      points: [...thirtyTrackSemanticManifest.tier2.automation.points],
    },
  ],
})

const assertCanonical = <Actual, Expected>(label: string, actual: Actual, expected: Expected): void => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} does not match the canonical Tier 2 fixture.`)
  }
}

export const assertThirtyTrackSnapshot = (snapshot: ProjectSnapshotV2): void => {
  const expected = thirtyTrackSemanticManifest
  const tracks = [...snapshot.tracks].sort((left, right) => left.index - right.index)
  const audioTracks = tracks.filter((track) => track.kind === "audio" && track.channelRole === "track")
  const trackIndexById = new Map(tracks.map((track) => [track.id, track.index]))
  const audioClips = snapshot.clips
    .filter((clip) => clip.midi === undefined)
    .sort((left, right) => left.bufferOffsetSec - right.bufferOffsetSec)

  assertCanonical("Project name", snapshot.project.name, expected.projectName)
  assertCanonical("Track count", snapshot.tracks.length, expected.timeline.trackCount)
  assertCanonical("Clip count", snapshot.clips.length, expected.timeline.clipCount)
  assertCanonical("Audio tracks", audioTracks.map((track) => ({
    index: track.index,
    name: track.name,
    kind: track.kind,
    volume: track.volume,
    color: track.color,
  })), expected.timeline.tracks)
  assertCanonical("Audio clips", audioClips.map((clip, index) => ({
    index,
    name: clip.name,
    trackIndex: trackIndexById.get(clip.trackId) ?? -1,
    startSec: clip.startSec,
    durationSec: clip.duration,
    sourceOffsetSec: clip.bufferOffsetSec,
    gain: clip.gain,
    color: clip.color,
    sourceKind: "recording",
    sourceDurationSec: expected.source.durationSec,
    sourceSampleRate: expected.sampleRate,
    sourceChannelCount: expected.source.channelCount,
  })), expected.timeline.clips)

  const tierTwoTrack = tracks.find((track) => track.name === expected.tier2.track.name)
  if (!tierTwoTrack) throw new Error("Tier 2 instrument track is missing.")
  assertCanonical("Tier 2 track", {
    id: trackClientRef,
    name: tierTwoTrack.name,
    index: tierTwoTrack.index,
    kind: tierTwoTrack.kind,
    volume: tierTwoTrack.volume,
  }, expected.tier2.track)

  const midiClip = snapshot.clips.find((clip) => clip.trackId === tierTwoTrack.id && clip.midi !== undefined)
  if (!midiClip?.midi) throw new Error("Tier 2 MIDI clip is missing.")
  assertCanonical("Tier 2 MIDI clip", {
    id: clipClientRef,
    name: midiClip.name,
    startSec: midiClip.startSec,
    durationSec: midiClip.duration,
    wave: midiClip.midi.wave,
    notes: midiClip.midi.notes.map((note) => ({
      id: note.id ?? "missing-tier2-note-id",
      beat: note.beat,
      length: note.length,
      pitch: note.pitch,
      velocity: note.velocity,
    })),
  }, expected.tier2.midiClip)

  const processors = snapshot.processors
    .filter((processor) => "trackId" in processor.target && processor.target.trackId === tierTwoTrack.id)
    .sort((left, right) => left.index - right.index)
  const instrument = processors.find((processor) => processor.processor.kind === "instrument")
  const saturator = processors.find((processor) => processor.processor.kind === "saturator")
  const utility = processors.find((processor) => processor.processor.kind === "utility")
  if (instrument?.processor.kind !== "instrument" || instrument.processor.params.kind !== "synth") {
    throw new Error("Tier 2 synth processor is missing.")
  }
  if (saturator?.processor.kind !== "saturator") throw new Error("Tier 2 saturator is missing.")
  if (utility?.processor.kind !== "utility") throw new Error("Tier 2 utility is missing.")
  assertCanonical("Tier 2 instrument", {
    id: expected.tier2.instrument.id,
    kind: instrument.processor.params.kind,
    params: instrument.processor.params.params,
  }, expected.tier2.instrument)
  assertCanonical("Tier 2 effects", [
    { id: saturatorClientRef, index: saturator.index, kind: saturator.processor.kind, params: saturator.processor.params },
    { id: utilityClientRef, index: utility.index, kind: utility.processor.kind, params: utility.processor.params },
  ], expected.tier2.effects)

  const automation = snapshot.automation.find((entry) => (
    "trackId" in entry.target
    && entry.target.trackId === tierTwoTrack.id
    && entry.effectInstanceId === saturator.instanceId
    && entry.parameterId === expected.tier2.automation.parameterId
  ))
  if (!automation) throw new Error("Tier 2 saturator automation is missing.")
  assertCanonical("Tier 2 automation", {
    effectKind: "saturator",
    parameterId: automation.parameterId,
    enabled: automation.enabled,
    points: automation.points.map((point) => ({
      id: point.id,
      timeSec: point.timeSec,
      value: point.value,
      interpolation: point.interpolation,
    })),
  }, expected.tier2.automation)
}
