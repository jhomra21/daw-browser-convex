import { normalizeCompressorParams } from '@daw-browser/shared'
import { createCompressorNodeChain } from './effects/chain'
import { measureAudio, measureChannelLeakageDb } from './dsp-characterization'

type BrowserCharacterizationCase = {
  status: 'pass' | 'fail' | 'unsupported'
  metrics?: Readonly<Record<string, number | boolean>>
  message?: string
}

export type BrowserCharacterizationReport = {
  userAgent: string
  sampleRates: Readonly<Record<string, BrowserCharacterizationCase>>
  dryGain: BrowserCharacterizationCase
  stereoIsolation: BrowserCharacterizationCase
  eq: BrowserCharacterizationCase
  compressorRegistration: BrowserCharacterizationCase
  compressorProcessing: BrowserCharacterizationCase
}

const readBuffer = (buffer: AudioBuffer) =>
  Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel))

const render = async (
  sampleRate: number,
  channels: number,
  frames: number,
  connect: (context: OfflineAudioContext, source: AudioBufferSourceNode) => Promise<void> | void,
) => {
  const context = new OfflineAudioContext(channels, frames, sampleRate)
  const buffer = context.createBuffer(channels, frames, sampleRate)
  const source = context.createBufferSource()
  source.buffer = buffer
  await connect(context, source)
  source.start()
  return context.startRendering()
}

const capture = async (run: () => Promise<BrowserCharacterizationCase>): Promise<BrowserCharacterizationCase> => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      run(),
      new Promise<BrowserCharacterizationCase>((resolve) => {
        // Browser worklet registration can remain pending indefinitely, so the diagnostic must terminate with evidence.
        timeoutId = setTimeout(() => resolve({ status: 'fail', message: 'Browser characterization timed out.' }), 8_000)
      }),
    ])
  } catch (error) {
    return { status: 'fail', message: error instanceof Error ? error.message : String(error) }
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId)
  }
}

export async function runBrowserCharacterization(): Promise<BrowserCharacterizationReport> {
  const sampleRates: Record<string, BrowserCharacterizationCase> = {}
  for (const sampleRate of [44_100, 48_000, 96_000]) {
    sampleRates[String(sampleRate)] = await capture(async () => {
      const context = new OfflineAudioContext(1, 1, sampleRate)
      const rendered = await context.startRendering()
      return {
        status: rendered.sampleRate === sampleRate ? 'pass' : 'fail',
        metrics: { requestedSampleRate: sampleRate, activeSampleRate: rendered.sampleRate },
      }
    })
  }

  const dryGain = await capture(async () => {
    const rendered = await render(48_000, 1, 128, (context, source) => {
      source.buffer?.getChannelData(0).fill(0.25)
      const gain = context.createGain()
      gain.gain.value = 2
      source.connect(gain)
      gain.connect(context.destination)
    })
    const metrics = measureAudio(readBuffer(rendered))
    return { status: Math.abs(metrics.peak - 0.5) < 1e-3 ? 'pass' : 'fail', metrics: { peak: metrics.peak, rms: metrics.rms } }
  })

  const stereoIsolation = await capture(async () => {
    const rendered = await render(48_000, 2, 128, (context, source) => {
      if (source.buffer) {
        source.buffer.getChannelData(0)[0] = 1
        source.buffer.getChannelData(1)[0] = 0
      }
      source.connect(context.destination)
    })
    const leftPeak = measureAudio([rendered.getChannelData(0)]).peak
    const rightPeak = measureAudio([rendered.getChannelData(1)]).peak
    const leakageDetected = Number.isFinite(measureChannelLeakageDb(leftPeak, rightPeak))
    return {
      status: Math.abs(leftPeak - 1) < 1e-3 && rightPeak < 1e-6 ? 'pass' : 'fail',
      metrics: { leftPeak, rightPeak, leakageDetected },
    }
  })

  const eq = await capture(async () => {
    const rendered = await render(48_000, 1, 4_800, (context, source) => {
      if (source.buffer) {
        const channel = source.buffer.getChannelData(0)
        for (let frame = 0; frame < channel.length; frame += 1) channel[frame] = Math.sin(2 * Math.PI * 1_000 * frame / 48_000) * 0.25
      }
      const filter = context.createBiquadFilter()
      filter.type = 'peaking'
      filter.frequency.value = 1_000
      filter.Q.value = 1
      filter.gain.value = 6
      source.connect(filter)
      filter.connect(context.destination)
    })
    const rms = measureAudio(readBuffer(rendered)).rms
    return { status: rms > 0.3 && rms < 0.4 ? 'pass' : 'fail', metrics: { rms } }
  })

  const compressorRegistration = await capture(async () => {
    const rendered = await render(48_000, 2, 128, async (context, source) => {
      if (source.buffer) {
        source.buffer.getChannelData(0)[16] = 0.5
        source.buffer.getChannelData(1)[80] = -0.25
      }
      const chain = await createCompressorNodeChain(context, normalizeCompressorParams({ enabled: true, dryWet: 0 }))
      source.connect(chain.input)
      chain.output.connect(context.destination)
    })
    const left = rendered.getChannelData(0)
    const right = rendered.getChannelData(1)
    const expectedFramesMatch = left[16] === 0.5
      && right[80] === -0.25
      && left[80] === 0
      && right[16] === 0
    return {
      status: expectedFramesMatch ? 'pass' : 'fail',
      metrics: {
        expectedFramesMatch,
        leftFrame16: left[16],
        rightFrame80: right[80],
        leftFrame80: left[80],
        rightFrame16: right[16],
      },
    }
  })

  const compressorProcessing = await capture(async () => {
    const inputLevel = 0.5
    const rendered = await render(48_000, 2, 4_800, async (context, source) => {
      source.buffer?.getChannelData(0).fill(inputLevel)
      source.buffer?.getChannelData(1).fill(inputLevel)
      const chain = await createCompressorNodeChain(context, normalizeCompressorParams({
        enabled: true,
        thresholdDb: -30,
        ratio: 20,
        attackMs: 0.1,
        releaseMs: 5,
        autoRelease: false,
        dryWet: 1,
        kneeDb: 0,
        detectorMode: 'peak',
      }))
      source.connect(chain.input)
      chain.output.connect(context.destination)
    })
    const settled = rendered.getChannelData(0).subarray(2_400)
    const metrics = measureAudio([settled])
    return {
      status: !metrics.containsNonFiniteSamples && metrics.rms < inputLevel * 0.5 ? 'pass' : 'fail',
      metrics: {
        inputLevel,
        settledPeak: metrics.peak,
        settledRms: metrics.rms,
        containsNonFiniteSamples: metrics.containsNonFiniteSamples,
      },
    }
  })

  return { userAgent: navigator.userAgent, sampleRates, dryGain, stereoIsolation, eq, compressorRegistration, compressorProcessing }
}
