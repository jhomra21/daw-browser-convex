export type CapturedClipMediaReference = {
  projectId?: string
  sampleUrl?: string
  sourceAssetKey?: string
  targetSampleRate?: number
}

export type CapturedClipBufferLoadResult =
  | { status: 'ready'; buffer: AudioBuffer }
  | { status: 'missing' }
  | { status: 'permission-denied' }

type UploadToR2Result = { assetKey: string; url: string } | null

export type UploadToR2 = (
  projectId: string,
  assetKey: string,
  file: File,
  durationSec?: number,
  signal?: AbortSignal,
) => Promise<UploadToR2Result>
