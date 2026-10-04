import { loadWorkletModule } from './worklet-loader'
import { resolveWorkletModuleUrl, trackMeterWorklet } from './worklet-manifest'

export const AUDIO_BROWSER_SUPPORT_POLICY = {
  productionTarget: 'chrome-stable',
  smokeTargets: ['safari-current', 'firefox-current'],
  unsupportedFeatureBehavior: 'report-and-degrade',
  crossOriginIsolation: 'deferred',
} as const

export type AudioPlatformCapabilities = {
  audioWorklet: boolean
  offlineAudioWorklet: boolean
  transferableBuffers: boolean
  sharedArrayBuffer: boolean
  crossOriginIsolated: boolean
  outputSelection: boolean
  sinkRouting: boolean
  mediaTrackSettings: boolean
}

export type AudioCapabilityEvidence = {
  supported: boolean
  probe: 'active' | 'runtime' | 'structural'
  message?: string
}

export type AudioPlatformCapabilityReport = {
  policy: typeof AUDIO_BROWSER_SUPPORT_POLICY
  capabilities: AudioPlatformCapabilities
  evidence: Readonly<Record<keyof AudioPlatformCapabilities, AudioCapabilityEvidence>>
}

const probeLiveAudioWorklet = async (): Promise<AudioCapabilityEvidence> => {
  if (!('AudioContext' in globalThis)) {
    return { supported: false, probe: 'active', message: 'AudioContext is unavailable.' }
  }
  let context: AudioContext | null = null
  try {
    context = new AudioContext({ latencyHint: 'interactive' })
    if (!context.audioWorklet) {
      return { supported: false, probe: 'active', message: 'AudioContext.audioWorklet is unavailable.' }
    }
    await loadWorkletModule(context, resolveWorkletModuleUrl(trackMeterWorklet.modulePath))
    return { supported: true, probe: 'active' }
  } catch (error) {
    return {
      supported: false,
      probe: 'active',
      message: error instanceof Error ? error.message : 'AudioWorklet probe failed.',
    }
  } finally {
    if (context && context.state !== 'closed') {
      await context.close().catch(() => undefined)
    }
  }
}

const probeOfflineAudioWorklet = async (): Promise<AudioCapabilityEvidence> => {
  if (!('OfflineAudioContext' in globalThis)) {
    return { supported: false, probe: 'active', message: 'OfflineAudioContext is unavailable.' }
  }
  try {
    const context = new OfflineAudioContext(1, 128, 48_000)
    if (!context.audioWorklet) {
      return { supported: false, probe: 'active', message: 'OfflineAudioContext.audioWorklet is unavailable.' }
    }
    await loadWorkletModule(context, resolveWorkletModuleUrl(trackMeterWorklet.modulePath))
    return { supported: true, probe: 'active' }
  } catch (error) {
    return {
      supported: false,
      probe: 'active',
      message: error instanceof Error ? error.message : 'Offline AudioWorklet probe failed.',
    }
  }
}

const probeTransferableBuffers = (): AudioCapabilityEvidence => {
  if (!('MessageChannel' in globalThis)) {
    return { supported: false, probe: 'active', message: 'MessageChannel is unavailable.' }
  }
  const channel = new MessageChannel()
  try {
    const buffer = new ArrayBuffer(1)
    channel.port1.postMessage(buffer, [buffer])
    return {
      supported: buffer.byteLength === 0,
      probe: 'active',
      message: buffer.byteLength === 0 ? undefined : 'ArrayBuffer was not detached after transfer.',
    }
  } catch (error) {
    return {
      supported: false,
      probe: 'active',
      message: error instanceof Error ? error.message : 'ArrayBuffer transfer probe failed.',
    }
  } finally {
    channel.port1.close()
    channel.port2.close()
  }
}

const runtimeEvidence = (supported: boolean, unsupportedMessage: string): AudioCapabilityEvidence => ({
  supported,
  probe: 'runtime',
  message: supported ? undefined : unsupportedMessage,
})

const structuralEvidence = (supported: boolean, unsupportedMessage: string): AudioCapabilityEvidence => ({
  supported,
  probe: 'structural',
  message: supported ? undefined : unsupportedMessage,
})

export async function probeAudioPlatformCapabilities(): Promise<AudioPlatformCapabilityReport> {
  const [audioWorklet, offlineAudioWorklet] = await Promise.all([
    probeLiveAudioWorklet(),
    probeOfflineAudioWorklet(),
  ])
  const transferableBuffers = probeTransferableBuffers()
  const sharedArrayBuffer = runtimeEvidence(
    'SharedArrayBuffer' in globalThis,
    'SharedArrayBuffer is unavailable in this browsing context.',
  )
  const crossOriginIsolation = runtimeEvidence(
    globalThis.crossOriginIsolated === true,
    'The browsing context is not cross-origin isolated.',
  )
  const mediaDevices = 'navigator' in globalThis ? globalThis.navigator.mediaDevices : undefined
  const outputSelectionSupported = mediaDevices !== undefined
    && 'selectAudioOutput' in mediaDevices
  const outputSelection = structuralEvidence(
    outputSelectionSupported,
    'navigator.mediaDevices.selectAudioOutput is unavailable.',
  )
  const sinkRoutingSupported = 'AudioContext' in globalThis
    && 'setSinkId' in AudioContext.prototype
  const sinkRouting = structuralEvidence(
    sinkRoutingSupported,
    'AudioContext.setSinkId is unavailable.',
  )
  const mediaTrackSettingsSupported = 'MediaStreamTrack' in globalThis
    && 'getSettings' in MediaStreamTrack.prototype
  const mediaTrackSettings = structuralEvidence(
    mediaTrackSettingsSupported,
    'MediaStreamTrack.getSettings is unavailable.',
  )

  const evidence = {
    audioWorklet,
    offlineAudioWorklet,
    transferableBuffers,
    sharedArrayBuffer,
    crossOriginIsolated: crossOriginIsolation,
    outputSelection,
    sinkRouting,
    mediaTrackSettings,
  } satisfies Record<keyof AudioPlatformCapabilities, AudioCapabilityEvidence>

  return {
    policy: AUDIO_BROWSER_SUPPORT_POLICY,
    capabilities: {
      audioWorklet: audioWorklet.supported,
      offlineAudioWorklet: offlineAudioWorklet.supported,
      transferableBuffers: transferableBuffers.supported,
      sharedArrayBuffer: sharedArrayBuffer.supported,
      crossOriginIsolated: crossOriginIsolation.supported,
      outputSelection: outputSelection.supported,
      sinkRouting: sinkRouting.supported,
      mediaTrackSettings: mediaTrackSettings.supported,
    },
    evidence,
  }
}
