import type { EngineDisposition } from '@daw-browser/audio-engine/audio-engine'

// The abort reason of work that a newer sync replaced. It never leaves the
// synchronizers: `replaceSampledInstrumentSync` and `untilNotSuperseded` consume it.
export class SampledInstrumentSyncSupersededError extends Error {
  readonly replacement: Promise<EngineDisposition>

  constructor(replacement: Promise<EngineDisposition>) {
    super('Sampled instrument buffer sync was superseded.')
    this.name = 'SampledInstrumentSyncSupersededError'
    this.replacement = replacement
  }
}

const followReplacement = async (sync: Promise<EngineDisposition>): Promise<EngineDisposition> => {
  try {
    return await sync
  } catch (cause) {
    if (!(cause instanceof SampledInstrumentSyncSupersededError)) throw cause
    await cause.replacement

    return 'superseded'
  }
}

// Starts `run` as the sync that replaces the one owning `previous`. The replaced
// sync resolves 'superseded' once its replacement settles, and rejects if the
// replacement fails: it installed nothing, but the target is not settled until
// the replacement is. `register` sees the replacement before `run` starts.
export const replaceSampledInstrumentSync = (
  previous: AbortController | undefined,
  run: () => Promise<EngineDisposition>,
  register?: (replacement: Promise<EngineDisposition>) => void,
): Promise<EngineDisposition> => {
  let start = () => {}

  const replacement = followReplacement(new Promise<EngineDisposition>((resolve, reject) => {
    start = () => { void run().then(resolve, reject) }
  }))

  register?.(replacement)
  previous?.abort(new SampledInstrumentSyncSupersededError(replacement))
  start()

  return replacement
}

// Runs `load` again after the sync that cut it short settles.
export const untilNotSuperseded = async <T>(load: () => Promise<T>): Promise<T> => {
  for (;;) {
    try {
      return await load()
    } catch (cause) {
      if (!(cause instanceof SampledInstrumentSyncSupersededError)) throw cause
      await cause.replacement
    }
  }
}
