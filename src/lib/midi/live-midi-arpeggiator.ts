import { arpeggiatorSequence, arpeggiatorStepBeats, type ArpeggiatorParams } from '@daw-browser/shared'

export type LiveMidiArpeggiatorScheduler = {
  schedule: (callback: () => void, delayMs: number) => number
  clear: (timer: number) => void
}

export type LiveMidiArpeggiatorRelease = {
  force?: boolean
  reason?: 'manual' | 'gate'
  when?: number
}

type LiveMidiArpeggiatorConfig = {
  trackId: string | undefined
  params: ArpeggiatorParams | undefined
  bpm: number
}

type SourceNote<Handle> = {
  pitch: number
  velocity: number
  when?: number
  handle?: Handle
}

type EmittedNote<Handle> = {
  handle: Handle
  releaseTimer: number
}

type LiveMidiArpeggiatorOptions<Handle> = {
  getConfig: () => LiveMidiArpeggiatorConfig
  start: (note: { trackId: string; pitch: number; velocity: number; when?: number }) => Handle | undefined
  stop: (handle: Handle, release?: LiveMidiArpeggiatorRelease) => void
  scheduler?: LiveMidiArpeggiatorScheduler
}

const configFingerprint = (config: LiveMidiArpeggiatorConfig) => JSON.stringify(config)

export function createLiveMidiArpeggiator<Handle>(
  options: LiveMidiArpeggiatorOptions<Handle>,
) {
  // Live musical timing is event-driven but needs one bounded timer for the next
  // step and one bounded timer for each gate release. Both are cancelled on reset.
  const scheduler: LiveMidiArpeggiatorScheduler = options.scheduler ?? {
    schedule: (callback, delayMs) => window.setTimeout(callback, delayMs),
    clear: (timer) => window.clearTimeout(timer),
  }
  const sourceNotes = new Map<number, SourceNote<Handle>>()
  const emittedNotes = new Map<number, EmittedNote<Handle>>()
  let nextSourceId = 1
  let nextEmissionId = 1
  let sequence: number[] = []
  let sequenceIndex = 0
  let nextStepTimer: number | undefined
  let configKey = ''
  let previousConfig: LiveMidiArpeggiatorConfig | undefined
  let generation = 0

  const currentConfig = () => options.getConfig()
  const enabled = () => currentConfig().params?.enabled === true

  const clearNextStepTimer = () => {
    if (nextStepTimer === undefined) return
    scheduler.clear(nextStepTimer)
    nextStepTimer = undefined
  }

  const releaseEmission = (emissionId: number, force = false) => {
    const emitted = emittedNotes.get(emissionId)
    if (!emitted) return
    emittedNotes.delete(emissionId)
    scheduler.clear(emitted.releaseTimer)
    options.stop(emitted.handle, {
      force,
      reason: force ? 'manual' : 'gate',
    })
  }

  const releaseAllEmitted = (force = false) => {
    for (const [emissionId] of emittedNotes) releaseEmission(emissionId, force)
  }

  const stopArpeggiator = (force = false) => {
    generation += 1
    clearNextStepTimer()
    releaseAllEmitted(force)
    sequence = []
    sequenceIndex = 0
  }

  const rebuildSequence = () => {
    const params = currentConfig().params
    if (!params) {
      sequence = []
      sequenceIndex = 0
      return
    }
    sequence = arpeggiatorSequence(
      [...sourceNotes.values()].map((source) => source.pitch),
      params,
    )
    sequenceIndex = 0
  }

  let latched = false

  const scheduleNextStep = (token: number, immediate: boolean) => {
    const config = currentConfig()
    const params = config.params
    if (
      token !== generation
      || !config.trackId
      || !params?.enabled
      || sourceNotes.size === 0
      || sequence.length === 0
    ) return
    const stepMs = arpeggiatorStepBeats(params.rate) * 60_000 / Math.max(1, config.bpm)
    nextStepTimer = scheduler.schedule(() => {
      nextStepTimer = undefined
      if (token !== generation) return
      if (configFingerprint(currentConfig()) !== configKey) {
        configure()
        return
      }
      const pitch = sequence[sequenceIndex % sequence.length]
      sequenceIndex += 1
      if (pitch !== undefined) {
        const velocity = Math.max(...[...sourceNotes.values()].map((source) => source.velocity))
        const trackId = config.trackId
        if (!trackId) return
        const handle = options.start({ trackId, pitch, velocity })
        if (handle !== undefined) {
          const emissionId = nextEmissionId
          nextEmissionId += 1
          const releaseTimer = scheduler.schedule(
            () => releaseEmission(emissionId),
            stepMs * Math.max(0, Math.min(1, params.gate)),
          )
          emittedNotes.set(emissionId, { handle, releaseTimer })
        }
      }
      scheduleNextStep(token, false)
    }, immediate ? 0 : stepMs)
  }

  const configure = () => {
    const nextConfig = currentConfig()
    const nextKey = configFingerprint(nextConfig)
    if (nextKey === configKey) return
    const hadConfig = previousConfig !== undefined
    const trackChanged = hadConfig && previousConfig?.trackId !== nextConfig.trackId
    const wasEnabled = previousConfig?.params?.enabled === true
    const holdDisabled = latched && nextConfig.params?.hold !== true
    configKey = nextKey
    previousConfig = nextConfig
    if (trackChanged || holdDisabled) latched = false
    const sources = [...sourceNotes.entries()]
    stopArpeggiator()
    if (trackChanged || holdDisabled) {
      for (const source of sources) {
        if (source[1].handle !== undefined) {
          options.stop(source[1].handle, { force: true, reason: 'manual' })
        }
      }
      sourceNotes.clear()
      return
    }
    if (enabled() && sources.length > 0) {
      if (!wasEnabled) {
        for (const [sourceId, source] of sources) {
          if (source.handle === undefined) continue
          options.stop(source.handle, { force: true, reason: 'manual' })
          sourceNotes.set(sourceId, { pitch: source.pitch, velocity: source.velocity })
        }
      }
      rebuildSequence()
      generation += 1
      scheduleNextStep(generation, true)
    } else if (!enabled()) {
      if (wasEnabled) {
        const trackId = nextConfig.trackId
        if (trackId && !latched) {
          for (const [sourceId, source] of sources) {
            if (source.handle !== undefined) continue
            const handle = options.start({ trackId, pitch: source.pitch, velocity: source.velocity, when: source.when })
            if (handle !== undefined) sourceNotes.set(sourceId, { ...source, handle })
          }
          return
        }
      }
      if (wasEnabled) {
        for (const source of sources) {
          if (source[1].handle !== undefined) options.stop(source[1].handle, { force: true, reason: 'manual' })
        }
        sourceNotes.clear()
      }
    }
  }

  const reset = (force: boolean) => {
    latched = false
    stopArpeggiator(force)
    for (const source of sourceNotes.values()) {
      if (source.handle !== undefined) options.stop(source.handle, { force, reason: 'manual' })
    }
    sourceNotes.clear()
    configKey = ''
    previousConfig = undefined
  }

  return {
    configure,
    noteOn: (pitch: number, velocity: number, when?: number) => {
      configure()
      const config = currentConfig()
      if (!config.trackId) return undefined
      if (latched) {
        stopArpeggiator(true)
        sourceNotes.clear()
        latched = false
      }
      const sourceId = nextSourceId
      nextSourceId += 1
      if (!config.params?.enabled) {
        const handle = options.start({ trackId: config.trackId, pitch, velocity, when })
        if (handle === undefined) return undefined
        sourceNotes.set(sourceId, { pitch, velocity, when, handle })
        return sourceId
      }
      sourceNotes.set(sourceId, { pitch, velocity, when })
      rebuildSequence()
      if (nextStepTimer === undefined) {
        generation += 1
        scheduleNextStep(generation, true)
      }
      return sourceId
    },
    noteOff: (sourceId: number, force = false, when?: number) => {
      configure()
      const source = sourceNotes.get(sourceId)
      if (!source) return
      if (source.handle !== undefined) {
        sourceNotes.delete(sourceId)
        options.stop(source.handle, { force, reason: 'manual', when })
        return
      }
      const isFinalSource = sourceNotes.size === 1
      if (isFinalSource && currentConfig().params?.hold === true && !force) {
        latched = true
        return
      }
      sourceNotes.delete(sourceId)
      if (isFinalSource) {
        stopArpeggiator(force)
        return
      }
      rebuildSequence()
    },
    panic: () => reset(true),
    reset: () => reset(true),
  }
}
