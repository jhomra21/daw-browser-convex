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
import type { NativeInstrumentBudgetPolicy, NativeInstrumentPreparation } from '~/lib/desktop/native-instrument-budget-policy'

export type SampledInstrumentSession = {
  aggregateBudget: SampledInstrumentRegionBudget
  samplerBufferSync: ReturnType<typeof createSamplerBufferSync>
  drumRackBufferSync: ReturnType<typeof createDrumRackBufferSync>
  createExportScope: () => SampledInstrumentRegionBudgetScope
  setNativePreparation: (trackIds: readonly string[], status: NativeInstrumentPreparation) => void
  dispose: () => void
}

export const createSampledInstrumentSession = (
  options: SampledInstrumentRegionLoaderOptions & {
    projectId: NonNullable<SampledInstrumentRegionLoaderOptions['projectId']>
    aggregateMaxBytes?: number
    nativeAudio?: () => boolean
    nativeMemoryPolicy?: NativeInstrumentBudgetPolicy
  },
): SampledInstrumentSession => {
  const aggregateBudget = createSampledInstrumentRegionBudget(
    options.aggregateMaxBytes ?? (options.nativeAudio?.()
      ? options.nativeMemoryPolicy?.aggregateBytes ?? 0
      : DEFAULT_SAMPLED_INSTRUMENT_AGGREGATE_BYTES),
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
    setNativePreparation: (trackIds, status) => {
      for (const trackId of trackIds) {
        samplerBufferSync.setNativePreparation(trackId, status)
        drumRackBufferSync.setNativePreparation(trackId, status)
      }
    },
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
