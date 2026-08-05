export type EqFrameScheduler = {
  request: (callback: (time: number) => void) => number
  cancel: (id: number) => void
}

export const createOneShotEqFrameScheduler = (
  scheduler: EqFrameScheduler,
  draw: (time: number) => void,
) => {
  let pending: number | null = null

  const invalidate = () => {
    if (pending !== null) return
    pending = scheduler.request((time) => {
      pending = null
      draw(time)
    })
  }

  const dispose = () => {
    if (pending === null) return
    scheduler.cancel(pending)
    pending = null
  }

  return { invalidate, dispose }
}

/**
 * A fixed-radius moving average keeps spectrum smoothing bounded and linear.
 * The caller owns the reusable output buffer so pointer and display frames do
 * not allocate. The injected scheduler is likewise cancelled by the owner.
 */
export const smoothSpectrumLinear = (
  values: Float32Array,
  output: Float32Array,
  radius: number,
) => {
  if (output.length !== values.length) throw new Error('Spectrum buffers must have equal lengths.')
  if (values.length === 0) return output
  const boundedRadius = Math.max(0, Math.floor(radius))
  let sum = 0
  let left = 0
  let right = -1
  for (let index = 0; index < values.length; index++) {
    const nextRight = Math.min(values.length - 1, index + boundedRadius)
    while (right < nextRight) {
      right += 1
      sum += values[right] ?? 0
    }
    const nextLeft = Math.max(0, index - boundedRadius)
    while (left < nextLeft) {
      sum -= values[left] ?? 0
      left += 1
    }
    output[index] = sum / (right - left + 1)
  }
  return output
}
