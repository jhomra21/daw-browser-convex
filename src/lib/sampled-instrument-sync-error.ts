import type { EngineDisposition } from '@daw-browser/audio-engine/audio-engine'

export class SampledInstrumentSyncSupersededError extends Error {
  readonly replacement: Promise<EngineDisposition>

  constructor(replacement: Promise<EngineDisposition>) {
    super('Sampled instrument buffer sync was superseded.')
    this.name = 'SampledInstrumentSyncSupersededError'
    this.replacement = replacement
  }
}
