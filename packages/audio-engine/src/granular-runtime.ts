import { GRANULAR_AUTOMATION_DESCRIPTORS, normalizeGranularParams, parseGranularAutomationKey, type AutomationEnvelope, type GranularParams } from '@daw-browser/shared'
import { observeResource, type ResourceObserver } from './runtime-diagnostics'
import { loadWorkletModule } from './worklet-loader'
import { granularWorklet, resolveWorkletModuleUrl } from './worklet-manifest'
import { scheduleAutomationEnvelope } from './automation'

export type GranularInstalledBuffer = {
  assetKey: string
  buffer: AudioBuffer
}

type GranularRuntimeOptions = {
  context: BaseAudioContext | { currentTime: number }
  destination?: AudioNode
  params: GranularParams
  onFault?: (code: string) => void
  resourceObserver?: ResourceObserver
  createNode?: (context: BaseAudioContext | { currentTime: number }, params: GranularParams) => GranularWorkletNode
}

type GranularWorkletNode = {
  parameters: ReadonlyMap<string, AudioParam>
  port: {
    onmessage: ((event: MessageEvent) => void) | null
    postMessage(message: unknown, transfer: Transferable[]): void
    postMessage(message: unknown, options?: StructuredSerializeOptions): void
    close: () => void
  }
  onprocessorerror: ((event: ErrorEvent) => unknown) | null
  connect: (destination: AudioNode) => unknown
  disconnect: () => void
}

type PendingInstall = {
  resolve: () => void
  reject: (error: Error) => void
}

const bufferBytes = (buffer: AudioBuffer) =>
  buffer.length * buffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT

export async function createGranularRuntime(options: GranularRuntimeOptions) {
  const params = normalizeGranularParams(options.params)
  let node: GranularWorkletNode
  if (options.createNode) {
    node = options.createNode(options.context, params)
  } else {
    if (!('audioWorklet' in options.context)) throw new Error('Granular runtime requires an AudioContext.')
    await loadWorkletModule(options.context, resolveWorkletModuleUrl(granularWorklet.modulePath))
    node = new AudioWorkletNode(
      options.context,
      granularWorklet.processorName,
      {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions: {
          seed: params.seed,
          maxGrains: params.maxGrains,
          windowShape: params.windowShape,
        },
      },
    )
  }
  if (options.destination) node.connect(options.destination)
  const releaseResource = observeResource(options.resourceObserver, 'granular-worklet', node)
  let closed = false
  let generation = 0
  const scheduledNotes = new Map<string, { start: number; end: number }[]>()
  const rebuildGate = (fromTime: number) => {
    const gate = node.parameters.get('gate')
    if (!gate) return
    gate.cancelScheduledValues(fromTime)
    gate.setValueAtTime(0, fromTime)
    const intervals = [...scheduledNotes.values()].flat().filter((interval) => interval.end > fromTime).sort((a, b) => a.start - b.start)
    let start = -1
    let end = -1
    for (const interval of intervals) {
      const intervalStart = Math.max(fromTime, interval.start)
      if (start < 0) {
        start = intervalStart
        end = interval.end
        continue
      }
      if (intervalStart <= end) {
        end = Math.max(end, interval.end)
        continue
      }
      gate.setValueAtTime(1, start)
      gate.setValueAtTime(0, end)
      start = intervalStart
      end = interval.end
    }
    if (start >= 0) {
      gate.setValueAtTime(1, start)
      gate.setValueAtTime(0, end)
    }
    scheduledGateEnd = Math.max(0, end)
  }
  let installedBuffer: AudioBuffer | undefined
  let installedAssetKey: string | undefined
  const pending = new Map<number, PendingInstall>()
  let scheduledGateEnd = 0

  const rejectPending = (error: Error) => {
    for (const request of pending.values()) request.reject(error)
    pending.clear()
  }

  node.port.onmessage = (event) => {
    const data = event.data
    if (typeof data !== 'object' || data === null || !('generation' in data) || typeof data.generation !== 'number') return
    const request = pending.get(data.generation)
    if (!request) return
    if (!('type' in data)) return
    if (data.type === 'installed') {
      pending.delete(data.generation)
      request.resolve()
    } else if (data.type === 'error') {
      pending.delete(data.generation)
      const code = 'code' in data && typeof data.code === 'string' ? data.code : 'install-error'
      request.reject(new Error(`Granular sample installation failed: ${code}`))
      options.onFault?.(code)
    }
  }
  node.onprocessorerror = () => options.onFault?.('processor-error')

  const setParam = (name: string, value: number) => node.parameters.get(name)?.setValueAtTime(value, options.context.currentTime)
  setParam('grainSizeMs', params.grainSizeMs)
  setParam('densityHz', params.densityHz)
  setParam('position', params.position)
  setParam('spray', params.spray)
  setParam('pitchSemitones', params.pitchSemitones)
  setParam('reverseProbability', params.reverseProbability)
  setParam('stereoSpread', params.stereoSpread)
  setParam('gate', 0)

  return {
    node,
    installSample: ({ assetKey, buffer }: GranularInstalledBuffer): Promise<void> => {
      if (closed) return Promise.reject(new Error('Granular runtime is closed.'))
      if (buffer === installedBuffer && assetKey === installedAssetKey) return Promise.resolve()
      const bytes = bufferBytes(buffer)
      if (bytes > params.maxDecodedBytes) {
        const error = new Error(`Granular sample exceeds the ${params.maxDecodedBytes} byte limit.`)
        options.onFault?.('sample-too-large')
        return Promise.reject(error)
      }
      rejectPending(new Error('Granular sample installation was superseded by a newer generation.'))
      generation += 1
      const requestGeneration = generation
      const channels = Array.from(
        { length: Math.min(2, buffer.numberOfChannels) },
        (_, channel) => new Float32Array(buffer.getChannelData(channel)),
      )
      const transfer = channels.map((channel) => channel.buffer)
      const promise = new Promise<void>((resolve, reject) => {
        pending.set(requestGeneration, { resolve: () => {
          installedBuffer = buffer
          installedAssetKey = assetKey
          resolve()
        }, reject })
      })
      node.port.postMessage({
        type: 'install',
        version: 1,
        generation: requestGeneration,
        assetKey,
        sampleRate: buffer.sampleRate,
        channels,
      }, transfer)
      return promise
    },
    releaseSample: () => {
      if (closed) return
      generation += 1
      installedBuffer = undefined
      installedAssetKey = undefined
      rejectPending(new Error('Granular sample installation was superseded by release.'))
      node.port.postMessage({ type: 'release', version: 1, generation })
    },
    resetSeed: (seed = params.seed) => {
      if (!closed) node.port.postMessage({ type: 'reset-seed', version: 1, seed })
    },
    setFrozen: (freeze: boolean) => {
      if (!closed) node.port.postMessage({ type: 'freeze', version: 1, freeze })
    },
    stop: () => {
      if (closed) return
      const gate = node.parameters.get('gate')
      if (!gate) return
      scheduledGateEnd = 0
      scheduledNotes.clear()
      gate.cancelScheduledValues(options.context.currentTime)
      gate.setValueAtTime(0, options.context.currentTime)
    },
    scheduleNote: (input: {
      clipId?: string
      when: number
      durationSec: number
      timelineStartSec: number
      timelineToCtxTime: (timeSec: number) => number
      automationEnvelopes: readonly AutomationEnvelope[]
    }) => {
      const gate = node.parameters.get('gate')
      const end = input.when + Math.max(0, input.durationSec)
      if (input.clipId) scheduledNotes.set(input.clipId, [...(scheduledNotes.get(input.clipId) ?? []), { start: input.when, end }])
      scheduledGateEnd = scheduledGateEnd > input.when ? Math.max(scheduledGateEnd, end) : end
      gate?.cancelScheduledValues(input.when)
      gate?.setValueAtTime(1, input.when)
      gate?.setValueAtTime(0, scheduledGateEnd)
      const bindings = {
        grainSize: node.parameters.get('grainSizeMs'),
        density: node.parameters.get('densityHz'),
        position: node.parameters.get('position'),
        spray: node.parameters.get('spray'),
        pitch: node.parameters.get('pitchSemitones'),
        reverseProbability: node.parameters.get('reverseProbability'),
        stereoSpread: node.parameters.get('stereoSpread'),
      }
      for (const envelope of input.automationEnvelopes) {
        const key = parseGranularAutomationKey(envelope.parameterId)
        if (!key || !envelope.enabled) continue
        const param = bindings[key.parameterId]
        if (!param) continue
        const descriptor = GRANULAR_AUTOMATION_DESCRIPTORS[key.parameterId]
        scheduleAutomationEnvelope(
          [{ param, valueToAudioValue: (value) => value }],
          envelope,
          { playheadSec: input.timelineStartSec, startLimitSec: input.timelineStartSec, endLimitSec: input.timelineStartSec + input.durationSec },
          input.timelineToCtxTime,
          descriptor.defaultValue,
        )
      }
    },
    stopClip: (clipId: string) => {
      scheduledNotes.delete(clipId)
      rebuildGate(options.context.currentTime)
    },
    close: () => {
      if (closed) return
      closed = true
      scheduledGateEnd = 0
      scheduledNotes.clear()
      generation += 1
      rejectPending(new Error('Granular runtime is closed.'))
      node.port.onmessage = null
      node.onprocessorerror = null
      try { node.port.postMessage({ type: 'release', version: 1, generation }) } catch {}
      try { node.port.close() } catch {}
      node.disconnect()
      releaseResource()
    },
  }
}
