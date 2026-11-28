export const abortableSleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  try {
    signal?.throwIfAborted()
  } catch (error) {
    reject(error)

    return
  }

  const abort = () => {
    clearTimeout(timer)
    reject(signal?.reason)
  }

  const timer = setTimeout(() => {
    signal?.removeEventListener('abort', abort)
    resolve()
  }, ms)

  signal?.addEventListener('abort', abort, { once: true })
})
