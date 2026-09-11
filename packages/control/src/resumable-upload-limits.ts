export type ResumableUploadLimitsV1 = Readonly<{
  version: 'v1'
  partSizeBytes: number
  maxPartCount: number
  maxActiveSessionsPerProject: number
  maxActiveSessionsPerActor: number
}>

export const resumableUploadLimitsV1: ResumableUploadLimitsV1 = Object.freeze({
  version: 'v1',
  partSizeBytes: 8 * 1024 * 1024,
  maxPartCount: 10_000,
  maxActiveSessionsPerProject: 8,
  maxActiveSessionsPerActor: 4,
})

export const resumableUploadMaximumBytes = (
  resumableUploadLimitsV1.partSizeBytes * resumableUploadLimitsV1.maxPartCount
)
