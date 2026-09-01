import { decodeAudioPages, type DecodeAudioPageSource } from '@daw-browser/audio-engine/media-pages'
import { readLocalAssetBytes } from '~/lib/local-assets'
import type { NativeHostMappedAssetPage } from '@daw-browser/audio-engine/native-host-wire'
import {
  nativeAudioHostMaximumMappedAssetPageFramesForChannels,
} from '@daw-browser/desktop-protocol/native-audio-host'
import { runWithConcurrency } from '~/lib/run-with-concurrency'

export type NativeTimelineSource = {
  sourceAssetKey: string
  sessionAssetId: number
  frameCount: number
  sampleRateHz: number
  channelCount: number
  buffer?: AudioBuffer | null
  sourceKind?: 'upload' | 'url' | 'recording'
  sampleUrl?: string | URL | Request
}

export type NativeTimelinePageManager = {
  ensureRanges: (
    ranges: readonly { sourceAssetKey: string; startFrame: number; endFrame: number }[],
    signal?: AbortSignal,
  ) => Promise<void>
  invalidateRanges: (
    ranges: readonly { sourceAssetKey: string; startFrame: number; endFrame: number }[],
  ) => void
  dispose: () => void
}

type PageWriter = (page: NativeHostMappedAssetPage, signal?: AbortSignal) => Promise<void>
type RangePreparer = (
  sessionAssetId: number,
  startFrame: number,
  frameCount: number,
  signal?: AbortSignal,
) => Promise<void>
type SourceReader = (projectId: string, assetId: string) => Promise<Awaited<ReturnType<typeof readLocalAssetBytes>>>

const maximumDecoders = 2
const maximumDecodedPageFrames = 16_384
export const nativeTimelineMaximumUploadedPages = 128

const pageKey = (sourceAssetKey: string, startFrame: number) => (
  `${sourceAssetKey}:${startFrame}`
)

const mergeRanges = (
  ranges: readonly { startFrame: number; endFrame: number }[],
) => {
  const sorted = ranges
    .filter((range) => range.endFrame > range.startFrame)
    .toSorted((left, right) => left.startFrame - right.startFrame)
  const merged: { startFrame: number; endFrame: number }[] = []
  for (const range of sorted) {
    const previous = merged.at(-1)
    if (previous && range.startFrame <= previous.endFrame) {
      previous.endFrame = Math.max(previous.endFrame, range.endFrame)
    } else {
      merged.push({ ...range })
    }
  }
  return merged
}

export const createNativeTimelinePageManager = (input: {
  projectId?: string
  sources: readonly NativeTimelineSource[]
  writePage: PageWriter
  prepareRange?: RangePreparer
  readLocalAsset?: SourceReader
  pageFrames?: number
}): NativeTimelinePageManager => {
  const sources = new Map(input.sources.map((source) => [source.sourceAssetKey, source]))
  const active = new Set<string>()
  const inFlight = new Map<string, Promise<void>>()
  const uploaded = new Map<string, Map<number, number>>()
  const slotWaiters: Array<() => void> = []
  const abortController = new AbortController()
  const readLocalAsset = input.readLocalAsset ?? readLocalAssetBytes
  let accessSequence = 0
  const requestedPageFrames = input.pageFrames ?? maximumDecodedPageFrames
  if (!Number.isSafeInteger(requestedPageFrames) || requestedPageFrames <= 0) {
    throw new Error('Native timeline page size must be a positive integer.')
  }
  const pageFramesForSource = (source: NativeTimelineSource) => {
    const payloadFrames = nativeAudioHostMaximumMappedAssetPageFramesForChannels(source.channelCount)
    if (payloadFrames <= 0) {
      throw new Error(`Native audio asset "${source.sourceAssetKey}" has too many channels for mapped pages.`)
    }
    return Math.min(requestedPageFrames, payloadFrames)
  }
  const isUploaded = (sourceAssetKey: string, startFrame: number) => {
    const pages = uploaded.get(sourceAssetKey)
    const timestamp = pages?.get(startFrame)
    if (timestamp === undefined) return false
    pages?.set(startFrame, ++accessSequence)
    return true
  }
  const markUploaded = (sourceAssetKey: string, startFrame: number) => {
    const pages = uploaded.get(sourceAssetKey) ?? new Map<number, number>()
    pages.set(startFrame, ++accessSequence)
    uploaded.set(sourceAssetKey, pages)
    let count = [...uploaded.values()].reduce((total, current) => total + current.size, 0)
    while (count > nativeTimelineMaximumUploadedPages) {
      let oldest: { sourceAssetKey: string; startFrame: number; timestamp: number } | undefined
      for (const [candidateAssetKey, candidatePages] of uploaded) {
        for (const [candidateStartFrame, timestamp] of candidatePages) {
          if (inFlight.has(pageKey(candidateAssetKey, candidateStartFrame))) continue
          if (!oldest || timestamp < oldest.timestamp) {
            oldest = { sourceAssetKey: candidateAssetKey, startFrame: candidateStartFrame, timestamp }
          }
        }
      }
      if (!oldest) break
      const candidatePages = uploaded.get(oldest.sourceAssetKey)
      candidatePages?.delete(oldest.startFrame)
      if (candidatePages?.size === 0) uploaded.delete(oldest.sourceAssetKey)
      count -= 1
    }
  }

  const acquireSlot = async (signal?: AbortSignal) => {
    signal?.throwIfAborted()
    if (active.size < maximumDecoders) return
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        const index = slotWaiters.findIndex((wake) => wake === wakeSlot)
        if (index >= 0) slotWaiters.splice(index, 1)
        reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
      }
      const wakeSlot = () => {
        signal?.removeEventListener('abort', abort)
        resolve()
      }
      signal?.addEventListener('abort', abort, { once: true })
      slotWaiters.push(wakeSlot)
    })
    try {
      signal?.throwIfAborted()
    } catch (error) {
      releaseSlot()
      throw error
    }
  }

  const releaseSlot = () => slotWaiters.shift()?.()
  const combinedSignal = (signal?: AbortSignal) => signal
    ? AbortSignal.any([abortController.signal, signal])
    : abortController.signal
  const awaitWithSignal = async (promise: Promise<void>, signal?: AbortSignal) => {
    if (!signal) return await promise
    signal.throwIfAborted()
    let onAbort: (() => void) | undefined
    try {
      return await Promise.race([
        promise,
        new Promise<void>((_, reject) => {
          onAbort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
          signal.addEventListener('abort', onAbort, { once: true })
        }),
      ])
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort)
    }
  }

  const sourceFor = async (source: NativeTimelineSource): Promise<DecodeAudioPageSource> => {
    if (source.sourceKind !== 'url' && input.projectId) {
      const local = await readLocalAsset(input.projectId, source.sourceAssetKey)
      if (local.status === 'ready') return local.file
      throw new Error(`Native audio asset "${source.sourceAssetKey}" is not available locally.`)
    }
    if (!source.sampleUrl) throw new Error(`Native audio asset "${source.sourceAssetKey}" has no source URL.`)
    return source.sampleUrl
  }

  const hydratePage = async (
    sourceAssetKey: string,
    startFrame: number,
    signal?: AbortSignal,
  ) => {
    const source = sources.get(sourceAssetKey)
    if (!source) throw new Error(`Native audio asset "${sourceAssetKey}" is not registered.`)
    const pageFrames = pageFramesForSource(source)
    const endFrame = Math.min(source.frameCount, startFrame + pageFrames)
    if (startFrame < 0 || startFrame >= source.frameCount || endFrame <= startFrame) {
      throw new Error(`Native audio asset "${sourceAssetKey}" page is invalid.`)
    }
    const key = pageKey(sourceAssetKey, startFrame)
    const existing = inFlight.get(key)
    if (existing) return await awaitWithSignal(existing, signal)
    const operation = (async () => {
      // The page operation is shared by all callers. A caller abort only
      // detaches that caller; manager disposal aborts the shared decoder.
      const operationSignal = combinedSignal()
      let slotAcquired = false
      try {
        await acquireSlot(operationSignal)
        slotAcquired = true
        active.add(key)
        const pagePlanes = Array.from(
          { length: source.channelCount },
          () => new Float32Array(endFrame - startFrame),
        )
        const written: { startFrame: number; endFrame: number }[] = []
        if (source.buffer) {
          if (source.buffer.sampleRate !== source.sampleRateHz
            || source.buffer.numberOfChannels !== source.channelCount
            || source.buffer.length < endFrame) {
            throw new Error(`Native audio asset "${sourceAssetKey}" eager metadata is inconsistent.`)
          }
          for (let channel = 0; channel < source.channelCount; channel += 1) {
            const sourcePlane = source.buffer.getChannelData(channel)
            const destinationPlane = pagePlanes[channel]
            if (!destinationPlane) {
              throw new Error(`Native audio asset "${sourceAssetKey}" has an incomplete channel layout.`)
            }
            destinationPlane.set(sourcePlane.subarray(startFrame, endFrame))
          }
          written.push({ startFrame, endFrame })
        } else {
          const decoderSource = await sourceFor(source)
          for await (const page of decodeAudioPages(decoderSource, {
            startSec: startFrame / source.sampleRateHz,
            endSec: endFrame / source.sampleRateHz,
            pageFrames,
            signal: operationSignal,
          })) {
            operationSignal.throwIfAborted()
            if (page.sampleRate !== source.sampleRateHz || page.channelCount !== source.channelCount) {
              throw new Error(`Native audio asset "${sourceAssetKey}" metadata changed while decoding.`)
            }
            const overlapStart = Math.max(startFrame, page.startFrame)
            const overlapEnd = Math.min(endFrame, page.startFrame + page.frameCount)
            if (overlapEnd <= overlapStart) continue
            const pageOffset = overlapStart - page.startFrame
            const outputOffset = overlapStart - startFrame
            const frameCount = overlapEnd - overlapStart
            for (let channel = 0; channel < source.channelCount; channel += 1) {
              const sourcePlane = page.planes[channel]
              const destinationPlane = pagePlanes[channel]
              if (!sourcePlane || !destinationPlane) {
                throw new Error(`Native audio asset "${sourceAssetKey}" has an incomplete channel layout.`)
              }
              destinationPlane.set(
                sourcePlane.subarray(pageOffset, pageOffset + frameCount),
                outputOffset,
              )
            }
            written.push({ startFrame: overlapStart, endFrame: overlapEnd })
          }
        }
        const covered = mergeRanges(written)
        if (covered.length !== 1
          || covered[0]?.startFrame !== startFrame
          || covered[0]?.endFrame !== endFrame) {
          throw new Error(`Native audio asset "${sourceAssetKey}" did not decode the requested page.`)
        }
        const planarPcm = new Uint8Array(
          source.channelCount * (endFrame - startFrame) * Float32Array.BYTES_PER_ELEMENT,
        )
        const bytesPerPlane = (endFrame - startFrame) * Float32Array.BYTES_PER_ELEMENT
        pagePlanes.forEach((plane, channel) => {
          planarPcm.set(
            new Uint8Array(plane.buffer, plane.byteOffset, plane.byteLength),
            channel * bytesPerPlane,
          )
        })
        await input.writePage({
          sessionAssetId: source.sessionAssetId,
          startFrame,
          frameCount: endFrame - startFrame,
          planarPcm,
        }, operationSignal)
        markUploaded(sourceAssetKey, startFrame)
      } finally {
        if (slotAcquired) {
          active.delete(key)
          releaseSlot()
        }
      }
    })()
    inFlight.set(key, operation)
    const clearOperation = () => {
      if (inFlight.get(key) === operation) inFlight.delete(key)
    }
    void operation.then(clearOperation, clearOperation)
    await awaitWithSignal(operation, signal)
  }

  return {
    ensureRanges: async (ranges, signal) => {
      signal?.throwIfAborted()
      const merged = new Map<string, { sourceAssetKey: string; startFrame: number; endFrame: number }[]>()
      for (const range of ranges) {
        const source = sources.get(range.sourceAssetKey)
        if (!source) throw new Error(`Native audio asset "${range.sourceAssetKey}" is not registered.`)
        if (!Number.isSafeInteger(range.startFrame)
          || !Number.isSafeInteger(range.endFrame)
          || range.startFrame < 0
          || range.endFrame <= range.startFrame
          || range.startFrame >= source.frameCount) {
          throw new Error(`Native audio asset "${range.sourceAssetKey}" range is invalid.`)
        }
        const entries = merged.get(range.sourceAssetKey) ?? []
        entries.push({
          sourceAssetKey: range.sourceAssetKey,
          startFrame: range.startFrame,
          endFrame: Math.min(source.frameCount, range.endFrame),
        })
        merged.set(range.sourceAssetKey, entries)
      }
      const hydrationJobs: { sourceAssetKey: string; pageStart: number }[] = []
      const prepareJobs: { source: NativeTimelineSource; startFrame: number; frameCount: number }[] = []
      for (const [sourceAssetKey, entries] of merged) {
        const source = sources.get(sourceAssetKey)
        if (!source) throw new Error(`Native audio asset "${sourceAssetKey}" is not registered.`)
        const pageFrames = pageFramesForSource(source)
        const pageStarts = new Set<number>()
        for (const range of mergeRanges(entries)) {
          const firstPage = Math.floor(range.startFrame / pageFrames) * pageFrames
          const lastPage = Math.floor((range.endFrame - 1) / pageFrames) * pageFrames
          for (let pageStart = firstPage; pageStart <= lastPage; pageStart += pageFrames) {
            if (!isUploaded(sourceAssetKey, pageStart)) pageStarts.add(pageStart)
          }
        }
        for (const range of mergeRanges(entries)) {
          prepareJobs.push({
            source,
            startFrame: range.startFrame,
            frameCount: range.endFrame - range.startFrame,
          })
        }
        hydrationJobs.push(...[...pageStarts].map((pageStart) => ({ sourceAssetKey, pageStart })))
      }
      await runWithConcurrency(hydrationJobs, maximumDecoders, async ({ sourceAssetKey, pageStart }) => {
        await hydratePage(sourceAssetKey, pageStart, signal)
      })
      for (const job of prepareJobs) {
        await input.prepareRange?.(job.source.sessionAssetId, job.startFrame, job.frameCount, signal)
      }
    },
    invalidateRanges: (ranges) => {
      for (const range of ranges) {
        const current = uploaded.get(range.sourceAssetKey)
        if (!current) continue
        const source = sources.get(range.sourceAssetKey)
        if (!source) continue
        const pageFrames = pageFramesForSource(source)
        for (const pageStart of current.keys()) {
          const pageEnd = pageStart + pageFrames
          if (pageEnd > range.startFrame && pageStart < range.endFrame) current.delete(pageStart)
        }
      }
    },
    dispose: () => {
      abortController.abort()
      inFlight.clear()
      uploaded.clear()
    },
  }
}
