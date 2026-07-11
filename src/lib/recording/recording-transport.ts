import type {
  RecordingCaptureTransport,
  RecordingMessageEndpoint,
} from '../../../packages/audio-engine/src/recording/recording-runtime'
import { createRecordingSabTransport } from './recording-sab-transport'
import { createRecordingTransferTransport } from './recording-transfer-transport'

type RecordingTransportOptions = {
  generation: number
  sessionId: string
  sampleRate: number
  channelCount: number
  worklet: RecordingMessageEndpoint
}

type RecordingTransportDiagnostics = {
  requested: 'sab' | 'transferable'
  active: 'sab' | 'transferable'
  sab: {
    enabled: boolean
    crossOriginIsolated: boolean
    available: boolean
  }
}

type RecordingTransportEnvironment = {
  sabEnabled: boolean
  crossOriginIsolated: boolean
  sharedArrayBufferAvailable: boolean
}

export const getRecordingTransportDiagnostics = (
  environment: RecordingTransportEnvironment = {
    sabEnabled: import.meta.env.VITE_ENABLE_RECORDING_SAB === 'true',
    crossOriginIsolated: typeof crossOriginIsolated === 'boolean' && crossOriginIsolated,
    sharedArrayBufferAvailable: typeof SharedArrayBuffer === 'function',
  },
): RecordingTransportDiagnostics => {
  const active = environment.sabEnabled &&
    environment.crossOriginIsolated &&
    environment.sharedArrayBufferAvailable
    ? 'sab'
    : 'transferable'
  return {
    requested: environment.sabEnabled ? 'sab' : 'transferable',
    active,
    sab: {
      enabled: environment.sabEnabled,
      crossOriginIsolated: environment.crossOriginIsolated,
      available: environment.sharedArrayBufferAvailable,
    },
  }
}

export const createRecordingTransport = (
  options: RecordingTransportOptions,
  environment?: RecordingTransportEnvironment,
): { transport: RecordingCaptureTransport; diagnostics: RecordingTransportDiagnostics } => {
  const diagnostics = getRecordingTransportDiagnostics(environment)
  return {
    transport: diagnostics.active === 'sab'
      ? createRecordingSabTransport(options)
      : createRecordingTransferTransport(options),
    diagnostics,
  }
}
