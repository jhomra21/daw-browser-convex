import type { AudioEngine } from '@daw-browser/audio-engine/audio-engine'
import type { JsonValue } from '@daw-browser/shared'
import { publishSharedTimelineOperation } from '~/lib/shared-timeline-operations-api'
import type { Track } from '@daw-browser/timeline-core/types'
import { supportsPlanarFloat32WavEncoding } from '@daw-browser/audio-engine/recording-encode-wav'
import { isRecordingTempStorageSupported } from '~/lib/recording/recording-temp-storage'
import { z } from 'zod'

const RECORDING_LOCK_KEEPALIVE_MS = 30_000

const lockResultSchema = z.object({
  ok: z.boolean().optional(),
  reason: z.string().optional(),
})

const readLockResult = (value: JsonValue) => {
  const result = lockResultSchema.safeParse(value)
  return result.success ? result.data : undefined
}

export type RecordingContext = {
  projectId: string
  userId: string | undefined
  isLocalProject: boolean
  trackId: Track['id']
  tracks: Track[]
  createdTrack: Track | null
  startSec: number
  stream: MediaStream | null
  lockedByUserId: string
  engineCaptureActive: boolean
  portableCaptureActive: boolean
  nativeCaptureActive: boolean
  engineCaptureSessionId: string
  sampleRate: number
  recordingOffsetFrames: number
}

export function getProductionRecordingSupport(): boolean {
  return 'window' in globalThis
    && 'AudioWorkletNode' in globalThis
    && 'Worker' in globalThis
    && 'navigator' in globalThis
    && isRecordingTempStorageSupported()
    && supportsPlanarFloat32WavEncoding()
}

export function ensureRecordingAudioContext(audioEngine: AudioEngine): void {
  try {
    audioEngine.ensureAudio()
  } catch {}
}

export async function acquireTrackRecordingLock(options: {
  projectId: string
  trackId: Track['id']
  locker: string
  setTrackLock: (trackId: Track['id'], lockedBy: string | null) => void
  clearTrackLock: (trackId: Track['id']) => void
}): Promise<{ ok: boolean; reason?: string }> {
  try {
    const res = await publishSharedTimelineOperation(options.projectId, {
      kind: 'tracks.lock',
      payload: { trackId: options.trackId },
    })
    const result = readLockResult(res)
    if (!result?.ok) {
      options.clearTrackLock(options.trackId)
      return { ok: false, reason: result?.reason }
    }
    options.setTrackLock(options.trackId, options.locker)
    return { ok: true }
  } catch (err) {
    console.error('[useTrackRecording] failed to lock track', err)
    options.clearTrackLock(options.trackId)
    return { ok: false, reason: 'Failed to lock track' }
  }
}

export async function releaseTrackRecordingLock(options: {
  projectId: string
  trackId: Track['id']
  locker: string | undefined
  setTrackLock: (trackId: Track['id'], lockedBy: string | null) => void
  clearTrackLock: (trackId: Track['id']) => void
}): Promise<void> {
  if (!options.locker) {
    options.clearTrackLock(options.trackId)
    return
  }
  try {
    const response = await publishSharedTimelineOperation(options.projectId, {
      kind: 'tracks.unlock',
      payload: { trackId: options.trackId },
    })
    const result = readLockResult(response)
    if (!result?.ok) {
      options.clearTrackLock(options.trackId)
      return
    }
    options.setTrackLock(options.trackId, null)
  } catch (err) {
    console.error('[useTrackRecording] failed to unlock track', err)
    options.clearTrackLock(options.trackId)
  }
}

export function clearRecordingLockHeartbeat(lockHeartbeatTimer: number | null): number | null {
  if (lockHeartbeatTimer === null) return null
  window.clearInterval(lockHeartbeatTimer)
  return null
}

export function startRecordingLockHeartbeat(options: {
  projectId: string
  trackId: Track['id']
  locker: string
  onError?: (cause: unknown) => void
  onLost?: (reason?: string) => void
}): number {
  return window.setInterval(() => {
    void publishSharedTimelineOperation(options.projectId, {
      kind: 'tracks.lock',
      payload: { trackId: options.trackId },
    }).then((response) => {
      const result = readLockResult(response)
      if (result && !result.ok) options.onLost?.(result.reason)
    }).catch((error) => {
      options.onError?.(error)
    })
  }, RECORDING_LOCK_KEEPALIVE_MS)
}

export async function cleanupRecordingSession(options: {
  activeCtx: RecordingContext | null
  clearLockHeartbeat: () => void
  releaseTrackLock: (trackId: Track['id'], locker: string | undefined, isLocalProject: boolean) => Promise<void>
  setIsRecording: (value: boolean) => void
  livePreviewPoints: { offset: number; amplitude: number }[]
  setPreviewPoints: (points: { offset: number; amplitude: number }[]) => void
  setPreviewStartSec: (value: number | null) => void
  setCurrentRecordingTrackId: (value: Track['id'] | null) => void
}): Promise<void> {
  if (!options.activeCtx) return
  const ctx = options.activeCtx
  options.clearLockHeartbeat()

  try { ctx.stream?.getTracks().forEach((track) => track.stop()) } catch {}

  await options.releaseTrackLock(ctx.trackId, ctx.lockedByUserId, ctx.isLocalProject)
  options.setIsRecording(false)
  options.livePreviewPoints.length = 0
  options.setPreviewPoints(options.livePreviewPoints)
  options.setPreviewStartSec(null)
  options.setCurrentRecordingTrackId(null)
}

export function haltRecordingPreview(options: {
  activeCtx: RecordingContext | null
  livePreviewPoints: { offset: number; amplitude: number }[]
  setPreviewPoints: (points: { offset: number; amplitude: number }[]) => void
  setPreviewStartSec: (value: number | null) => void
}): void {
  if (!options.activeCtx) return
  const ctx = options.activeCtx
  try {
    try { ctx.stream?.getTracks().forEach((track) => track.stop()) } catch {}
  } catch {}
  options.livePreviewPoints.length = 0
  options.setPreviewPoints(options.livePreviewPoints)
  options.setPreviewStartSec(null)
}
