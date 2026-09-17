import { expect, test } from 'bun:test'

test('runs the timeline viewport regression with Solid browser conditions', () => {
  const result = Bun.spawnSync({
    cmd: ['bun', 'test', '--conditions=browser', new URL('./useTimelineViewport.browser-test.ts', import.meta.url).pathname],
    stdout: 'pipe',
    stderr: 'pipe',
  })
  expect(result.exitCode).toBe(0)
})
