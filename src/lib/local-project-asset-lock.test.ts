import { expect, test } from 'bun:test'
import { withLocalProjectAssetLock } from './local-project-asset-lock'

test('fails closed in a browser without Web Locks', async () => {
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const locksDescriptor = Object.getOwnPropertyDescriptor(navigator, 'locks')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: globalThis })
  Reflect.deleteProperty(navigator, 'locks')
  try {
    let ran = false
    await expect(withLocalProjectAssetLock('browser-no-locks', async () => {
      ran = true
    })).rejects.toThrow('Web Locks are required')
    expect(ran).toBe(false)
  } finally {
    if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor)
    else Reflect.deleteProperty(globalThis, 'window')
    if (locksDescriptor) Object.defineProperty(navigator, 'locks', locksDescriptor)
    else Reflect.deleteProperty(navigator, 'locks')
  }
})

test('serializes same-project work without a browser', async () => {
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Reflect.deleteProperty(globalThis, 'window')
  const order: string[] = []
  try {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const first = withLocalProjectAssetLock('nonbrowser-lock', async () => {
      order.push('first-start')
      await gate
      order.push('first-end')
    })
    const second = withLocalProjectAssetLock('nonbrowser-lock', async () => {
      order.push('second')
    })
    await Promise.resolve()
    expect(order).toEqual(['first-start'])
    release()
    await Promise.all([first, second])
    expect(order).toEqual(['first-start', 'first-end', 'second'])
  } finally {
    if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor)
  }
})
