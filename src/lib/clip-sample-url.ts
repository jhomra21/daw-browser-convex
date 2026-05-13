import type { UploadToR2 } from '~/hooks/useClipBuffers'

type UploadClipSampleUrlOptions = {
  roomId: string
  assetKey: string
  file: File
  duration?: number
  uploadToR2: UploadToR2
}

export async function uploadClipSampleUrl(options: UploadClipSampleUrlOptions) {
  const sampleUrl = await options.uploadToR2(options.roomId, options.assetKey, options.file, options.duration)
  if (!sampleUrl) {
    throw new Error('sample-upload-failed')
  }
  return sampleUrl
}
