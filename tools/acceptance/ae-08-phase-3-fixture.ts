import { audioCoreContractVersion, encodeReverbProcessorState, type AudioCoreGraphSnapshot } from "@daw-browser/audio-core-contract"
import { compilePortableSynthState } from "@daw-browser/audio-engine/mixer/graph-contract"
import { serializeNativeGraph, serializeNativeInstrumentEvents, serializeNativeInstrumentStates,
  type NativeInstrumentEvent } from "@daw-browser/audio-engine/native-host-wire"
import { createDefaultReverbParams, createDefaultSynthParams, normalizeReverbParams } from "@daw-browser/shared"

// Acceptance-only fixed graph for AE-08 phase 3. It is consumed through the
// normal typed session bridge and never enters product playback or edit routing.
// Each audible source has its own pitch so the analyzer can attribute energy.
export const phase3Notes = { held: 69, wet: 60, deleted: 76 } as const

const base = createDefaultSynthParams()
const sine = [{ enabled: true, wave: "sine" as const, octave: 0, semitone: 0, detuneCents: 0, level: 0.7 }]
// Clean sustained sines make the held and deleted contributions separable by frequency.
const synth = compilePortableSynthState({ ...base, oscillators: sine, filter: { ...base.filter, enabled: false },
  ampEnvelope: { attackSec: 0.005, decaySec: 0.1, sustain: 1, releaseSec: 0.12 } })
// The wet source ends by itself, so every run feeds the reverb identical audio.
const pluck = compilePortableSynthState({ ...base, oscillators: sine, filter: { ...base.filter, enabled: false },
  ampEnvelope: { attackSec: 0.001, decaySec: 0.02, sustain: 0, releaseSec: 0.01 } })
const reverb = normalizeReverbParams({ ...createDefaultReverbParams(), enabled: true, wet: 1, decaySec: 12 })
const reverbProcessor = {
  id: "ae08-wet-reverb", kind: "reverb", kindId: 14, instanceId: 8_080, stateVersion: audioCoreContractVersion,
  state: encodeReverbProcessorState(reverb), parameterTargets: [], latencyFrames: 0, tailFrames: 48_000 * 13, bypassed: false,
} satisfies AudioCoreGraphSnapshot["nodes"][number]["processorOrder"][number]

const instrument = (id: string, processorOrder: AudioCoreGraphSnapshot["nodes"][number]["processorOrder"] = []) => ({
  id, kind: "instrument", inputLayout: "stereo", outputLayout: "stereo", processorOrder, latencyFrames: 0, instrument: id === "wet" ? pluck : synth,
} satisfies AudioCoreGraphSnapshot["nodes"][number])
const edge = (from: string) => ({
  version: audioCoreContractVersion, id: `edge-${from}`, fromNodeId: from, toNodeId: "master", gain: 0.3,
  kind: "output", tap: "post-fader", sidechain: false, pdcDelayFrames: 0,
} satisfies AudioCoreGraphSnapshot["edges"][number])

const revision = (number: number, ids: readonly string[], wet: boolean) => serializeNativeGraph({
  version: audioCoreContractVersion, revision: number, contractHash: "", masterNodeId: "master", assets: [],
  nodes: [...ids.map((id) => instrument(id, wet && id === "wet" ? [reverbProcessor] : [])),
    { id: "master", kind: "master", inputLayout: "stereo", outputLayout: "stereo", processorOrder: [], latencyFrames: 0 }],
  edges: ids.map(edge),
})

const note = (nodeId: string, type: "live-note-on", sequence: number, pitch: number): NativeInstrumentEvent => ({
  nodeId, noteId: pitch, sequence, frameOffset: 0, channel: 0, note: pitch, value: 0.5, type,
})

export const buildPhase3Fixture = () => {
  const initial = ["held", "wet", "deleted"]
  return {
    // Revision 1 is the baseline. 2 adds a silent connected node, 3 removes it
    // again, and 4 deletes a sounding source (the 5 ms fade).
    revisions: [
      revision(1, initial, true),
      revision(2, [...initial, "added"], true),
      revision(3, initial, true),
      revision(4, ["held", "wet"], true),
    ],
    instrumentStates: serializeNativeInstrumentStates(
      initial.map((nodeId) => ({ nodeId, state: nodeId === "wet" ? pluck : synth })), []),
    noteOn: serializeNativeInstrumentEvents(1, [
      note("held", "live-note-on", 1, phase3Notes.held),
      note("wet", "live-note-on", 2, phase3Notes.wet),
      note("deleted", "live-note-on", 3, phase3Notes.deleted),
    ]),
  }
}
