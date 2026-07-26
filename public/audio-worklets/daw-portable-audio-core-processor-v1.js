import { DawPortableAudioCoreHost } from './daw-portable-audio-core-host-v1.js'

class DawPortableAudioCoreProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    this.wasmModule = options.processorOptions && options.processorOptions.wasmModule
    this.host = new DawPortableAudioCoreHost({
      sampleRate,
      postMessage: (message) => this.port.postMessage(message),
      close: () => this.port.close(),
    })
    this.port.onmessage = (event) => this.host.handleMessage(
      event.data && event.data.type === 'initialize'
        ? { ...event.data, wasmModule: this.wasmModule }
        : event.data,
    )
  }

  process(inputs, outputs) {
    return this.host.process(inputs, outputs)
  }
}

registerProcessor('daw-portable-audio-core-processor-v1', DawPortableAudioCoreProcessor)
