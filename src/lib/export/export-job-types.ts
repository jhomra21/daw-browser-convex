import type { StemMode, StemRecombinationMetadata } from "@daw-browser/audio-engine/export-stem-plan"
import type { ExportRange } from '@daw-browser/audio-engine/export-range'
import type { ExportAnalysisReport } from '@daw-browser/audio-engine/export-fidelity'
import type { AudioPcmSourceDescriptor, ExportAudioFormat } from '@daw-browser/shared'
import type { RuntimeClip, RuntimeTrack } from '~/lib/timeline-runtime-types'
import type { ExternalSidechainRoute } from '@daw-browser/timeline-core/types'
import type { ExportEncodingSettings, ExportRenderSettings } from '~/lib/export/export-settings'
import type { ExportFileSink, ExportOutputTargetFactory } from '~/lib/export/export-output-targets'
import type { ExportRenderStateSnapshot } from '~/lib/desired-playback-state'
import type { NativeOfflinePcmRenderer } from '~/lib/export/desktop-native-offline-pcm-renderer'
import type { AudioStretchRuntimeClip } from '@daw-browser/audio-engine/audio-stretch-rendering'
import type { SampledInstrumentRegionBudgetScope } from '~/lib/sampled-instrument-region-budget'

export type ExportFileCommit = Awaited<ReturnType<ExportFileSink['commit']>>

export type ExportPhase =
  | 'snapshot'
  | 'source-range'
  | 'preroll'
  | 'tail'
  | 'rendering'
  | 'analyzing'
  | 'gain'
  | 'limiting'
  | 'verifying'
  | 'quantizing'
  | 'encoding'
  | 'saving'

export type ExportProgress = {
  phase: ExportPhase
  sizeBytes?: number
  currentStemName?: string
  completedStems?: number
  totalStems?: number
  currentFormat?: ExportAudioFormat
  completedFormats?: number
  totalFormats?: number
  renderedFrames?: number
  totalRenderFrames?: number
  analysis?: ExportAnalysisReport
}

export type TimelineExportRequest = {
  nativeRendererRequired?: boolean
  getTracks: () => RuntimeTrack[]
  bpm: number
  timeSignature?: { numerator: number; denominator: number }
  masterVolume: number
  range: ExportRange
  formats: readonly ExportAudioFormat[]
  render: ExportRenderSettings
  encoding: ExportEncodingSettings
  projectId?: string
  userId?: string
  projectGeneration: number
  getProjectGeneration?: () => number
  createBuffer?: (channels: number, frames: number, sampleRate: number) => AudioBuffer
  sidechainRoutes: ExternalSidechainRoute[]
  loadCapturedClipBuffer: (clip: RuntimeClip, signal: AbortSignal) => Promise<void>
  resolveAudioSource?: (clip: AudioStretchRuntimeClip, signal?: AbortSignal) => Promise<AudioPcmSourceDescriptor>
  signal: AbortSignal
  onProgress?: (progress: ExportProgress) => void
  outputTargets: ExportOutputTargetFactory
  renderStateSnapshot: ExportRenderStateSnapshot
  nativeOfflinePcmRenderer?: NativeOfflinePcmRenderer
  sampledInstrumentRegionScope?: SampledInstrumentRegionBudgetScope
}

export type StemExportSelection =
  | { stemSelection: 'all-tracks'; stemMode: StemMode }
  | { stemSelection: 'selected-tracks'; stemMode: StemMode; selectedTrackIds: readonly string[] }

export type StemExportRequest = TimelineExportRequest & StemExportSelection

export type ExportOutput =
  | { destination: 'local'; name: string; sizeBytes: number; analysis?: ExportAnalysisReport; stem?: StemRecombinationMetadata }
  | { destination: 'cloud'; name: string; url: string; sizeBytes: number; analysis?: ExportAnalysisReport; stem?: StemRecombinationMetadata }

export type ExportOutcome =
  | { type: 'success'; outputs: readonly ExportOutput[] }
  | { type: 'canceled'; outputs: readonly ExportOutput[] }
  | {
    type: 'error'
    message: string
    failureOwner?: 'native'
    outputs: readonly ExportOutput[]
  }

export const NATIVE_EXPORT_UNAVAILABLE_MESSAGE =
  'Native desktop export is unavailable until native offline rendering is implemented.'
