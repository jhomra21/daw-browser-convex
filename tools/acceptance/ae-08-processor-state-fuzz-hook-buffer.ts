export default class FixtureBuffer implements AudioBuffer {
  readonly length = 48_000
  readonly numberOfChannels = 2
  readonly sampleRate = 48_000
  readonly duration = 1
  private readonly planes = [new Float32Array(this.length), new Float32Array(this.length)]
  getChannelData(channel: number) {
    const plane = this.planes[channel]
    if (!plane) throw new Error("Invalid channel")
    return plane
  }
  copyFromChannel(destination: Float32Array<ArrayBuffer>, channel: number, start = 0) {
    destination.set(this.getChannelData(channel).subarray(start, start + destination.length))
  }
  copyToChannel(source: Float32Array<ArrayBuffer>, channel: number, start = 0) {
    this.getChannelData(channel).set(source, start)
  }
}
