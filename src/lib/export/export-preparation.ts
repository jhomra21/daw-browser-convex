import type { ExportFx } from "@daw-browser/audio-engine/export-mixdown"
import { getExportRangeBounds, type ExportRange } from '@daw-browser/audio-engine/export-range'
import { loadSampledInstrumentRegion } from '~/lib/sampled-instrument-region-loader'
import { sampledInstrumentRegion, sampledInstrumentRegionBytes, sampledInstrumentRegionIdentity, validateSampledInstrumentBuffer, type SampledInstrumentBuffer } from '@daw-browser/audio-engine/sampled-instrument-region'
import { DRUM_RACK_MAX_DECODED_BYTES } from '@daw-browser/audio-engine/drum-rack-runtime'
import { runWithConcurrency } from '~/lib/run-with-concurrency'
import type { RuntimeClip, RuntimeTrack } from '~/lib/timeline-runtime-types'
import { isPortableStretchClip } from '@daw-browser/audio-engine/portable-stretch-preparation'
import type { SampledInstrumentRegionBudgetScope } from '~/lib/sampled-instrument-region-budget'
import { portableInstrumentExportMemory, type InstrumentExportMemoryPolicy } from '~/lib/export/instrument-export-memory'
import type { TimelineExportRequest } from '~/lib/export/export-job-types'

export const throwIfExportAborted = (signal: AbortSignal) => {
  signal.throwIfAborted()
}

const MAX_CONCURRENT_BUFFER_LOADS = 4

const createExportRangeClipPredicate = (
  tracks: readonly RuntimeTrack[],
  range: ExportRange,
): ((clip: RuntimeClip) => boolean) => {
  const { startSec: rangeStart, endSec: rangeEnd } = getExportRangeBounds(tracks, range)

  return (clip) => {
    const clipEnd = clip.startSec + clip.duration

    return clipEnd > rangeStart && clip.startSec < rangeEnd
  }
}

export const filterTracksToExportRange = (
  tracks: readonly RuntimeTrack[],
  range: ExportRange,
) => {
  const intersects = createExportRangeClipPredicate(tracks, range)

  return tracks.map((track) => ({
    ...track,
    clips: track.clips.filter(intersects),
  }))
}

export async function ensureNativeStretchBuffers(input: {
  tracks: readonly RuntimeTrack[]
  range: ExportRange
  loadCapturedClipBuffer: TimelineExportRequest['loadCapturedClipBuffer']
  resolveAudioSource?: TimelineExportRequest['resolveAudioSource']
  signal: AbortSignal
}) {
  const intersects = createExportRangeClipPredicate(input.tracks, input.range)
  const jobs: (() => Promise<void>)[] = []

  for (const track of input.tracks) {
    for (const clip of track.clips) {
      if (clip.midi || !intersects(clip) || clip.buffer
        || input.resolveAudioSource && isPortableStretchClip(clip)) continue
      jobs.push(() => input.loadCapturedClipBuffer(clip, input.signal))
    }
  }

  await runWithConcurrency(jobs, MAX_CONCURRENT_BUFFER_LOADS, async (job) => {
    throwIfExportAborted(input.signal)
    await job()
  })
  throwIfExportAborted(input.signal)
}

export async function loadInstrumentExportBuffers(
  fx: ExportFx,
  signal: AbortSignal,
  allowedTrackIds?: ReadonlySet<string>,
  projectId?: string,
  sampledInstrumentRegionScope?: SampledInstrumentRegionBudgetScope,
  memory: InstrumentExportMemoryPolicy = portableInstrumentExportMemory,
): Promise<void> {
  const trackFx = fx.trackFx

  if (!trackFx) return
  const budget = sampledInstrumentRegionScope

  type ExportSample = {
    assetKey: string
    url: string
    sourceKind: 'upload' | 'url' | 'recording'
    source: { durationSec: number; sampleRate: number; channelCount: number }
  }

  type Consumer = {
    input: ExportSample
    bounds: { sourceStartFrame: number; sourceEndFrame: number }
    decodedBytes: number
    maxDecodedBytes: number
    install: (buffer: SampledInstrumentBuffer) => void
    current: SampledInstrumentBuffer | undefined
  }

  type RegionJob = {
    key: string
    bytes: number
    consumers: Consumer[]
    existing?: SampledInstrumentBuffer
  }

  const jobsByIdentity = new Map<string, RegionJob>()

  const matchesRegion = (
    buffer: SampledInstrumentBuffer | undefined,
    sample: ExportSample,
    region: { sourceStartFrame: number; sourceEndFrame: number },
  ) => buffer !== undefined
    && buffer.sourceIdentity === sampledInstrumentRegionIdentity(sample, region)
    && (() => {
      try {
        return validateSampledInstrumentBuffer(buffer, sample.source, region) === buffer
      } catch {
        return false
      }
    })()

  const addConsumer = (
    key: string,
    retainedBytes: number,
    consumer: Consumer,
  ) => {
    if (consumer.decodedBytes > consumer.maxDecodedBytes) {
      throw new Error(`Sampled instrument region exceeds the ${consumer.maxDecodedBytes} byte limit.`)
    }

    const existing = jobsByIdentity.get(key)

    if (existing) {
      existing.consumers.push(consumer)
      existing.bytes = Math.max(existing.bytes, retainedBytes)

      if (!existing.existing && consumer.current) existing.existing = consumer.current

      return
    }

    jobsByIdentity.set(key, {
      key,
      bytes: retainedBytes,
      consumers: [consumer],
      existing: consumer.current,
    })
  }

  for (const [trackId, entry] of Object.entries(trackFx)) {
    if (allowedTrackIds && !allowedTrackIds.has(trackId)) continue

    if (entry.instrument?.kind === 'drum-rack') {
      const buffers = new Map<string, SampledInstrumentBuffer>(entry.drumRackBuffers ?? [])
      entry.drumRackBuffers = buffers

      for (const pad of entry.instrument.params.pads) {
        const sample = pad.sample

        const region = sample
          ? sampledInstrumentRegion(sample.source, pad.startSec, pad.endSec ?? sample.source.durationSec)
          : undefined

        if (sample && region) {
          const key = sampledInstrumentRegionIdentity(sample, region)
          addConsumer(key, sampledInstrumentRegionBytes(region, sample.source.channelCount), {
            input: sample,
            bounds: region,
            decodedBytes: sampledInstrumentRegionBytes(region, sample.source.channelCount),
            maxDecodedBytes: memory.decodedLimit(DRUM_RACK_MAX_DECODED_BYTES),
            current: matchesRegion(buffers.get(pad.id), sample, region) ? buffers.get(pad.id) : undefined,
            install: (buffer) => buffers.set(pad.id, buffer),
          })
        }
      }

      const localRegions = new Map<string, number>()

      for (const pad of entry.instrument.params.pads) {
        if (!pad.sample) continue
        const region = sampledInstrumentRegion(pad.sample.source, pad.startSec, pad.endSec ?? pad.sample.source.durationSec)
        localRegions.set(sampledInstrumentRegionIdentity(pad.sample, region), sampledInstrumentRegionBytes(region, pad.sample.source.channelCount))
      }

      const localBytes = [...localRegions.values()].reduce((total, bytes) => total + bytes, 0)
      const limit = memory.decodedLimit(DRUM_RACK_MAX_DECODED_BYTES)

      if (localBytes > limit) throw new Error(`Drum Rack regions exceed the ${limit} byte limit.`)
    }

    if (entry.instrument?.kind === 'sampler') {
      const buffers = new Map<string, SampledInstrumentBuffer>(entry.samplerBuffers ?? [])
      entry.samplerBuffers = buffers
      const localRegions = new Map<string, number>()

      for (const zone of entry.instrument.params.zones) {
        const region = sampledInstrumentRegion(zone.sample.source, zone.startSec, zone.endSec ?? zone.sample.source.durationSec)
        const key = sampledInstrumentRegionIdentity(zone.sample, region)
        const bytes = sampledInstrumentRegionBytes(region, zone.sample.source.channelCount)
        localRegions.set(key, bytes)
        addConsumer(key, bytes, {
          input: zone.sample,
          bounds: region,
          decodedBytes: bytes,
          maxDecodedBytes: memory.decodedLimit(entry.instrument.params.maxDecodedBytes),
          current: matchesRegion(buffers.get(zone.id), zone.sample, region) ? buffers.get(zone.id) : undefined,
          install: (buffer) => buffers.set(zone.id, buffer),
        })
      }

      const localBytes = [...localRegions.values()].reduce((total, bytes) => total + bytes, 0)
      const limit = memory.decodedLimit(entry.instrument.params.maxDecodedBytes)

      if (localBytes > limit) {
        throw new Error(`Sampler regions exceed the ${limit} byte limit.`)
      }
    }

    if (entry.instrument?.kind === 'granular') {
      const zone = entry.instrument.params.zone

      if (!zone) {
        entry.granularBuffer = undefined
      } else {
        const region = sampledInstrumentRegion(zone.sample.source, zone.startSec, zone.endSec ?? zone.sample.source.durationSec)
        const existing = entry.granularBuffer
        const currentIdentity = sampledInstrumentRegionIdentity(zone.sample, region)
        const decodedBytes = sampledInstrumentRegionBytes(region, zone.sample.source.channelCount)
        const limit = memory.decodedLimit(entry.instrument.params.maxDecodedBytes)
        addConsumer(currentIdentity, memory.granularRetainedBytes(decodedBytes), {
          input: zone.sample,
          bounds: region,
          decodedBytes,
          maxDecodedBytes: limit,
          current: existing?.assetKey === currentIdentity && matchesRegion(existing, zone.sample, region) ? existing : undefined,
          install: (buffer) => {
            entry.granularBuffer = {
              assetKey: currentIdentity,
              buffer: buffer.buffer,
              sourceStartFrame: buffer.sourceStartFrame,
              sourceIdentity: buffer.sourceIdentity,
            }
          },
        })

        if (decodedBytes > limit) {
          throw new Error(`Granular regions exceed the ${limit} byte limit.`)
        }
      }
    }
  }

  const jobs = [...jobsByIdentity.values()]

  if (jobs.length === 0) return
  memory.admit(budget, jobs)

  const leasedExisting = (job: RegionJob) => (
    job.existing !== undefined
    && budget?.isLeased(job.existing.buffer) === true
  )

  if (budget) {
    budget.ensureCapacityFor(new Map(
      jobs.flatMap((job) => leasedExisting(job) ? [] : [[job.key, job.bytes]]),
    ))
  }

  for (const job of jobs) {
    if (!job.existing) continue

    if (!leasedExisting(job)) budget?.set(job.key, job.bytes, () => undefined, job.existing.buffer)

    for (const consumer of job.consumers) consumer.install(job.existing)
  }

  const loads = jobs.filter((job) => !job.existing)
  const reservations = new Map<string, { release: () => void; commit: () => void }>()

  if (budget) {
    for (const job of loads) reservations.set(job.key, budget.reserve(job.key, job.bytes))
  }

  try {
    let loadError: unknown
    const loading = new AbortController()
    const loadSignal = AbortSignal.any([signal, loading.signal])
    await runWithConcurrency(loads, MAX_CONCURRENT_BUFFER_LOADS, async (job) => {
      try {
        throwIfExportAborted(loadSignal)

        const result = await loadSampledInstrumentRegion(
          job.consumers[0]?.input ?? (() => { throw new Error('Export sample job has no consumer.') })(),
          job.consumers[0]?.bounds ?? (() => { throw new Error('Export sample job has no bounds.') })(),
          job.consumers[0]?.maxDecodedBytes ?? 0,
          loadSignal,
          projectId ? { projectId: () => projectId } : {},
        )

        throwIfExportAborted(loadSignal)

        if (result.status === 'missing') {
          throw new Error(`Failed to preload export sample ${job.consumers[0]?.input.url ?? job.key}`)
        }

        const buffer = result.buffer
        const reservation = reservations.get(job.key)
        reservation?.commit()
        budget?.set(job.key, job.bytes, () => undefined, buffer.buffer)

        if (memory.leaseRegions) budget?.lease([{ key: job.key, buffer: buffer.buffer, bytes: job.bytes }], true)

        for (const consumer of job.consumers) consumer.install(buffer)
      } catch (error) {
        if (!loading.signal.aborted) {
          loadError = error
          loading.abort(error)
        }
      }
    })

    // Drain sibling decodes before their owning export scope may be released.
    if (loading.signal.aborted) throw loadError
    throwIfExportAborted(signal)
  } finally {
    for (const reservation of reservations.values()) reservation.release()
  }
}
