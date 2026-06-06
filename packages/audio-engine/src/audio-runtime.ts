import { disconnectAudioNodes } from './effects/chain'

export type AudioRuntime = {
  ctx: AudioContext
  masterGain: GainNode
  destination: AudioDestinationNode
}

export function createAudioRuntime(): AudioRuntime {
  const ctx = new AudioContext()
  const masterGain = ctx.createGain()
  masterGain.gain.value = 1.0

  return {
    ctx,
    masterGain,
    destination: ctx.destination,
  }
}

export async function decodeAudioData(runtime: AudioRuntime | null, arrayBuffer: ArrayBuffer) {
  if (runtime) return runtime.ctx.decodeAudioData(arrayBuffer)
  const offline = new OfflineAudioContext(2, 1, 44100)
  return offline.decodeAudioData(arrayBuffer)
}

export function getOutputLatencySec(runtime: AudioRuntime | null) {
  if (!runtime) return 0
  const { baseLatency = 0, outputLatency = 0 } = runtime.ctx
  const total = baseLatency + outputLatency
  return Number.isFinite(total) ? total : 0
}

export function closeAudioRuntime(runtime: AudioRuntime | null) {
  if (!runtime) return
  disconnectAudioNodes([runtime.masterGain])
  try { runtime.ctx.close() } catch {}
}
