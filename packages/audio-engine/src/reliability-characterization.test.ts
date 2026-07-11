import { describe, expect, test } from 'bun:test'
import {
  createReliabilityCharacterizationReport,
  createReliabilityResourceLedger,
  RELIABILITY_RESOURCE_KINDS,
  RELIABILITY_SAMPLE_RATES,
  runCancellableExportStages,
  type CancellableExportStage,
} from './reliability-characterization'
import { createRuntimeFaultCounter } from './runtime-diagnostics'

describe('reliability characterization report', () => {
  test('aggregates one bounded diagnostic per live generation fault and resets cleanly', () => {
    const counter = createRuntimeFaultCounter(2)
    const generation = counter.generation()
    expect(counter.report(generation, { kind: 'compressor', code: 'processor-error', context: 'track' })).toBe(true)
    expect(counter.report(generation, { kind: 'compressor', code: 'processor-error', context: 'track' })).toBe(true)
    expect(counter.report(generation, { kind: 'owned-processor', code: 'nonfinite-input', context: 'gate' })).toBe(true)
    expect(counter.snapshot()).toEqual({
      eventCount: 3,
      uniqueSignatureCount: 2,
      byKind: { compressor: 2, 'owned-processor': 1, 'track-meter': 0, recorder: 0 },
      last: { kind: 'owned-processor', code: 'nonfinite-input', context: 'gate' },
    })
    const nextGeneration = counter.reset()
    expect(counter.report(generation, { kind: 'recorder', code: 'stale' })).toBe(false)
    expect(counter.report(nextGeneration, { kind: 'track-meter', code: 'processor-error' })).toBe(true)
    expect(counter.snapshot().eventCount).toBe(1)
    expect(counter.reset()).toBe(nextGeneration + 1)
    expect(counter.snapshot()).toEqual({
      eventCount: 0,
      uniqueSignatureCount: 0,
      byKind: { compressor: 0, 'owned-processor': 0, 'track-meter': 0, recorder: 0 },
      last: null,
    })
  })

  test('declares bounded fixtures at every supported characterization rate', () => {
    const report = createReliabilityCharacterizationReport()
    expect(report.performance.processorBudgets.cpuPercentagesClaimed).toBe(false)
    expect(report.performance.processorBudgets.measurement).toBe('elapsed-time-environment-specific')
    expect(report.performance.processorBudgets.liveFixtures.map((fixture) => fixture.sampleRate))
      .toEqual([...RELIABILITY_SAMPLE_RATES])
    expect(report.performance.processorBudgets.liveFixtures.every((fixture) =>
      fixture.tracks * fixture.effectsPerTrack <= fixture.maximumOwnedWorklets)).toBe(true)
  })

  test('uses duration-independent bounded recording memory', () => {
    const report = createReliabilityCharacterizationReport()
    const resources = report.performance.boundedResources
    expect(report.performance.fixedMemoryModels.recordingCaptureBytes).toBe(
      resources.recorderPoolBlocks
        * resources.recorderBlockFrames
        * resources.recorderMaximumChannels
        * Float32Array.BYTES_PER_ELEMENT,
    )
    expect(report.performance.fixedMemoryModels.recordingCaptureBytes)
      .toBeLessThanOrEqual(resources.recorderPoolMaximumBytes)
    expect(report.performance.fixedMemoryModels.durationIndependentQueues).toBe(true)
  })

  test('separates deterministic evidence from genuine browser-only work', () => {
    const report = createReliabilityCharacterizationReport()
    expect(report.lifecycle['device-unplug']).toBe('production-test')
    expect(report.lifecycle['permission-revocation']).toBe('pending')
    expect(report.lifecycle['visibility-background-transition']).toBe('pending')
    expect(report.lifecycle['worker-termination']).toBe('production-test')
    expect(report.ownership.resources).toEqual([
      'recording-runtime',
      'metering-runtime',
      'live-mixer-track-nodes',
      'master-meter-node',
      'offline-export-context',
    ])
    expect(report.ownership.productionGlobalMonkeypatch).toBe(false)
    expect(report.ownership.closeContract).toBe('idempotent')
    expect(report.ownership.pollingLoopsAllowed).toBe(false)
  })

  test('resource ledger proves every owned resource is released idempotently on terminal paths', () => {
    for (const terminal of ['complete', 'cancelled', 'failed']) {
      const ledger = createReliabilityResourceLedger()
      const releases = RELIABILITY_RESOURCE_KINDS.map((kind) => ledger.acquire(kind, { terminal, kind }))
      for (const release of releases.reverse()) {
        release()
        release()
      }
      expect(ledger.snapshot()).toEqual({
        'media-streams': 0,
        'audio-contexts': 0,
        'audio-worklet-nodes': 0,
        workers: 0,
        'object-urls': 0,
        'event-listeners': 0,
        'monitor-paths': 0,
        'ring-buffers': 0,
      })
      expect(() => ledger.assertEmpty()).not.toThrow()
    }
  })

  test('export cancellation cleans up at rendering, analysis, encoding, and saving', async () => {
    const stages: readonly CancellableExportStage[] = ['rendering', 'analysis', 'encoding', 'saving']
    for (const cancelledStage of stages) {
      const controller = new AbortController()
      const visited: CancellableExportStage[] = []
      let cleanupCount = 0
      const run = (stage: CancellableExportStage) => async () => {
        visited.push(stage)
        if (stage === cancelledStage) controller.abort(new DOMException('Cancelled', 'AbortError'))
      }
      await expect(runCancellableExportStages(controller.signal, {
        rendering: run('rendering'),
        analysis: run('analysis'),
        encoding: run('encoding'),
        saving: run('saving'),
      }, async () => {
        cleanupCount += 1
      })).rejects.toHaveProperty('name', 'AbortError')
      expect(visited.at(-1)).toBe(cancelledStage)
      expect(cleanupCount).toBe(1)
    }
  })

  test('owned worklet process loops contain no logging, timers, or explicit allocations', async () => {
    const worklets = [
      'daw-compressor-processor-v1.js',
      'daw-recorder-processor-v1.js',
      'daw-lofi-processor-v1.js',
      'daw-autofilter-processor-v1.js',
      'daw-modulation-processor-v1.js',
      'daw-utility-processor-v1.js',
      'daw-gate-processor-v1.js',
      'daw-limiter-processor-v1.js',
      'track-meter-processor-v2.js',
    ]
    for (const fileName of worklets) {
      const source = await Bun.file(new URL(`../../../public/audio-worklets/${fileName}`, import.meta.url)).text()
      const processBodies = [...source.matchAll(/process\s*\([^)]*\)\s*\{([\s\S]*?)\n\s{2}\}/g)].map((match) => match[1] ?? '')
      expect(processBodies.length).toBeGreaterThan(0)
      for (const body of processBodies) {
        expect(body).not.toMatch(/\bconsole\.|\bsetTimeout\b|\bsetInterval\b|\brequestAnimationFrame\b/)
        expect(body).not.toMatch(/\bnew\s+(?:Array|Float32Array|Float64Array|Uint8Array|Map|Set)\b/)
      }
    }
  })
})
