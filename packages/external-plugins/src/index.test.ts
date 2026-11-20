import { describe, expect, test } from 'bun:test'
import { assertBrowserExportHasNoLiveExternalPlugins } from './index'

describe('external plugin safety boundaries', () => {
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
