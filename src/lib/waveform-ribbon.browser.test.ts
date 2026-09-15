import { expect, test } from 'bun:test'
import { mkdir, rm } from 'node:fs/promises'
import { z } from 'zod'

type RasterMeasurement = {
  readonly darkestLuminance: number
  readonly darkestColorDistance: number
  readonly fullyCoveredBackingRows: number
}

type RasterRegressionResult = {
  readonly aligned: readonly RasterMeasurement[]
  readonly legacy: readonly RasterMeasurement[]
  readonly samplesWithoutPoints: RasterMeasurement
  readonly samplesWithPoints: RasterMeasurement
  readonly centerRelease: readonly {
    readonly thickness: number
    readonly center: number
    readonly rawCenter: number
  }[]
}

const rasterMeasurementSchema = z.object({
  darkestLuminance: z.number(),
  darkestColorDistance: z.number(),
  fullyCoveredBackingRows: z.number(),
})

const rasterRegressionResultSchema = z.object({
  aligned: z.array(rasterMeasurementSchema),
  legacy: z.array(rasterMeasurementSchema),
  samplesWithoutPoints: rasterMeasurementSchema,
  samplesWithPoints: rasterMeasurementSchema,
  centerRelease: z.array(z.object({
    thickness: z.number(),
    center: z.number(),
    rawCenter: z.number(),
  })),
})

const browserRasterOutputSchema = z.union([
  z.string().transform((value) => rasterRegressionResultSchema.parse(JSON.parse(value))),
  rasterRegressionResultSchema,
])

const runtimePath = new URL('./waveform-ribbon.browser-runtime.ts', import.meta.url).pathname

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
  if (exitCode !== 0) {
    throw new Error(`agent-browser ${args[0] ?? 'command'} failed: ${stderr || stdout}`)
  }
  return stdout.trim()
}

const parseEvalResult = (output: string): RasterRegressionResult => {
  return browserRasterOutputSchema.parse(JSON.parse(output))
}

const measureInChromium = async (): Promise<RasterRegressionResult> => {
  const temporaryRoot = `${process.env.TMPDIR ?? '/tmp'}/daw-waveform-raster-${crypto.randomUUID()}`
  await mkdir(temporaryRoot, { recursive: true })
  const build = await Bun.build({
    entrypoints: [runtimePath],
    target: 'browser',
    format: 'esm',
    outdir: temporaryRoot,
    naming: 'raster.js',
  })
  if (!build.success) {
    throw new Error(build.logs.map((log) => log.message).join('\n'))
  }
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname
      if (path === '/') {
        return new Response(
          '<!doctype html><script type="module" src="/raster.js"></script>',
          { headers: { 'content-type': 'text/html' } },
        )
      }
      if (path === '/raster.js') {
        return new Response(Bun.file(`${temporaryRoot}/raster.js`), {
          headers: { 'content-type': 'text/javascript' },
        })
      }
      return new Response('Not found', { status: 404 })
    },
  })
  const session = `daw-waveform-raster-${crypto.randomUUID()}`
  try {
    await browserCommand(session, ['open', server.url.toString()])
    await browserCommand(session, ['wait', '100'])
    const output = await browserCommand(session, [
      'eval',
      'JSON.stringify(window.__waveformRasterRegressionResult)',
    ])
    return parseEvalResult(output)
  } finally {
    await browserCommand(session, ['close']).catch(() => undefined)
    server.stop(true)
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

test('rasterizes the globally minimum physical thickness consistently in Chromium', async () => {
  const result = await measureInChromium()
  const alignedLuminances = result.aligned.map((measurement) => measurement.darkestLuminance)
  const alignedDistances = result.aligned.map((measurement) => measurement.darkestColorDistance)
  const legacyLuminances = result.legacy.map((measurement) => measurement.darkestLuminance)
  const legacyDistances = result.legacy.map((measurement) => measurement.darkestColorDistance)
  const luminanceSpread = Math.max(...alignedLuminances) - Math.min(...alignedLuminances)
  const colorDistanceSpread = Math.max(...alignedDistances) - Math.min(...alignedDistances)
  const legacyLuminanceSpread = Math.max(...legacyLuminances) - Math.min(...legacyLuminances)
  const legacyColorDistanceSpread = Math.max(...legacyDistances) - Math.min(...legacyDistances)
  const maxPhaseLuminanceSpread = (values: readonly number[]) => {
    let maximum = 0
    for (let dprIndex = 0; dprIndex < 3; dprIndex += 1) {
      for (let thicknessIndex = 0; thicknessIndex < 21; thicknessIndex += 1) {
        const start = dprIndex * 126 + thicknessIndex * 6
        maximum = Math.max(
          maximum,
          Math.max(...values.slice(start, start + 6))
            - Math.min(...values.slice(start, start + 6)),
        )
      }
    }
    return maximum
  }
  const maxAdjacentThresholdLuminanceSpread = (values: readonly number[]) => {
    let maximum = 0
    for (let dprIndex = 0; dprIndex < 3; dprIndex += 1) {
      for (let thicknessIndex = 1; thicknessIndex < 21; thicknessIndex += 1) {
        for (let phaseIndex = 0; phaseIndex < 6; phaseIndex += 1) {
          const current = values[dprIndex * 126 + thicknessIndex * 6 + phaseIndex] ?? 0
          const previous = values[dprIndex * 126 + (thicknessIndex - 1) * 6 + phaseIndex] ?? 0
          maximum = Math.max(maximum, Math.abs(current - previous))
        }
      }
    }
    return maximum
  }

  expect(luminanceSpread).toBeLessThanOrEqual(0.5)
  expect(colorDistanceSpread).toBeLessThanOrEqual(0.5)
  expect(maxPhaseLuminanceSpread(alignedLuminances)).toBeLessThanOrEqual(0.5)
  expect(maxAdjacentThresholdLuminanceSpread(alignedLuminances)).toBeLessThanOrEqual(0.5)
  expect(result.aligned.every((measurement) => measurement.fullyCoveredBackingRows >= 1)).toBe(true)
  expect(legacyLuminanceSpread).toBeGreaterThan(50)
  expect(legacyColorDistanceSpread).toBeGreaterThan(100)
  expect(maxPhaseLuminanceSpread(legacyLuminances)).toBeGreaterThan(50)
  expect(maxAdjacentThresholdLuminanceSpread(legacyLuminances)).toBeGreaterThan(50)
  expect(result.samplesWithPoints.darkestLuminance).toBe(result.samplesWithoutPoints.darkestLuminance)
  expect(result.samplesWithPoints.darkestColorDistance).toBe(result.samplesWithoutPoints.darkestColorDistance)
  expect(result.samplesWithPoints.fullyCoveredBackingRows).toBe(
    result.samplesWithoutPoints.fullyCoveredBackingRows,
  )
  const centerJumps = result.centerRelease
    .filter((sample) => sample.rawCenter === 8.25)
    .map((sample, index, samples) => (
      index === 0 ? 0 : Math.abs(sample.center - (samples[index - 1]?.center ?? sample.center))
    ))
  const maxCenterJump = Math.max(...centerJumps)
  expect(maxCenterJump).toBeLessThan(0.25)
  expect(result.centerRelease
    .filter((sample) => sample.thickness === 4)
    .every((sample) => sample.center === sample.rawCenter))
    .toBe(true)
})
