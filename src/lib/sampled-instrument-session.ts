import { createDrumRackBufferSync } from '~/lib/drum-rack-buffer-sync'
import {
  createSamplerBufferSync,
  DEFAULT_SAMPLED_INSTRUMENT_AGGREGATE_BYTES,
} from '~/lib/sampler-buffer-sync'
import {
  createSampledInstrumentRegionBudget,
  type SampledInstrumentRegionBudgetScope,
  type SampledInstrumentRegionBudget,
} from '~/lib/sampled-instrument-region-budget'
import type { SampledInstrumentRegionLoaderOptions } from '~/lib/sampled-instrument-region-loader'

export type SampledInstrumentSession = {
  aggregateBudget: SampledInstrumentRegionBudget
  samplerBufferSync: ReturnType<typeof createSamplerBufferSync>
  drumRackBufferSync: ReturnType<typeof createDrumRackBufferSync>
  createExportScope: () => SampledInstrumentRegionBudgetScope
  dispose: () => void
}

export const createSampledInstrumentSession = (
  options: SampledInstrumentRegionLoaderOptions & {
    projectId: NonNullable<SampledInstrumentRegionLoaderOptions['projectId']>
    aggregateMaxBytes?: number
  },
): SampledInstrumentSession => {
  const aggregateBudget = createSampledInstrumentRegionBudget(
    options.aggregateMaxBytes ?? DEFAULT_SAMPLED_INSTRUMENT_AGGREGATE_BYTES,
  )
  const samplerBufferSync = createSamplerBufferSync({
    ...options,
    aggregateBudget,
  })
  const drumRackBufferSync = createDrumRackBufferSync({
    ...options,
    aggregateBudget,
  })
  let disposed = false
  return {
    aggregateBudget,
    samplerBufferSync,
    drumRackBufferSync,
    createExportScope: () => aggregateBudget.createScope(`prepared-export:${crypto.randomUUID()}`),
    dispose: () => {
      if (disposed) return
      disposed = true
      drumRackBufferSync.dispose()
      samplerBufferSync.dispose()
      aggregateBudget.dispose()
    },
  }
}
