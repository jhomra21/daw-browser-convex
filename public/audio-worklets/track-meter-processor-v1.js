class TrackMeterProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.active = false
    this.frames = 0
    this.sumL = 0
    this.sumR = 0
    this.emittedSilence = false
    this.port.onmessage = (event) => {
      const data = event.data
      if (!data || typeof data !== 'object' || typeof data.active !== 'boolean') return
      this.active = data.active
      if (!this.active) this.reset()
    }
  }
  reset() {
    this.frames = 0
    this.sumL = 0
    this.sumR = 0
    this.emittedSilence = false
  }
  process(inputs) {
    if (!this.active) return true
    const input = inputs[0]
    const left = input && input[0]
    if (!left) {
      this.frames += 128
    } else {
      const right = input[1] || left
      for (let i = 0; i < left.length; i++) {
        const l = Number.isFinite(left[i]) ? left[i] : 0
        const r = Number.isFinite(right[i]) ? right[i] : 0
        this.sumL += l * l
        this.sumR += r * r
      }
      this.frames += left.length
    }
    if (this.frames >= 4096) {
      const nextLeft = Math.min(1, Math.max(0, Math.sqrt(Math.sqrt(this.sumL / this.frames))))
      const nextRight = Math.min(1, Math.max(0, Math.sqrt(Math.sqrt(this.sumR / this.frames))))
      if (nextLeft > 0 || nextRight > 0 || !this.emittedSilence) {
        this.port.postMessage({ type: 'levels', left: nextLeft, right: nextRight })
        this.emittedSilence = nextLeft === 0 && nextRight === 0
      }
      this.frames = 0
      this.sumL = 0
      this.sumR = 0
    }
    return true
  }
}
registerProcessor('track-meter-processor', TrackMeterProcessor)
