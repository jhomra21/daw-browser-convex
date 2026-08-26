import type { AudioEngine } from '@daw-browser/audio-engine/audio-engine'
import { assertDefined, type JsonValue } from '@daw-browser/shared'
import { publishSharedTimelineOperation } from '~/lib/shared-timeline-operations-api'
import type { Track } from '@daw-browser/timeline-core/types'
import { supportsPlanarFloat32WavEncoding } from '@daw-browser/audio-engine/recording-encode-wav'
import { z } from 'zod'

const RECORDING_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/ogg',
  'audio/mp4',
]

const RECORDING_LOCK_KEEPALIVE_MS = 30_000

const lockResultSchema = z.object({
  ok: z.boolean().optional(),
  reason: z.string().optional(),
})

const readLockResult = (value: JsonValue) => {
  const result = lockResultSchema.safeParse(value)
  return result.success ? result.data : undefined
}

type StopPromise = {
  promise: Promise<void>
  resolve: () => void
  reject: (cause?: unknown) => void
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
  recorder: MediaRecorder | null
  chunks: BlobPart[]
  mimeType: string
  lockedByUserId: string
  engineCaptureActive: boolean
  portableCaptureActive: boolean
  nativeCaptureActive: boolean
  engineCaptureSessionId: string
  savedAudioSource: 'worklet-pcm-f32' | 'media-recorder-compressed'
  sampleRate: number
  recordingOffsetFrames: number
  onDataAvailable: (event: BlobEvent) => void
  onStop: () => void
  stopPromise: Promise<void>
  rejectStopPromise: (cause?: unknown) => void
}

export function createStopPromise(): StopPromise {
  let settled = false
  let resolvePromise: (() => void) | undefined
  let rejectPromise: ((cause?: unknown) => void) | undefined
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = () => {
      if (settled) return
      settled = true
      resolve()
    }
    rejectPromise = (cause?: unknown) => {
      if (settled) return
      settled = true
      reject(cause)
    }
  })
  const resolve = assertDefined(resolvePromise, 'Stop promise resolver was not initialized')
  const reject = assertDefined(rejectPromise, 'Stop promise rejecter was not initialized')
  return {
    promise,
    resolve,
    reject,
  }
}

type RecordingSupport = {
  supported: boolean
  mimeType: string
}

export function getRecordingSupport(): RecordingSupport {
  if (!('window' in globalThis)) {
    return { supported: false, mimeType: '' }
  }
  if (!('navigator' in globalThis) || !globalThis.navigator.mediaDevices?.getUserMedia) {
    return { supported: false, mimeType: '' }
  }
  const mediaRecorderCtor = window.MediaRecorder
  if (!mediaRecorderCtor) {
    return { supported: false, mimeType: '' }
  }
  const isTypeSupported = 'isTypeSupported' in mediaRecorderCtor
    ? mediaRecorderCtor.isTypeSupported.bind(mediaRecorderCtor)
    : null
  for (const mime of RECORDING_MIME_TYPES) {
    if (!isTypeSupported || isTypeSupported(mime)) {
      return { supported: true, mimeType: mime }
    }
  }
  return { supported: true, mimeType: '' }
}

export function getProductionRecordingSupport(): boolean {
  return 'window' in globalThis
    && 'AudioWorkletNode' in globalThis
    && 'Worker' in globalThis
    && 'navigator' in globalThis
    && globalThis.navigator.storage !== undefined
    && 'getDirectory' in globalThis.navigator.storage
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

  try {
    ctx.recorder?.removeEventListener('dataavailable', ctx.onDataAvailable)
    ctx.recorder?.removeEventListener('stop', ctx.onStop)
  } catch {}

  try {
    if (ctx.recorder && ctx.recorder.state !== 'inactive') ctx.recorder.stop()
  } catch {}
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
