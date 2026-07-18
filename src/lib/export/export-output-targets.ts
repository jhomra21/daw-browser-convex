import type { EncodeAudioBufferTarget } from '@daw-browser/audio-engine/export-mixdown'
import type { ExportAudioFormat } from '@daw-browser/shared'

export type ExportFileSink = {
  name: string
  target: Extract<EncodeAudioBufferTarget, { mode: 'stream' }>
  commit: () => Promise<void>
  abort: (reason?: unknown) => Promise<void>
}

export type MixdownOutputTarget = {
  openFile: (fileName: string) => Promise<ExportFileSink | undefined>
  saveBuffer: (input: {
    blob: Blob
    fileName: string
    types: FilePickerAcceptType[]
    format: ExportAudioFormat
    durationSec: number
    sampleRate: number
    signal: AbortSignal
  }) => Promise<{ destination: 'local'; name: string } | { destination: 'cloud'; name: string; url: string }>
}

export type StemOutputTarget = {
  openFile: (fileName: string) => Promise<ExportFileSink>
}

export type ExportOutputTargetFactory = {
  createMixdownTarget: (input: {
    projectId?: string
    localProject: boolean
    multiFormat: boolean
    firstFileName: string
    firstFileTypes: FilePickerAcceptType[]
  }) => Promise<MixdownOutputTarget>
  createStemTarget: () => Promise<StemOutputTarget>
}
