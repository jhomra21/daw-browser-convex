import { createSignal, onCleanup, type Accessor, type Setter } from 'solid-js'

import { createUploadedAudioClip } from '~/lib/clip-create'
import { createAudioAssetKey, getAudioSourceMetadata } from '~/lib/audio-source'
import type { AudioEngine } from '~/lib/audio-engine'
import { selectPrimaryClip } from '~/lib/timeline-selection'
import { calcNonOverlapStart, willOverlap } from '~/lib/timeline-utils'
import { getTrackHistoryRef } from '~/lib/undo/refs'
import type { HistoryEntry } from '~/lib/undo/types'
import type { UploadToR2 } from '~/hooks/useClipBuffers'
import type { Track, SelectedClip } from '~/types/timeline'

const RECORDING_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/ogg',
  'audio/mp4',
]

type ConvexClientType = typeof import('~/lib/convex').convexClient

type ConvexApiType = typeof import('~/lib/convex').convexApi

type UseTrackRecordingOptions = {
  audioEngine: AudioEngine
  tracks: Accessor<Track[]>
  setTracks: Setter<Track[]>
  setSelectedTrackId: Setter<string>
  setSelectedClip: Setter<SelectedClip>
  setSelectedClipIds: Setter<Set<string>>
  setSelectedFXTarget: Setter<string>
  playheadSec: Accessor<number>
  uploadToR2: UploadToR2
  audioBufferCache: Map<string, AudioBuffer>
  roomId: Accessor<string | undefined>
  userId: Accessor<string | undefined>
  convexClient: ConvexClientType
  convexApi: ConvexApiType
  requestTransportPlay: () => Promise<void>
  setIsRecording: Setter<boolean>
  notify?: (message: string) => void
  historyPush?: (entry: HistoryEntry, mergeKey?: string, mergeWindowMs?: number) => void
  grantClipWrite?: (clipId: string) => void
}

type StartRecordingResult = {
  ok: boolean
  trackId?: string
  reason?: string
}

type RecordingContext = {
  trackId: string
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

export type UseTrackRecordingReturn = {
  isRecording: Accessor<boolean>
  previewPoints: Accessor<{ offset: number; amplitude: number }[]>
  previewStartSec: Accessor<number | null>
  recordingTrackId: Accessor<string | null>
  startRecording: (trackId: string) => Promise<StartRecordingResult>
  stopRecording: () => Promise<void>
  toggleRecording: (trackId: string) => Promise<StartRecordingResult>
}

export function useTrackRecording(options: UseTrackRecordingOptions): UseTrackRecordingReturn {
  const {
    audioEngine,
    tracks,
    setTracks,
    setSelectedTrackId,
    setSelectedClip,
    setSelectedClipIds,
    setSelectedFXTarget,
    playheadSec,
    uploadToR2,
    audioBufferCache,
    roomId,
    userId,
    convexClient,
    convexApi,
    requestTransportPlay,
    setIsRecording,
    notify,
    historyPush,
    grantClipWrite,
  } = options

  const selectionSetters = {
    setSelectedTrackId,
    setSelectedClip,
    setSelectedClipIds,
    setSelectedFXTarget,
  }

  const [isRecordingInternal, setIsRecordingInternal] = createSignal(false)
  const livePreviewPoints: { offset: number; amplitude: number }[] = []
  const [previewPoints, setPreviewPoints] = createSignal<{ offset: number; amplitude: number }[]>([], { equals: false })
  const [previewStartSec, setPreviewStartSec] = createSignal<number | null>(null)
  const [currentRecordingTrackId, setCurrentRecordingTrackId] = createSignal<string | null>(null)

  let activeCtx: RecordingContext | null = null
  const createStopPromise = () => {
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

  const emit = (message: string) => {
    console.warn('[useTrackRecording]', message)
    try {
      notify?.(message)
    } catch (err) {
      console.warn('[useTrackRecording] notify handler failed', err)
    }
  }

  const pickMimeType = () => {
    for (const mime of RECORDING_MIME_TYPES) {
      if (MediaRecorder.isTypeSupported(mime)) return mime
    }
    return ''
  }

  const ensureAudioCtx = () => {
    try {
      audioEngine.ensureAudio()
    } catch {}
  }

  const acquireTrackLock = async (trackId: string, locker: string) => {
    try {
      const res: any = await convexClient.mutation((convexApi as any).tracks.lock, {
        trackId: trackId as any,
        userId: locker,
      })
      if (!res?.ok) {
        return { ok: false, reason: res?.reason as string | undefined }
      }
      setTracks(ts => ts.map(t => t.id === trackId ? ({ ...t, lockedBy: locker }) : t))
      return { ok: true }
    } catch (err) {
      console.error('[useTrackRecording] failed to lock track', err)
      return { ok: false, reason: 'Failed to lock track' }
    }
  }

  const releaseTrackLock = async (trackId: string, locker: string | undefined) => {
    if (!locker) {
      setTracks(ts => ts.map(t => t.id === trackId ? ({ ...t, lockedBy: null }) : t))
      return
    }
    try {
      await convexClient.mutation((convexApi as any).tracks.unlock, {
        trackId: trackId as any,
        userId: locker,
      })
    } catch (err) {
      console.error('[useTrackRecording] failed to unlock track', err)
    } finally {
      setTracks(ts => ts.map(t => t.id === trackId ? ({ ...t, lockedBy: null }) : t))
    }
  }

  const cleanupRecording = async () => {
    if (!activeCtx) return
    const ctx = activeCtx
    activeCtx = null

    try {
      ctx.recorder.removeEventListener('dataavailable', ctx.onDataAvailable)
      ctx.recorder.removeEventListener('stop', ctx.onStop)
    } catch {}

    try {
      if (ctx.recorder.state !== 'inactive') ctx.recorder.stop()
    } catch {}
    try { ctx.stream.getTracks().forEach(track => track.stop()) } catch {}
    try {
      ctx.scriptProcessor?.disconnect()
      ctx.analyser?.disconnect()
    } catch {}
    try { await ctx.analysisCtx?.close() } catch {}

    await releaseTrackLock(ctx.trackId, ctx.lockedByUserId)
    setIsRecording(false)
    setIsRecordingInternal(false)
    livePreviewPoints.length = 0
    setPreviewPoints(livePreviewPoints)
    setPreviewStartSec(null)
    setCurrentRecordingTrackId(null)
  }

  const haltLivePreview = () => {
    if (!activeCtx) return
    const ctx = activeCtx
    try {
      try { ctx.stream.getTracks().forEach(t => t.stop()) } catch {}
      try { ctx.scriptProcessor?.disconnect() } catch {}
      try { ctx.analyser?.disconnect() } catch {}
      try { ctx.analysisCtx?.close() } catch {}
      ctx.analyser = null
      ctx.scriptProcessor = null
      ctx.analysisCtx = null
    } catch {}
    setIsRecording(false)
    livePreviewPoints.length = 0
    setPreviewPoints(livePreviewPoints)
    setPreviewStartSec(null)
  }

  const finalizeRecording = async () => {
    if (!activeCtx) return
    const ctx = activeCtx
    const rid = roomId()
    const uid = userId()
    if (!rid || !uid) {
      emit('Missing room or user context; recording discarded.')
      await cleanupRecording()
      return
    }

    const blob = new Blob(ctx.chunks, { type: ctx.mimeType || 'audio/webm' })
    if (!blob.size) {
      emit('Recording contained no audio data.')
      await cleanupRecording()
      return
    }

    const fileName = `recording-${Date.now()}.webm`
    const file = new File([blob], fileName, { type: blob.type })

    let decoded: AudioBuffer | null = null
    try {
      const buffer = await file.arrayBuffer()
      decoded = await audioEngine.decodeAudioData(buffer)
    } catch (err) {
      console.error('[useTrackRecording] decodeAudioData failed', err)
    }

    if (!decoded) {
      emit('Failed to decode recorded audio; skipping clip creation.')
      await cleanupRecording()
      return
    }

    const existingTracks = tracks()
    const targetTrack = existingTracks.find(t => t.id === ctx.trackId)
    if (!targetTrack) {
      emit('Recording target track missing; clip skipped.')
      await cleanupRecording()
      return
    }

    const baseDuration = decoded.duration
    const sourceMetadata = getAudioSourceMetadata(decoded)
    const sourceAssetKey = createAudioAssetKey()
    const desiredStart = Math.max(0, ctx.startSec)
    const nonOverlapStart = willOverlap(targetTrack.clips, null, desiredStart, baseDuration)
      ? calcNonOverlapStart(targetTrack.clips, null, desiredStart, baseDuration)
      : desiredStart

    try {
      await createUploadedAudioClip({
        roomId: rid,
        userId: uid,
        trackId: ctx.trackId,
        trackRef: getTrackHistoryRef(tracks().find((entry) => entry.id === ctx.trackId)),
        startSec: nonOverlapStart,
        file,
        decoded,
        source: sourceMetadata,
        sourceAssetKey,
        sourceKind: 'recording',
        createServerClip: async (payload) => await convexClient.mutation(convexApi.clips.create, payload as any) as any as string,
        insertLocalClip: (trackId, clip) => {
          setTracks(ts => ts.map(t => t.id !== trackId ? t : ({
            ...t,
            clips: [...t.clips, clip],
          })))
        },
        selectClip: (trackId, clipId) => {
          selectPrimaryClip(selectionSetters, { trackId, clipId })
        },
        historyPush,
        uploadToR2,
        audioBufferCache,
        grantClipWrite,
        color: 'clip-recording',
      })
    } catch (err) {
      if (err instanceof Error && err.message === 'sample-upload-failed') {
        emit('Failed to upload recorded audio.')
      } else {
        if (!(err instanceof Error && err.message === 'clip-create-failed')) {
          console.error('[useTrackRecording] clips.create failed', err)
        }
        emit('Failed to create recorded clip on server.')
      }
      await cleanupRecording()
      return
    }

    await cleanupRecording()
  }

  const startRecording = async (trackId: string): Promise<StartRecordingResult> => {
    if (isRecordingInternal()) return { ok: false, reason: 'Already recording' }
    const uid = userId()
    const rid = roomId()
    if (!uid || !rid) {
      emit('You must be signed in and inside a project to record.')
      return { ok: false, reason: 'Missing session context' }
    }

    const track = tracks().find(t => t.id === trackId)
    if (!track) {
      emit('Selected track no longer exists.')
      return { ok: false, reason: 'Track not found' }
    }
    if (track.lockedBy && track.lockedBy !== uid) {
      emit('Track is locked by another collaborator.')
      return { ok: false, reason: 'Track locked' }
    }

    const lockRes = await acquireTrackLock(trackId, uid)
    if (!lockRes.ok) {
      emit(lockRes.reason ?? 'Unable to lock track for recording.')
      return { ok: false, reason: lockRes.reason }
    }

    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      emit('Microphone access denied.')
      await releaseTrackLock(trackId, uid)
      return { ok: false, reason: 'Permission denied' }
    }

    const mimeType = pickMimeType()
    let recorder: MediaRecorder
    try {
      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
    } catch (err) {
      console.error('[useTrackRecording] failed to create MediaRecorder', err)
      emit('Recording is not supported in this browser.')
      stream.getTracks().forEach(track => track.stop())
      await releaseTrackLock(trackId, uid)
      return { ok: false, reason: 'Recorder unsupported' }
    }

    const chunks: BlobPart[] = []
    const stopCompletion = createStopPromise()
    const onDataAvailable = (event: BlobEvent) => {
      if (event.data?.size) chunks.push(event.data)
    }
    const onStop = () => {
      void (async () => {
        try {
          await finalizeRecording()
          stopCompletion.resolve()
        } catch (error) {
          console.error('[useTrackRecording] finalize recording failed', error)
          try {
            await cleanupRecording()
          } catch {}
          stopCompletion.reject(error)
        }
      })()
    }
    recorder.addEventListener('dataavailable', onDataAvailable)
    recorder.addEventListener('stop', onStop)

    const startSec = Math.max(0, playheadSec())

    let analyser: AnalyserNode | null = null
    let scriptProcessor: ScriptProcessorNode | null = null
    let analysisCtx: AudioContext | null = null
    let startCtxTime = 0
    try {
      analysisCtx = new AudioContext({ latencyHint: 'interactive' })
      const source = analysisCtx.createMediaStreamSource(stream)
      analyser = analysisCtx.createAnalyser()
      analyser.fftSize = 2048
      scriptProcessor = analysisCtx.createScriptProcessor(2048, 1, 1)
      startCtxTime = analysisCtx.currentTime
      const gain = analysisCtx.createGain()
      gain.gain.value = 0
      scriptProcessor.connect(gain)
      gain.connect(analysisCtx.destination)
      const ctxRef = analysisCtx
      scriptProcessor.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0)
        let sum = 0
        for (let i = 0; i < input.length; i++) {
          const value = input[i]
          sum += value * value
        }
        const rms = Math.sqrt(sum / input.length)
        const ctxTime = ctxRef?.currentTime ?? 0
        const offset = Math.max(0, ctxTime - startCtxTime)
        const cutoff = Math.max(0, offset - 5)
        livePreviewPoints.push({ offset, amplitude: Math.min(1, rms) })
        while (livePreviewPoints.length > 0 && livePreviewPoints[0].offset < cutoff) {
          livePreviewPoints.shift()
        }
        setPreviewPoints(livePreviewPoints)
      }
      source.connect(analyser)
      analyser.connect(scriptProcessor)
    } catch (err) {
      console.warn('[useTrackRecording] analyser setup failed', err)
      analysisCtx = null
      analyser = null
      scriptProcessor = null
    }

    activeCtx = {
      trackId,
      startSec,
      stream,
      recorder,
      chunks,
      mimeType: mimeType || recorder.mimeType,
      lockedByUserId: uid,
      analyser,
      scriptProcessor,
      analysisCtx,
      onDataAvailable,
      onStop,
      stopPromise: stopCompletion.promise,
      rejectStopPromise: stopCompletion.reject,
    }

    ensureAudioCtx()

    try {
      recorder.start()
    } catch (err) {
      console.error('[useTrackRecording] recorder.start failed', err)
      emit('Failed to start recording.')
      await cleanupRecording()
      return { ok: false, reason: 'Recorder failed to start' }
    }

    setIsRecording(true)
    setIsRecordingInternal(true)
    setCurrentRecordingTrackId(trackId)
    livePreviewPoints.length = 0
    setPreviewPoints(livePreviewPoints)
    setPreviewStartSec(startSec)

    try {
      await requestTransportPlay()
    } catch (err) {
      console.warn('[useTrackRecording] requestTransportPlay failed', err)
    }

    return { ok: true, trackId }
  }

  const stopRecording = async () => {
    if (!activeCtx) return
    const ctx = activeCtx
    try {
      if (ctx.recorder.state !== 'inactive') {
        ctx.recorder.stop()
      }
    } catch (err) {
      console.error('[useTrackRecording] recorder.stop failed', err)
      ctx.rejectStopPromise(err)
      await cleanupRecording()
    }
    haltLivePreview()
    try {
      await ctx.stopPromise
    } catch (err) {
      console.error('[useTrackRecording] finalize recording failed', err)
    }
  }

  const toggleRecording = async (trackId: string): Promise<StartRecordingResult> => {
    if (isRecordingInternal()) {
      await stopRecording()
      return { ok: true, trackId }
    }
    return startRecording(trackId)
  }

  onCleanup(() => {
    void stopRecording()
  })

  return {
    isRecording: isRecordingInternal,
    previewPoints,
    previewStartSec,
    recordingTrackId: currentRecordingTrackId,
    startRecording,
    stopRecording,
    toggleRecording,
  }
}
