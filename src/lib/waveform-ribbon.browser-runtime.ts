import {
  drawWaveformSignal,
  minimumWaveformThicknessCssPx,
  waveformRibbonGeometry,
} from '@daw-browser/waveforms/draw-waveform-signal'
import { resolveWaveformPaintStyle } from './waveform-style'

type RasterMeasurement = {
  readonly darkestLuminance: number
  readonly darkestColorDistance: number
  readonly fullyCoveredBackingRows: number
  readonly effectiveBackingThickness: number
}

type CenterReleaseSample = {
  readonly thickness: number
  readonly center: number
  readonly rawCenter: number
}

type FractionalCoverageSample = {
  readonly dpr: number
  readonly fraction: number
  readonly darkestLuminance: number
  readonly fullyCoveredBackingRows: number
}

type FloorExperiment = {
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
}

type GeometryDiagnostic = {
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
}

type RasterRegressionResult = {
  readonly aligned: readonly RasterMeasurement[]
  readonly legacy: readonly RasterMeasurement[]
  readonly samplesWithoutPoints: RasterMeasurement
  readonly samplesWithPoints: RasterMeasurement
  readonly centerRelease: readonly CenterReleaseSample[]
  readonly fractionalCoverage: readonly FractionalCoverageSample[]
  readonly floorExperiments: readonly FloorExperiment[]
  readonly geometryDiagnostics: readonly GeometryDiagnostic[]
}

const background = { red: 238, green: 238, blue: 238 }
const waveform = { red: 17, green: 17, blue: 17 }

const luminance = (red: number, green: number, blue: number) => (
  0.2126 * red + 0.7152 * green + 0.0722 * blue
)

const colorDistance = (red: number, green: number, blue: number) => Math.sqrt(
  (background.red - red) ** 2
    + (background.green - green) ** 2
    + (background.blue - blue) ** 2,
)

const sampleMeasurement = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  dpr: number,
): RasterMeasurement => {
  const pixels = ctx.getImageData(0, 0, width, height).data
  const x = Math.floor(26 * dpr)
  let darkestLuminance = Number.POSITIVE_INFINITY
  let darkestColorDistance = 0
  let fullyCoveredBackingRows = 0
  let effectiveBackingThickness = 0
  for (let y = 0; y < height; y += 1) {
    const offset = (y * width + x) * 4
    const red = pixels[offset] ?? 0
    const green = pixels[offset + 1] ?? 0
    const blue = pixels[offset + 2] ?? 0
    const alpha = pixels[offset + 3] ?? 0
    darkestLuminance = Math.min(darkestLuminance, luminance(red, green, blue))
    darkestColorDistance = Math.max(darkestColorDistance, colorDistance(red, green, blue))
    effectiveBackingThickness += Math.max(
      0,
      Math.min(
        1,
        (luminance(background.red, background.green, background.blue)
          - luminance(red, green, blue))
          / (luminance(background.red, background.green, background.blue)
            - luminance(waveform.red, waveform.green, waveform.blue)),
      ),
    )
    if (
      red === waveform.red
      && green === waveform.green
      && blue === waveform.blue
      && alpha === 255
    ) {
      fullyCoveredBackingRows += 1
    }
  }
  return {
    darkestLuminance,
    darkestColorDistance,
    fullyCoveredBackingRows,
    effectiveBackingThickness,
  }
}

const render = (input: {
  readonly dpr: number
  readonly deviceThickness: number
  readonly centerDeviceY: number
  readonly kind: 'aligned' | 'legacy'
  readonly data?: Parameters<typeof drawWaveformSignal>[1]['data']
  readonly pointRadius?: number
  readonly minimumThicknessCssPx?: number
}): RasterMeasurement => {
  const cssWidth = 64
  const cssHeight = 32
  const canvas = document.createElement('canvas')
  if (!(canvas instanceof HTMLCanvasElement)) throw new Error('Canvas element unavailable')
  canvas.width = cssWidth * input.dpr
  canvas.height = cssHeight * input.dpr
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D context unavailable')
  if (!(ctx instanceof CanvasRenderingContext2D)) throw new Error('Canvas 2D context has the wrong type')
  ctx.setTransform(input.dpr, 0, 0, input.dpr, 0, 0)
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-over'
  ctx.fillStyle = '#eeeeee'
  ctx.fillRect(0, 0, cssWidth, cssHeight)

  const centerY = input.centerDeviceY / input.dpr
  if (input.kind === 'aligned') {
    if (!input.data) throw new Error('Waveform data is required for aligned rendering')
    const resolvedStyle = resolveWaveformPaintStyle({
      color: '#111111',
      backingScaleY: input.dpr,
      pointRadius: input.pointRadius,
    })
    const style = input.minimumThicknessCssPx === undefined
      ? resolvedStyle
      : {
        ...resolvedStyle,
        minimumThicknessCssPx: input.minimumThicknessCssPx,
      }
    drawWaveformSignal(ctx, {
      data: input.data,
      sourceStartFrame: 0,
      sourceEndFrame: 4,
      startPx: 8,
      endPx: 56,
      topY: centerY - 8,
      contentH: 16,
      channelCount: 1,
      style,
    })
  } else {
    // Deliberately keep the unsnapped geometry local to this regression control.
    const thickness = input.deviceThickness / input.dpr
    ctx.fillStyle = '#111111'
    ctx.beginPath()
    ctx.moveTo(8, centerY - thickness / 2)
    ctx.lineTo(56, centerY - thickness / 2)
    ctx.lineTo(56, centerY + thickness / 2)
    ctx.lineTo(8, centerY + thickness / 2)
    ctx.fill()
  }
  return sampleMeasurement(ctx, canvas.width, canvas.height, input.dpr)
}

const intervalData = {
  kind: 'intervals' as const,
  encoding: 'float32' as const,
  channels: [new Float32Array([0, 0])],
  firstFrame: 0,
  sampleRate: 1,
  sourceFrameCount: 4,
  framesPerInterval: 4,
  intervalCount: 1,
}

const sampleData = {
  kind: 'samples' as const,
  channels: [new Float32Array([0, 0, 0, 0, 0])],
  firstFrame: 0,
  sampleRate: 1,
  sourceFrameCount: 5,
}

const renderAll = (): RasterRegressionResult => {
  const aligned: RasterMeasurement[] = []
  const legacy: RasterMeasurement[] = []
  const centerRelease: CenterReleaseSample[] = []
  const fractionalCoverage: FractionalCoverageSample[] = []
  const floorExperiments: FloorExperiment[] = []
  const geometryDiagnostics: GeometryDiagnostic[] = []
  for (const dpr of [1, 2, 3]) {
    for (const deviceThickness of [
      0.9, 0.999, 1, 1.001, 1.25, 1.5, 1.999, 2, 2.001, 2.01,
      2.1, 2.25, 2.5, 2.75, 2.999, 3, 3.001, 3.5, 3.999, 4, 4.001,
    ]) {
      for (const centerDeviceY of [8, 8.25, 8.5, 8.75, 8.999, 9]) {
        const amplitude = deviceThickness / (dpr * 14.4)
        const data = {
          ...intervalData,
          channels: [new Float32Array([-amplitude, amplitude])],
        }
        aligned.push(render({ dpr, deviceThickness, centerDeviceY, kind: 'aligned', data }))
        legacy.push(render({ dpr, deviceThickness, centerDeviceY, kind: 'legacy', data }))
        if (dpr === 2) {
          const ribbon = waveformRibbonGeometry({
            upperY: (centerDeviceY - deviceThickness / 2) / dpr,
            lowerY: (centerDeviceY + deviceThickness / 2) / dpr,
            minimumThicknessCssPx: 1 / dpr,
            backingScaleY: dpr,
          })
          centerRelease.push({
            thickness: deviceThickness,
            center: ribbon.centerY * dpr,
            rawCenter: centerDeviceY,
          })
        }
      }
    }
    for (const fraction of [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]) {
      const measurement = render({
        dpr,
        deviceThickness: 1,
        centerDeviceY: 8 + fraction,
        kind: 'aligned',
        data: sampleData,
      })
      fractionalCoverage.push({
        dpr,
        fraction,
        darkestLuminance: measurement.darkestLuminance,
        fullyCoveredBackingRows: measurement.fullyCoveredBackingRows,
      })
    }
    for (const floor of [
      { label: 'one-physical-pixel', cssPx: 1 / dpr },
      { label: '0.75-css-pixel', cssPx: 0.75 },
      { label: 'one-css-pixel', cssPx: 1 },
      { label: 'two-physical-pixels', cssPx: 2 / dpr },
    ]) {
      const measurements = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]
        .map((fraction) => render({
          dpr,
          deviceThickness: 0,
          centerDeviceY: 8 + fraction,
          kind: 'aligned',
          data: sampleData,
          minimumThicknessCssPx: floor.cssPx,
        }))
      const luminances = measurements.map((measurement) => measurement.darkestLuminance)
      const effectiveThicknesses = measurements.map((measurement) => measurement.effectiveBackingThickness)
      const sortedLuminances = [...luminances].sort((a, b) => a - b)
      const sortedThicknesses = [...effectiveThicknesses].sort((a, b) => a - b)
      const middle = Math.floor(sortedLuminances.length / 2)
      const median = (
        (sortedLuminances[middle - 1] ?? 0)
          + (sortedLuminances[middle] ?? 0)
      ) / 2
      const thicknessMiddle = Math.floor(sortedThicknesses.length / 2)
      floorExperiments.push({
        dpr,
        floorCssPx: floor.cssPx,
        floorLabel: floor.label,
        medianDarkestLuminance: median,
        luminanceSpread: Math.max(...luminances) - Math.min(...luminances),
        phasePulse: Math.max(...luminances) - Math.min(...luminances),
        medianEffectiveBackingThickness: (
          (sortedThicknesses[thicknessMiddle - 1] ?? 0)
            + (sortedThicknesses[thicknessMiddle] ?? 0)
        ) / 2,
        effectiveThicknessSpread: Math.max(...effectiveThicknesses)
          - Math.min(...effectiveThicknesses),
        minimumEffectiveBackingThickness: Math.min(...effectiveThicknesses),
        maximumEffectiveBackingThickness: Math.max(...effectiveThicknesses),
        minimumDarkestLuminance: Math.min(...luminances),
        maximumDarkestLuminance: Math.max(...luminances),
      })
    }
    const rawCenter = (8.25 + 8.75) / 2 / dpr
    const rawThickness = (8.75 - 8.25) / dpr
    const ribbon = waveformRibbonGeometry({
      upperY: 8.25 / dpr,
      lowerY: 8.75 / dpr,
      minimumThicknessCssPx: minimumWaveformThicknessCssPx(dpr),
      backingScaleY: dpr,
    })
    geometryDiagnostics.push({
      dpr,
      zoom: 1,
      sourceFrame: 0,
      framesPerInterval: 1,
      tier: 1,
      generation: 1,
      paintIdentity: 'rgba(17,17,17,1)|source-over|fill',
      rawCenter,
      finalCenter: ribbon.centerY,
      rawThickness,
      finalThickness: ribbon.thickness,
    })
  }
  return {
    aligned,
    legacy,
    samplesWithoutPoints: render({
      dpr: 2,
      deviceThickness: 1,
      centerDeviceY: 8.5,
      kind: 'aligned',
      data: sampleData,
    }),
    samplesWithPoints: render({
      dpr: 2,
      deviceThickness: 1,
      centerDeviceY: 8.5,
      kind: 'aligned',
      data: sampleData,
      pointRadius: 1.5,
    }),
    centerRelease,
    fractionalCoverage,
    floorExperiments,
    geometryDiagnostics,
  }
}

Reflect.set(globalThis, '__waveformRasterRegressionResult', renderAll())
