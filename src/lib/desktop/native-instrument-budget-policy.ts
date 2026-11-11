export type NativeInstrumentBudgetPolicy = {
  deviceDecodedBytes: number
  aggregateBytes: number
}
export const nativeInstrumentDeviceDecodedBytes = 1024 ** 3

// Match the co-shipped host's hw.memsize / 8 resident backstop. This combined
// allowance is stricter: renderer PCM and page-rounded native copies both count.
export const nativeInstrumentBudgetPolicy = (totalMemoryBytes: number): NativeInstrumentBudgetPolicy => {
  if (!Number.isSafeInteger(totalMemoryBytes) || totalMemoryBytes <= 0) {
    throw new Error('System memory is unavailable. Restart desktop audio and retry.')
  }
  return { deviceDecodedBytes: nativeInstrumentDeviceDecodedBytes, aggregateBytes: Math.floor(totalMemoryBytes / 8) }
}

export type NativeInstrumentPreparation = {
  state: 'loading' | 'ready' | 'error'
  error?: string
}
