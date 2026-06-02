import type { AudioEngine } from '~/lib/audio-engine'
import { publishTransientSharedTimelineOperation } from '~/lib/shared-timeline-operations-api'
import type { Track } from '~/types/timeline'

type ConvexClientType = typeof import('~/lib/convex').convexClient

type ConvexApiType = typeof import('~/lib/convex').convexApi

const RECORDING_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/ogg',
  'audio/mp4',
]

const RECORDING_LOCK_KEEPALIVE_MS = 30_000

const isLockResult = (value: unknown): value is { ok?: boolean; reason?: string } => (
  typeof value === 'object' && value !== null
)

export type RecordingContext = {
  projectId: string
  userId: string | undefined
  isLocalProject: boolean
  trackId: Track['id']
  tracks: Track[]
  createdTrack: Track | null
  startSec: number
  stream: MediaStream
  recorder: MediaRecorder
  chunks: BlobPart[]
  mimeType: string
  lockedByUserId: string
  analyser: AnalyserNode | null
  scriptProcessor: ScriptProcessorNode | null
  analysisCtx: AudioContext | null
  onDataAvailable: (event: BlobEvent) => void
  onStop: () => void
  stopPromise: Promise<void>
  rejectStopPromise: (error?: unknown) => void
}

export function createStopPromise(): {
  promise: Promise<void>
  resolve: () => void
  reject: (error?: unknown) => void
} {
  let settled = false
  let resolvePromise!: () => void
  let rejectPromise!: (error?: unknown) => void
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = () => {
      if (settled) return
      settled = true
      resolve()
    }
    rejectPromise = (error?: unknown) => {
      if (settled) return
      settled = true
      reject(error)
    }
  })
  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
  }
}

export function getRecordingSupport(): {
  supported: boolean
  mimeType: string
} {
  if (typeof window === 'undefined') {
    return { supported: false, mimeType: '' }
  }
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    return { supported: false, mimeType: '' }
  }
  const mediaRecorderCtor = window.MediaRecorder
  if (typeof mediaRecorderCtor !== 'function') {
    return { supported: false, mimeType: '' }
  }
  const isTypeSupported = typeof mediaRecorderCtor.isTypeSupported === 'function'
    ? mediaRecorderCtor.isTypeSupported.bind(mediaRecorderCtor)
    : null
  for (const mime of RECORDING_MIME_TYPES) {
    if (!isTypeSupported || isTypeSupported(mime)) {
      return { supported: true, mimeType: mime }
    }
  }
  return { supported: true, mimeType: '' }
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
  convexClient: ConvexClientType
  convexApi: ConvexApiType
  setTrackLock: (trackId: Track['id'], lockedBy: string | null) => void
  clearTrackLock: (trackId: Track['id']) => void
}): Promise<{ ok: boolean; reason?: string }> {
  try {
    const res = await publishTransientSharedTimelineOperation(options.projectId, {
      kind: 'tracks.lock',
      payload: { trackId: options.trackId },
    })
    if (!isLockResult(res) || !res.ok) {
      options.clearTrackLock(options.trackId)
      return { ok: false, reason: isLockResult(res) ? res.reason : undefined }
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
  convexClient: ConvexClientType
  convexApi: ConvexApiType
  setTrackLock: (trackId: Track['id'], lockedBy: string | null) => void
  clearTrackLock: (trackId: Track['id']) => void
}): Promise<void> {
  if (!options.locker) {
    options.clearTrackLock(options.trackId)
    return
  }
  try {
    const result = await publishTransientSharedTimelineOperation(options.projectId, {
      kind: 'tracks.unlock',
      payload: { trackId: options.trackId },
    })
    if (!isLockResult(result) || !result.ok) {
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
  convexClient: ConvexClientType
  convexApi: ConvexApiType
  onError?: (error: unknown) => void
}): number {
  return window.setInterval(() => {
    void publishTransientSharedTimelineOperation(options.projectId, {
      kind: 'tracks.lock',
      payload: { trackId: options.trackId },
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
  setIsRecordingInternal: (value: boolean) => void
  livePreviewPoints: { offset: number; amplitude: number }[]
  setPreviewPoints: (points: { offset: number; amplitude: number }[]) => void
  setPreviewStartSec: (value: number | null) => void
  setCurrentRecordingTrackId: (value: Track['id'] | null) => void
}): Promise<void> {
  if (!options.activeCtx) return
  const ctx = options.activeCtx
  options.clearLockHeartbeat()

  try {
    ctx.recorder.removeEventListener('dataavailable', ctx.onDataAvailable)
    ctx.recorder.removeEventListener('stop', ctx.onStop)
  } catch {}

  try {
    if (ctx.recorder.state !== 'inactive') ctx.recorder.stop()
  } catch {}
  try { ctx.stream.getTracks().forEach((track) => track.stop()) } catch {}
  try {
    ctx.scriptProcessor?.disconnect()
    ctx.analyser?.disconnect()
  } catch {}
  try { await ctx.analysisCtx?.close() } catch {}

  await options.releaseTrackLock(ctx.trackId, ctx.lockedByUserId, ctx.isLocalProject)
  options.setIsRecording(false)
  options.setIsRecordingInternal(false)
  options.livePreviewPoints.length = 0
  options.setPreviewPoints(options.livePreviewPoints)
  options.setPreviewStartSec(null)
  options.setCurrentRecordingTrackId(null)
}

export function haltRecordingPreview(options: {
  activeCtx: RecordingContext | null
  setIsRecording: (value: boolean) => void
  livePreviewPoints: { offset: number; amplitude: number }[]
  setPreviewPoints: (points: { offset: number; amplitude: number }[]) => void
  setPreviewStartSec: (value: number | null) => void
}): void {
  if (!options.activeCtx) return
  const ctx = options.activeCtx
  try {
    try { ctx.stream.getTracks().forEach((track) => track.stop()) } catch {}
    try { ctx.scriptProcessor?.disconnect() } catch {}
    try { ctx.analyser?.disconnect() } catch {}
    try { ctx.analysisCtx?.close() } catch {}
    ctx.analyser = null
    ctx.scriptProcessor = null
    ctx.analysisCtx = null
  } catch {}
  options.setIsRecording(false)
  options.livePreviewPoints.length = 0
  options.setPreviewPoints(options.livePreviewPoints)
  options.setPreviewStartSec(null)
}
