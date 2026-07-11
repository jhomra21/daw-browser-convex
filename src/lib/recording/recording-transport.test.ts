import { describe, expect, test } from 'bun:test'
import { getRecordingTransportDiagnostics } from './recording-transport'

describe('recording transport capability selection', () => {
  test('selects SAB only when enabled and isolated', () => {
    expect(getRecordingTransportDiagnostics({
      sabEnabled: true,
      crossOriginIsolated: true,
      sharedArrayBufferAvailable: true,
    })).toEqual({
      requested: 'sab',
      active: 'sab',
      sab: { enabled: true, crossOriginIsolated: true, available: true },
    })
  })

  test('falls back deterministically when non-isolated', () => {
    expect(getRecordingTransportDiagnostics({
      sabEnabled: true,
      crossOriginIsolated: false,
      sharedArrayBufferAvailable: true,
    })).toMatchObject({ requested: 'sab', active: 'transferable' })
  })

  test('defaults to transferable when the deployment gate is disabled', () => {
    expect(getRecordingTransportDiagnostics({
      sabEnabled: false,
      crossOriginIsolated: true,
      sharedArrayBufferAvailable: true,
    })).toMatchObject({ requested: 'transferable', active: 'transferable' })
  })
})
