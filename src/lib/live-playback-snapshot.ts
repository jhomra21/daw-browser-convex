import { resolveLiveMixerGraph } from "@daw-browser/audio-engine/live-mixer-runtime"
import type { ExportRenderStateSnapshot } from "~/lib/export/run-export-job"
import type { RuntimeTrack } from "~/lib/timeline-runtime-types"
import type { ExternalSidechainRoute } from "@daw-browser/timeline-core/types"
import type { AutomationEnvelope, TrackInstrumentParams } from "@daw-browser/shared"
import type { NativeExternalAttachmentPlan } from "@daw-browser/plugin-host-protocol"
import type { ExportFx } from "@daw-browser/audio-engine/export-mixdown"
import { localizeInstrumentFx } from "@daw-browser/audio-engine/portable-export-snapshot"
import type { AudioSourceMetadata } from "~/lib/audio-source"
import {
  sampledInstrumentRegion,
  sampledInstrumentRegionIdentity,
  validateSampledInstrumentBuffer,
} from "@daw-browser/audio-engine/sampled-instrument-region"

export type LivePlaybackTransport = {
  state: "playing" | "paused" | "stopped"
  playheadSec: number
  loopEnabled: boolean
  loopStartSec: number
  loopEndSec: number
}

export type LivePlaybackCompileContext = {
  instrumentOverride?: {
    targetId: string
    instrument: TrackInstrumentParams
  }
}

export type LivePlaybackTimeSignature = {
  numerator: number
  denominator: number
}

export type LivePlaybackAsset = {
  assetId: string
  buffer?: AudioBuffer | null
  source?: AudioSourceMetadata
  sourceKind?: "upload" | "url" | "recording"
  sampleUrl?: string
}

export type LivePlaybackSnapshot = {
  revision: number
  bpm: number
  timeSignature?: LivePlaybackTimeSignature
  transport: LivePlaybackTransport
  tracks: readonly RuntimeTrack[]
  assets: readonly LivePlaybackAsset[]
  mixer: {
    graph: ReturnType<typeof resolveLiveMixerGraph>
    fx: ExportRenderStateSnapshot["fx"]
    automationEnvelopes: readonly AutomationEnvelope[]
    sidechainRoutes: readonly ExternalSidechainRoute[]
  }
  nativeExternalAttachmentPlan?: NativeExternalAttachmentPlan
  nativeExternalAttachmentStates?: readonly {
    instanceId: string
    bytes: Uint8Array
    sha256: string
  }[]
  nativeExternalAttachmentStateRequirements?: readonly string[]
  requiresNativePlayback?: boolean
}

export type LivePlaybackSnapshotInput = {
  revision: number
  bpm: number
  timeSignature?: LivePlaybackTimeSignature
  transport: LivePlaybackTransport
  tracks: readonly RuntimeTrack[]
  renderState: ExportRenderStateSnapshot
  sidechainRoutes: readonly ExternalSidechainRoute[]
}

type PlaybackSourceMetadata = {
  source: AudioSourceMetadata
  sourceKind?: "upload" | "url" | "recording"
  sampleUrl?: string
}

const sameAudioMetadata = (left: AudioSourceMetadata, right: AudioSourceMetadata) =>
  Math.round(left.durationSec * left.sampleRate) === Math.round(right.durationSec * right.sampleRate)
  && left.sampleRate === right.sampleRate
  && left.channelCount === right.channelCount

const addInstrumentAssets = (
  assetsById: Map<string, AudioBuffer>,
  fx: ExportFx["trackFx"],
) => {
  const add = (assetId: string, buffer: AudioBuffer) => {
    const previous = assetsById.get(assetId)
    if (previous && (
      previous.length !== buffer.length
      || previous.sampleRate !== buffer.sampleRate
      || previous.numberOfChannels !== buffer.numberOfChannels
    )) throw new Error(`Audio asset "${assetId}" resolves inconsistently.`)
    assetsById.set(assetId, buffer)
  }
  for (const entry of Object.values(fx ?? {})) {
    const instrument = entry.instrument
    if (instrument?.kind === "sampler") {
      for (const zone of instrument.params.zones) {
        const buffer = entry.samplerBuffers?.get(zone.id)
        if (!buffer) throw new Error(`Sampler zone "${zone.id}" is missing its authoritative audio buffer.`)
        add(zone.sample.assetKey, buffer.buffer)
      }
    }
    if (instrument?.kind === "drum-rack") {
      for (const pad of instrument.params.pads) {
        if (!pad.sample) continue
        const buffer = entry.drumRackBuffers?.get(pad.id)
        if (!buffer) throw new Error(`Drum Rack pad "${pad.id}" is missing its authoritative audio buffer.`)
        add(pad.sample.assetKey, buffer.buffer)
      }
    }
    if (instrument?.kind === "granular" && instrument.params.zone) {
      if (!entry.granularBuffer) {
        throw new Error(`Granular zone "${instrument.params.zone.id}" is missing its authoritative audio buffer.`)
      }
      if (entry.granularBuffer.assetKey !== instrument.params.zone.sample.assetKey) {
        throw new Error(`Audio asset "${instrument.params.zone.sample.assetKey}" resolves inconsistently.`)
      }
      add(instrument.params.zone.sample.assetKey, entry.granularBuffer.buffer)
    }
  }
}

const validateInstrumentBuffers = (fx: ExportFx["trackFx"]) => {
  for (const entry of Object.values(fx ?? {})) {
    const instrument = entry.instrument
    if (instrument?.kind === "sampler") {
      for (const zone of instrument.params.zones) {
        const buffer = entry.samplerBuffers?.get(zone.id)
        if (!buffer) continue
        const region = sampledInstrumentRegion(zone.sample.source, zone.startSec, zone.endSec ?? zone.sample.source.durationSec)
        validateSampledInstrumentBuffer(
          buffer,
          zone.sample.source,
          region,
          sampledInstrumentRegionIdentity(zone.sample, region),
        )
      }
    }
    if (instrument?.kind === "drum-rack") {
      for (const pad of instrument.params.pads) {
        if (!pad.sample) continue
        const buffer = entry.drumRackBuffers?.get(pad.id)
        if (!buffer) continue
        const region = sampledInstrumentRegion(pad.sample.source, pad.startSec, pad.endSec ?? pad.sample.source.durationSec)
        validateSampledInstrumentBuffer(
          buffer,
          pad.sample.source,
          region,
          sampledInstrumentRegionIdentity(pad.sample, region),
        )
      }
    }
    if (instrument?.kind === "granular" && instrument.params.zone && entry.granularBuffer) {
      const zone = instrument.params.zone
      const region = sampledInstrumentRegion(zone.sample.source, zone.startSec, zone.endSec ?? zone.sample.source.durationSec)
      if (entry.granularBuffer.assetKey !== sampledInstrumentRegionIdentity(zone.sample, region)) {
        throw new Error(`Audio asset "${zone.sample.assetKey}" resolves inconsistently.`)
      }
      validateSampledInstrumentBuffer(
        entry.granularBuffer,
        zone.sample.source,
        region,
        sampledInstrumentRegionIdentity(zone.sample, region),
      )
    }
  }
}

export type LivePlaybackSnapshotCompilation =
  | { supported: true; snapshot: LivePlaybackSnapshot }
  | { supported: false; reasons: readonly string[] }

const invalid = (reasons: readonly string[]): LivePlaybackSnapshotCompilation => ({
  supported: false,
  reasons,
})

const snapshotTracks = (tracks: readonly RuntimeTrack[]): RuntimeTrack[] => tracks.map((track) => {
  const { clips, ...trackWithoutClips } = track
  return {
    ...structuredClone(trackWithoutClips),
    clips: clips.map((clip) => {
      const { buffer, ...clipWithoutBuffer } = clip
      return { ...structuredClone(clipWithoutBuffer), buffer }
    }),
  }
})

type LiveTrackFxMap = NonNullable<ExportFx["trackFx"]>
type LiveTrackFxEntry = LiveTrackFxMap[string]

const cloneAudioBufferMap = <Value,>(buffers: ReadonlyMap<string, Value>): Map<string, Value> => {
  const clone = new Map<string, Value>()
  for (const [key, buffer] of buffers) clone.set(key, buffer)
  return clone
}

const cloneLiveTrackFxEntry = (entry: LiveTrackFxEntry): LiveTrackFxEntry => {
  const { drumRackBuffers, samplerBuffers, granularBuffer, ...serializableEntry } = entry
  return {
    ...structuredClone(serializableEntry),
    drumRackBuffers: drumRackBuffers === undefined ? undefined : cloneAudioBufferMap(drumRackBuffers),
    samplerBuffers: samplerBuffers === undefined ? undefined : cloneAudioBufferMap(samplerBuffers),
    granularBuffer: granularBuffer === undefined ? undefined : {
      assetKey: granularBuffer.assetKey,
      buffer: granularBuffer.buffer,
      sourceStartFrame: granularBuffer.sourceStartFrame,
      sourceIdentity: granularBuffer.sourceIdentity,
    },
  }
}

const cloneLiveFx = (fx: ExportFx): ExportFx => {
  const { trackFx, ...serializableFx } = fx
  return {
    ...structuredClone(serializableFx),
    trackFx: trackFx === undefined ? undefined : Object.fromEntries(
      Object.entries(trackFx).map(([trackId, entry]) => [trackId, cloneLiveTrackFxEntry(entry)]),
    ),
  }
}

/**
 * Timeline owns this portable playback input. The caller supplies the already
 * resolved project render state so this boundary neither reads persistence nor
 * reimplements effects, mixer, or sidechain resolution.
 */
export const compileLivePlaybackSnapshot = (
  input: LivePlaybackSnapshotInput,
): LivePlaybackSnapshotCompilation => {
  const reasons: string[] = []
  if (!Number.isSafeInteger(input.revision) || input.revision <= 0) reasons.push("Playback revision must be a positive safe integer.")
  if (!Number.isFinite(input.bpm) || input.bpm <= 0) reasons.push("Playback BPM must be positive and finite.")
  const timeSignature = input.timeSignature ?? { numerator: 4, denominator: 4 }
  if (!Number.isSafeInteger(timeSignature.numerator) || timeSignature.numerator <= 0
    || !Number.isSafeInteger(timeSignature.denominator) || timeSignature.denominator <= 0) {
    reasons.push("Playback time signature must contain positive integer values.")
  }
  if (!Number.isFinite(input.transport.playheadSec) || input.transport.playheadSec < 0) reasons.push("Playback playhead must be finite and non-negative.")
  if (input.transport.loopEnabled && !(input.transport.loopStartSec >= 0 && input.transport.loopEndSec > input.transport.loopStartSec)) {
    reasons.push("An enabled playback loop must have a positive range.")
  }

  const trackIds = new Set<string>()
  const clipIds = new Set<string>()
  const assetsById = new Map<string, AudioBuffer>()
  const sourceMetadataById = new Map<string, PlaybackSourceMetadata>()
  const addSourceMetadata = (
    assetId: string,
    clip: typeof input.tracks[number]["clips"][number],
    buffer: AudioBuffer | null | undefined,
  ) => {
    const resolvedSource = buffer
      ? {
        durationSec: buffer.duration,
        sampleRate: buffer.sampleRate,
        channelCount: buffer.numberOfChannels,
      }
      : clip.sourceDurationSec !== undefined
        && clip.sourceSampleRate !== undefined
        && clip.sourceChannelCount !== undefined
        ? {
          durationSec: clip.sourceDurationSec,
          sampleRate: clip.sourceSampleRate,
          channelCount: clip.sourceChannelCount,
        }
        : undefined
    if (!resolvedSource) {
      if (clip.audioWarp?.enabled === true
        && clip.audioWarp.mode === 'stretch'
        && clip.sourceDurationSec !== undefined
        && clip.sourceSampleRate !== undefined
        && clip.sourceChannelCount !== undefined) {
        sourceMetadataById.set(assetId, {
          source: {
            durationSec: clip.sourceDurationSec,
            sampleRate: clip.sourceSampleRate,
            channelCount: clip.sourceChannelCount,
          },
          sourceKind: clip.sourceKind,
          sampleUrl: clip.sampleUrl,
        })
        return
      }
      reasons.push(`Audio clip "${clip.id}" is not hydrated.`)
      return
    }
    if (buffer && (
      clip.sourceDurationSec !== undefined && Math.round(clip.sourceDurationSec * buffer.sampleRate) !== buffer.length
      || clip.sourceSampleRate !== undefined && clip.sourceSampleRate !== buffer.sampleRate
      || clip.sourceChannelCount !== undefined && clip.sourceChannelCount !== buffer.numberOfChannels
    )) {
      reasons.push(`Audio asset "${assetId}" resolves inconsistently.`)
      return
    }
    const previous = sourceMetadataById.get(assetId)
    if (previous && (
      !sameAudioMetadata(previous.source, resolvedSource)
      || previous.sourceKind !== undefined && clip.sourceKind !== undefined && previous.sourceKind !== clip.sourceKind
      || previous.sampleUrl !== undefined && clip.sampleUrl !== undefined && previous.sampleUrl !== clip.sampleUrl
    )) {
      reasons.push(`Audio asset "${assetId}" resolves inconsistently.`)
      return
    }
    const metadata: PlaybackSourceMetadata = {
      source: previous?.source ?? resolvedSource,
      sourceKind: previous?.sourceKind ?? clip.sourceKind,
      sampleUrl: previous?.sampleUrl ?? clip.sampleUrl,
    }
    sourceMetadataById.set(assetId, metadata)
  }
  for (const track of input.tracks) {
    if (trackIds.has(track.id)) reasons.push(`Duplicate playback track: ${track.id}`)
    trackIds.add(track.id)
    for (const clip of track.clips) {
      if (clipIds.has(clip.id)) reasons.push(`Duplicate playback clip: ${clip.id}`)
      clipIds.add(clip.id)
      if (clip.midi) continue
      if (!clip.sourceAssetKey) {
        reasons.push(`Audio clip "${clip.id}" has no source asset.`)
        continue
      }
      addSourceMetadata(clip.sourceAssetKey, clip, clip.buffer)
      if (!clip.buffer) continue
      const previous = assetsById.get(clip.sourceAssetKey)
      if (previous && (
        previous.length !== clip.buffer.length
        || previous.sampleRate !== clip.buffer.sampleRate
        || previous.numberOfChannels !== clip.buffer.numberOfChannels
      )) reasons.push(`Audio asset "${clip.sourceAssetKey}" resolves inconsistently.`)
      else assetsById.set(clip.sourceAssetKey, clip.buffer)
    }
  }
  if (reasons.length > 0) return invalid(reasons)

  const tracks = snapshotTracks(input.tracks)
  try {
    validateInstrumentBuffers(input.renderState.fx.trackFx)
  } catch (error) {
    return invalid([error instanceof Error ? error.message : "Instrument audio assets resolve inconsistently."])
  }
  const fx = localizeInstrumentFx(cloneLiveFx(input.renderState.fx)) ?? {
    masterFxInstances: [],
    trackFx: {},
  }
  try {
    addInstrumentAssets(assetsById, fx.trackFx)
  } catch (error) {
    return invalid([error instanceof Error ? error.message : "Instrument audio assets resolve inconsistently."])
  }
  for (const [assetId, buffer] of assetsById) {
    if (sourceMetadataById.has(assetId)) continue
    sourceMetadataById.set(assetId, {
      source: {
        durationSec: buffer.duration,
        sampleRate: buffer.sampleRate,
        channelCount: buffer.numberOfChannels,
      },
    })
  }
  const sidechainRoutes = structuredClone(input.sidechainRoutes)
  return {
    supported: true,
    snapshot: {
      revision: input.revision,
      bpm: input.bpm,
      timeSignature: structuredClone(timeSignature),
      transport: structuredClone(input.transport),
      tracks,
      assets: [...sourceMetadataById.entries()].map(([assetId, metadata]) => {
        const buffer = assetsById.get(assetId)
        return buffer ? { assetId, buffer } : { assetId, ...metadata }
      }),
      mixer: {
        graph: resolveLiveMixerGraph(tracks, fx.trackFx ?? {}, {
          masterFxInstances: fx.masterFxInstances,
          masterVolume: fx.masterVolume,
        }),
        fx,
        automationEnvelopes: structuredClone(input.renderState.automationEnvelopes),
        sidechainRoutes,
      },
    },
  }
}
