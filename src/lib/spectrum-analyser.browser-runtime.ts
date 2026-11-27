import { createSpectrumTap } from '@daw-browser/audio-engine/spectrum-analyser'
import type { SpectrumFrame } from '@daw-browser/audio-engine/audio-engine'
import type { SpectrumSettings } from '@daw-browser/shared'
import { interpolatedPeak, readoutAt } from '~/lib/spectrum-readout'

const SAMPLE_RATE = 48000
const results: Record<string, boolean> = {}

// Renders a graph offline, pausing it at each read time so the real AnalyserNode is read mid-render, and returns the last frame read.
const measure = async (
  build: (context: OfflineAudioContext) => AudioNode,
  settings: SpectrumSettings,
  seconds = 1.5,
) => {
  const context = new OfflineAudioContext(2, Math.ceil((seconds + 0.1) * SAMPLE_RATE), SAMPLE_RATE)
  const output = build(context)
  output.connect(context.destination)
  const tap = createSpectrumTap(context, output, () => () => undefined)
  const reads: Promise<SpectrumFrame | null>[] = []

  // Every 20 ms for the last half second, so the power average has settled.
  for (let time = seconds - 0.5; time <= seconds; time += 0.02) {
    reads.push(context.suspend(time).then(() => {
      const frame = tap.read(settings)
      void context.resume()

      return frame
    }))
  }

  const rendering = context.startRendering()
  const frames = await Promise.all(reads)
  await rendering
  tap.dispose()

  return frames.at(-1) ?? null
}

const sine = (context: OfflineAudioContext, hertz: number, amplitude: number, channels: 'both' | 'left' = 'both') => {
  const oscillator = context.createOscillator()
  oscillator.frequency.value = hertz
  const gain = context.createGain()
  gain.gain.value = amplitude
  oscillator.connect(gain)
  oscillator.start()

  if (channels === 'both') return gain
  const merger = context.createChannelMerger(2)
  gain.connect(merger, 0, 0)

  return merger
}

const decibels = (frame: SpectrumFrame) => Array.from(frame.data, (level) => level * 90 - 90)

const peakOf = (frame: SpectrumFrame) => {
  const levels = decibels(frame)
  const bin = levels.indexOf(Math.max(...levels))

  return { bin, ...interpolatedPeak(levels[bin - 1], levels[bin], levels[bin + 1]) }
}

const run = async () => {
  const same = { channel: 'both' } as const

  for (const level of [-6, -20, -60]) {
    const frame = await measure((context) => sine(context, 1000, 10 ** (level / 20)), { block: 2048, ...same })
    const peak = frame && peakOf(frame)
    results[`1000 Hz at ${level} dBFS reads ${peak?.decibels.toFixed(3)} dB at block 2048`] = !!peak && Math.abs(peak.decibels - level) <= 0.5
  }

  for (const block of [512, 1024, 4096, 8192, 16384] as const) {
    const frame = await measure((context) => sine(context, 1000, 0.1), { block, ...same })
    const peak = frame && peakOf(frame)
    results[`1000 Hz at -20 dBFS reads ${peak?.decibels.toFixed(3)} dB at block ${block}, frame of ${block / 2} bins`]
      = !!peak && frame.data.length === block / 2 && frame.fftSize === block && Math.abs(peak.decibels - -20) <= 0.5
  }

  // The production readout under a pointer on the peak of a 1 kHz sine.
  const readoutFrame = await measure((context) => sine(context, 1000, 0.1), { block: 8192, ...same })
  const position = Math.log(1000 / 20) / Math.log(1000)
  const reading = readoutFrame && readoutAt(readoutFrame, position)
  results[`the readout under 1 kHz at -20 dBFS shows ${reading?.frequency.toFixed(2)} Hz, ${reading?.decibels.toFixed(2)} dB`]
    = !!reading && Math.abs(reading.frequency - 1000) <= 1 && Math.abs(reading.decibels - -20) <= 0.5

  const leftOnly = (settings: SpectrumSettings) => measure((context) => sine(context, 1500, 0.5, 'left'), settings)
  const left = await leftOnly({ block: 2048, channel: 'left' })
  const both = await leftOnly({ block: 2048, channel: 'both' })
  const right = await leftOnly({ block: 2048, channel: 'right' })
  const leftPeak = left ? peakOf(left).decibels : undefined
  const bothPeak = both ? peakOf(both).decibels : undefined
  results[`a left-only 1.5 kHz sine reads ${leftPeak?.toFixed(2)} dB on Left, ${bothPeak?.toFixed(2)} dB on L+R, and nothing on Right`]
    = leftPeak !== undefined && bothPeak !== undefined && Math.abs(leftPeak - 20 * Math.log10(0.5)) <= 0.5
      && Math.abs(leftPeak - bothPeak - 6.02) <= 0.2 && right === null

  const pair = (context: OfflineAudioContext) => {
    const sum = context.createGain()
    sine(context, 40, 0.25).connect(sum)
    sine(context, 55, 0.25).connect(sum)

    return sum
  }

  const depth = async (block: SpectrumSettings['block']) => {
    const frame = await measure(pair, { block, ...same }, 2)

    if (!frame) return 0
    const levels = decibels(frame)
    const binHertz = SAMPLE_RATE / block
    const bin = (hertz: number) => Math.round(hertz / binHertz)
    const peak = (hertz: number) => Math.max(...levels.slice(bin(hertz) - 1, bin(hertz) + 2))
    const valley = Math.min(...levels.slice(bin(40), bin(55) + 1))

    return Math.min(peak(40), peak(55)) - valley
  }

  const [shallow, medium, deep] = [await depth(2048), await depth(8192), await depth(16384)]
  results[`40 Hz and 55 Hz: valley ${shallow.toFixed(2)} dB at 2048, ${medium.toFixed(2)} dB at 8192, ${deep.toFixed(2)} dB at 16384`]
    = shallow < 0.5 && medium >= 3 && deep >= 12

  Object.defineProperty(window, '__browserFixtureResults', { value: results })
}

void run().catch((error) => { Object.assign(window, { __browserFixtureError: String(error) }) })
