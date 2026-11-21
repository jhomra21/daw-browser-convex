type FetchHandler = (...args: Parameters<typeof globalThis.fetch>) => Promise<Response>

// Replaces the global fetch for one test and returns a function that puts the original back.
export const installFetch = (handler: FetchHandler) => {
  const original = globalThis.fetch
  globalThis.fetch = Object.assign(handler, { preconnect: original.preconnect })

  return () => {
    globalThis.fetch = original
  }
}
