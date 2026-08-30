import { expect, test } from 'bun:test'
import type { NativeExternalAttachmentPlan } from '@daw-browser/plugin-host-protocol'
import { externalAutomationParameterId, type AutomationEnvelope } from '@daw-browser/shared'
import type { Clip, Track } from '@daw-browser/timeline-core/types'
import type { PortablePreparedStretchAsset } from '@daw-browser/audio-engine/portable-stretch-preparation'
import { compilePortableExportSnapshot } from '@daw-browser/audio-engine/portable-export-snapshot'

import { compileNativeOfflineRenderPlan } from '~/lib/export/native-offline-render-plan'

const defaultChannels = () => {
  const left = new Float32Array(new ArrayBuffer(4 * Float32Array.BYTES_PER_ELEMENT))
  const right = new Float32Array(new ArrayBuffer(4 * Float32Array.BYTES_PER_ELEMENT))
  left.set([0, 0.25, -0.5, 1])
  right.set([1, -0.5, 0.25, 0])
  return [left, right]
}

class TestAudioBuffer implements AudioBuffer {
  readonly duration: number
  readonly length: number
  readonly numberOfChannels: number
  readonly sampleRate: number
  private readonly channels: readonly Float32Array<ArrayBuffer>[]

  constructor(
    channels: readonly Float32Array<ArrayBuffer>[] = [
      ...defaultChannels(),
    ],
    sampleRate = 48_000,
  ) {
    this.channels = channels
    this.length = channels[0]?.length ?? 0
    this.numberOfChannels = channels.length
    this.sampleRate = sampleRate
    this.duration = this.length / sampleRate
  }

  copyFromChannel(destination: Float32Array<ArrayBuffer>, channel: number, bufferOffset = 0) {
    destination.set(this.channels[channel]?.subarray(bufferOffset, bufferOffset + destination.length))
  }

  copyToChannel(source: Float32Array<ArrayBuffer>, channel: number, bufferOffset = 0) {
    this.channels[channel]?.set(source, bufferOffset)
  }

  getChannelData(channel: number): Float32Array<ArrayBuffer> {
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

const preparedStretchAsset = (
  clipId: string,
  projectGeneration: number,
  frameCount = 4,
  sampleRateHz = 48_000,
  timelineStartSec = 0,
): PortablePreparedStretchAsset => {
  const planes = frameCount === 4
    ? [
      new Float32Array([0.5, 0.25, 0, -0.25]),
      new Float32Array([-0.5, -0.25, 0, 0.25]),
    ]
    : [
      new Float32Array(frameCount),
      new Float32Array(frameCount),
    ]
  const assetId = `portable-stretch:${projectGeneration}:${clipId}`
  return {
    clipId,
    sourceAssetKey: 'asset-1',
    sourceDurationSec: frameCount / sampleRateHz,
    projectGeneration,
    projectAssetId: assetId,
    portableAssetId: assetId,
    asset: {
      version: 1,
      assetId,
      frameCount,
      sampleRateHz,
      channelCount: 2,
    },
    pcm: { frameCount, planes },
    transferables: planes.map((plane) => plane.buffer),
    timelineStartSec,
    timelineDurationSec: frameCount / sampleRateHz,
    sourceStartSec: 0,
  }
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
  let offset = 60 + instrumentCount * 48 + sourceCount * 112
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

const sourceEventsFromSchedule = (payload: Uint8Array) => {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  const instrumentCount = view.getUint32(44, true)
  const sourceCount = view.getUint32(48, true)
  return Array.from({ length: sourceCount }, (_, index) => {
    const offset = 60 + instrumentCount * 48 + index * 112
    return {
      assetSessionId: view.getUint32(offset + 20, true),
      sequence: Number(view.getBigUint64(offset + 4, true)),
      startFrame: Number(view.getBigInt64(offset + 24, true)),
      stopFrame: Number(view.getBigInt64(offset + 32, true)),
      sourceOffsetFrame: Number(view.getBigUint64(offset + 40, true)),
      sourceFrameCount: Number(view.getBigUint64(offset + 48, true)),
    }
  })
}

const sourceEventFromSchedule = (payload: Uint8Array) => {
  const events = sourceEventsFromSchedule(payload)
  if (events.length !== 1) throw new Error(`Expected one source event, got ${events.length}.`)
  const event = events[0]
  if (!event) throw new Error('Expected one decoded source event.')
  return event
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
    projectGeneration: 1,
    externalAttachments: attachmentPlan(),
  })

  expect(() => structuredClone(plan)).not.toThrow()
  expect(structuredClone(plan)).toEqual(plan)
})

test('chunks long stereo assets for a custom offline export range', () => {
  const frameCount = 12 * 48_000
  const longTrack: Track<AudioBuffer> = {
    ...track,
    clips: [{
      ...track.clips[0]!,
      duration: frameCount / 48_000,
      buffer: new TestAudioBuffer([
        new Float32Array(frameCount),
        new Float32Array(frameCount),
      ]),
    } satisfies Clip<AudioBuffer>],
  }
  const plan = compileNativeOfflineRenderPlan({
    tracks: [longTrack],
    fx: { trackFx: {}, masterFxInstances: [], masterVolume: 1 },
    automationEnvelopes: [],
    sidechainRoutes: [],
    bpm: 120,
    range: { mode: 'custom', startSec: 2, endSec: 10 },
    sampleRateHz: 48_000,
    channelCount: 2,
    tailFrames: 0,
    projectGeneration: 1,
  })

  expect(plan.totalFrames).toBe(8 * 48_000)
  expect(plan.assets).toHaveLength(5)
  expect(plan.assets.every((asset) => asset.frameCount <= 131_069)).toBe(true)
  expect(new DataView(plan.schedule.buffer).getUint32(48, true)).toBeGreaterThan(1)
})

test('accepts prepared Stretch PCM with custom range timing', () => {
  const warpedTrack: Track<AudioBuffer> = {
    ...track,
    clips: [{
      ...track.clips[0]!,
      audioWarp: { enabled: true, mode: 'stretch', sourceBpm: 120 },
    } satisfies Clip<AudioBuffer>],
  }
  const plan = compileNativeOfflineRenderPlan({
    tracks: [warpedTrack],
    fx: { trackFx: {}, masterFxInstances: [], masterVolume: 1 },
    automationEnvelopes: [],
    sidechainRoutes: [],
    bpm: 120,
    range: { mode: 'whole' },
    sampleRateHz: 48_000,
    channelCount: 2,
    tailFrames: 0,
    projectGeneration: 7,
    preparedStretchAssets: [preparedStretchAsset('clip-1', 7)],
  })

  expect(plan.assets).toHaveLength(1)
  expect(plan.assets[0]?.planarPcm.byteLength).toBe(4 * 2 * Float32Array.BYTES_PER_ELEMENT)
  expect(plan.totalFrames).toBeGreaterThan(0)
  expect(new Float32Array(plan.assets[0]!.planarPcm.buffer)).toEqual(new Float32Array([
    0.5, 0.25, 0, -0.25, -0.5, -0.25, 0, 0.25,
  ]))
  expect(sourceEventFromSchedule(plan.schedule)).toEqual({
    assetSessionId: 1,
    sequence: 1,
    startFrame: 0,
    stopFrame: 4,
    sourceOffsetFrame: 0,
    sourceFrameCount: 4,
  })
})

test('rebases prepared Stretch source timing and offsets for a custom range', () => {
  const warpedTrack: Track<AudioBuffer> = {
    ...track,
    clips: [{
      ...track.clips[0]!,
      audioWarp: { enabled: true, mode: 'stretch', sourceBpm: 120 },
    } satisfies Clip<AudioBuffer>],
  }
  const plan = compileNativeOfflineRenderPlan({
    tracks: [warpedTrack],
    fx: { trackFx: {}, masterFxInstances: [], masterVolume: 1 },
    automationEnvelopes: [],
    sidechainRoutes: [],
    bpm: 120,
    range: { mode: 'custom', startSec: 1 / 48_000, endSec: 3 / 48_000 },
    sampleRateHz: 48_000,
    channelCount: 2,
    tailFrames: 0,
    projectGeneration: 7,
    preparedStretchAssets: [preparedStretchAsset('clip-1', 7)],
  })

  expect(sourceEventFromSchedule(plan.schedule)).toMatchObject({
    startFrame: 0,
    stopFrame: 3,
    sourceOffsetFrame: 1,
    sourceFrameCount: 3,
  })
})

test('chunks long prepared Stretch PCM instead of rejecting the asset', () => {
  const frameCount = 262_144
  const warpedTrack: Track<AudioBuffer> = {
    ...track,
    clips: [{
      ...track.clips[0]!,
      duration: frameCount / 48_000,
      audioWarp: { enabled: true, mode: 'stretch', sourceBpm: 120 },
    } satisfies Clip<AudioBuffer>],
  }
  const plan = compileNativeOfflineRenderPlan({
    tracks: [warpedTrack],
    fx: { trackFx: {}, masterFxInstances: [], masterVolume: 1 },
    automationEnvelopes: [],
    sidechainRoutes: [],
    bpm: 120,
    range: { mode: 'whole' },
    sampleRateHz: 48_000,
    channelCount: 2,
    tailFrames: 0,
    projectGeneration: 7,
    preparedStretchAssets: [preparedStretchAsset('clip-1', 7, frameCount)],
  })

  expect(plan.assets.length).toBeGreaterThan(1)
  expect(plan.assets.every((asset) => asset.frameCount <= 131_069)).toBe(true)
  expect(new DataView(plan.schedule.buffer).getUint32(48, true)).toBeGreaterThan(1)
})

test('preserves the existing no-warp native source projection', () => {
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
    projectGeneration: 1,
  })

  expect(plan.assets).toHaveLength(1)
  expect(sourceEventFromSchedule(plan.schedule)).toMatchObject({
    startFrame: 0,
    stopFrame: 4,
    sourceOffsetFrame: 0,
    sourceFrameCount: 4,
  })
})

test('re-sequences offline source events in chronological enqueue order across chunk windows', () => {
  const sampleRateHz = 44_100
  const stretchStartSec = 29.5
  const stretchFrameCount = 110_250
  const longStartSec = 70.5
  const longFrameCount = 4 * 48_000
  const traversalOrderTracks: Track<AudioBuffer>[] = [
    {
      ...track,
      id: 'early-track',
      clips: [{
        ...track.clips[0]!,
        id: 'early-clip',
        startSec: 4,
      } satisfies Clip<AudioBuffer>],
    },
    {
      ...track,
      id: 'second-track',
      clips: [{
        ...track.clips[0]!,
        id: 'second-clip',
        startSec: 8,
      } satisfies Clip<AudioBuffer>],
    },
    {
      ...track,
      id: 'long-track',
      clips: [{
        ...track.clips[0]!,
        id: 'long-clip',
        startSec: longStartSec,
        duration: longFrameCount / 48_000,
        sourceAssetKey: 'asset-long',
        buffer: new TestAudioBuffer([
          new Float32Array(longFrameCount),
          new Float32Array(longFrameCount),
        ]),
      } satisfies Clip<AudioBuffer>],
    },
    {
      ...track,
      id: 'stretch-track',
      clips: [{
        ...track.clips[0]!,
        id: 'stretch-clip',
        startSec: stretchStartSec,
        duration: stretchFrameCount / sampleRateHz,
        audioWarp: { enabled: true, mode: 'stretch', sourceBpm: 120 },
      } satisfies Clip<AudioBuffer>],
    },
    {
      ...track,
      id: 'trailing-track',
      clips: Array.from({ length: 2_050 }, (_, index) => ({
        ...track.clips[0]!,
        id: `trailing-clip-${index}`,
        startSec: 100 + index * 0.01,
      } satisfies Clip<AudioBuffer>)),
    },
  ]
  const plan = compileNativeOfflineRenderPlan({
    tracks: traversalOrderTracks,
    fx: { trackFx: {}, masterFxInstances: [], masterVolume: 1 },
    automationEnvelopes: [],
    sidechainRoutes: [],
    bpm: 120,
    range: { mode: 'whole' },
    sampleRateHz,
    channelCount: 2,
    tailFrames: 0,
    projectGeneration: 7,
    preparedStretchAssets: [preparedStretchAsset(
      'stretch-clip',
      7,
      stretchFrameCount,
      sampleRateHz,
      stretchStartSec,
    )],
  })
  const payloads = plan.scheduleWindows ?? [plan.schedule]
  const events = payloads.flatMap(sourceEventsFromSchedule)
  const assetBySessionId = new Map(plan.assets.map((asset, index) => [index + 1, asset]))

  expect(events.map((event) => event.startFrame)).toEqual(
    [...events].map((event) => event.startFrame).sort((left, right) => left - right),
  )
  expect(events.every((event, index) => index === 0 || event.sequence > events[index - 1]!.sequence)).toBe(true)
  expect(events.every((event) => {
    const asset = assetBySessionId.get(event.assetSessionId)
    return asset !== undefined
      && event.sourceOffsetFrame >= 0
      && event.sourceFrameCount > 0
      && event.sourceOffsetFrame + event.sourceFrameCount <= asset.frameCount
  })).toBe(true)
  const stretchEvent = events.find((event) => event.startFrame === Math.round(stretchStartSec * sampleRateHz))
  expect(stretchEvent).toMatchObject({
    stopFrame: Math.round((stretchStartSec + stretchFrameCount / sampleRateHz) * sampleRateHz),
    sourceFrameCount: stretchFrameCount,
  })
  expect(events.filter((event) => {
    const startFrame = Math.round(longStartSec * sampleRateHz)
    return event.startFrame >= startFrame
      && event.startFrame < startFrame + 4 * sampleRateHz
  })).toHaveLength(2)
  expect(payloads.length).toBeGreaterThan(1)
})

test('returns native Stretch diagnostics for missing, stale, and unsupported warp assets', () => {
  const stretchTrack: Track<AudioBuffer> = {
    ...track,
    clips: [{
      ...track.clips[0]!,
      audioWarp: { enabled: true, mode: 'stretch', sourceBpm: 120 },
    } satisfies Clip<AudioBuffer>],
  }
  expect(() => compileNativeOfflineRenderPlan({
    tracks: [stretchTrack],
    fx: { trackFx: {}, masterFxInstances: [], masterVolume: 1 },
    automationEnvelopes: [],
    sidechainRoutes: [],
    bpm: 120,
    range: { mode: 'whole' },
    sampleRateHz: 48_000,
    channelCount: 2,
    tailFrames: 0,
    projectGeneration: 7,
  })).toThrow('portable export requires a pre-rendered Stretch asset')
  expect(() => compileNativeOfflineRenderPlan({
    tracks: [stretchTrack],
    fx: { trackFx: {}, masterFxInstances: [], masterVolume: 1 },
    automationEnvelopes: [],
    sidechainRoutes: [],
    bpm: 120,
    range: { mode: 'whole' },
    sampleRateHz: 48_000,
    channelCount: 2,
    tailFrames: 0,
    projectGeneration: 8,
    preparedStretchAssets: [preparedStretchAsset('clip-1', 7)],
  })).toThrow('stale project generation')
  expect(() => compileNativeOfflineRenderPlan({
    tracks: [{
      ...track,
      clips: [{
        ...track.clips[0]!,
        audioWarp: { enabled: true, mode: 'repitch', sourceBpm: 120 },
      } satisfies Clip<AudioBuffer>],
    }],
    fx: { trackFx: {}, masterFxInstances: [], masterVolume: 1 },
    automationEnvelopes: [],
    sidechainRoutes: [],
    bpm: 120,
    range: { mode: 'whole' },
    sampleRateHz: 48_000,
    channelCount: 2,
    tailFrames: 0,
    projectGeneration: 7,
    preparedStretchAssets: [],
  })).toThrow('repitch warp is not supported')
})

test('preserves structured missing-asset diagnostics at the portable snapshot boundary', () => {
  const result = compilePortableExportSnapshot({
    tracks: [{
      ...track,
      clips: [{
        ...track.clips[0]!,
        audioWarp: { enabled: true, mode: 'stretch', sourceBpm: 120 },
      } satisfies Clip<AudioBuffer>],
    }],
    bpm: 120,
    range: { mode: 'whole' },
    sampleRateHz: 48_000,
    revision: 1,
    epoch: 1,
    firstSequence: 1,
    projectGeneration: 7,
    capabilityTarget: 'native',
  })

  expect(result).toMatchObject({
    supported: false,
    diagnostics: [{
      code: 'stretch-prepared-asset-required',
      clipId: 'clip-1',
    }],
  })
})

test('keeps VST and native processor automation with prepared Stretch', () => {
  const attachment = attachmentPlan()
  const warpedTrack: Track<AudioBuffer> = {
    ...track,
    clips: [{
      ...track.clips[0]!,
      audioWarp: { enabled: true, mode: 'stretch', sourceBpm: 120 },
    } satisfies Clip<AudioBuffer>],
  }
  const parameterId = externalAutomationParameterId(attachment.attachments[0]!.instanceId, 7)
  const plan = compileNativeOfflineRenderPlan({
    tracks: [warpedTrack],
    fx: { trackFx: {}, masterFxInstances: [], masterVolume: 1 },
    automationEnvelopes: [
      automationEnvelope(parameterId, [{ id: 'vst', timeSec: 0, value: 0.5, interpolation: 'hold' }]),
      automationEnvelope('volume', [{ id: 'mixer', timeSec: 0, value: 0.5, interpolation: 'hold' }]),
    ],
    sidechainRoutes: [],
    bpm: 120,
    range: { mode: 'whole' },
    sampleRateHz: 48_000,
    channelCount: 2,
    tailFrames: 0,
    projectGeneration: 7,
    preparedStretchAssets: [preparedStretchAsset('clip-1', 7)],
    externalAttachments: attachment,
  })

  const view = new DataView(plan.schedule.buffer)
  expect(plan.assets).toHaveLength(1)
  expect(view.getUint32(52, true)).toBeGreaterThan(0)
  expect(view.getUint32(56, true)).toBeGreaterThan(0)
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
    projectGeneration: 1,
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
    projectGeneration: 1,
    externalAttachments: plan,
  })

  expect(exportPlan.blockFrames).toBe(512)
  expect(automationSegmentsFromSchedule(exportPlan.schedule).map((segment) => ({
    startFrame: segment.startFrame,
    endFrame: segment.endFrame,
    interpolation: segment.interpolation,
  }))).toEqual([
    { startFrame: 0, endFrame: 24_000, interpolation: 'hold' },
    { startFrame: 24_000, endFrame: 48_000, interpolation: 'linear' },
  ])
})

test('rejects VST automation that exceeds the worker callback event capacity', () => {
  const plan = attachmentPlan()
  const constrainedPlan: NativeExternalAttachmentPlan = {
    ...plan,
    attachments: plan.attachments.map((attachment) => ({
      ...attachment,
      workerTransport: { ...attachment.workerTransport, maximumEventsPerBlock: 1 },
    })),
  }
  const parameterId = externalAutomationParameterId(constrainedPlan.attachments[0]!.instanceId, 7)
  expect(() => compileNativeOfflineRenderPlan({
    tracks: [track],
    fx: { trackFx: {}, masterFxInstances: [], masterVolume: 1 },
    automationEnvelopes: [automationEnvelope(parameterId, [
      { id: 'start', timeSec: 0, value: 0.25, interpolation: 'linear' },
      { id: 'middle', timeSec: 0.0005, value: 0.5, interpolation: 'hold' },
      { id: 'end', timeSec: 0.001, value: 0.75, interpolation: 'hold' },
    ])],
    sidechainRoutes: [],
    bpm: 120,
    range: { mode: 'whole' },
    sampleRateHz: 48_000,
    channelCount: 2,
    tailFrames: 0,
    projectGeneration: 1,
    externalAttachments: constrainedPlan,
  })).toThrow('Native VST3 export exceeds the callback event capacity')
})

test('renders track volume automation into native processor schedule events', () => {
  const exportPlan = compileNativeOfflineRenderPlan({
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
    projectGeneration: 1,
    externalAttachments: attachmentPlan(),
  })
  const view = new DataView(exportPlan.schedule.buffer, exportPlan.schedule.byteOffset, exportPlan.schedule.byteLength)
  expect(view.getUint32(56, true)).toBe(1)
  const processorOffset = 60 + view.getUint32(48, true) * 112
  expect(Number(view.getBigUint64(processorOffset, true))).toBeGreaterThan(0)
  expect(view.getUint32(processorOffset + 8, true)).toBe(26)
  expect(view.getUint32(processorOffset + 12, true)).toBe(0)
  expect(Number(view.getBigUint64(processorOffset + 16, true))).toBe(0)
  expect(view.getFloat32(processorOffset + 32, true)).toBe(0.5)
})

test('rejects unsupported native automation targets', () => {
  expect(() => compileNativeOfflineRenderPlan({
    tracks: [track],
    fx: { trackFx: {}, masterFxInstances: [], masterVolume: 1 },
    automationEnvelopes: [automationEnvelope('unsupported.parameter', [
      { id: 'unsupported', timeSec: 0, value: 0.5, interpolation: 'hold' },
    ])],
    sidechainRoutes: [],
    bpm: 120,
    range: { mode: 'whole' },
    sampleRateHz: 48_000,
    channelCount: 2,
    tailFrames: 0,
    projectGeneration: 1,
    externalAttachments: attachmentPlan(),
  })).toThrow('Native mixer automation parameter')
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
    projectGeneration: 1,
  })

  expect(plan.scheduleWindows?.length).toBe(2)
})
