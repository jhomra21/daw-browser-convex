import { z } from 'zod'
import { getAudioEngine } from '~/lib/audio-engine-singleton'
import { cpuLoadFromNativeSample, type AudioCpuLoad } from '~/lib/audio-cpu-load'
import { desktopBridge, isDesktopRenderer } from '~/lib/runtime'

// A meter reads about four times a second: fast enough to catch a spike inside the one-second peak hold,
// slow enough that the read-and-reset request stays negligible beside the audio thread's own work.
const NATIVE_SAMPLE_INTERVAL_MS = 250

type RenderCapacity = {
  start: (options: { updateInterval: number }) => void
  stop: () => void
  addEventListener: (type: 'update', listener: (event: Event) => void) => void
  removeEventListener: (type: 'update', listener: (event: Event) => void) => void
}

const isRenderCapacity = (value: unknown): value is RenderCapacity => (
  typeof value === 'object' && value !== null
  && 'start' in value && typeof value.start === 'function'
  && 'stop' in value && typeof value.stop === 'function'
  && 'addEventListener' in value && typeof value.addEventListener === 'function'
  && 'removeEventListener' in value && typeof value.removeEventListener === 'function'
)

const browserHasRenderCapacity = () => typeof AudioContext !== 'undefined' && 'renderCapacity' in AudioContext.prototype

const renderCapacityOf = (context: AudioContext | undefined) => {
  if (!context || !('renderCapacity' in context)) return undefined

  return isRenderCapacity(context.renderCapacity) ? context.renderCapacity : undefined
}

const renderCapacityUpdateSchema = z.object({ averageLoad: z.number(), peakLoad: z.number() })

const loadFromUpdate = (event: Event): AudioCpuLoad | undefined => {
  const update = renderCapacityUpdateSchema.safeParse(event)

  return update.success ? { average: update.data.averageLoad, current: update.data.peakLoad } : undefined
}

/** The desktop host measures its own callbacks; a browser without AudioContext.renderCapacity has no honest reading, so no meter. */
export const cpuLoadSourceKind = () => {
  if (isDesktopRenderer() && desktopBridge()?.audioHost) return 'native'

  return browserHasRenderCapacity() ? 'render-capacity' : undefined
}

type CpuLoadSourceKind = NonNullable<ReturnType<typeof cpuLoadSourceKind>>

const startNativeSampling = (onLoad: (load: AudioCpuLoad) => void) => {
  const audioHost = desktopBridge()?.audioHost
  let timer: ReturnType<typeof setInterval> | undefined
  let inFlight = false
  let stopped = false

  const sample = async () => {
    if (inFlight || !audioHost) return
    inFlight = true

    try {
      const reply = await audioHost.cpuLoad()

      if (!stopped && reply.ok) onLoad(reply.load ? cpuLoadFromNativeSample(reply.load) : { average: 0, current: 0 })
    } catch {
      // The host went away between reads; the next tick tries again.
    } finally {
      inFlight = false
    }
  }

  // A hidden window has nobody to show the meter to, so the timer stops until it is visible again.
  const syncTimer = () => {
    if (document.hidden) {
      clearInterval(timer)
      timer = undefined
    } else if (timer === undefined) {
      timer = setInterval(() => void sample(), NATIVE_SAMPLE_INTERVAL_MS)
    }
  }

  document.addEventListener('visibilitychange', syncTimer)
  syncTimer()

  return () => {
    stopped = true
    document.removeEventListener('visibilitychange', syncTimer)
    clearInterval(timer)
  }
}

const startRenderCapacitySampling = (onLoad: (load: AudioCpuLoad) => void) => {
  const engine = getAudioEngine()
  let attached: { capacity: RenderCapacity, listener: (event: Event) => void } | undefined

  const detach = () => {
    if (!attached) return
    attached.capacity.removeEventListener('update', attached.listener)
    attached.capacity.stop()
    attached = undefined
  }

  // The context exists only after the engine's first user-gesture start and is replaced by a new runtime.
  const attach = () => {
    const capacity = renderCapacityOf(engine.getAudioContext() ?? undefined)

    if (capacity === attached?.capacity) return
    detach()

    if (!capacity) return

    const listener = (event: Event) => {
      const load = loadFromUpdate(event)

      if (load) onLoad(load)
    }

    capacity.addEventListener('update', listener)
    capacity.start({ updateInterval: 0.25 })
    attached = { capacity, listener }
  }

  const unsubscribe = engine.subscribeRuntimeSnapshot(attach)
  attach()

  return () => {
    unsubscribe()
    detach()
  }
}

/** Starts feeding `onLoad`; the returned function stops it. */
export const startCpuLoadSampling = (kind: CpuLoadSourceKind, onLoad: (load: AudioCpuLoad) => void) => (
  kind === 'native' ? startNativeSampling(onLoad) : startRenderCapacitySampling(onLoad)
)
