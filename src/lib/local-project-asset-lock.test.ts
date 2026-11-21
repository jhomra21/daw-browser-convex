import { expect, test } from 'bun:test'
import { withLocalProjectAssetLock } from './local-project-asset-lock'
import { installGlobals } from '~/test-support/install-globals'

test('fails closed in a browser without Web Locks', async () => {
  const restoreGlobals = installGlobals({ window: globalThis })
  const locksDescriptor = Object.getOwnPropertyDescriptor(navigator, 'locks')
  Reflect.deleteProperty(navigator, 'locks')

  try {
    let ran = false
    await expect(withLocalProjectAssetLock('browser-no-locks', async () => {
      ran = true
    })).rejects.toThrow('Web Locks are required')
    expect(ran).toBe(false)
  } finally {
    restoreGlobals()

    if (locksDescriptor) Object.defineProperty(navigator, 'locks', locksDescriptor)
    else Reflect.deleteProperty(navigator, 'locks')
  }
})

test('serializes same-project work without a browser', async () => {
  const restoreGlobals = installGlobals({ window: undefined })
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
    restoreGlobals()
  }
})
