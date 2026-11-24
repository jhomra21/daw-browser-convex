import type { NativeAudioHostCpuLoad } from '@daw-browser/desktop-protocol/native-audio-host'

// Fractions of buffer time: 1 is a callback that took exactly as long as its buffer plays, above 1 it is late.
export type AudioCpuLoad = { average: number, current: number }

export const PEAK_HOLD_MS = 1000
const MAX_DISPLAY_PERCENT = 999

export const cpuLoadFromNativeSample = (sample: NativeAudioHostCpuLoad): AudioCpuLoad => ({
  average: sample.bufferNanoseconds === 0 ? 0 : sample.callbackNanoseconds / sample.bufferNanoseconds,
  current: sample.peakLoadPerMillion / 1_000_000,
})

type HeldPeak = { value: number, atMs: number }

// A spike stays visible for PEAK_HOLD_MS, then the reading falls to what the audio thread is doing now.
export const holdPeak = (held: HeldPeak, reading: number, nowMs: number): HeldPeak => (
  reading >= held.value || nowMs - held.atMs >= PEAK_HOLD_MS ? { value: reading, atMs: nowMs } : held
)

export const cpuLoadPercent = (load: number) => (
  Number.isFinite(load) ? Math.min(MAX_DISPLAY_PERCENT, Math.max(0, Math.round(load * 100))) : 0
)

export const cpuLoadValueText = (load: AudioCpuLoad) => (
  `average ${cpuLoadPercent(load.average)}%, current ${cpuLoadPercent(load.current)}%`
)
