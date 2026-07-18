import type { UploadToR2 } from '~/hooks/useClipBuffers'

type UploadClipSampleUrlOptions = {
  projectId: string
  assetKey: string
  file: File
  duration?: number
  uploadToR2: UploadToR2
}

export async function uploadClipSampleUrl(options: UploadClipSampleUrlOptions) {
  const upload = await options.uploadToR2(options.projectId, options.assetKey, options.file, options.duration)
  if (!upload) {
    throw new Error('sample-upload-failed')
  }
  return upload
}
