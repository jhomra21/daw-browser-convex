import type {
  AudioAssetRef,
  AudioCoreGraphSnapshot,
  AudioCoreSampleSourceEventDto,
  PlanarPcm,
} from '../../audio-core-contract/src/index'
import { nativeAudioHostMaximumAssetFramesForChannels } from '@daw-browser/desktop-protocol/native-audio-host'

export type NativeProjectedSourceEvent = AudioCoreSampleSourceEventDto & {
  sourceIdentity?: string
}

export type NativePcmChunk = {
  asset: AudioAssetRef
  pcm: PlanarPcm
  sourceStartFrame: number
  sourceEndFrame: number
}

export type NativePcmChunkDescriptor = {
  sourceAssetId: string
  chunks: readonly NativePcmChunk[]
}

export type NativePcmChunkProjection = {
  assets: readonly { asset: AudioAssetRef; pcm: PlanarPcm }[]
  events: readonly NativeProjectedSourceEvent[]
  descriptors: readonly NativePcmChunkDescriptor[]
}

const chunkAssetId = (assetId: string, index: number) =>
  `${assetId}:native-chunk:${index}`

const instrumentAssetIds = (graph: AudioCoreGraphSnapshot) => {
  const ids = new Set<string>()
  for (const node of graph.nodes) {
    const instrument = node.instrument
    if (!instrument) continue
    if (instrument.kind === 'granular') {
      if (instrument.assetId) ids.add(instrument.assetId)
      continue
    }
    if (instrument.kind === 'sampler' || instrument.kind === 'drum-rack') {
      for (const zone of instrument.zones) ids.add(zone.assetId)
    }
  }
  return ids
}

const fallbackSourceIdentity = (event: NativeProjectedSourceEvent) =>
  `source:${event.sourceNodeId}:${event.assetId}:${event.startFrame}:${event.stopFrame}`

const splitEvent = (
  event: NativeProjectedSourceEvent,
  descriptor: NativePcmChunkDescriptor,
  firstSequence: number,
) => {
  const sourceStart = event.sourceOffsetFrame + (event.sourceOffsetFraction ?? 0)
  const sourceEnd = sourceStart + event.sourceFrameCount
  const timelineDuration = event.stopFrame - event.startFrame
  const output: NativeProjectedSourceEvent[] = []
  for (const [index, chunk] of descriptor.chunks.entries()) {
    const segmentStart = Math.max(sourceStart, chunk.sourceStartFrame)
    const segmentEnd = Math.min(sourceEnd, chunk.sourceEndFrame)
    if (segmentEnd <= segmentStart) continue
    const startFrame = Math.round(
      event.startFrame + (segmentStart - sourceStart) * timelineDuration / event.sourceFrameCount,
    )
    const stopFrame = Math.round(
      event.startFrame + (segmentEnd - sourceStart) * timelineDuration / event.sourceFrameCount,
    )
    if (stopFrame <= startFrame) continue
    const localPosition = segmentStart - chunk.sourceStartFrame
    const sourceOffsetFrame = Math.floor(localPosition)
    const identity = event.sourceIdentity ?? fallbackSourceIdentity(event)
    output.push({
      ...event,
      sequence: firstSequence + output.length,
      assetId: chunk.asset.assetId,
      startFrame,
      stopFrame,
      sourceOffsetFrame,
      sourceOffsetFraction: localPosition - sourceOffsetFrame || undefined,
      sourceFrameCount: Math.ceil(segmentEnd - segmentStart),
      sourceIdentity: `${identity}:chunk:${index}`,
    })
  }
  return output
}

export const chunkNativeSourceEvents = (
  events: readonly NativeProjectedSourceEvent[],
  descriptors: readonly NativePcmChunkDescriptor[],
  firstSequence: number,
) => {
  const bySourceAssetId = new Map(descriptors.map((descriptor) => [descriptor.sourceAssetId, descriptor]))
  const output: NativeProjectedSourceEvent[] = []
  for (const event of events) {
    const descriptor = bySourceAssetId.get(event.assetId)
    if (!descriptor) {
      output.push({ ...event, sequence: firstSequence + output.length })
      continue
    }
    output.push(...splitEvent(event, descriptor, firstSequence + output.length))
  }
  return output
}

export const chunkNativePcmProjection = (input: {
  graph: AudioCoreGraphSnapshot
  assets: readonly { asset: AudioAssetRef; pcm: PlanarPcm }[]
  events: readonly NativeProjectedSourceEvent[]
  firstSequence: number
}): NativePcmChunkProjection | { supported: false; reason: string } => {
  const instrumentIds = instrumentAssetIds(input.graph)
  const occupiedAssetIds = new Set(input.assets.map(({ asset }) => asset.assetId))
  const descriptors: NativePcmChunkDescriptor[] = []
  const assets: { asset: AudioAssetRef; pcm: PlanarPcm }[] = []
  for (const entry of input.assets) {
    const capacity = nativeAudioHostMaximumAssetFramesForChannels(entry.asset.channelCount)
    if (entry.asset.frameCount <= capacity) {
      assets.push(entry)
      continue
    }
    if (capacity < 2) {
      return {
        supported: false,
        reason: `Native PCM asset "${entry.asset.assetId}" has no valid chunk capacity.`,
      }
    }
    if (instrumentIds.has(entry.asset.assetId)) {
      return {
        supported: false,
        reason: `Native PCM asset "${entry.asset.assetId}" is owned by an instrument and exceeds the native payload capacity.`,
      }
    }
    const chunks: NativePcmChunk[] = []
    const stride = capacity - 1
    for (let start = 0, index = 0; start < entry.asset.frameCount; start += stride, index += 1) {
      const end = Math.min(entry.asset.frameCount, start + capacity)
      const planes = entry.pcm.planes.map((plane) => plane.slice(start, end))
      const asset: AudioAssetRef = {
        ...entry.asset,
        assetId: chunkAssetId(entry.asset.assetId, index),
        frameCount: end - start,
      }
      if (occupiedAssetIds.has(asset.assetId)) {
        return {
          supported: false,
          reason: `Native PCM chunk identity "${asset.assetId}" conflicts with an existing asset.`,
        }
      }
      occupiedAssetIds.add(asset.assetId)
      chunks.push({
        asset,
        pcm: { frameCount: end - start, planes },
        sourceStartFrame: start,
        sourceEndFrame: end === entry.asset.frameCount ? end : end - 1,
      })
      if (end === entry.asset.frameCount) break
    }
    descriptors.push({ sourceAssetId: entry.asset.assetId, chunks })
    assets.push(...chunks)
  }
  return {
    assets,
    events: chunkNativeSourceEvents(input.events, descriptors, input.firstSequence),
    descriptors,
  }
}
