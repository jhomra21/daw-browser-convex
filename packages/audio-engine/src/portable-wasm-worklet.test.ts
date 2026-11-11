import { expect, test } from 'bun:test'
import { portableAudioCoreWorklet } from './worklet-manifest'
import { PortableWasmPlaybackSession } from './backends/wasm-audio-worklet-backend'
import type { PortableWasmControlMessage } from './portable-wasm-protocol'

const publicRoot = new URL('../../../public/', import.meta.url)

test('instrument parameter delivery waits for an applied ack and rejects retirement', async () => {
  const posted: PortableWasmControlMessage[] = []
  const node: AudioWorkletNode = Object.assign(Object.create(null), {
    port: {
      onmessage: null,
      postMessage: (message: PortableWasmControlMessage) => posted.push(message),
      close: () => undefined,
    },
    disconnect: () => undefined,
    onprocessorerror: null,
  })
  const session = new PortableWasmPlaybackSession(node)
  const events = [{ nodeId: 'track', type: 'parameter', noteId: 1, sequence: 1, frameOffset: 0, channel: 0, note: 3, value: 913 }] satisfies Parameters<typeof session.queueInstrumentEvents>[1]
  let settled = false
  const delivery = session.queueInstrumentEvents(2, events,
    process.env.DAW_INSTRUMENT_R21_ACK_BASELINE === '1' ? undefined : { revision: 3, sequence: 4 })
    .then(() => { settled = true })
  await Promise.resolve()
  expect(settled).toBe(false)
  expect(posted[0]).toEqual({ version: 2, type: 'instrument-parameters', requestId: 1, revision: 3, epoch: 2, sequence: 4, events })
  node.port.onmessage?.(new MessageEvent('message', { data: {
    version: 2, type: 'instrument-events-applied', requestId: 1, revision: 3, epoch: 2, sequence: 4, result: 'applied',
  } }))
  await delivery
  expect(settled).toBe(true)
  const retired = session.queueInstrumentEvents(2, events, { revision: 3, sequence: 5 })
  session.dispose()
  await expect(retired).rejects.toThrow('disposed')
})

test('portable Wasm worklet defers initialization and keeps process allocation-free', async () => {
  const worklet = await Bun.file(new URL(portableAudioCoreWorklet.modulePath, publicRoot)).text()
  const source = await Bun.file(new URL('audio-worklets/daw-portable-audio-core-host-v2.js', publicRoot)).text()
  const processStart = source.indexOf('  process(inputs, outputs)')
  const processBody = source.slice(processStart, source.indexOf('\n  }\n}', processStart))
  expect(worklet).toContain("import { DawPortableAudioCoreHost } from './daw-portable-audio-core-host-v2.js'")
  expect(worklet).toContain('return this.host.process(inputs, outputs)')
  expect(worklet).toContain('options.processorOptions.wasmModule')
  expect(worklet).toContain('{ ...event.data, wasmModule: this.wasmModule }')
  expect(source).toContain('WebAssembly.instantiate(message.wasmModule)')
  expect(processBody).not.toContain('WebAssembly.')
  expect(processBody).not.toContain('new ')
  expect(processBody).not.toContain("type: 'recording-capture-")
  expect(processBody).toContain('this.postMessage(this.recordingCaptureAvailableMessage)')
  expect(processBody).not.toContain('console.')
  expect(processBody).toContain('const frames = output[0] ? output[0].length : 0')
  expect(processBody).toContain('this.coreProcess(frames')
  expect(source).toContain('daw_audio_core_wasm_graph_prepare')
  expect(source).toContain('daw_audio_core_wasm_graph_process')
  expect(source).toContain('daw_audio_core_wasm_graph_schedule_sample_source')
  expect(source).toContain('daw_audio_core_wasm_recording_capture_initialize')
  expect(source).toContain('recording-capture-diagnostics')
  expect(source).toContain("type: 'sources-scheduled'")
})

test('portable worklet writes the native graph v3 node layout and bounded installed schedules', async () => {
  const source = await Bun.file(new URL('audio-worklets/daw-portable-audio-core-host-v2.js', publicRoot)).text()
  const graphEnvelopeSource = await Bun.file(new URL('audio-worklets/daw-portable-graph-envelope-v3.js', publicRoot)).text()
  const materializeStart = source.indexOf('  materializeSchedule(startFrame, frameCount)')
  const materializeBody = source.slice(materializeStart, source.indexOf('\n  process(inputs, outputs)', materializeStart))
  expect(source).toContain('SUPPORTED_GRAPH_ENVELOPE_VERSIONS')
  expect(source).toContain("from './daw-portable-graph-envelope-v3.js'")
  expect(graphEnvelopeSource).toContain('view.setBigUint64(mixerOffset, BigInt(mixer ? mixer.instanceId : 0), true)')
  expect(source).toContain('nodes.length * (envelopeView.getUint32')
  expect(source).toContain("message.type === 'install-schedule'")
  expect(source).toContain("type: 'schedule-installed'")
  expect(source).toContain('this.scheduleEventOffset = exports.malloc(4 + 256 * 20)')
  expect(source).toContain('this.scheduleInstrumentEventOffset = exports.malloc(4 + 256 * 48)')
  expect(materializeBody).not.toContain('this.schedule.events')
  expect(materializeBody).not.toContain('stableId(')
  expect(materializeBody).not.toContain('BigInt(')
  expect(materializeBody).toContain('stream.cursor')
  expect(materializeBody).toContain('this.scheduleInstrumentCursor')
  expect(source).toContain('const busesToWrite = Math.max(stagedInputBusCount, this.stagedInputBusCount)')
  expect(source).not.toContain('for (let bus = 0; bus < MAX_INPUT_BUSES; bus += 1)')
})

test('portable live processor overrides stay within the core event envelope without faulting on overflow', async () => {
  const source = await Bun.file(new URL('audio-worklets/daw-portable-audio-core-host-v2.js', publicRoot)).text()
  expect(source).toContain('const MAX_PROCESSOR_OVERRIDE_TARGETS = 256')
  expect(source).not.toContain('const MAX_PROCESSOR_OVERRIDE_TARGETS = 512')
  expect(source).toContain('if (newKeys.size > availableSlots)')
  expect(source).toContain("if (count >= MAX_PROCESSOR_EVENTS) break")
  expect(source).toContain("if (count >= MAX_PROCESSOR_EVENTS) continue")
})

test('both hosts keep live instrument merging and acknowledgement allocation-free', async () => {
  for (const version of [1, 2]) {
    const source = await Bun.file(new URL(`audio-worklets/daw-portable-audio-core-host-v${version}.js`, publicRoot)).text()
    for (const name of ['materializeSchedule(startFrame, frameCount)', 'flushInstrumentAcks(result)']) {
      const start = source.indexOf(`  ${name}`)
      const body = source.slice(start, source.indexOf('\n  }', start))
      expect(body).not.toContain('new ')
      expect(body).not.toContain('.map(')
      expect(body).not.toContain('.filter(')
      expect(body).not.toContain('.push(')
    }
    expect(source).toContain('this.materializedLiveInstrumentCount = liveLimit')
    expect(source).toContain("this.flushInstrumentAcks('applied')")
  }
})

test('B6f5 the portable worklet stages schedules, refuses discontinuous adoptions and leaves encoding off its thread', async () => {
  const source = await Bun.file(new URL('audio-worklets/daw-portable-audio-core-host-v2.js', publicRoot)).text()
  const publishStart = source.indexOf("if (message.type === 'publish-graph'")
  const prepareStart = source.indexOf("if (message.type === 'prepare-graph')")
  const publishBody = source.slice(publishStart, source.indexOf("if (message.type === 'prepare-graph')", publishStart))
  const prepareBody = source.slice(prepareStart, source.indexOf("if (message.type === 'utility-state'", prepareStart))
  // R1: the main thread encodes the envelope; prepare hashes and copies nothing for diagnostics.
  expect(prepareBody).toContain('let envelope = message.envelope')
  expect(prepareBody).toContain('if (!(envelope instanceof Uint8Array))')
  expect(prepareBody).not.toContain('byteHash(')
  expect(prepareBody).not.toContain('Array.from(')
  expect(prepareBody).not.toContain('.reduce(')
  // An adoption is refused before any instrument of the playing graph is reconfigured, and swaps its staged schedule in.
  expect(publishBody).toContain('message.requireContinuity === true')
  expect(publishBody.indexOf('const refused')).toBeLessThan(publishBody.indexOf('this.configureInstruments('))
  expect(publishBody).toContain('this.commitSchedule(staged, true)')
  expect(source).toContain('if (staged) this.stagedSchedule = built')
  // The source-bus counters left unused when portable sources stopped reading live buses.
  expect(source).not.toContain('liveInputBusCount')
  expect(source).not.toContain('preparedInputBusCount')
})
