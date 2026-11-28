type FetchHandler = (...args: Parameters<typeof globalThis.fetch>) => Promise<Response>

// Replaces the global fetch for one test and returns a function that puts the original back. The original property
// may be an accessor (convex-test installs one), so it is restored by descriptor, never by value.
export const installFetch = (handler: FetchHandler) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'fetch')
  const { preconnect } = globalThis.fetch

  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value: Object.assign(handler, { preconnect }),
  })

  return () => {
    if (original) Object.defineProperty(globalThis, 'fetch', original)
    else Reflect.deleteProperty(globalThis, 'fetch')
  }
}
