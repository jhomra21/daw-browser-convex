import type { ExportRange } from '@daw-browser/audio-engine/export-range'
import {
  normalizeExportNormalization,
  normalizeExportTailPolicy,
  normalizeWavEncodingSettings,
} from '@daw-browser/audio-engine/export-fidelity'
import type { ExportAudioFormat, MidiClip } from '@daw-browser/shared'
import type { ExternalSidechainRoute } from '@daw-browser/timeline-core/types'
import type { RuntimeClip, RuntimeTrack } from '~/lib/timeline-runtime-types'
import type { ExportEncodingSettings, ExportRenderSettings } from '~/lib/export/export-settings'
import type { ExportAutomationPatch } from '~/lib/export/run-export-job'

type TimelineExportSettings = {
  range: ExportRange
  formats: readonly ExportAudioFormat[]
  render: ExportRenderSettings
  encoding: ExportEncodingSettings
}

const cloneRange = (range: ExportRange): ExportRange => {
  if (range.mode === 'whole') return { mode: range.mode }
  return { mode: range.mode, startSec: range.startSec, endSec: range.endSec }
}

const cloneMidiClip = (midi: MidiClip): MidiClip => ({
  wave: midi.wave,
  ...(midi.gain === undefined ? {} : { gain: midi.gain }),
  ...(midi.inputChannel === undefined ? {} : { inputChannel: midi.inputChannel }),
  notes: midi.notes.map((note) => ({
    ...(note.id === undefined ? {} : { id: note.id }),
    beat: note.beat,
    length: note.length,
    pitch: note.pitch,
    ...(note.velocity === undefined ? {} : { velocity: note.velocity }),
    ...(note.channel === undefined ? {} : { channel: note.channel }),
  })),
  ...(midi.cc === undefined ? {} : {
    cc: midi.cc.map((event) => ({
      ...(event.id === undefined ? {} : { id: event.id }),
      beat: event.beat,
      controller: event.controller,
      value: event.value,
      ...(event.channel === undefined ? {} : { channel: event.channel }),
    })),
  }),
  ...(midi.pitchBends === undefined ? {} : {
    pitchBends: midi.pitchBends.map((event) => ({
      ...(event.id === undefined ? {} : { id: event.id }),
      beat: event.beat,
      value: event.value,
      ...(event.channel === undefined ? {} : { channel: event.channel }),
    })),
  }),
  ...(midi.channelPressure === undefined ? {} : {
    channelPressure: midi.channelPressure.map((event) => ({
      ...(event.id === undefined ? {} : { id: event.id }),
      beat: event.beat,
      value: event.value,
      ...(event.channel === undefined ? {} : { channel: event.channel }),
    })),
  }),
  ...(midi.polyPressure === undefined ? {} : {
    polyPressure: midi.polyPressure.map((event) => ({
      ...(event.id === undefined ? {} : { id: event.id }),
      beat: event.beat,
      pitch: event.pitch,
      value: event.value,
      ...(event.channel === undefined ? {} : { channel: event.channel }),
    })),
  }),
  ...(midi.mappings === undefined ? {} : {
    mappings: midi.mappings.map((mapping) => ({
      id: mapping.id,
      source: mapping.source.kind === 'cc'
        ? {
          kind: mapping.source.kind,
          controller: mapping.source.controller,
          ...(mapping.source.channel === undefined ? {} : { channel: mapping.source.channel }),
        }
        : mapping.source.kind === 'pitch-bend'
          ? {
            kind: mapping.source.kind,
            ...(mapping.source.channel === undefined ? {} : { channel: mapping.source.channel }),
          }
          : mapping.source.kind === 'channel-pressure'
            ? {
              kind: mapping.source.kind,
              ...(mapping.source.channel === undefined ? {} : { channel: mapping.source.channel }),
            }
            : {
              kind: mapping.source.kind,
              ...(mapping.source.channel === undefined ? {} : { channel: mapping.source.channel }),
              ...(mapping.source.pitch === undefined ? {} : { pitch: mapping.source.pitch }),
            },
      target: {
        parameterId: mapping.target.parameterId,
        ...(mapping.target.effectInstanceId === undefined ? {} : { effectInstanceId: mapping.target.effectInstanceId }),
      },
      outputMin: mapping.outputMin,
      outputMax: mapping.outputMax,
    })),
  }),
})

const cloneClip = (clip: RuntimeClip): RuntimeClip => ({
  id: clip.id,
  ...(clip.historyRef === undefined ? {} : { historyRef: clip.historyRef }),
  name: clip.name,
  ...(clip.mediaStatus === undefined ? {} : { mediaStatus: clip.mediaStatus }),
  startSec: clip.startSec,
  duration: clip.duration,
  ...(clip.sourceAssetKey === undefined ? {} : { sourceAssetKey: clip.sourceAssetKey }),
  ...(clip.waveformAssetKey === undefined ? {} : { waveformAssetKey: clip.waveformAssetKey }),
  ...(clip.sourceKind === undefined ? {} : { sourceKind: clip.sourceKind }),
  ...(clip.sourceDurationSec === undefined ? {} : { sourceDurationSec: clip.sourceDurationSec }),
  ...(clip.sourceSampleRate === undefined ? {} : { sourceSampleRate: clip.sourceSampleRate }),
  ...(clip.sourceChannelCount === undefined ? {} : { sourceChannelCount: clip.sourceChannelCount }),
  ...(clip.leftPadSec === undefined ? {} : { leftPadSec: clip.leftPadSec }),
  ...(clip.bufferOffsetSec === undefined ? {} : { bufferOffsetSec: clip.bufferOffsetSec }),
  ...(clip.audioWarp === undefined ? {} : {
    audioWarp: {
      enabled: clip.audioWarp.enabled,
      ...(clip.audioWarp.sourceBpm === undefined ? {} : { sourceBpm: clip.audioWarp.sourceBpm }),
      ...(clip.audioWarp.sourceBeatOffset === undefined ? {} : { sourceBeatOffset: clip.audioWarp.sourceBeatOffset }),
      ...(clip.audioWarp.markers === undefined ? {} : {
        markers: clip.audioWarp.markers.map((marker) => ({
          id: marker.id,
          sourceBeat: marker.sourceBeat,
          timelineBeat: marker.timelineBeat,
        })),
      }),
      mode: clip.audioWarp.mode,
    },
  }),
  ...(clip.gain === undefined ? {} : { gain: clip.gain }),
  ...(clip.fades === undefined ? {} : {
    fades: {
      ...(clip.fades.fadeInStartSec === undefined ? {} : { fadeInStartSec: clip.fades.fadeInStartSec }),
      fadeInSec: clip.fades.fadeInSec,
      fadeOutSec: clip.fades.fadeOutSec,
      ...(clip.fades.fadeOutEndSec === undefined ? {} : { fadeOutEndSec: clip.fades.fadeOutEndSec }),
      fadeInCurve: clip.fades.fadeInCurve,
      fadeOutCurve: clip.fades.fadeOutCurve,
      ...(clip.fades.fadeInCurvePosition === undefined ? {} : { fadeInCurvePosition: clip.fades.fadeInCurvePosition }),
      ...(clip.fades.fadeOutCurvePosition === undefined ? {} : { fadeOutCurvePosition: clip.fades.fadeOutCurvePosition }),
    },
  }),
  color: clip.color,
  ...(clip.sampleUrl === undefined ? {} : { sampleUrl: clip.sampleUrl }),
  ...(clip.midi === undefined ? {} : { midi: cloneMidiClip(clip.midi) }),
  ...(clip.midiOffsetBeats === undefined ? {} : { midiOffsetBeats: clip.midiOffsetBeats }),
  ...(clip.buffer === undefined ? {} : { buffer: clip.buffer }),
})

const cloneTrack = (track: RuntimeTrack): RuntimeTrack => ({
  id: track.id,
  ...(track.historyRef === undefined ? {} : { historyRef: track.historyRef }),
  name: track.name,
  volume: track.volume,
  clips: track.clips.map(cloneClip),
  ...(track.muted === undefined ? {} : { muted: track.muted }),
  ...(track.soloed === undefined ? {} : { soloed: track.soloed }),
  ...(track.lockedBy === undefined ? {} : { lockedBy: track.lockedBy }),
  ...(track.lockedAt === undefined ? {} : { lockedAt: track.lockedAt }),
  ...(track.kind === undefined ? {} : { kind: track.kind }),
  ...(track.channelRole === undefined ? {} : { channelRole: track.channelRole }),
  ...(track.groupId === undefined ? {} : { groupId: track.groupId }),
  ...(track.collapsed === undefined ? {} : { collapsed: track.collapsed }),
  ...(track.color === undefined ? {} : { color: track.color }),
  ...(track.outputTargetId === undefined ? {} : { outputTargetId: track.outputTargetId }),
  ...(track.sends === undefined ? {} : {
    sends: track.sends.map((send) => ({
      targetId: send.targetId,
      amount: send.amount,
      ...(send.tap === undefined ? {} : { tap: send.tap }),
    })),
  }),
})

const cloneAutomationEnvelope = (envelope: ExportAutomationPatch['envelope']) => (
  envelope === undefined
    ? undefined
    : {
      id: envelope.id,
      projectId: envelope.projectId,
      target: envelope.target.kind === 'track'
        ? {
          kind: envelope.target.kind,
          trackId: envelope.target.trackId,
          ...(envelope.target.effectInstanceId === undefined ? {} : { effectInstanceId: envelope.target.effectInstanceId }),
        }
        : {
          kind: envelope.target.kind,
          ...(envelope.target.effectInstanceId === undefined ? {} : { effectInstanceId: envelope.target.effectInstanceId }),
        },
      targetKey: envelope.targetKey,
      parameterId: envelope.parameterId,
      enabled: envelope.enabled,
      points: envelope.points.map((point) => ({
        id: point.id,
        timeSec: point.timeSec,
        value: point.value,
        interpolation: point.interpolation,
      })),
      updatedAt: envelope.updatedAt,
    }
)

export const snapshotTimelineTracks = (tracks: readonly RuntimeTrack[]): RuntimeTrack[] => tracks.map(cloneTrack)

export const snapshotAutomationPatches = (
  patches: readonly ExportAutomationPatch[],
): ExportAutomationPatch[] => patches.map((patch) => ({
  targetKey: patch.targetKey,
  envelope: cloneAutomationEnvelope(patch.envelope),
}))

export const snapshotSidechainRoutes = (routes: readonly ExternalSidechainRoute[]): ExternalSidechainRoute[] => routes.map((route) => ({
  sourceTrackId: route.sourceTrackId,
  targetTrackId: route.targetTrackId,
  effectInstanceId: route.effectInstanceId,
}))

export const snapshotExportSettings = (settings: TimelineExportSettings): TimelineExportSettings => ({
  range: cloneRange(settings.range),
  formats: [...settings.formats],
  render: {
    sampleRate: settings.render.sampleRate,
    numberOfChannels: settings.render.numberOfChannels,
    normalization: normalizeExportNormalization(settings.render.normalization),
    tail: normalizeExportTailPolicy(settings.render.tail),
  },
  encoding: {
    bitrateByFormat: {
      ...(settings.encoding.bitrateByFormat.mp3 === undefined ? {} : { mp3: settings.encoding.bitrateByFormat.mp3 }),
      ...(settings.encoding.bitrateByFormat['ogg-opus'] === undefined ? {} : { 'ogg-opus': settings.encoding.bitrateByFormat['ogg-opus'] }),
    },
    wav: normalizeWavEncodingSettings(settings.encoding.wav),
  },
})
