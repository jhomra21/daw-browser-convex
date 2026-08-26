import { expect, test } from 'bun:test'
import type { NativeExternalAttachmentPlan } from '@daw-browser/plugin-host-protocol'
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
