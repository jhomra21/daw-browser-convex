import { resolveLiveMixerGraph } from "@daw-browser/audio-engine/live-mixer-runtime"
import type { ExportRenderStateSnapshot } from "~/lib/export/run-export-job"
import type { RuntimeTrack } from "~/lib/timeline-runtime-types"
import type { ExternalSidechainRoute } from "@daw-browser/timeline-core/types"
import type { AutomationEnvelope } from "@daw-browser/shared"
import type { NativeExternalAttachmentPlan } from "@daw-browser/plugin-host-protocol"

export type LivePlaybackTransport = {
  state: "playing" | "paused" | "stopped"
  playheadSec: number
  loopEnabled: boolean
  loopStartSec: number
  loopEndSec: number
}

export type LivePlaybackTimeSignature = {
  numerator: number
  denominator: number
}

export type LivePlaybackAsset = {
  assetId: string
  buffer: AudioBuffer
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
      return { ...structuredClone(clipWithoutBuffer), ...(buffer === undefined ? {} : { buffer }) }
    }),
  }
})

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
      if (!clip.buffer) {
        reasons.push(`Audio clip "${clip.id}" is not hydrated.`)
        continue
      }
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
  const fx = structuredClone(input.renderState.fx)
  const sidechainRoutes = structuredClone(input.sidechainRoutes)
  return {
    supported: true,
    snapshot: {
      revision: input.revision,
      bpm: input.bpm,
      timeSignature: structuredClone(timeSignature),
      transport: structuredClone(input.transport),
      tracks,
      assets: [...assetsById.entries()].map(([assetId, buffer]) => ({ assetId, buffer })),
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
