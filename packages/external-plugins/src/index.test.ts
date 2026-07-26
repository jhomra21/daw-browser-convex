import { describe, expect, test } from 'bun:test'
import {
  assertBrowserExportHasNoLiveExternalPlugins,
  evaluateBridgeFeasibility,
  migrateVstLaunchReference,
  scheduleExternalAutomation,
  scheduleExternalParameters,
} from './index'

describe('external plugin safety boundaries', () => {
  test('migrates legacy local discovery records into path-free launch references', () => {
    const reference = migrateVstLaunchReference({
      classId: 'class-1',
      vendor: 'Vendor',
      architecture: 'arm64',
      discoveredPath: '/Users/me/Library/Audio/Plug-Ins/VST3/Example.vst3',
      binaryFingerprint: 'a'.repeat(64),
      scannerProtocolVersion: 2,
    })
    expect(reference).toEqual({
      version: 1,
      classId: 'class-1',
      vendorId: 'Vendor',
      architecture: 'arm64',
      bundleFingerprint: 'a'.repeat(64),
      binaryFingerprint: 'a'.repeat(64),
      scannerCatalogVersion: 2,
    })
    expect(JSON.stringify(reference)).not.toContain('discoveredPath')
  })

  test('fails closed when no browser-native bridge integration point exists', () => {
    expect(evaluateBridgeFeasibility({
      candidate: 'bounded-copy-transport',
      browserSabAvailable: true,
      measuredAt: 1,
    })).toMatchObject({
      status: 'unsupported',
      reason: 'No browser-to-native audio bridge integration point exists in the current audio engine.',
    })
  })

  test('converts beat automation into quantized absolute sample offsets', () => {
    expect(scheduleExternalAutomation({
      points: [{ id: 9, value: 0.5, beat: 3, gesture: 'update' }],
      beatsToTimelineSec: (beat) => beat * 0.5,
      timelineToAbsoluteSample: (seconds) => seconds * 48_000,
      windowStartBeat: 2,
      windowEndBeat: 4,
      quantizationSamples: 64,
      maxEvents: 8,
    })).toEqual([{ id: 9, value: 0.5, sampleOffset: 72_000, gesture: 'update' }])
  })

  test('coalesces parameter updates by stable numeric parameter ID', () => {
    expect(scheduleExternalParameters({
      changes: [
        { id: 3, value: 0.1, sampleOffset: 100, gesture: 'update' },
        { id: 3, value: 0.2, sampleOffset: 200, gesture: 'end' },
        { id: 1, value: 0.5, sampleOffset: 300, gesture: 'update' },
      ],
      sampleRate: 48_000,
      windowStartSec: 0,
      lookAheadSec: 0,
      maxEvents: 8,
    })).toEqual([
      { id: 3, value: 0.2, sampleOffset: 200, gesture: 'end' },
      { id: 1, value: 0.5, sampleOffset: 300, gesture: 'update' },
    ])
  })

  test('blocks browser export until a live plugin is frozen or bypassed', () => {
    const states: Array<'ready' | 'degraded' | 'faulted' | 'architecture-mismatch'> = [
      'ready', 'degraded', 'faulted', 'architecture-mismatch',
    ]
    for (const state of states) {
      expect(() => assertBrowserExportHasNoLiveExternalPlugins([{
        instanceId: 'a7a0b9ac-7884-492c-8b68-80f15802442c',
        bypassed: false,
        health: { state, updatedAt: 1 },
      }])).toThrow('must be frozen or bypassed')
    }
  })
})
