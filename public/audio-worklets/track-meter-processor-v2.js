const REPORT_FRAMES = 2048
const TRUE_PEAK_PHASES = 4
const TRUE_PEAK_TAPS = 24
const isTrackMeterMessage = (data) => data !== null && Object.prototype.toString.call(data) === '[object Object]'
const isTrackMeterBoolean = (value) => value === true || value === false
const sinc = (value) => value === 0 ? 1 : Math.sin(Math.PI * value) / (Math.PI * value)
const TRUE_PEAK_COEFFICIENTS = Array.from({ length: TRUE_PEAK_PHASES }, (_, phase) => {
  const coefficients = new Float64Array(TRUE_PEAK_TAPS)
  const center = TRUE_PEAK_TAPS / 2 - 1
  let sum = 0
  for (let tap = 0; tap < TRUE_PEAK_TAPS; tap += 1) {
    const distance = tap - center - phase / TRUE_PEAK_PHASES
    const window = 0.42
      - 0.5 * Math.cos(2 * Math.PI * tap / (TRUE_PEAK_TAPS - 1))
      + 0.08 * Math.cos(4 * Math.PI * tap / (TRUE_PEAK_TAPS - 1))
    coefficients[tap] = sinc(distance) * window
    sum += coefficients[tap]
  }
  for (let tap = 0; tap < TRUE_PEAK_TAPS; tap += 1) coefficients[tap] /= sum
  return coefficients
})

class TrackMeterProcessorV2 extends AudioWorkletProcessor {
  constructor() {
    super()
    this.active = false
    this.truePeak = false
    this.truePeakHistoryL = new Float64Array(TRUE_PEAK_TAPS)
    this.truePeakHistoryR = new Float64Array(TRUE_PEAK_TAPS)
    this.reset()
    this.port.onmessage = (event) => {
      const data = event.data
      if (!isTrackMeterMessage(data)) return
      if (data.type === 'reset') {
        this.reset()
        if (this.active) this.emitZero()
        return
      }
      if (!isTrackMeterBoolean(data.active)) return
      this.active = data.active
      this.truePeak = data.truePeak === true
      this.reset()
      if (this.active) this.emitZero()
    }
  }
  reset() {
    this.frames = 0
    this.peakL = 0
    this.peakR = 0
    this.sumSquareL = 0
    this.sumSquareR = 0
    this.sumL = 0
    this.sumR = 0
    this.sumLR = 0
    this.truePeakHistoryL.fill(0)
    this.truePeakHistoryR.fill(0)
    this.truePeakHistoryIndex = 0
    this.truePeakL = 0
    this.truePeakR = 0
  }
  emitZero() {
    this.port.postMessage({
      type: 'meter-frame',
      frameCount: 0,
      channels: [
        { samplePeak: 0, rms: 0, clipping: false, dcMean: 0, truePeak: null },
        { samplePeak: 0, rms: 0, clipping: false, dcMean: 0, truePeak: null },
      ],
      correlation: 0,
    })
  }
  process(inputs) {
    if (!this.active) return true
    const input = inputs[0]
    const left = input && input[0]
    const right = input && (input[1] || left)
    const length = left ? left.length : 128
    for (let index = 0; index < length; index += 1) {
      const l = left && Number.isFinite(left[index]) ? left[index] : 0
      const r = right && Number.isFinite(right[index]) ? right[index] : 0
      const absL = Math.abs(l)
      const absR = Math.abs(r)
      if (absL > this.peakL) this.peakL = absL
      if (absR > this.peakR) this.peakR = absR
      this.sumSquareL += l * l
      this.sumSquareR += r * r
      this.sumL += l
      this.sumR += r
      this.sumLR += l * r
      if (this.truePeak) {
        this.truePeakHistoryL[this.truePeakHistoryIndex] = l
        this.truePeakHistoryR[this.truePeakHistoryIndex] = r
        for (const coefficients of TRUE_PEAK_COEFFICIENTS) {
          let interpolatedL = 0
          let interpolatedR = 0
          for (let tap = 0; tap < TRUE_PEAK_TAPS; tap += 1) {
            const historyIndex = (this.truePeakHistoryIndex - tap + TRUE_PEAK_TAPS) % TRUE_PEAK_TAPS
            interpolatedL += this.truePeakHistoryL[historyIndex] * coefficients[tap]
            interpolatedR += this.truePeakHistoryR[historyIndex] * coefficients[tap]
          }
          if (Math.abs(interpolatedL) > this.truePeakL) this.truePeakL = Math.abs(interpolatedL)
          if (Math.abs(interpolatedR) > this.truePeakR) this.truePeakR = Math.abs(interpolatedR)
        }
        this.truePeakHistoryIndex = (this.truePeakHistoryIndex + 1) % TRUE_PEAK_TAPS
      }
      this.frames += 1
      if (this.frames === REPORT_FRAMES) {
        const denominator = Math.sqrt(this.sumSquareL * this.sumSquareR)
        this.port.postMessage({
          type: 'meter-frame',
          frameCount: REPORT_FRAMES,
          channels: [
            {
              samplePeak: this.peakL,
              rms: Math.sqrt(this.sumSquareL / REPORT_FRAMES),
              clipping: this.peakL >= 1,
              dcMean: this.sumL / REPORT_FRAMES,
              truePeak: this.truePeak ? this.truePeakL : null,
            },
            {
              samplePeak: this.peakR,
              rms: Math.sqrt(this.sumSquareR / REPORT_FRAMES),
              clipping: this.peakR >= 1,
              dcMean: this.sumR / REPORT_FRAMES,
              truePeak: this.truePeak ? this.truePeakR : null,
            },
          ],
          correlation: denominator > 0 ? Math.max(-1, Math.min(1, this.sumLR / denominator)) : 0,
        })
        this.reset()
      }
    }
    return true
  }
}

registerProcessor('track-meter-processor-v2', TrackMeterProcessorV2)
