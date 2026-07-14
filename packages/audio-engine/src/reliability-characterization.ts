import { PROCESSOR_RESOURCE_LIMITS } from './effects/processor-release-contract'
import {
  RECORDER_BLOCK_FRAMES,
  RECORDER_MAX_CHANNELS,
  RECORDER_MAX_QUEUED_BLOCKS,
  RECORDER_POOL_BLOCKS,
  RECORDER_POOL_PAYLOAD_MAX_BYTES,
} from './recording/recording-protocol'
import type { ResourceObserver } from './runtime-diagnostics'

export const RELIABILITY_SAMPLE_RATES = [44_100, 48_000, 96_000] as const
export const RELIABILITY_RESOURCE_KINDS = [
  'media-streams',
  'audio-contexts',
  'audio-worklet-nodes',
  'workers',
  'object-urls',
  'event-listeners',
  'monitor-paths',
  'ring-buffers',
] as const

export type ReliabilityResourceKind = typeof RELIABILITY_RESOURCE_KINDS[number]

export const createReliabilityResourceLedger = (): ResourceObserver & {
  snapshot: () => Record<ReliabilityResourceKind, number>
  assertEmpty: () => void
} => {
  const active = new Map<string, Set<object | string>>(
    RELIABILITY_RESOURCE_KINDS.map((kind) => [kind, new Set()]),
  )
  return {
    acquire(kind: string, resource: object | string) {
      const resources = active.get(kind) ?? new Set<object | string>()
      resources.add(resource)
      active.set(kind, resources)
      let released = false
      return () => {
        if (released) return
        released = true
        resources.delete(resource)
      }
    },
    snapshot: (): Record<ReliabilityResourceKind, number> => ({
      'media-streams': active.get('media-streams')?.size ?? 0,
      'audio-contexts': active.get('audio-contexts')?.size ?? 0,
      'audio-worklet-nodes': active.get('audio-worklet-nodes')?.size ?? 0,
      workers: active.get('workers')?.size ?? 0,
      'object-urls': active.get('object-urls')?.size ?? 0,
      'event-listeners': active.get('event-listeners')?.size ?? 0,
      'monitor-paths': active.get('monitor-paths')?.size ?? 0,
      'ring-buffers': active.get('ring-buffers')?.size ?? 0,
    }),
    assertEmpty() {
      for (const [kind, resources] of active) {
        if (resources.size !== 0) throw new Error(`Leaked reliability resource: ${kind}`)
      }
    },
  }
}

export type CancellableExportStage = 'rendering' | 'analysis' | 'encoding' | 'saving'

export const runCancellableExportStages = async (
  signal: AbortSignal,
  stages: Readonly<Record<CancellableExportStage, () => Promise<void>>>,
  onCleanup: () => Promise<void>,
) => {
  try {
    const orderedStages: readonly CancellableExportStage[] = ['rendering', 'analysis', 'encoding', 'saving']
    for (const stage of orderedStages) {
      signal.throwIfAborted()
      await stages[stage]()
      signal.throwIfAborted()
    }
  } finally {
    await onCleanup()
  }
}

export type ReliabilityCharacterizationReport = {
  version: 1
  evidenceKind: 'scoped-reliability-evidence'
  performance: {
    processorBudgets: {
      measurement: 'elapsed-time-environment-specific'
      cpuPercentagesClaimed: false
      liveFixtures: readonly {
        sampleRate: number
        tracks: number
        effectsPerTrack: number
        maximumOwnedWorklets: number
      }[]
    }
    boundedResources: {
      liveOwnedWorklets: number
      offlineOwnedWorklets: number
      recorderPoolBlocks: number
      recorderQueuedBlocks: number
      recorderBlockFrames: number
      recorderMaximumChannels: number
      recorderPoolMaximumBytes: number
    }
    fixedMemoryModels: {
      recordingCaptureBytes: number
      exportModel: 'one-render-buffer-plus-streaming-encoder'
      durationIndependentQueues: true
    }
  }
  lifecycle: Readonly<Record<string, 'production-test' | 'policy-test' | 'browser-measured' | 'pending'>>
  ownership: {
    testInstrumentation: 'production-owner-ledgers'
    productionGlobalMonkeypatch: false
    resources: readonly string[]
    closeContract: 'idempotent'
    staleMapsAllowed: false
    pollingLoopsAllowed: false
  }
}

export const createReliabilityCharacterizationReport = (): ReliabilityCharacterizationReport => ({
  version: 1,
  evidenceKind: 'scoped-reliability-evidence',
  performance: {
    processorBudgets: {
      measurement: 'elapsed-time-environment-specific',
      cpuPercentagesClaimed: false,
      liveFixtures: RELIABILITY_SAMPLE_RATES.map((sampleRate) => ({
        sampleRate,
        tracks: 16,
        effectsPerTrack: 4,
        maximumOwnedWorklets: PROCESSOR_RESOURCE_LIMITS.liveOwnedWorklets,
      })),
    },
    boundedResources: {
      liveOwnedWorklets: PROCESSOR_RESOURCE_LIMITS.liveOwnedWorklets,
      offlineOwnedWorklets: PROCESSOR_RESOURCE_LIMITS.offlineOwnedWorklets,
      recorderPoolBlocks: RECORDER_POOL_BLOCKS,
      recorderQueuedBlocks: RECORDER_MAX_QUEUED_BLOCKS,
      recorderBlockFrames: RECORDER_BLOCK_FRAMES,
      recorderMaximumChannels: RECORDER_MAX_CHANNELS,
      recorderPoolMaximumBytes: RECORDER_POOL_PAYLOAD_MAX_BYTES,
    },
    fixedMemoryModels: {
      recordingCaptureBytes: RECORDER_POOL_BLOCKS
        * RECORDER_BLOCK_FRAMES
        * RECORDER_MAX_CHANNELS
        * Float32Array.BYTES_PER_ELEMENT,
      exportModel: 'one-render-buffer-plus-streaming-encoder',
      durationIndependentQueues: true,
    },
  },
  lifecycle: {
    'context-suspend-resume': 'pending',
    'device-unplug': 'production-test',
    'permission-revocation': 'pending',
    'context-rebuild': 'pending',
    'sample-rate-change': 'pending',
    'rapid-effect-bypass-reorder': 'policy-test',
    'latency-topology-replacement': 'policy-test',
    'project-switch-during-recording': 'pending',
    'worker-termination': 'production-test',
    'sab-capture': 'production-test',
    'transferable-capture': 'production-test',
    'visibility-background-transition': 'pending',
    'export-cancel-rendering': 'pending',
    'export-cancel-analysis': 'pending',
    'export-cancel-encoding': 'pending',
    'export-cancel-saving': 'pending',
    'worklet-registration-failure': 'production-test',
    'worklet-construction-failure': 'production-test',
  },
  ownership: {
    testInstrumentation: 'production-owner-ledgers',
    productionGlobalMonkeypatch: false,
    resources: ['recording-runtime', 'metering-runtime', 'live-mixer-track-nodes', 'master-meter-node', 'offline-export-context'],
    closeContract: 'idempotent',
    staleMapsAllowed: false,
    pollingLoopsAllowed: false,
  },
})
