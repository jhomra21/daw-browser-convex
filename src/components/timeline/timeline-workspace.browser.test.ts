import { expect, test } from 'bun:test'
import { mkdir, rm } from 'node:fs/promises'
import { z } from 'zod'

const runtimePath = new URL('./timeline-workspace.browser-runtime.ts', import.meta.url).pathname

const browserCommand = async (session: string, args: readonly string[]) => {
  const process = Bun.spawn(['agent-browser', '--session', session, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ])
  const exitCode = await process.exited
  if (exitCode !== 0) throw new Error(stderr || stdout)
  return stdout.trim()
}

const timelineSampleSchema = z.object({
  scrollLeft: z.number(),
  viewportLeft: z.number(),
  viewportRight: z.number(),
  surfaceLeft: z.number(),
  surfaceRight: z.number(),
  rulerPresent: z.boolean(),
  lanePresent: z.boolean(),
  overviewPresent: z.boolean(),
  visibleStartSec: z.number(),
  pixelsPerSecond: z.number(),
  rulerMajorPhasePx: z.number(),
  gridMinorPhasePx: z.number(),
  gridMajorPhasePx: z.number(),
  rulerMajorSpacingPx: z.number(),
  gridMinorSpacingPx: z.number(),
  gridMajorSpacingPx: z.number(),
})

const timelineWorkspaceRegressionSchema = z.object({
  coldMount: z.array(timelineSampleSchema),
  pinnedScroll: z.array(timelineSampleSchema),
  pinnedMaxAttachmentError: z.number(),
  runwayWidth: z.number(),
  activeNativeScrollFrames: z.array(timelineSampleSchema),
  recenterSameLogicalViewport: z.array(timelineSampleSchema),
  sameLogicalViewportPhysicalProxies: z.array(timelineSampleSchema),
  panZoomSequence: z.array(timelineSampleSchema),
  fixedLogicalPan: z.array(timelineSampleSchema),
  coldMountExpected: timelineSampleSchema,
  canonicalMinorSpacingPx: z.number(),
  canonicalMajorSpacingPx: z.number(),
  activeNativeExpectedPhases: z.array(z.number()),
  fixedLogicalPanExpectedDeltaPx: z.number(),
  panZoomExpectedPhases: z.array(z.number()),
})

const browserOutputSchema = z.union([
  z.string().transform((value) => timelineWorkspaceRegressionSchema.parse(JSON.parse(value))),
  timelineWorkspaceRegressionSchema,
])

test('keeps the mounted timeline surface pinned through runway scrolling', async () => {
  const temporaryRoot = `${process.env.TMPDIR ?? '/tmp'}/daw-timeline-workspace-${crypto.randomUUID()}`
  await mkdir(temporaryRoot, { recursive: true })
  const build = await Bun.build({
    entrypoints: [runtimePath],
    target: 'browser',
    format: 'esm',
    outdir: temporaryRoot,
    naming: 'timeline.js',
  })
  expect(build.success).toBe(true)
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname
      if (path === '/') {
        return new Response(
          '<!doctype html><meta name="viewport" content="width=device-width"><script type="module" src="/timeline.js"></script>',
          { headers: { 'content-type': 'text/html' } },
        )
      }
      if (path === '/timeline.js') {
        return new Response(Bun.file(`${temporaryRoot}/timeline.js`), {
          headers: { 'content-type': 'text/javascript' },
        })
      }
      return new Response('Not found', { status: 404 })
    },
  })
  const session = `daw-timeline-workspace-${crypto.randomUUID()}`
  try {
    await browserCommand(session, ['open', server.url.toString()])
    await browserCommand(session, ['wait', '3000'])
    const output = await browserCommand(session, [
      'eval',
      'JSON.stringify(window.__timelineWorkspaceRegressionResult)',
    ])
    const result = browserOutputSchema.parse(JSON.parse(output))
    expect(result.runwayWidth).toBe(200_000)
    expect(result.coldMount).toHaveLength(2)
    expect(result.coldMount.every((sample) => (
      Math.abs(sample.surfaceLeft - sample.viewportLeft) <= 0.5
        && Math.abs(sample.surfaceRight - sample.viewportRight) <= 0.5
        && sample.rulerPresent
        && sample.lanePresent
        && sample.overviewPresent
    ))).toBe(true)
    expect(result.coldMount.every((sample) => (
      sample.rulerMajorPhasePx === sample.gridMajorPhasePx
        && sample.rulerMajorPhasePx === result.coldMountExpected.rulerMajorPhasePx
        && sample.gridMinorSpacingPx > 0
        && sample.gridMajorSpacingPx > sample.gridMinorSpacingPx
        && sample.rulerMajorSpacingPx === sample.gridMajorSpacingPx
        && sample.gridMinorSpacingPx === result.canonicalMinorSpacingPx
        && sample.gridMajorSpacingPx === result.canonicalMajorSpacingPx
    ))).toBe(true)
    expect(result.fixedLogicalPan[1]?.rulerMajorPhasePx)
      .toBe(result.fixedLogicalPan[0]?.rulerMajorPhasePx + result.fixedLogicalPanExpectedDeltaPx)
    expect(result.fixedLogicalPan.every((sample) => (
      sample.rulerMajorPhasePx === sample.gridMajorPhasePx
    ))).toBe(true)
    expect(result.pinnedScroll.length).toBe(7)
    expect(result.pinnedMaxAttachmentError).toBeLessThanOrEqual(0.5)
    expect(result.pinnedScroll.every((sample) => (
      Math.abs(sample.surfaceLeft - sample.viewportLeft) <= 0.5
        && Math.abs(sample.surfaceRight - sample.viewportRight) <= 0.5
    ))).toBe(true)
    expect(result.pinnedScroll.every((sample) => (
      sample.rulerMajorPhasePx === sample.gridMajorPhasePx
    ))).toBe(true)
    expect(result.activeNativeScrollFrames.length).toBe(4)
    expect(result.activeNativeScrollFrames.every((sample, index, frames) => (
      Math.abs(sample.surfaceLeft - sample.viewportLeft) <= 0.5
        && Math.abs(sample.surfaceRight - sample.viewportRight) <= 0.5
        && sample.rulerMajorPhasePx === sample.gridMajorPhasePx
        && (index === 0
          || sample.visibleStartSec !== frames[index - 1]?.visibleStartSec)
    ))).toBe(true)
    expect(result.activeNativeScrollFrames.map((sample) => sample.rulerMajorPhasePx))
      .toEqual(result.activeNativeExpectedPhases)
    expect(result.activeNativeScrollFrames.every((sample, index, frames) => (
      index === 0
        || sample.rulerMajorPhasePx !== frames[index - 1]?.rulerMajorPhasePx
    ))).toBe(true)
    expect(result.recenterSameLogicalViewport[0]?.rulerMajorPhasePx)
      .toBe(result.recenterSameLogicalViewport[1]?.rulerMajorPhasePx)
    expect(result.recenterSameLogicalViewport[0]?.gridMajorPhasePx)
      .toBe(result.recenterSameLogicalViewport[1]?.gridMajorPhasePx)
    expect(result.sameLogicalViewportPhysicalProxies[0]?.rulerMajorPhasePx)
      .toBe(result.sameLogicalViewportPhysicalProxies[1]?.rulerMajorPhasePx)
    expect(result.sameLogicalViewportPhysicalProxies[0]?.gridMajorPhasePx)
      .toBe(result.sameLogicalViewportPhysicalProxies[1]?.gridMajorPhasePx)
    expect(result.panZoomSequence.map((sample) => sample.rulerMajorPhasePx))
      .toEqual(result.panZoomExpectedPhases)
    expect(result.panZoomSequence.every((sample) => (
      sample.rulerMajorPhasePx === sample.gridMajorPhasePx
        && sample.rulerMajorSpacingPx === sample.gridMajorSpacingPx
    ))).toBe(true)
  } finally {
    await browserCommand(session, ['close']).catch(() => undefined)
    server.stop(true)
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})
