import {
  readSharedTimelineClipCreatePayload,
  type SharedTimelineClipCreatePayload,
} from '@daw-browser/shared'
import { SharedTimelineOperationHttpError } from '~/lib/shared-timeline-operations-api'
import { ResumableAudioUploadHttpError, uploadAudioFile } from './resumable-audio-uploader'
import { readLocalRetryFile } from '~/lib/local-assets'
import { finiteNumberSchema } from '~/lib/shared-outbox-completion-schema'
import type { SharedOutboxEntry } from '~/lib/shared-outbox-entry'
import { z } from 'zod'

export type UploadedAudioClipPayload = {
  projectId: string
  assetKey: string
  file: File
  materializedPath?: string
  fileName?: string
  mimeType?: string
  duration?: number
  clipPayload: SharedTimelineClipCreatePayload
}

export const uploadedAudioClipPayloadSchema = z.object({
  projectId: z.string(),
  assetKey: z.string(),
  file: z.instanceof(File).optional(),
  materializedPath: z.string().min(1).max(256).optional(),
  fileName: z.string().min(1).max(256).optional(),
  mimeType: z.string().min(1).max(128).optional(),
  duration: finiteNumberSchema.optional(),
  clipPayload: z.custom<SharedTimelineClipCreatePayload>((value) => (
    (() => {
      const parsed = z.json().safeParse(value)

      return parsed.success
        && readSharedTimelineClipCreatePayload(parsed.data, { requireAudioSampleUrl: false, durable: true }) !== null
    })()
  )),
}).refine((value) => value.file !== undefined || value.materializedPath !== undefined)

export const readUploadedAudioClipPayload = async (
  value: SharedOutboxEntry['payload'],
): Promise<UploadedAudioClipPayload | null> => {
  const parsed = uploadedAudioClipPayloadSchema.safeParse(value)

  if (!parsed.success) return null
  const parsedClipPayload = z.json().safeParse(parsed.data.clipPayload)

  if (!parsedClipPayload.success) return null

  const clipPayload = readSharedTimelineClipCreatePayload(
    parsedClipPayload.data,
    { requireAudioSampleUrl: false, durable: true },
  )

  if (!clipPayload) return null

  const file = parsed.data.materializedPath
    ? await readLocalRetryFile(
      parsed.data.projectId,
      parsed.data.materializedPath,
      parsed.data.fileName,
      parsed.data.mimeType,
    ) ?? parsed.data.file
    : parsed.data.file

  if (!file) return null

  return {
    projectId: parsed.data.projectId,
    assetKey: parsed.data.assetKey,
    file,
    materializedPath: parsed.data.materializedPath,
    duration: parsed.data.duration,
    clipPayload,
  }
}

export const uploadSharedAudioClipAsset = async (payload: UploadedAudioClipPayload, idempotencyKey: string) => {
  try {
    return await uploadAudioFile({
      projectId: payload.projectId,
      idempotencyKey,
      assetKey: payload.assetKey,
      file: payload.file,
      durationSec: payload.duration,
    })
  } catch (error) {
    if (error instanceof ResumableAudioUploadHttpError) {
      throw new SharedTimelineOperationHttpError(error.status, error.message)
    }

    throw new SharedTimelineOperationHttpError(500, error instanceof Error ? error.message : undefined)
  }
}
