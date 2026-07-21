import { describe, expect, test } from 'bun:test'

describe('useTimelineMixerController', () => {
  test('runs the reactive controller regression with Solid browser conditions', () => {
    const result = Bun.spawnSync({
      cmd: ['bun', 'test', '--conditions=browser', new URL('./useTimelineMixerController.browser-test.ts', import.meta.url).pathname],
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(result.exitCode).toBe(0)
  })
})
