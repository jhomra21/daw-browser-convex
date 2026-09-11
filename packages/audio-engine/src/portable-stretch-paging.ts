import type { AudioAssetRef } from '../../audio-core-contract/src/index'
import { audioCoreContractVersion } from '../../audio-core-contract/src/index'
import type { Clip } from '@daw-browser/timeline-core/types'
import {
  createAudioPcmSourceDescriptor,
  type AudioPcmSourceDescriptor,
} from './media-pages'
import {
  renderStretchedAudioToArtifact,
} from './audio-stretch-rendering'
import type { AudioStretchRuntimeClip } from './audio-stretch-rendering'
import type { PreparedStretchProjectionMetadata } from './prepared-stretch-artifact'
import type {
  PreparedStretchArtifactLease,
  PreparedStretchArtifactManifest,
  PreparedStretchArtifactRepository,
} from './prepared-stretch-store'
const isPortableStretchClip = (clip: Clip<AudioBuffer>) =>
  clip.midi === undefined
  && clip.audioWarp?.enabled === true
  && clip.audioWarp.mode === 'stretch'

export type PortablePagedStretchAsset = PreparedStretchProjectionMetadata & {
  artifactId: string
  manifest: PreparedStretchArtifactManifest
  lease: PreparedStretchArtifactLease
  portableAssetId: string
  projectAssetId: string
}

const sourceForClip = (
  clip: AudioStretchRuntimeClip,
): AudioPcmSourceDescriptor | undefined => {
  if (!clip.buffer) return undefined
  return createAudioPcmSourceDescriptor({
    identity: clip.sourceAssetKey ? `buffer:${clip.sourceAssetKey}` : `buffer:${clip.id}`,
    durationSec: clip.buffer.duration,
    frameCount: clip.buffer.length,
    sampleRate: clip.buffer.sampleRate,
    channelCount: clip.buffer.numberOfChannels,
    source: clip.buffer,
  })
}

const equivalentManifest = (
  left: PreparedStretchArtifactManifest,
  right: PreparedStretchArtifactManifest,
) => left.artifactId === right.artifactId
  && left.writeId === right.writeId
  && left.pageFrames === right.pageFrames
  && left.frameCount === right.frameCount
  && left.byteSize === right.byteSize
  && JSON.stringify(left.descriptor) === JSON.stringify(right.descriptor)

export const preparePortablePagedStretchAssets = async (input: {
  tracks: readonly { clips: readonly Clip<AudioBuffer>[] }[]
  projectBpm: number
  projectGeneration: number
  repository: PreparedStretchArtifactRepository
  resolveSource?: (
    clip: AudioStretchRuntimeClip,
    signal?: AbortSignal,
  ) => Promise<AudioPcmSourceDescriptor>
  signal?: AbortSignal
}): Promise<
  | { supported: true; assets: readonly PortablePagedStretchAsset[] }
  | { supported: false; message: string }
> => {
  const assets: PortablePagedStretchAsset[] = []
  const byArtifact = new Map<string, PortablePagedStretchAsset>()
  try {
    for (const track of input.tracks) {
      for (const candidate of track.clips) {
        if (!isPortableStretchClip(candidate)) continue
        const clip: AudioStretchRuntimeClip = candidate
        input.signal?.throwIfAborted()
        const source = clip.buffer
          ? sourceForClip(clip)
          : input.resolveSource
            ? await input.resolveSource(clip, input.signal)
            : undefined
        if (!source) throw new Error(`${clip.id}: Stretch source is unavailable.`)
        const artifact = await renderStretchedAudioToArtifact({
          clip,
          source,
          projectBpm: input.projectBpm,
          repository: input.repository,
          signal: input.signal,
        })
        const existing = byArtifact.get(artifact.manifest.artifactId)
        if (existing) {
          if (!equivalentManifest(existing.manifest, artifact.manifest)
            || existing.asset.frameCount !== artifact.manifest.frameCount
            || existing.asset.sampleRateHz !== artifact.manifest.descriptor.output.sampleRate
            || existing.asset.channelCount !== artifact.manifest.descriptor.output.channelCount) {
            throw new Error(`Stretch artifact "${artifact.manifest.artifactId}" has conflicting metadata.`)
          }
          assets.push({
            ...existing,
            clipId: clip.id,
            sourceAssetKey: clip.sourceAssetKey,
            sourceDurationSec: source.durationSec,
            timelineStartSec: artifact.binding.timelineStartSec,
            timelineDurationSec: artifact.binding.timelineDurationSec,
            sourceStartSec: artifact.binding.sourceStartSec,
          })
          continue
        }
        const lease = await input.repository.acquireLease(artifact.manifest)
        const assetId = artifact.manifest.artifactId
        const asset: AudioAssetRef = {
          version: audioCoreContractVersion,
          assetId,
          frameCount: artifact.manifest.frameCount,
          sampleRateHz: artifact.manifest.descriptor.output.sampleRate,
          channelCount: artifact.manifest.descriptor.output.channelCount,
        }
        const prepared: PortablePagedStretchAsset = {
          clipId: clip.id,
          preparedStretchArtifactId: assetId,
          artifactId: artifact.manifest.artifactId,
          manifest: artifact.manifest,
          lease,
          sourceAssetKey: clip.sourceAssetKey,
          sourceDurationSec: source.durationSec,
          projectGeneration: input.projectGeneration,
          projectAssetId: assetId,
          portableAssetId: assetId,
          asset,
          timelineStartSec: artifact.binding.timelineStartSec,
          timelineDurationSec: artifact.binding.timelineDurationSec,
          sourceStartSec: artifact.binding.sourceStartSec,
        }
        byArtifact.set(artifact.manifest.artifactId, prepared)
        assets.push(prepared)
      }
    }
    return { supported: true, assets }
  } catch (error) {
    for (const asset of assets) await asset.lease.release().catch(() => undefined)
    return {
      supported: false,
      message: error instanceof Error ? error.message : String(error),
    }
  }
}
