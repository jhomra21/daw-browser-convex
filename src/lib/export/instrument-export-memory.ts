import { nativeAudioHostPageBytes } from '@daw-browser/desktop-protocol/native-audio-host'
import { sampledInstrumentRetainedBytes, type SampledInstrumentBuffer } from '@daw-browser/audio-engine/sampled-instrument-region'
import { nativeInstrumentDeviceDecodedBytes } from '@daw-browser/desktop-protocol/native-instrument-budget-policy'
import type { SampledInstrumentRegionBudgetScope } from '~/lib/sampled-instrument-region-budget'

export type InstrumentExportRegionJob = {
  key: string
  bytes: number
  existing?: SampledInstrumentBuffer
}

// What differs between exporting through the browser engine and through the
// native host: the decoded-byte ceiling, how retained bytes are counted, and
// whether the budget holds the regions for the whole export.
export type InstrumentExportMemoryPolicy = {
  decodedLimit: (instrumentLimit: number) => number
  granularRetainedBytes: (decodedBytes: number) => number
  leaseRegions: boolean
  // Runs once the jobs are known, before anything loads. Throws when the budget cannot hold them.
  admit: (budget: SampledInstrumentRegionBudgetScope | undefined, jobs: readonly InstrumentExportRegionJob[]) => void
}

export const portableInstrumentExportMemory: InstrumentExportMemoryPolicy = {
  decodedLimit: (instrumentLimit) => instrumentLimit,
  granularRetainedBytes: (decodedBytes) => sampledInstrumentRetainedBytes(decodedBytes, 2),
  leaseRegions: false,
  admit: () => undefined,
}

export const nativeInstrumentExportMemory: InstrumentExportMemoryPolicy = {
  decodedLimit: () => nativeInstrumentDeviceDecodedBytes,
  granularRetainedBytes: (decodedBytes) => decodedBytes,
  leaseRegions: true,
  admit: (budget, jobs) => {
    if (!budget) throw new Error('Native export sample memory accounting is unavailable. Restart desktop audio and retry.')

    try {
      budget.lease(jobs.flatMap((job) => job.existing ? [{
        key: job.key, buffer: job.existing.buffer, bytes: job.bytes,
      }] : []), true)
      // Separate child-host mappings from physical renderer PCM. Offline does
      // not lock memory; conservatively charge the same 16 KiB mapping pages.
      budget.set('native-export-page-staging', 2 * 1024 ** 2, () => undefined)

      for (const job of jobs) {
        budget.set(`native-export-mapping:${job.key}`, Math.ceil(job.bytes / nativeAudioHostPageBytes) * nativeAudioHostPageBytes, () => undefined)
      }

      budget.ensureCapacityFor(new Map(jobs.filter((job) => !job.existing).map((job) => [job.key, job.bytes])))
    } catch {
      throw new Error('Not enough sample memory to export. Shorten sample regions or remove unused samples, then retry. No export was completed.')
    }
  },
}
