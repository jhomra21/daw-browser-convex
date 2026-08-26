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
  gain: midi.gain,
  inputChannel: midi.inputChannel,
  notes: midi.notes.map((note) => ({
    id: note.id,
    beat: note.beat,
    length: note.length,
    pitch: note.pitch,
    velocity: note.velocity,
    channel: note.channel,
  })),
  cc: midi.cc === undefined ? undefined : midi.cc.map((event) => ({
      id: event.id,
      beat: event.beat,
      controller: event.controller,
      value: event.value,
      channel: event.channel,
    })),
  pitchBends: midi.pitchBends === undefined ? undefined : midi.pitchBends.map((event) => ({
      id: event.id,
      beat: event.beat,
      value: event.value,
      channel: event.channel,
    })),
  channelPressure: midi.channelPressure === undefined ? undefined : midi.channelPressure.map((event) => ({
      id: event.id,
      beat: event.beat,
      value: event.value,
      channel: event.channel,
    })),
  polyPressure: midi.polyPressure === undefined ? undefined : midi.polyPressure.map((event) => ({
      id: event.id,
      beat: event.beat,
      pitch: event.pitch,
      value: event.value,
      channel: event.channel,
    })),
  mappings: midi.mappings === undefined ? undefined : midi.mappings.map((mapping) => ({
      id: mapping.id,
      source: mapping.source.kind === 'cc'
        ? {
          kind: mapping.source.kind,
          controller: mapping.source.controller,
          channel: mapping.source.channel,
        }
        : mapping.source.kind === 'pitch-bend'
          ? {
            kind: mapping.source.kind,
            channel: mapping.source.channel,
          }
          : mapping.source.kind === 'channel-pressure'
            ? {
              kind: mapping.source.kind,
              channel: mapping.source.channel,
            }
            : {
              kind: mapping.source.kind,
              channel: mapping.source.channel,
              pitch: mapping.source.pitch,
            },
      target: {
        parameterId: mapping.target.parameterId,
        effectInstanceId: mapping.target.effectInstanceId,
      },
      outputMin: mapping.outputMin,
      outputMax: mapping.outputMax,
    })),
})

const cloneClip = (clip: RuntimeClip): RuntimeClip => ({
  id: clip.id,
  historyRef: clip.historyRef,
  name: clip.name,
  mediaStatus: clip.mediaStatus,
  startSec: clip.startSec,
  duration: clip.duration,
  sourceAssetKey: clip.sourceAssetKey,
  waveformAssetKey: clip.waveformAssetKey,
  sourceKind: clip.sourceKind,
  sourceDurationSec: clip.sourceDurationSec,
  sourceSampleRate: clip.sourceSampleRate,
  sourceChannelCount: clip.sourceChannelCount,
  leftPadSec: clip.leftPadSec,
  bufferOffsetSec: clip.bufferOffsetSec,
  audioWarp: clip.audioWarp === undefined ? undefined : {
      enabled: clip.audioWarp.enabled,
      sourceBpm: clip.audioWarp.sourceBpm,
      sourceBeatOffset: clip.audioWarp.sourceBeatOffset,
      markers: clip.audioWarp.markers === undefined ? undefined : clip.audioWarp.markers.map((marker) => ({
        id: marker.id,
        sourceBeat: marker.sourceBeat,
        timelineBeat: marker.timelineBeat,
      })),
      mode: clip.audioWarp.mode,
    },
  gain: clip.gain,
  fades: clip.fades === undefined ? undefined : {
      fadeInStartSec: clip.fades.fadeInStartSec,
      fadeInSec: clip.fades.fadeInSec,
      fadeOutSec: clip.fades.fadeOutSec,
      fadeOutEndSec: clip.fades.fadeOutEndSec,
      fadeInCurve: clip.fades.fadeInCurve,
      fadeOutCurve: clip.fades.fadeOutCurve,
      fadeInCurvePosition: clip.fades.fadeInCurvePosition,
      fadeOutCurvePosition: clip.fades.fadeOutCurvePosition,
    },
  color: clip.color,
  sampleUrl: clip.sampleUrl,
  midi: clip.midi === undefined ? undefined : cloneMidiClip(clip.midi),
  midiOffsetBeats: clip.midiOffsetBeats,
  buffer: clip.buffer,
})

const cloneTrack = (track: RuntimeTrack): RuntimeTrack => ({
  id: track.id,
  historyRef: track.historyRef,
  name: track.name,
  volume: track.volume,
  clips: track.clips.map(cloneClip),
  muted: track.muted,
  soloed: track.soloed,
  lockedBy: track.lockedBy,
  lockedAt: track.lockedAt,
  kind: track.kind,
  channelRole: track.channelRole,
  groupId: track.groupId,
  collapsed: track.collapsed,
  color: track.color,
  outputTargetId: track.outputTargetId,
  sends: track.sends === undefined ? undefined : track.sends.map((send) => ({
      targetId: send.targetId,
      amount: send.amount,
      tap: send.tap,
    })),
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
          effectInstanceId: envelope.target.effectInstanceId,
        }
        : {
          kind: envelope.target.kind,
          effectInstanceId: envelope.target.effectInstanceId,
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
      mp3: settings.encoding.bitrateByFormat.mp3,
      'ogg-opus': settings.encoding.bitrateByFormat['ogg-opus'],
    },
    wav: normalizeWavEncodingSettings(settings.encoding.wav),
  },
})
