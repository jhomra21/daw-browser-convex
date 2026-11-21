import type { AudioAssetRef, PlanarPcm } from "@daw-browser/audio-core-contract"
import type { PreparedPortableSession, PortableAssetRegistryInput } from "@daw-browser/audio-engine/portable-session-compiler"
import { portableWasmPagedMaxChannels } from "@daw-browser/audio-engine/portable-wasm-protocol"
import { compilePreparedPortableLiveSession } from "~/lib/portable-live-session"
import type { LivePlaybackSnapshot } from "~/lib/live-playback-snapshot"
import type { PortablePreparedStretchAsset } from "@daw-browser/audio-engine/portable-stretch-preparation"
import type { PortablePagedStretchAsset } from "@daw-browser/audio-engine/portable-stretch-paging"
import type { AudioPcmSourceResolver } from "~/lib/audio-pcm-source-resolver"
import type { AudioPcmSourceDescriptor } from "@daw-browser/shared"

export type PortablePreparedStretch = PortablePreparedStretchAsset | PortablePagedStretchAsset

export type PortableOrdinaryDescriptor = {
  asset: AudioAssetRef
  descriptor: AudioPcmSourceDescriptor
}

export const isPagedStretchAsset = (
  asset: PortablePreparedStretch,
): asset is PortablePagedStretchAsset => "manifest" in asset

export const planarPcm = (buffer: AudioBuffer): PlanarPcm => ({
  frameCount: buffer.length,
  planes: Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel)),
})

const instrumentAssetKeys = (snapshot: LivePlaybackSnapshot) => new Set(
  Object.values(snapshot.mixer.fx.trackFx ?? {}).flatMap((entry) => {
    if (entry.instrument?.kind === 'sampler') {
      return entry.instrument.params.zones.map((zone) => zone.sample.assetKey)
    }

    if (entry.instrument?.kind === 'drum-rack') {
      return entry.instrument.params.pads.flatMap((pad) => pad.sample ? [pad.sample.assetKey] : [])
    }

    if (entry.instrument?.kind === 'granular' && entry.instrument.params.zone) {
      return [entry.instrument.params.zone.sample.assetKey]
    }

    return []
  }),
)

const unavailableInstrumentAssetKeys = (snapshot: LivePlaybackSnapshot) => [
  ...new Set(Object.values(snapshot.mixer.fx.trackFx ?? {}).flatMap(
    (entry) => entry.unavailableSampleAssetKeys ?? [],
  )),
]

const isInstalledSnapshotAsset = (
  snapshot: LivePlaybackSnapshot,
  assetId: string,
  instrumentKeys: ReadonlySet<string>,
) => {
  const usedByStretch = snapshot.tracks.some((track) => track.clips.some((clip) => (
    clip.sourceAssetKey === assetId
    && clip.audioWarp?.enabled === true
    && clip.audioWarp.mode === 'stretch'
  )))

  const usedByInstalledSource = snapshot.tracks.some((track) => track.clips.some((clip) => (
    clip.sourceAssetKey === assetId
    && !(clip.audioWarp?.enabled === true && clip.audioWarp.mode === 'stretch')
  )))

  return !usedByStretch || usedByInstalledSource || instrumentKeys.has(assetId)
}

const assetRegistry = (
  snapshot: LivePlaybackSnapshot,
  generation: number,
  preparedStretchAssets: readonly PortablePreparedStretch[] = [],
  ordinaryDescriptors: ReadonlyMap<string, PortableOrdinaryDescriptor> = new Map(),
): PortableAssetRegistryInput => ({
  projectGeneration: generation,
  unavailableProjectAssetIds: unavailableInstrumentAssetKeys(snapshot),
  assets: [
    ...(() => {
      const instrumentKeys = instrumentAssetKeys(snapshot)

      return snapshot.assets.flatMap((asset) => {
        const buffer = asset.buffer
        const descriptor = ordinaryDescriptors.get(asset.assetId)

        if ((!buffer && !descriptor) || !isInstalledSnapshotAsset(snapshot, asset.assetId, instrumentKeys)) return []

        if (!buffer && instrumentKeys.has(asset.assetId)) return []

        return [{
          projectAssetId: asset.assetId,
          portableAssetId: asset.assetId,
          projectGeneration: generation,
          handle: { slot: 0, generation },
          decoded: {
            sampleRateHz: buffer?.sampleRate ?? descriptor?.descriptor.sampleRate ?? 0,
            channelCount: buffer?.numberOfChannels ?? descriptor?.descriptor.channelCount ?? 0,
            frameCount: buffer?.length ?? descriptor?.descriptor.frameCount ?? 0,
          },
        }]
      }).map((entry, slot) => ({ ...entry, handle: { ...entry.handle, slot } }))
    })(),
    ...[...new Map(preparedStretchAssets.map((prepared) => [prepared.portableAssetId, prepared])).values()]
      .map((prepared, slot) => ({
        projectAssetId: prepared.projectAssetId,
        portableAssetId: prepared.portableAssetId,
        projectGeneration: generation,
        handle: { slot: installedSnapshotAssetCount(snapshot, ordinaryDescriptors) + slot, generation },
        decoded: {
          sampleRateHz: prepared.asset.sampleRateHz,
          channelCount: prepared.asset.channelCount,
          frameCount: prepared.asset.frameCount,
        },
      })),
  ],
})

const installedSnapshotAssetCount = (
  snapshot: LivePlaybackSnapshot,
  ordinaryDescriptors: ReadonlyMap<string, PortableOrdinaryDescriptor> = new Map(),
) => {
  const instrumentKeys = instrumentAssetKeys(snapshot)

  return snapshot.assets.reduce((count, asset) => {
    if (!asset.buffer && !ordinaryDescriptors.has(asset.assetId)) return count

    return count + (isInstalledSnapshotAsset(snapshot, asset.assetId, instrumentKeys) ? 1 : 0)
  }, 0)
}

export const resolveOrdinaryDescriptors = async (
  snapshot: LivePlaybackSnapshot,
  resolveSource: AudioPcmSourceResolver | undefined,
  signal?: AbortSignal,
  // The descriptors of the session already playing: its assets are not resolved again.
  known: ReadonlyMap<string, PortableOrdinaryDescriptor> = new Map(),
) => {
  const clipsByAsset = new Map<string, LivePlaybackSnapshot["tracks"][number]["clips"][number]>()

  for (const track of snapshot.tracks) {
    for (const clip of track.clips) {
      if (clip.sourceAssetKey
        && !clip.midi
        && !(clip.audioWarp?.enabled === true && clip.audioWarp.mode === "stretch")) {
        clipsByAsset.set(clip.sourceAssetKey, clip)
      }
    }
  }

  const descriptors = new Map<string, PortableOrdinaryDescriptor>()

  for (const asset of snapshot.assets) {
    if (asset.buffer || !clipsByAsset.has(asset.assetId)) continue
    const resolved = known.get(asset.assetId)

    if (resolved) {
      descriptors.set(asset.assetId, resolved)
      continue
    }

    if (!resolveSource) throw new Error(`Audio asset "${asset.assetId}" has no source resolver.`)
    const clip = clipsByAsset.get(asset.assetId)

    if (!clip) continue
    signal?.throwIfAborted()
    const descriptor = await resolveSource(clip, signal)

    if (descriptor.frameCount <= 0 || descriptor.channelCount > portableWasmPagedMaxChannels) {
      throw new Error(`Portable audio asset "${asset.assetId}" has incompatible paged metadata.`)
    }

    if (asset.source && (
      descriptor.sampleRate !== asset.source.sampleRate
      || descriptor.channelCount !== asset.source.channelCount
      || descriptor.frameCount !== Math.round(asset.source.durationSec * asset.source.sampleRate)
    )) throw new Error(`Portable audio asset "${asset.assetId}" descriptor metadata is inconsistent.`)
    descriptors.set(asset.assetId, {
      asset: {
        version: 1,
        assetId: asset.assetId,
        frameCount: descriptor.frameCount,
        sampleRateHz: descriptor.sampleRate,
        channelCount: descriptor.channelCount,
      },
      descriptor,
    })
  }

  return descriptors
}

export const preparedSession = (
  snapshot: LivePlaybackSnapshot,
  sampleRateHz: number,
  epoch: number,
  projectGeneration: number,
  horizonSec: number,
  sourceFirstSequence = 1,
  preparedStretchAssets: readonly PortablePreparedStretch[] = [],
  sourceRangeStartSec?: number,
  ordinaryDescriptors: ReadonlyMap<string, PortableOrdinaryDescriptor> = new Map(),
  // The raw frame that plays the playhead, when it is not the playhead's own frame (see PositionSegment).
  originFrame = Math.round(snapshot.transport.playheadSec * sampleRateHz),
): PreparedPortableSession => compilePreparedPortableLiveSession(snapshot, {
  assetRegistry: assetRegistry(snapshot, projectGeneration, preparedStretchAssets, ordinaryDescriptors),
  preparedStretchAssets: new Map(preparedStretchAssets.map((asset) => [asset.clipId, asset])),
  sampleRateHz,
  transportEpoch: epoch,
  timeOrigin: {
    timelineSec: snapshot.transport.playheadSec,
    frame: originFrame,
  },
  rangeEndSec: Math.min(
    snapshot.transport.playheadSec + horizonSec,
    Number.MAX_SAFE_INTEGER / sampleRateHz,
  ),
  sourceRangeStartSec,
  clipSpanningNoteOn: true,
  // An id that depends on the note and not on the compile origin lets a seam reconcile match a sounding note to the
  // same note in a schedule compiled from a later origin.
  stableNoteIds: true,
  sourceFirstSequence,
  loop: snapshot.transport,
})
