import { createEffect, createSignal } from 'solid-js'
import { holdPeak, type AudioCpuLoad } from '~/lib/audio-cpu-load'
import { cpuLoadSourceKind, startCpuLoadSampling } from '~/lib/audio-cpu-load-source'

// The latest reading, with the current load held so a spike stays readable. Samples only while `enabled`.
export function useAudioCpuLoad(enabled: () => boolean) {
  const [load, setLoad] = createSignal<AudioCpuLoad>({ average: 0, current: 0 })
  let held = { value: 0, atMs: 0 }

  createEffect(
    () => enabled() ? cpuLoadSourceKind() : undefined,
    (kind) => {
      if (!kind) return
      held = { value: 0, atMs: 0 }

      return startCpuLoadSampling(kind, (reading) => {
        held = holdPeak(held, reading.current, performance.now())
        setLoad({ average: reading.average, current: held.value })
      })
    },
  )

  return load
}
