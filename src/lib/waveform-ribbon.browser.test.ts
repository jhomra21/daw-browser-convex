import { expect, test } from 'bun:test'
import { mkdir, rm } from 'node:fs/promises'
import { z } from 'zod'

type RasterMeasurement = {
  readonly darkestLuminance: number
  readonly darkestColorDistance: number
  readonly fullyCoveredBackingRows: number
  readonly effectiveBackingThickness: number
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
  readonly fractionalCoverage: readonly {
    readonly dpr: number
    readonly fraction: number
    readonly darkestLuminance: number
    readonly fullyCoveredBackingRows: number
  }[]
  readonly floorExperiments: readonly {
    readonly dpr: number
    readonly floorCssPx: number
    readonly floorLabel: string
    readonly medianDarkestLuminance: number
    readonly luminanceSpread: number
    readonly phasePulse: number
    readonly medianEffectiveBackingThickness: number
    readonly effectiveThicknessSpread: number
    readonly minimumEffectiveBackingThickness: number
    readonly maximumEffectiveBackingThickness: number
    readonly minimumDarkestLuminance: number
    readonly maximumDarkestLuminance: number
  }[]
  readonly geometryDiagnostics: readonly {
    readonly dpr: number
    readonly zoom: number
    readonly sourceFrame: number
    readonly framesPerInterval: number
    readonly tier: number
    readonly generation: number
    readonly paintIdentity: string
    readonly rawCenter: number
    readonly finalCenter: number
    readonly rawThickness: number
    readonly finalThickness: number
  }[]
}

const rasterMeasurementSchema = z.object({
  darkestLuminance: z.number(),
  darkestColorDistance: z.number(),
  fullyCoveredBackingRows: z.number(),
  effectiveBackingThickness: z.number(),
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
  fractionalCoverage: z.array(z.object({
    dpr: z.number(),
    fraction: z.number(),
    darkestLuminance: z.number(),
    fullyCoveredBackingRows: z.number(),
  })),
  floorExperiments: z.array(z.object({
    dpr: z.number(),
    floorCssPx: z.number(),
    floorLabel: z.string(),
    medianDarkestLuminance: z.number(),
    luminanceSpread: z.number(),
    phasePulse: z.number(),
    medianEffectiveBackingThickness: z.number(),
    effectiveThicknessSpread: z.number(),
    minimumEffectiveBackingThickness: z.number(),
    maximumEffectiveBackingThickness: z.number(),
    minimumDarkestLuminance: z.number(),
    maximumDarkestLuminance: z.number(),
  })),
  geometryDiagnostics: z.array(z.object({
    dpr: z.number(),
    zoom: z.number(),
    sourceFrame: z.number(),
    framesPerInterval: z.number(),
    tier: z.number(),
    generation: z.number(),
    paintIdentity: z.string(),
    rawCenter: z.number(),
    finalCenter: z.number(),
    rawThickness: z.number(),
    finalThickness: z.number(),
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

test('rasterizes the shared CSS floor and raw-center geometry consistently in Chromium', async () => {
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

  expect(luminanceSpread).toBeLessThanOrEqual(legacyLuminanceSpread)
  expect(colorDistanceSpread).toBeLessThanOrEqual(legacyColorDistanceSpread)
  expect(maxPhaseLuminanceSpread(alignedLuminances))
    .toBeLessThanOrEqual(maxPhaseLuminanceSpread(legacyLuminances))
  expect(maxAdjacentThresholdLuminanceSpread(alignedLuminances))
    .toBeLessThanOrEqual(maxAdjacentThresholdLuminanceSpread(legacyLuminances))
  expect(result.aligned.every((measurement) => measurement.darkestColorDistance > 0)).toBe(true)
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
  expect(result.fractionalCoverage).toHaveLength(30)
  for (const dpr of [1, 2, 3]) {
    const samples = result.fractionalCoverage.filter((sample) => sample.dpr === dpr)
    expect(samples.map((sample) => sample.fraction)).toEqual(
      [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9],
    )
    expect(samples.every((sample) => Number.isFinite(sample.darkestLuminance))).toBe(true)
    expect(samples.every((sample) => sample.fullyCoveredBackingRows >= 0)).toBe(true)
  }
  expect(result.floorExperiments).toHaveLength(12)
  expect(result.floorExperiments.every((experiment) => (
    experiment.luminanceSpread >= 0
      && experiment.minimumDarkestLuminance <= experiment.maximumDarkestLuminance
      && experiment.phasePulse === experiment.luminanceSpread
      && experiment.medianEffectiveBackingThickness >= 0
      && experiment.effectiveThicknessSpread >= 0
      && experiment.minimumEffectiveBackingThickness
        <= experiment.maximumEffectiveBackingThickness
  ))).toBe(true)
  for (const dpr of [1, 2, 3]) {
    const selectedFloor = result.floorExperiments.find((experiment) => (
      experiment.dpr === dpr && experiment.floorLabel === 'two-physical-pixels'
    ))
    if (!selectedFloor) throw new Error(`Missing two-physical-pixel floor diagnostics for DPR ${dpr}`)
    expect(selectedFloor.minimumEffectiveBackingThickness)
      .toBeGreaterThanOrEqual(1.99)
    expect(selectedFloor.effectiveThicknessSpread).toBeLessThanOrEqual(0.01)
    expect(selectedFloor.luminanceSpread).toBe(0)
  }
  expect(result.geometryDiagnostics).toHaveLength(3)
  expect(result.geometryDiagnostics.every((diagnostic) => (
    Math.abs(diagnostic.finalCenter - diagnostic.rawCenter) < 1e-12
      && diagnostic.finalThickness >= diagnostic.rawThickness
      && diagnostic.paintIdentity === 'rgba(17,17,17,1)|source-over|fill'
  ))).toBe(true)
})
