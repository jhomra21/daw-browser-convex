/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof, anti-slop/no-reflect-get, anti-slop/no-object-parameters -- dotted paths address processor state of every kind, so nodes are untyped until they are walked */

const child = (node: unknown, key: string): unknown => typeof node === 'object' && node !== null ? Reflect.get(node, key) : undefined

/** Reads the number at a dotted path such as "sidechain.q" or "bands.0.frequency" from a state object. */
export const getPath = (state: object, path: string): number | undefined => {
  const value = path.split('.').reduce<unknown>(child, state)

  return typeof value === 'number' ? value : undefined
}

/** Returns a copy of the state with every path replaced; used to mirror parameter steps into the legacy worklet state. */
export const withPaths = <T extends object>(state: T, set: Readonly<Record<string, number>>): T => {
  const next = structuredClone(state)

  for (const [path, value] of Object.entries(set)) {
    const keys = path.split('.')
    const last = keys.pop()
    const parent = keys.reduce<unknown>(child, next)

    if (last === undefined || typeof parent !== 'object' || parent === null) throw new Error(`Cannot set ${path}`)
    Reflect.set(parent, last, value)
  }

  return next
}
