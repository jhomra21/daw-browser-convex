import type { TransportClock } from './transport-clock'
import { disconnectAudioNodes } from './effects/chain'
import { stopAndDisconnectSource } from './source-registry'

const createMetronomeBuffer = (ctx: AudioContext) => {
  const durationSec = 0.06
  const sampleRate = ctx.sampleRate
  const totalSamples = Math.max(1, Math.floor(durationSec * sampleRate))
  const buffer = ctx.createBuffer(1, totalSamples, sampleRate)
  const data = buffer.getChannelData(0)
  const attackSamples = Math.floor(sampleRate * 0.002)
  const decaySamples = totalSamples - attackSamples
  for (let i = 0; i < totalSamples; i++) {
    if (i < attackSamples) {
      data[i] = i / Math.max(1, attackSamples)
    } else {
      const t = (i - attackSamples) / Math.max(1, decaySamples)
      data[i] = Math.pow(1 - t, 3)
    }
  }
  return buffer
}

export function createMetronomeRuntime(clock: TransportClock) {
  let enabled = false
  let gain: GainNode | null = null
  let buffer: AudioBuffer | null = null
  let schedulerId: number | null = null
  let nextBeatTimelineSec: number | null = null
  let sources: AudioBufferSourceNode[] = []
  const lookaheadSec = 0.25
  const intervalMs = 50

  const ensureNodes = (ctx: AudioContext, masterGain: GainNode) => {
    if (!gain) {
      gain = ctx.createGain()
      gain.gain.value = 0.35
      gain.connect(masterGain)
    }
    if (!buffer) buffer = createMetronomeBuffer(ctx)
  }

  const computeNextBeatTimelineSec = (fromTimelineSec: number) => {
    const epsilon = 1e-6
    const spb = clock.secondsPerBeat()
    if (!isFinite(spb) || spb <= 0) return fromTimelineSec
    const beats = Math.ceil((fromTimelineSec - epsilon) / spb)
    return Math.max(0, beats) * spb
  }

  const reset = () => {
    nextBeatTimelineSec = null
    for (const source of sources) {
      stopAndDisconnectSource(source)
    }
    sources = []
  }

  const scheduleTicks = (ctx: AudioContext) => {
    if (!enabled || !clock.isRunning() || !gain || !buffer) return
    const nowCtx = ctx.currentTime
    const scheduleUntil = nowCtx + lookaheadSec
    const spb = clock.secondsPerBeat()
    if (!isFinite(spb) || spb <= 0) return

    let nextTimelineBeat = nextBeatTimelineSec
    if (nextTimelineBeat === null) {
      const nowTimeline = clock.ctxTimeToTimeline(nowCtx)
      nextTimelineBeat = computeNextBeatTimelineSec(nowTimeline)
    }

    let iterations = 0
    while (iterations < 128 && nextTimelineBeat !== null) {
      iterations += 1
      const eventCtxTime = clock.timelineToCtxTime(nextTimelineBeat)
      if (eventCtxTime > scheduleUntil + 1e-3) break
      if (eventCtxTime >= nowCtx - 0.02) {
        const source = ctx.createBufferSource()
        source.buffer = buffer
        source.connect(gain)
        source.start(eventCtxTime)
        source.onended = () => {
          const index = sources.indexOf(source)
          if (index >= 0) sources.splice(index, 1)
        }
        sources.push(source)
      }
      nextTimelineBeat += spb
      if (nextTimelineBeat < 0) break
    }

    nextBeatTimelineSec = nextTimelineBeat
  }

  const clearIntervalHandle = () => {
    if (schedulerId !== null) {
      clearInterval(schedulerId)
      schedulerId = null
    }
  }

  const setIntervalHandle = (ctx: AudioContext) => {
    if (schedulerId !== null) return
    schedulerId = setInterval(() => {
      try {
        scheduleTicks(ctx)
      } catch (err) {
        console.error('[AudioEngine] metronome scheduling error', err)
      }
    }, intervalMs) as unknown as number
  }

  return {
    setEnabled: (next: boolean, ctx: AudioContext, masterGain: GainNode) => {
      enabled = next
      if (!enabled) {
        clearIntervalHandle()
        reset()
        return
      }
      ensureNodes(ctx, masterGain)
      nextBeatTimelineSec = null
      if (clock.isRunning()) {
        scheduleTicks(ctx)
        setIntervalHandle(ctx)
      }
    },
    onTransportStart: (ctx: AudioContext, masterGain: GainNode) => {
      ensureNodes(ctx, masterGain)
      reset()
      if (enabled) {
        scheduleTicks(ctx)
        setIntervalHandle(ctx)
      }
    },
    onTransportPause: () => {
      reset()
      clearIntervalHandle()
    },
    onTransportSeek: (ctx: AudioContext, shouldReset: boolean) => {
      if (shouldReset && enabled && clock.isRunning()) {
        reset()
        scheduleTicks(ctx)
      }
    },
    onBpmChange: (ctx: AudioContext | null) => {
      if (!ctx || !enabled || !clock.isRunning()) return
      reset()
      scheduleTicks(ctx)
    },
    reset,
    close: () => {
      clearIntervalHandle()
      reset()
      disconnectAudioNodes([gain])
      gain = null
      buffer = null
    },
  }
}
