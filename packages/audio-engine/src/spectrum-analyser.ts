import type { SpectrumChannel, SpectrumSettings } from '@daw-browser/shared'
import { safeDisconnect } from './safe-disconnect'
import type { SpectrumFrame } from './metering-runtime'

// The display runs from SPECTRUM_FLOOR_DB to 0 dBFS, the same range the native host's analyzer reports.
export const SPECTRUM_FLOOR_DB = -90

// Per-bin power relaxes toward each new read with this time constant, as it does in the native host.
const SPECTRUM_AVERAGING_SECONDS = 0.1

// An AnalyserNode reports 20*log10(|X|) with X = (1/N) * sum(x*w), so a sine of amplitude A reads A*a0/2, where
// a0 = 0.42 is the Blackman window's mean (https://webaudio.github.io/web-audio-api/#blackman-window).
const ANALYSER_TO_DBFS = -20 * Math.log10(0.42 / 2)

type SpectrumSource = {
  fftSize: number
  readonly frequencyBinCount: number
  getFloatFrequencyData: (array: Float32Array<ArrayBuffer>) => void
}

// Turns an AnalyserNode's reading into a calibrated frame: dBFS levels, power-averaged over time rather than per call.
export const createSpectrumReader = () => {
  let power = new Float64Array(0)
  let reading = new Float32Array(0)
  let levels = new Float32Array(0)
  let configuration = ''
  let lastTime = 0

  return (analyser: SpectrumSource, settings: SpectrumSettings, now: number, sampleRate: number): SpectrumFrame | null => {
    if (analyser.fftSize !== settings.block) analyser.fftSize = settings.block
    const bins = analyser.frequencyBinCount

    if (reading.length !== bins) {
      reading = new Float32Array(new ArrayBuffer(bins * Float32Array.BYTES_PER_ELEMENT))
      levels = new Float32Array(bins)
      power = new Float64Array(bins)
    }

    const key = `${settings.block}:${settings.channel}:${sampleRate}`
    const restart = key !== configuration
    configuration = key
    analyser.getFloatFrequencyData(reading)
    const blend = restart ? 1 : 1 - Math.exp(-Math.max(now - lastTime, 0) / SPECTRUM_AVERAGING_SECONDS)
    lastTime = now
    let visible = false

    for (let bin = 0; bin < bins; bin++) {
      const decibels = reading[bin] + ANALYSER_TO_DBFS
      const next = Number.isFinite(decibels) ? 10 ** (decibels / 10) : 0
      power[bin] = restart ? next : power[bin] + blend * (next - power[bin])
      const averaged = power[bin] > 0 ? 10 * Math.log10(power[bin]) : SPECTRUM_FLOOR_DB
      levels[bin] = Math.min(1, Math.max(0, (averaged - SPECTRUM_FLOOR_DB) / -SPECTRUM_FLOOR_DB))
      visible ||= levels[bin] > 0
    }

    // Everything under the floor is silence: no frame, as the display has nothing to draw.
    if (!visible) return null

    return { data: levels, sampleRate, fftSize: analyser.fftSize, binCount: bins }
  }
}

// One observed node's analysers: a mixed-down one, plus a left and a right one behind a splitter when those are asked for.
export const createSpectrumTap = (
  context: BaseAudioContext,
  source: AudioNode,
  trackNode: (node: AudioNode) => () => void,
) => {
  const analysers = new Map<SpectrumChannel, AnalyserNode>()
  const releases: Array<() => void> = []
  const read = createSpectrumReader()
  let splitter: ChannelSplitterNode | undefined

  const analyserFor = (channel: SpectrumChannel) => {
    const existing = analysers.get(channel)

    if (existing) return existing
    const analyser = context.createAnalyser()
    analyser.smoothingTimeConstant = 0
    releases.push(trackNode(analyser))
    analysers.set(channel, analyser)

    if (channel === 'both') {
      source.connect(analyser)

      return analyser
    }

    if (!splitter) {
      splitter = context.createChannelSplitter(2)
      releases.push(trackNode(splitter))
      source.connect(splitter)
    }

    splitter.connect(analyser, channel === 'left' ? 0 : 1)

    return analyser
  }

  return {
    source,
    read: (settings: SpectrumSettings) => read(analyserFor(settings.channel), settings, context.currentTime, context.sampleRate),
    // Re-joins the source after its routing was rebuilt; connecting an existing pair again is a no-op.
    attach: () => {
      if (analysers.has('both')) source.connect(analyserFor('both'))

      if (splitter) source.connect(splitter)
    },
    detach: () => {
      for (const node of [analysers.get('both'), splitter]) {
        if (node) safeDisconnect(source, node)
      }
    },
    dispose: () => {
      for (const node of [...analysers.values(), splitter]) node?.disconnect()

      for (const release of releases) release()
      analysers.clear()
      splitter = undefined
      releases.length = 0
    },
  }
}
