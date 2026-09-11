import {
  audioCoreContractVersion,
  type AudioAssetRef,
} from '../../audio-core-contract/src/index'
import type { Clip, Track } from '@daw-browser/timeline-core/types'
import type { AudioStretchRuntimeClip } from './audio-stretch-rendering'
import type { AudioStretchCache } from './audio-stretch-cache'
import {
  preparedStretchArtifactCanonicalJson,
  validatePreparedStretchProjectionMetadata,
  type PreparedStretchProjectionMetadata,
} from './prepared-stretch-artifact'
import type {
  PreparedStretchArtifactLease,
  PreparedStretchArtifactManifest,
  PreparedStretchArtifactRepository,
} from './prepared-stretch-store'
import type { PortableStretchDiagnostic } from './portable-stretch-preparation'

export type NativePreparedStretchAsset = Omit<PreparedStretchProjectionMetadata, 'preparedStretchArtifactId'> & {
  preparedStretchArtifactId: string
  manifest: PreparedStretchArtifactManifest
}

export type NativeStretchAssetPreparation =
  | {
    supported: true
    assets: readonly NativePreparedStretchAsset[]
    manifests: readonly PreparedStretchArtifactManifest[]
    dispose: () => Promise<void>
  }
  | { supported: false; diagnostics: readonly PortableStretchDiagnostic[] }

const diagnostic = (
  clipId: string,
  message: string,
): PortableStretchDiagnostic => ({
  clipId,
  code: 'stretch-metadata-mismatch',
  message,
})

const isStretchClip = (clip: Clip) =>
  clip.midi === undefined
  && clip.audioWarp?.enabled === true
  && clip.audioWarp.mode === 'stretch'

const runtimeClip = (clip: Clip<AudioBuffer>): AudioStretchRuntimeClip => clip

const artifactMatchesManifest = (
  artifactId: string,
  manifest: PreparedStretchArtifactManifest,
) => manifest.artifactId === artifactId
  && manifest.descriptor.output.frameCount === manifest.frameCount
  && manifest.descriptor.output.sampleRate > 0
  && manifest.descriptor.output.channelCount > 0

const sameManifestGeneration = (
  left: PreparedStretchArtifactManifest,
  right: PreparedStretchArtifactManifest,
) => left.artifactId === right.artifactId
  && left.writeId === right.writeId
  && preparedStretchArtifactCanonicalJson(left.descriptor) === preparedStretchArtifactCanonicalJson(right.descriptor)
  && left.pageFrames === right.pageFrames
  && left.frameCount === right.frameCount
  && left.byteSize === right.byteSize
  && left.committedAt === right.committedAt

export const prepareNativeStretchArtifacts = async (input: {
  tracks: readonly Track<AudioBuffer>[]
  projectBpm: number
  projectGeneration: number
  cache: AudioStretchCache
  repository: PreparedStretchArtifactRepository
  signal?: AbortSignal
}): Promise<NativeStretchAssetPreparation> => {
  const diagnostics: PortableStretchDiagnostic[] = []
  const clipIds = new Set<string>()
  const assets: NativePreparedStretchAsset[] = []
  const manifests = new Map<string, PreparedStretchArtifactManifest>()
  const leases = new Map<string, PreparedStretchArtifactLease>()
  let disposed = false
  const dispose = async () => {
    if (disposed) return
    disposed = true
    await Promise.allSettled([...leases.values()].map((lease) => lease.release()))
    leases.clear()
  }
  try {
    for (const track of input.tracks) {
      for (const clip of track.clips.filter(isStretchClip)) {
        if (clipIds.has(clip.id)) {
          diagnostics.push(diagnostic(clip.id, `${clip.id}: duplicate Stretch clip IDs are not supported.`))
          continue
        }
        clipIds.add(clip.id)
        try {
          input.signal?.throwIfAborted()
          const rendered = await input.cache.renderArtifactNow(
            runtimeClip(clip),
            input.projectBpm,
            input.signal,
          )
          const manifest = await input.repository.find(rendered.binding.artifactId)
          if (!manifest || !artifactMatchesManifest(rendered.binding.artifactId, manifest)) {
            diagnostics.push(diagnostic(
              clip.id,
              `${clip.id}: prepared Stretch artifact metadata is missing or stale.`,
            ))
            continue
          }
          const asset: AudioAssetRef = {
            version: audioCoreContractVersion,
            assetId: rendered.binding.artifactId,
            frameCount: manifest.frameCount,
            sampleRateHz: manifest.descriptor.output.sampleRate,
            channelCount: manifest.descriptor.output.channelCount,
          }
          const prepared: NativePreparedStretchAsset = {
            clipId: clip.id,
            preparedStretchArtifactId: rendered.binding.artifactId,
            sourceAssetKey: clip.sourceAssetKey,
            sourceDurationSec: clip.sourceDurationSec ?? clip.buffer?.duration ?? 0,
            projectGeneration: input.projectGeneration,
            asset,
            timelineStartSec: rendered.binding.timelineStartSec,
            timelineDurationSec: rendered.binding.timelineDurationSec,
            sourceStartSec: rendered.binding.sourceStartSec,
            manifest,
          }
          const invalid = validatePreparedStretchProjectionMetadata(prepared)
          if (invalid) {
            diagnostics.push(diagnostic(clip.id, invalid))
            continue
          }
          const existing = manifests.get(manifest.artifactId)
          if (existing && !sameManifestGeneration(existing, manifest)) {
            diagnostics.push(diagnostic(
              clip.id,
              `${clip.id}: prepared Stretch artifact identity has conflicting metadata.`,
            ))
            continue
          }
          if (!existing) {
            leases.set(manifest.artifactId, await input.repository.acquireLease(manifest))
            manifests.set(manifest.artifactId, manifest)
          }
          assets.push(prepared)
        } catch (error) {
          if (input.signal?.aborted) throw error
          diagnostics.push(diagnostic(
            clip.id,
            `${clip.id}: native Stretch preparation failed: ${error instanceof Error ? error.message : String(error)}`,
          ))
        }
      }
    }
    if (diagnostics.length > 0) {
      await dispose()
      return { supported: false, diagnostics }
    }
    return { supported: true, assets, manifests: [...manifests.values()], dispose }
  } catch (error) {
    await dispose()
    throw error
  }
}
