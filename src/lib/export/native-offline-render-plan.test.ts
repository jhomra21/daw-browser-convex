import { expect, test } from 'bun:test'
import type { NativeExternalAttachmentPlan } from '@daw-browser/plugin-host-protocol'
import { externalAutomationParameterId, type AutomationEnvelope } from '@daw-browser/shared'
import type { Clip, Track } from '@daw-browser/timeline-core/types'

import { compileNativeOfflineRenderPlan } from '~/lib/export/native-offline-render-plan'

class TestAudioBuffer implements AudioBuffer {
  readonly duration = 4 / 48_000
  readonly length = 4
  readonly numberOfChannels = 2
  readonly sampleRate = 48_000
  private readonly channels = [new Float32Array([0, 0.25, -0.5, 1]), new Float32Array([1, -0.5, 0.25, 0])]

  copyFromChannel(destination: Float32Array, channel: number, bufferOffset = 0) {
    destination.set(this.channels[channel]?.subarray(bufferOffset, bufferOffset + destination.length))
  }

  copyToChannel(source: Float32Array, channel: number, bufferOffset = 0) {
    this.channels[channel]?.set(source, bufferOffset)
  }

  getChannelData(channel: number) {
    const data = this.channels[channel]
    if (!data) throw new Error(`Missing channel ${channel}.`)
    return data
  }
}

const attachmentPlan = (): NativeExternalAttachmentPlan => ({
  version: 1,
  attachments: [{
    instanceId: 'a7a0b9ac-7884-492c-8b68-80f15802442c',
    graphNodeId: 'track-1',
    nativeGraphNodeId: '15667978324023168200',
    stageIndex: 0,
    catalogIdentity: {
      format: 'vst3',
      classId: '0123456789abcdef0123456789abcdef',
      vendorId: 'Example Vendor',
      architecture: 'arm64',
      scannerCatalogVersion: 2,
    },
    bundleFingerprint: 'b'.repeat(64),
    binaryFingerprint: 'a'.repeat(64),
    role: 'effect',
    inputBuses: [{ name: 'Main Input', channels: 2, enabled: true }],
    outputBuses: [{ name: 'Main Output', channels: 2, enabled: true }],
    workerTransport: {
      slotCount: 2,
      maximumFrames: 512,
      inputChannels: 2,
      outputChannels: 2,
      maximumEventsPerBlock: 128,
    },
    declaredLatencyFrames: 32,
    declaredTailFrames: 480,
    bypassed: false,
    stateRevision: 7,
    parameters: [{
      id: 7,
      title: 'Mix',
      unit: '%',
      minimum: 0,
      maximum: 1,
      defaultValue: 0.25,
      stepCount: 100,
      readOnly: false,
      hidden: false,
    }],
    parameterOverrides: {},
  }],
})

const track: Track<AudioBuffer> = {
  id: 'track-1',
  name: 'Track',
  volume: 1,
  clips: [{
    id: 'clip-1',
    name: 'Clip',
    color: '#fff',
    startSec: 0,
    duration: 4 / 48_000,
    sourceAssetKey: 'asset-1',
    buffer: new TestAudioBuffer(),
  } satisfies Clip<AudioBuffer>],
}

const automationEnvelope = (
  parameterId: string,
  points: AutomationEnvelope['points'],
): AutomationEnvelope => ({
  id: 'automation-1',
  projectId: 'project:1',
  target: { kind: 'track', trackId: track.id },
  targetKey: `track:${track.id}:${parameterId}`,
  parameterId,
  enabled: true,
  points,
  updatedAt: 1,
})

type DecodedAutomationSegment = {
  instanceId: string
  parameterId: number
  startFrame: number
  endFrame: number
  startValue: number
  endValue: number
  interpolation: 'linear' | 'hold'
}

const automationSegmentsFromSchedule = (payload: Uint8Array): DecodedAutomationSegment[] => {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  const instrumentCount = view.getUint32(44, true)
  const sourceCount = view.getUint32(48, true)
  const automationCount = view.getUint32(52, true)
  const decoder = new TextDecoder()
  let offset = 56 + instrumentCount * 48 + sourceCount * 112
  return Array.from({ length: automationCount }, () => {
    const instanceLength = view.getUint32(offset, true)
    offset += 4
    const instanceId = decoder.decode(payload.subarray(offset, offset + instanceLength))
    offset += instanceLength
    const parameterId = view.getUint32(offset, true)
    offset += 4
    const startFrame = Number(view.getBigUint64(offset, true))
    offset += 8
    const endFrame = Number(view.getBigUint64(offset, true))
    offset += 8
    const startValue = view.getFloat64(offset, true)
    offset += 8
    const endValue = view.getFloat64(offset, true)
    offset += 8
    const interpolation = view.getUint32(offset, true) === 1 ? 'linear' : 'hold'
    offset += 4
    return { instanceId, parameterId, startFrame, endFrame, startValue, endValue, interpolation }
  })
}

test('compiles a native plan that remains directly structured-cloneable', () => {
  const plan = compileNativeOfflineRenderPlan({
    tracks: [track],
    fx: { trackFx: {}, masterFxInstances: [], masterVolume: 1 },
    automationEnvelopes: [],
    sidechainRoutes: [],
    bpm: 120,
    range: { mode: 'whole' },
    sampleRateHz: 48_000,
    channelCount: 2,
    tailFrames: 0,
    externalAttachments: attachmentPlan(),
  })

  expect(() => structuredClone(plan)).not.toThrow()
  expect(structuredClone(plan)).toEqual(plan)
})

test('renders VST parameter automation into native offline schedule windows', () => {
  const plan = attachmentPlan()
  const parameterId = externalAutomationParameterId(plan.attachments[0]!.instanceId, 7)
  const exportPlan = compileNativeOfflineRenderPlan({
    tracks: [track],
    fx: { trackFx: {}, masterFxInstances: [], masterVolume: 1 },
    automationEnvelopes: [automationEnvelope(parameterId, [
      { id: 'start', timeSec: 0, value: 0.25, interpolation: 'linear' },
      { id: 'end', timeSec: 0.001, value: 0.75, interpolation: 'hold' },
    ])],
    sidechainRoutes: [],
    bpm: 120,
    range: { mode: 'whole' },
    sampleRateHz: 48_000,
    channelCount: 2,
    tailFrames: 0,
    externalAttachments: plan,
  })

  expect(automationSegmentsFromSchedule(exportPlan.schedule)).toEqual([{
    instanceId: plan.attachments[0]!.instanceId,
    parameterId: 7,
    startFrame: 0,
    endFrame: 48,
    startValue: 0.25,
    endValue: 0.75,
    interpolation: 'linear',
  }])
})

test('rebases VST automation to frame zero for a custom export range', () => {
  const plan = attachmentPlan()
  const parameterId = externalAutomationParameterId(plan.attachments[0]!.instanceId, 7)
  const exportPlan = compileNativeOfflineRenderPlan({
    tracks: [track],
    fx: { trackFx: {}, masterFxInstances: [], masterVolume: 1 },
    automationEnvelopes: [automationEnvelope(parameterId, [
      { id: 'before', timeSec: 0.5, value: 0.25, interpolation: 'hold' },
      { id: 'middle', timeSec: 1.5, value: 0.5, interpolation: 'linear' },
      { id: 'end', timeSec: 2, value: 0.75, interpolation: 'hold' },
    ])],
    sidechainRoutes: [],
    bpm: 120,
    range: { mode: 'custom', startSec: 1, endSec: 2 },
    sampleRateHz: 48_000,
    channelCount: 2,
    tailFrames: 0,
    externalAttachments: plan,
  })

  expect(automationSegmentsFromSchedule(exportPlan.schedule).map((segment) => ({
    startFrame: segment.startFrame,
    endFrame: segment.endFrame,
    interpolation: segment.interpolation,
  }))).toEqual([
    { startFrame: 0, endFrame: 24_000, interpolation: 'hold' },
    { startFrame: 24_000, endFrame: 48_000, interpolation: 'linear' },
  ])
})

test('still rejects enabled automation that is not a VST parameter envelope', () => {
  expect(() => compileNativeOfflineRenderPlan({
    tracks: [track],
    fx: { trackFx: {}, masterFxInstances: [], masterVolume: 1 },
    automationEnvelopes: [automationEnvelope('volume', [
      { id: 'volume', timeSec: 0, value: 0.5, interpolation: 'hold' },
    ])],
    sidechainRoutes: [],
    bpm: 120,
    range: { mode: 'whole' },
    sampleRateHz: 48_000,
    channelCount: 2,
    tailFrames: 0,
    externalAttachments: attachmentPlan(),
  })).toThrow('Native Phase A export supports VST3 parameter automation only.')
})

test('partitions many uniquely timed source events without rescanning earlier events', () => {
  const sourceTrack: Track<AudioBuffer> = {
    id: 'source-track',
    name: 'Source Track',
    volume: 1,
    clips: Array.from({ length: 300 }, (_, index) => ({
      id: `source-clip-${index}`,
      name: 'Source Clip',
      color: '#fff',
      startSec: index * 0.01,
      duration: 4 / 48_000,
      sourceAssetKey: 'asset-1',
      buffer: new TestAudioBuffer(),
    } satisfies Clip<AudioBuffer>)),
  }
  const plan = compileNativeOfflineRenderPlan({
    tracks: [sourceTrack],
    fx: { trackFx: {}, masterFxInstances: [], masterVolume: 1 },
    automationEnvelopes: [],
    sidechainRoutes: [],
    bpm: 120,
    range: { mode: 'whole' },
    sampleRateHz: 48_000,
    channelCount: 2,
    tailFrames: 0,
  })

  expect(plan.scheduleWindows?.length).toBe(2)
})
