import {
  createWsolaBoundedSourceAsync,
  createWsolaBoundedSourceAsyncTransaction,
  type WsolaPcmSource,
  type WsolaPcmTransaction,
  type WsolaPcmTransactionFactory,
} from './audio-stretching'
import {
  createAudioStretchReadPlan,
  DEFAULT_STRETCH_MATERIALIZATION_MAX_BYTES,
  validateAudioStretchMaterialization,
  type AudioStretchMaterializationPolicy,
  type AudioStretchReadPlan,
} from './audio-stretch-read-plan'
import type { AudioPcmSourceDescriptor } from './media-pages'
import {
  createRemoteMediaOperation,
  defaultRemoteMediaMaximumBytes,
  defaultRemoteMediaMaxRetries,
  defaultRemoteMediaOperationDeadlineMs,
} from './media-pages'
import type { Clip } from '@daw-browser/timeline-core/types'
import type { StretchedAudioRender } from './audio-stretch-cache'
import {
  createPreparedStretchArtifact,
  createPreparedStretchArtifactBinding,
  type PreparedStretchArtifactBinding,
} from './prepared-stretch-artifact'
import type {
  PreparedStretchArtifactManifest,
  PreparedStretchArtifactRepository,
} from './prepared-stretch-store'

export type AudioStretchRuntimeClip = Pick<Clip<AudioBuffer>, 'id' | 'duration' | 'startSec' | 'leftPadSec' | 'bufferOffsetSec' | 'sourceAssetKey' | 'sourceDurationSec' | 'sourceSampleRate' | 'sourceChannelCount' | 'sourceKind' | 'sampleUrl' | 'audioWarp' | 'buffer'>
type CreateBuffer = (channels: number, frames: number, sampleRate: number) => AudioBuffer

export const writeBuffer = (
  createBuffer: CreateBuffer,
  channels: Float32Array[],
  sampleRate: number,
) => {
  const frameCount = channels[0]?.length ?? 0
  const buffer = createBuffer(channels.length, frameCount, sampleRate)
  for (let channelIndex = 0; channelIndex < channels.length; channelIndex++) {
    const target = buffer.getChannelData(channelIndex)
    const source = channels[channelIndex]
    for (let frame = 0; frame < source.length; frame++) target[frame] = source[frame]
  }
  return buffer
}

type PcmChunk = { channels: Float32Array[] }

const createForwardingTransaction = (
  metadata: { sampleRate: number; channelCount: number; frameCount: number },
  forward: (chunk: PcmChunk) => void,
): WsolaPcmTransaction => {
  let writtenFrames = 0
  let open = true
  return {
    append: (chunk) => {
      if (!open) throw new Error('Stretch segment transaction is no longer writable.')
      const frameCount = chunk.channels[0]?.length ?? 0
      if (chunk.channels.length !== metadata.channelCount
        || chunk.channels.some((channel) => channel.length !== frameCount)
        || writtenFrames + frameCount > metadata.frameCount) {
        throw new Error('Stretch segment transaction received invalid PCM.')
      }
      forward(chunk)
      writtenFrames += frameCount
    },
    commit: () => {
      if (!open || writtenFrames !== metadata.frameCount) throw new Error('Stretch segment transaction cannot commit.')
      open = false
      return { ...metadata, replay: function* () {}, dispose: () => {} }
    },
    abort: () => { open = false },
  }
}

export const renderStretchedAudioToPcmSource = async (input: {
  clip: AudioStretchRuntimeClip
  source: AudioPcmSourceDescriptor
  projectBpm: number
  createTransaction: WsolaPcmTransactionFactory
  signal?: AbortSignal
}) => {
  const plan: AudioStretchReadPlan = createAudioStretchReadPlan(input)
  const remoteOperation = createRemoteMediaOperation(
    defaultRemoteMediaOperationDeadlineMs,
    defaultRemoteMediaMaximumBytes,
    defaultRemoteMediaMaxRetries,
  )
  const abortRemoteOperation = () => remoteOperation.abort(input.signal?.reason)
  input.signal?.addEventListener('abort', abortRemoteOperation, { once: true })
  const outer = input.createTransaction({
    sampleRate: input.source.sampleRate,
    channelCount: input.source.channelCount,
    frameCount: plan.frameCount,
  })
  let committed = false
  try {
    for (const item of plan.segments) {
      input.signal?.throwIfAborted()
      const source: WsolaPcmSource = {
        sampleRate: input.source.sampleRate,
        channelCount: input.source.channelCount,
        frameCount: item.sourceEndFrame - item.sourceStartFrame,
        replay: function* () {
          yield* []
          throw new Error('Page-backed Stretch sources require async traversal.')
        },
        replayAsync: async function* (signal) {
          let readFrames = 0
          for await (const page of input.source.readPages({
            startFrame: item.sourceStartFrame,
            endFrame: item.sourceEndFrame,
            signal: remoteOperation.signal,
            remoteOperation,
          })) {
            signal?.throwIfAborted()
            readFrames += page.frameCount
            yield { channels: page.planes }
          }
          if (readFrames !== item.sourceEndFrame - item.sourceStartFrame) {
            throw new Error('Stretch source pages did not cover the planned segment.')
          }
        },
        dispose: () => {},
      }
      let outputFrames = 0
      const trimStart = item.trimStartFrame
      const trimEnd = Math.min(item.targetFrameCount, item.trimEndFrame)
      const result = await createWsolaBoundedSourceAsync(source, {
        outputFrameCount: item.targetFrameCount,
        signal: input.signal,
        createTransaction: (metadata) => createForwardingTransaction(metadata, (chunk) => {
          const frameCount = chunk.channels[0]?.length ?? 0
          const keepStart = Math.max(outputFrames, trimStart)
          const keepEnd = Math.min(outputFrames + frameCount, trimEnd)
          if (keepEnd > keepStart) {
            const localStart = keepStart - outputFrames
            const keepCount = keepEnd - keepStart
            outer.append({
              channels: chunk.channels.map((channel) => channel.subarray(localStart, localStart + keepCount)),
            })
          }
          outputFrames += frameCount
        }),
      })
      result.source.dispose()
    }
    input.signal?.throwIfAborted()
    const source = outer.commit()
    committed = true
    return {
      source,
      timelineStartSec: plan.map.timelineStartSec,
      sourceStartSec: 0,
      timelineDurationSec: plan.frameCount / input.source.sampleRate,
    }
  } catch (error) {
    outer.abort()
    throw error
  } finally {
    if (!committed) outer.abort()
    input.signal?.removeEventListener('abort', abortRemoteOperation)
    remoteOperation.dispose()
  }
}

export const renderStretchedAudioFromSource = async (input: {
  clip: AudioStretchRuntimeClip
  source: AudioPcmSourceDescriptor
  projectBpm: number
  createBuffer: CreateBuffer
  materializationPolicy?: AudioStretchMaterializationPolicy
  signal?: AbortSignal
}): Promise<StretchedAudioRender> => {
  const plan = createAudioStretchReadPlan(input)
  validateAudioStretchMaterialization(
    plan,
    input.source,
    input.materializationPolicy ?? {
      maximumBytes: DEFAULT_STRETCH_MATERIALIZATION_MAX_BYTES,
      maximumChannels: 32,
    },
  )
  const channels = Array.from(
    { length: input.source.channelCount },
    () => new Float32Array(plan.frameCount),
  )
  let writtenFrames = 0
  const rendered = await renderStretchedAudioToPcmSource({
    ...input,
    createTransaction: (metadata) => ({
      append: (chunk) => {
        const frameCount = chunk.channels[0]?.length ?? 0
        if (writtenFrames + frameCount > metadata.frameCount) throw new Error('Rendered Stretch PCM exceeded its declared frame count.')
        for (let channel = 0; channel < metadata.channelCount; channel += 1) {
          channels[channel]?.set(chunk.channels[channel] ?? new Float32Array(), writtenFrames)
        }
        writtenFrames += frameCount
      },
      commit: () => ({
        ...metadata,
        replay: function* () {},
        dispose: () => {},
      }),
      abort: () => {},
    }),
    signal: input.signal,
  })
  rendered.source.dispose()
  return {
    buffer: writeBuffer(input.createBuffer, channels, input.source.sampleRate),
    timelineStartSec: rendered.timelineStartSec,
    sourceStartSec: rendered.sourceStartSec,
    timelineDurationSec: rendered.timelineDurationSec,
  }
}

export const renderStretchedAudioToArtifact = async (input: {
  clip: AudioStretchRuntimeClip
  source: AudioPcmSourceDescriptor
  projectBpm: number
  repository: PreparedStretchArtifactRepository
  signal?: AbortSignal
  windowFrameCount?: number
  overlapFrameCount?: number
  searchFrameCount?: number
}): Promise<{
  binding: PreparedStretchArtifactBinding
  manifest: PreparedStretchArtifactManifest
}> => {
  const plan = createAudioStretchReadPlan(input)
  const remoteOperation = createRemoteMediaOperation(
    defaultRemoteMediaOperationDeadlineMs,
    defaultRemoteMediaMaximumBytes,
    defaultRemoteMediaMaxRetries,
  )
  const abortRemoteOperation = () => remoteOperation.abort(input.signal?.reason)
  input.signal?.addEventListener('abort', abortRemoteOperation, { once: true })
  const artifact = createPreparedStretchArtifact({
    source: input.source,
    plan,
    persistable: input.source.persistable,
    windowFrameCount: input.windowFrameCount ?? 2_048,
    overlapFrameCount: input.overlapFrameCount ?? 1_024,
    searchFrameCount: input.searchFrameCount ?? 512,
  })
  let existing: PreparedStretchArtifactManifest | null
  try {
    existing = await input.repository.find(artifact.artifactId)
  } catch (error) {
    input.signal?.removeEventListener('abort', abortRemoteOperation)
    remoteOperation.dispose()
    throw error
  }
  if (existing) {
    input.signal?.removeEventListener('abort', abortRemoteOperation)
    remoteOperation.dispose()
    return {
      binding: createPreparedStretchArtifactBinding({
        clipId: input.clip.id,
        artifact,
        timelineStartSec: plan.map.timelineStartSec,
        timelineDurationSec: plan.frameCount / input.source.sampleRate,
      }),
      manifest: existing,
    }
  }
  let write: Awaited<ReturnType<PreparedStretchArtifactRepository['begin']>>
  try {
    write = await input.repository.begin(artifact)
  } catch (error) {
    input.signal?.removeEventListener('abort', abortRemoteOperation)
    remoteOperation.dispose()
    throw error
  }
  try {
    for (const item of plan.segments) {
      input.signal?.throwIfAborted()
      const source: WsolaPcmSource = {
        sampleRate: input.source.sampleRate,
        channelCount: input.source.channelCount,
        frameCount: item.sourceEndFrame - item.sourceStartFrame,
        replay: function* () {
          yield* []
          throw new Error('Page-backed Stretch sources require async traversal.')
        },
        replayAsync: async function* (signal) {
          let readFrames = 0
          for await (const page of input.source.readPages({
            startFrame: item.sourceStartFrame,
            endFrame: item.sourceEndFrame,
            signal: remoteOperation.signal,
            remoteOperation,
          })) {
            signal?.throwIfAborted()
            readFrames += page.frameCount
            yield { channels: page.planes }
          }
          if (readFrames !== item.sourceEndFrame - item.sourceStartFrame) {
            throw new Error('Stretch source pages did not cover the planned segment.')
          }
        },
        dispose: () => {},
      }
      let outputFrames = 0
      const trimStart = item.trimStartFrame
      const trimEnd = Math.min(item.targetFrameCount, item.trimEndFrame)
      const result = await createWsolaBoundedSourceAsyncTransaction(source, {
        outputFrameCount: item.targetFrameCount,
        signal: input.signal,
        createAsyncTransaction: (metadata) => {
          let open = true
          return {
            append: async (chunk) => {
              if (!open) throw new Error('Stretch segment transaction is no longer writable.')
              const frameCount = chunk.channels[0]?.length ?? 0
              const keepStart = Math.max(outputFrames, trimStart)
              const keepEnd = Math.min(outputFrames + frameCount, trimEnd)
              if (keepEnd > keepStart) {
                const localStart = keepStart - outputFrames
                const keepCount = keepEnd - keepStart
                const planes = chunk.channels.map((channel) => channel.slice(localStart, localStart + keepCount))
                await write.append(planes, input.signal)
              }
              outputFrames += frameCount
            },
            commit: async () => {
              open = false
              return { ...metadata, replay: function* () {}, dispose: () => {} }
            },
            abort: async () => { open = false },
          }
        },
      })
      result.source.dispose()
    }
    input.signal?.throwIfAborted()
    const manifest = await write.commit()
    return {
      binding: createPreparedStretchArtifactBinding({
        clipId: input.clip.id,
        artifact,
        timelineStartSec: plan.map.timelineStartSec,
        timelineDurationSec: plan.frameCount / input.source.sampleRate,
      }),
      manifest,
    }
  } catch (error) {
    await write.abort().catch(() => {})
    throw error
  } finally {
    input.signal?.removeEventListener('abort', abortRemoteOperation)
    remoteOperation.dispose()
  }
}
