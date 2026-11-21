type InstalledGlobals = {
  window?: object | undefined
  document?: object
  navigator?: object
  localStorage?: object
  HTMLElement?: object
  PointerEvent?: object
}

// Installs globals for one test and returns a function that puts every one back, deleting those that did not exist.
// A value of undefined removes the global for the test. Bun has no global window; assigning one by value would leave a
// non-writable property behind for later files.
export const installGlobals = (values: InstalledGlobals) => {
  const previous = Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const)

  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key)
    else Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }

  return () => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
}
