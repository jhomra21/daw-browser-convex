import { expect, test } from 'bun:test'
import { mkdir, rm } from 'node:fs/promises'
import { build } from 'vite'
import solidPlugin from 'vite-plugin-solid'
import { z } from 'zod'

test('dense-track resize keeps its bounds and does not rescan clips per move', async () => {
  const directory = `/tmp/daw-clip-resize-${crypto.randomUUID()}`
  const session = `daw-clip-resize-${crypto.randomUUID()}`
  const browser = async (...args: string[]) => {
    const env = { ...process.env }
    delete env.AGENT_BROWSER_CDP
    delete env.AGENT_BROWSER_SESSION
    const child = Bun.spawn(['agent-browser', '--session', session, ...args], {
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (await child.exited !== 0) throw new Error(stderr || stdout)
    return stdout.trim()
  }
  await mkdir(directory, { recursive: true })
  try {
    const repositoryRoot = new URL('../../', import.meta.url).pathname
    const result = await build({
      root: repositoryRoot,
      configFile: false,
      logLevel: 'silent',
      plugins: [solidPlugin()],
      resolve: { alias: { '~': `${repositoryRoot}src` } },
      build: {
        write: false,
        minify: false,
        lib: {
          entry: new URL('./useClipResize.browser-runtime.ts', import.meta.url).pathname,
          formats: ['iife'],
          name: 'clipResizeFixture',
        },
      },
    })
    const output = Array.isArray(result) ? result[0] : result
    if (!output || !('output' in output)) throw new Error('Expected a single clip resize fixture bundle.')
    const bundle = output.output.find((chunk) => chunk.type === 'chunk')?.code
    expect(bundle).toBeDefined()
    await Bun.write(`${directory}/index.html`, `<!doctype html><body><script>${bundle ?? ''}</script>`)
    await browser('open', `file://${directory}/index.html`)
    await browser('wait', '--fn', '!!window.__clipResizeDenseResult')
    const resultOutput = await browser('eval', 'JSON.stringify(window.__clipResizeDenseResult)')
    const actual = z.object({
      constraintComputations: z.number(),
      noDraftConstraintComputations: z.number(),
      duration: z.number(),
      committedDuration: z.number(),
      projectionUpdates: z.number(),
      isResizing: z.boolean(),
      insertedNeighborDuration: z.number(),
      removedNeighborDuration: z.number(),
      reorderedTrackDuration: z.number(),
      snappedLeftStartSec: z.number(),
      snappedLeftDuration: z.number(),
      snappedRightDuration: z.number(),
      canceledStartSec: z.number(),
      canceledDuration: z.number(),
      cancelDidNotCommit: z.boolean(),
      dialogEscapeDoesNotCancelResize: z.boolean(),
      removedTrackDoesNotCommit: z.boolean(),
      removedTrackClearsDraft: z.boolean(),
      removedTrackEndsResize: z.boolean(),
      leftResizeWithRemoteNeighborStartSec: z.number(),
    }).parse(JSON.parse(JSON.parse(resultOutput)))
    expect(actual.constraintComputations).toBe(4)
    expect(actual.noDraftConstraintComputations).toBe(0)
    expect(actual.projectionUpdates).toBeGreaterThan(1)
    expect(actual.duration).toBeGreaterThan(1.99)
    expect(actual.duration).toBeLessThan(2)
    expect(actual.committedDuration).toBe(actual.duration)
    expect(actual.isResizing).toBe(false)
    expect(actual.insertedNeighborDuration).toBeCloseTo(1.9999, 3)
    expect(actual.removedNeighborDuration).toBeCloseTo(3.9999, 3)
    expect(actual.reorderedTrackDuration).toBeCloseTo(6.9999, 3)
    expect(actual.snappedLeftStartSec).toBeCloseTo(20_001.5, 5)
    expect(actual.snappedLeftDuration).toBeCloseTo(0.5, 5)
    expect(actual.snappedRightDuration).toBeCloseTo(2.5, 5)
    expect(actual.canceledStartSec).toBe(20_000)
    expect(actual.canceledDuration).toBe(2)
    expect(actual.cancelDidNotCommit).toBe(true)
    expect(actual.dialogEscapeDoesNotCancelResize).toBe(true)
    expect(actual.removedTrackDoesNotCommit).toBe(true)
    expect(actual.removedTrackClearsDraft).toBe(true)
    expect(actual.removedTrackEndsResize).toBe(true)
    expect(actual.leftResizeWithRemoteNeighborStartSec).toBeCloseTo(19_999.5001, 5)
  } finally {
    await browser('close').catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
}, 60_000)
