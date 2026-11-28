import { createAudioPcmSourceDescriptor, getAudioBufferSessionIdentity } from '@daw-browser/audio-engine/media-pages'
import type { NativeHostMappedAssetPage, NativeOfflineMappedAsset } from '@daw-browser/audio-engine/native-host-wire'
import type { PreparedStretchArtifactRepository } from '@daw-browser/audio-engine/prepared-stretch-store'
import { createNativeTimelinePageManager, type NativeTimelinePageManager } from '~/lib/desktop/native-timeline-page-manager'
import { NativeOfflineRenderError } from '~/lib/export/desktop-native-offline-pcm-renderer'
import type { TimelineExportRequest } from '~/lib/export/export-job-types'
import type { RuntimeTrack } from '~/lib/timeline-runtime-types'

type NativeMappedSourcesInput = Pick<TimelineExportRequest, 'resolveAudioSource' | 'signal'> & {
  mappedAssets: readonly NativeOfflineMappedAsset[] | undefined
  tracks: RuntimeTrack[]
  instrumentSources: ReadonlyMap<string, AudioBuffer>
  stretchRepository: PreparedStretchArtifactRepository | undefined
}

// Registers the mapped assets of a native offline plan with a page manager and returns the provider the native renderer
// reads pages through. The caller owns the page manager and disposes it.
export const prepareNativeMappedSources = async (input: NativeMappedSourcesInput) => {
  const { mappedAssets, instrumentSources, stretchRepository } = input
  const sourceByKey = new Map<string, NativeOfflineMappedAsset>()
  let pageManager: NativeTimelinePageManager | undefined

  const clipsBySourceKey = new Map(input.tracks.flatMap((track) => track.clips)
    .filter((clip) => clip.sourceAssetKey !== undefined).map((clip) => [clip.sourceAssetKey, clip]))

  if (mappedAssets && mappedAssets.length > 0) {
    for (const asset of mappedAssets) {
      const previous = sourceByKey.get(asset.sourceAssetKey)

      if (previous && (
        previous.frameCount !== asset.frameCount
        || previous.sampleRateHz !== asset.sampleRateHz
        || previous.channelCount !== asset.channelCount
        || previous.preparedStretchArtifactId !== asset.preparedStretchArtifactId
      )) {
        throw new Error(`Native export mapped source "${asset.sourceAssetKey}" resolves inconsistently.`)
      }

      sourceByKey.set(asset.sourceAssetKey, asset)
    }

    const nativeSources = await Promise.all([...sourceByKey.values()].map(async (asset) => ({
        sourceAssetKey: asset.sourceAssetKey,
        sessionAssetId: asset.sessionAssetId,
        frameCount: asset.frameCount,
        sampleRateHz: asset.sampleRateHz,
        channelCount: asset.channelCount,
        preparedStretchArtifactId: asset.preparedStretchArtifactId,
        artifactRepository: stretchRepository,
        descriptor: asset.preparedStretchArtifactId
          ? undefined
          : await (async () => {
            const buffer = instrumentSources.get(asset.sourceAssetKey)

            if (buffer) {
              return createAudioPcmSourceDescriptor({
                identity: asset.sourceAssetKey,
                durationSec: buffer.duration, frameCount: buffer.length,
                sampleRate: buffer.sampleRate, channelCount: buffer.numberOfChannels,
                source: buffer,
              })
            }

            const clip = clipsBySourceKey.get(asset.sourceAssetKey)

            if (!clip) {
              throw new Error(`Native export source "${asset.sourceAssetKey}" is not present in the timeline.`)
            }

            if (input.resolveAudioSource) {
              return input.resolveAudioSource(clip, input.signal)
            }

            if (clip.buffer) {
              return createAudioPcmSourceDescriptor({
                identity: getAudioBufferSessionIdentity(clip.buffer),
                durationSec: clip.buffer.duration,
                frameCount: clip.buffer.length,
                sampleRate: clip.buffer.sampleRate,
                channelCount: clip.buffer.numberOfChannels,
                source: clip.buffer,
              })
            }

            return undefined
          })(),
    })))

    if (nativeSources.some((source) => (
      source.preparedStretchArtifactId === undefined
      && source.descriptor === undefined
    ))) {
      throw new Error('Native export metadata-only mapped audio requires a PCM source resolver.')
    }

    pageManager = createNativeTimelinePageManager({
      sources: nativeSources,
      writePage: async () => undefined,
    })
  }

  const provideMappedPage = pageManager
    ? async (request: {
      asset: NativeOfflineMappedAsset
      startFrame: number
      frameCount: number
      signal: AbortSignal
    }): Promise<NativeHostMappedAssetPage> => {
      const registered = sourceByKey.get(request.asset.sourceAssetKey)

      if (!registered || registered.sessionAssetId !== request.asset.sessionAssetId
        || registered.frameCount !== request.asset.frameCount
        || registered.sampleRateHz !== request.asset.sampleRateHz
        || registered.channelCount !== request.asset.channelCount) {
        throw new NativeOfflineRenderError('Native offline instrument/source identity changed. Reload samples and retry.')
      }

      const page = await pageManager?.readPage(
        request.asset.sourceAssetKey,
        request.startFrame,
        request.frameCount,
        request.signal,
      )

      if (!page || page.sessionAssetId !== request.asset.sessionAssetId) {
        throw new NativeOfflineRenderError('Native offline mapped page identity is invalid.')
      }

      return page
    }
    : undefined

  return { pageManager, provideMappedPage }
}
