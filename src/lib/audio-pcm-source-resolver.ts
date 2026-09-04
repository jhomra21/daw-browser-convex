import {
  createAudioPcmSourceDescriptor,
  inspectAudioSourceMetadata,
  type AudioPcmSourceDescriptor,
} from '@daw-browser/audio-engine/media-pages'
import { isLocalProjectAssetKey, resolveClipSampleUrl } from '@daw-browser/shared'
import { getLocalAsset, readLocalAssetBytes } from '~/lib/local-assets'
import { resolveSamplePlaybackUrlForRuntime } from '~/lib/renderer-api-url'
import type { AudioStretchRuntimeClip } from '@daw-browser/audio-engine/audio-stretch-rendering'

type RuntimeClip = AudioStretchRuntimeClip

export type AudioPcmSourceResolver = (
  clip: RuntimeClip,
  signal?: AbortSignal,
) => Promise<AudioPcmSourceDescriptor>

const persistedMetadata = (
  clip: RuntimeClip,
  source?: {
    durationSec?: number
    sampleRate?: number
    channelCount?: number
  },
) => {
  const durationSec = source?.durationSec ?? clip.sourceDurationSec
  const sampleRate = source?.sampleRate ?? clip.sourceSampleRate
  const channelCount = source?.channelCount ?? clip.sourceChannelCount
  if (durationSec === undefined
    || sampleRate === undefined
    || channelCount === undefined) {
    throw new Error(`Clip "${clip.id}" is missing persisted source metadata.`)
  }
  return {
    durationSec,
    frameCount: Math.round(durationSec * sampleRate),
    sampleRate,
    channelCount,
  }
}

const assertEncodedMetadataMatchesPersisted = (
  persisted: ReturnType<typeof persistedMetadata>,
  encoded: Awaited<ReturnType<typeof inspectAudioSourceMetadata>>,
  label: string,
) => {
  if (encoded.sampleRate !== persisted.sampleRate || encoded.channelCount !== persisted.channelCount) {
    throw new Error(`Audio source "${label}" metadata does not match its authoritative asset metadata.`)
  }
  if (encoded.durationSec !== undefined
    && Math.abs(encoded.durationSec - persisted.durationSec) > 0.5 / persisted.sampleRate) {
    throw new Error(`Audio source "${label}" duration does not match its authoritative asset metadata.`)
  }
}

const descriptorFromBuffer = (clip: RuntimeClip) => {
  if (!clip.buffer) return undefined
  if (clip.sourceSampleRate !== undefined && clip.buffer.sampleRate !== clip.sourceSampleRate) {
    throw new Error(`Clip "${clip.id}" buffer sample rate does not match its persisted source metadata.`)
  }
  if (clip.sourceChannelCount !== undefined && clip.buffer.numberOfChannels !== clip.sourceChannelCount) {
    throw new Error(`Clip "${clip.id}" buffer channel count does not match its persisted source metadata.`)
  }
  if (clip.sourceDurationSec !== undefined
    && Math.abs(clip.buffer.duration - clip.sourceDurationSec) > 0.5 / clip.buffer.sampleRate) {
    throw new Error(`Clip "${clip.id}" buffer duration does not match its persisted source metadata.`)
  }
  return createAudioPcmSourceDescriptor({
    identity: clip.sourceAssetKey ? `buffer:${clip.sourceAssetKey}` : `buffer:${clip.id}`,
    durationSec: clip.buffer.duration,
    frameCount: clip.buffer.length,
    sampleRate: clip.buffer.sampleRate,
    channelCount: clip.buffer.numberOfChannels,
    source: clip.buffer,
  })
}

const deriveCloudSampleUrl = (
  clip: RuntimeClip,
  projectId: string | undefined,
) => {
  if (!clip.sourceAssetKey) return undefined
  if (!projectId) {
    throw new Error(`Clip "${clip.id}" requires a project ID to resolve cloud audio asset "${clip.sourceAssetKey}".`)
  }
  return `/api/samples/${encodeURIComponent(projectId)}/${encodeURIComponent(clip.sourceAssetKey)}`
}

export const createAudioPcmSourceResolver = (input: {
  projectId?: () => string | undefined
  readLocalAsset?: typeof readLocalAssetBytes
  resolveUrl?: (value: string) => string | null
} = {}): AudioPcmSourceResolver => {
  const readLocalAsset = input.readLocalAsset ?? readLocalAssetBytes
  const resolveUrl = input.resolveUrl ?? resolveSamplePlaybackUrlForRuntime
  return async (clip, signal) => {
    signal?.throwIfAborted()
    const eager = descriptorFromBuffer(clip)
    if (eager) return eager
    const projectId = input.projectId?.()
    const localId = clip.sourceAssetKey && isLocalProjectAssetKey(clip.sourceAssetKey)
      ? clip.sourceAssetKey
      : undefined
    if (localId) {
      if (!projectId) {
        throw new Error(`Clip "${clip.id}" requires a project ID to resolve local audio asset "${localId}".`)
      }
      const row = await getLocalAsset(projectId, localId)
      const result = await readLocalAsset(projectId, localId)
      signal?.throwIfAborted()
      if (result.status === 'missing') throw new Error(`Local audio asset "${localId}" is missing.`)
      if (result.status === 'permission-denied') throw new Error(`Permission to read local audio asset "${localId}" was denied.`)
      if (!row) throw new Error(`Local audio asset "${localId}" has no metadata row.`)
      const identity = row?.contentHash
        ? `${clip.sourceAssetKey}:${row.contentHash}`
        : `${clip.sourceAssetKey}:${localId}:${result.file.size}:${result.file.lastModified}`
      if (row.durationSec === undefined
        || row.sampleRate === undefined
        || row.channelCount === undefined) {
        throw new Error(`Local audio asset "${localId}" is missing authoritative audio metadata.`)
      }
      const metadata = persistedMetadata(clip, row)
      const encoded = await inspectAudioSourceMetadata(result.file, { signal })
      assertEncodedMetadataMatchesPersisted(metadata, encoded, localId)
      return createAudioPcmSourceDescriptor({
        identity,
        persistable: row.contentHash !== undefined,
        ...metadata,
        source: result.file,
      })
    }
    const metadata = persistedMetadata(clip)
    const sampleUrl = resolveClipSampleUrl(clip) ?? deriveCloudSampleUrl(clip, projectId)
    if (!sampleUrl) throw new Error(`Clip "${clip.id}" has no resolvable audio source.`)
    const url = resolveUrl(sampleUrl)
    if (!url) throw new Error(`Clip "${clip.id}" has an invalid audio source URL.`)
    const encoded = await inspectAudioSourceMetadata(url, { signal })
    assertEncodedMetadataMatchesPersisted(metadata, encoded, url)
    return createAudioPcmSourceDescriptor({
      identity: clip.sourceAssetKey
        ? `asset:${projectId ?? 'project:unknown'}:${clip.sourceAssetKey}`
        : `remote:${url}`,
      persistable: false,
      ...metadata,
      source: url,
    })
  }
}
