import { createSignal, onCleanup, batch, type Accessor, type Setter } from 'solid-js'

import type { AudioEngine } from '~/lib/audio-engine'
import type { Track, SelectedClip } from '~/types/timeline'
import type { UploadToR2 } from '~/hooks/useClipBuffers'
import { calcNonOverlapStart, willOverlap } from '~/lib/timeline-utils'

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
  recordArmTrackId: Accessor<string | null>
  setRecordArmTrackId: Setter<string | null>
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
  isPlaying: Accessor<boolean>
  notify?: (message: string) => void
}

type StartRecordingResult = {
  ok: boolean
  trackId?: string
  reason?: string
}

type RecordingContext = {
  trackId: string
  startSec: number
  startCtxTime: number
  stream: MediaStream
  recorder: MediaRecorder
  chunks: BlobPart[]
  mimeType: string
  lockedByUserId: string
  analyser: AnalyserNode | null
  scriptProcessor: ScriptProcessorNode | null
  analysisCtx: AudioContext | null
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
    recordArmTrackId,
    setRecordArmTrackId,
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
    isPlaying,
    notify,
  } = options

  const [isRecordingInternal, setIsRecordingInternal] = createSignal(false)
  const [previewPoints, setPreviewPoints] = createSignal<{ offset: number; amplitude: number }[]>([])
  const [previewStartSec, setPreviewStartSec] = createSignal<number | null>(null)
  const [currentRecordingTrackId, setCurrentRecordingTrackId] = createSignal<string | null>(null)

  let activeCtx: RecordingContext | null = null
  let finalizePromise: Promise<void> | null = null

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
      ctx.recorder.ondataavailable = null
      ctx.recorder.onstop = null
    } catch {}

    try {
      ctx.recorder.stop()
    } catch {}

    try {
      ctx.stream.getTracks().forEach(track => track.stop())
    } catch {}

    try {
      ctx.scriptProcessor?.disconnect()
      ctx.analyser?.disconnect()
    } catch {}

    try {
      await ctx.analysisCtx?.close()
    } catch {}

    await releaseTrackLock(ctx.trackId, ctx.lockedByUserId)
    setIsRecording(false)
    setIsRecordingInternal(false)
    setPreviewPoints([])
    setPreviewStartSec(null)
    setCurrentRecordingTrackId(null)
  }

  const finalizeRecording = async () => {
    if (!activeCtx) return
    const ctx = activeCtx
    const rid = roomId()
    const uid = userId()
    if (!rid || !uid) {
      emit('Missing room or user context; recording discarded.')
      activeCtx = null
      return
    }

    const blob = new Blob(ctx.chunks, { type: ctx.mimeType || 'audio/webm' })
    if (!blob.size) {
      emit('Recording contained no audio data.')
      activeCtx = null
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
    const desiredStart = Math.max(0, ctx.startSec)
    const nonOverlapStart = willOverlap(targetTrack.clips, null, desiredStart, baseDuration)
      ? calcNonOverlapStart(targetTrack.clips, null, desiredStart, baseDuration)
      : desiredStart

    let createdClipId: string
    try {
      createdClipId = await convexClient.mutation(convexApi.clips.create, {
        roomId: rid,
        trackId: ctx.trackId as any,
        startSec: nonOverlapStart,
        duration: baseDuration,
        userId: uid,
        name: file.name,
      } as any) as any as string
    } catch (err) {
      console.error('[useTrackRecording] clips.create failed', err)
      emit('Failed to create recorded clip on server.')
      await cleanupRecording()
      return
    }

    audioBufferCache.set(createdClipId, decoded)

    setTracks(ts => ts.map(t => t.id !== ctx.trackId ? t : ({
      ...t,
      clips: [
        ...t.clips,
        {
          id: createdClipId,
          name: file.name,
          buffer: decoded,
          startSec: nonOverlapStart,
          duration: baseDuration,
          leftPadSec: 0,
          color: '#ef4444',
          sampleUrl: undefined,
        },
      ],
    })))

    batch(() => {
      setSelectedTrackId(ctx.trackId)
      setSelectedFXTarget(ctx.trackId)
      setSelectedClip({ trackId: ctx.trackId, clipId: createdClipId })
      setSelectedClipIds(new Set([createdClipId]))
    })

    try {
      const sampleUrl = await uploadToR2(rid, createdClipId, file, baseDuration)
      if (sampleUrl) {
        await convexClient.mutation(convexApi.clips.setSampleUrl, { clipId: createdClipId as any, sampleUrl })
        setTracks(ts => ts.map(t => t.id !== ctx.trackId ? t : ({
          ...t,
          clips: t.clips.map(c => c.id === createdClipId ? { ...c, sampleUrl } : c),
        })))
      }
    } catch (err) {
      console.error('[useTrackRecording] failed to upload recording', err)
      emit('Recorded clip created but upload failed. You may retry upload manually.')
    }

    await cleanupRecording()
  }

  const startRecording = async (trackId: string): Promise<StartRecordingResult> => {
    if (isRecordingInternal()) {
      return { ok: false, reason: 'Already recording' }
    }
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
      const constraints: MediaStreamConstraints = { audio: true }
      stream = await navigator.mediaDevices.getUserMedia(constraints)
    } catch (err) {
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
    recorder.addEventListener('dataavailable', (event) => {
      if (event.data?.size) chunks.push(event.data)
    })
    recorder.addEventListener('stop', () => {
      finalizePromise = finalizeRecording().finally(() => {
        finalizePromise = null
      })
    })

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
          const v = input[i]
          sum += v * v
        }
        const rms = Math.sqrt(sum / input.length)
        const ctxTime = ctxRef?.currentTime ?? 0
        const offset = Math.max(0, ctxTime - startCtxTime)
        setPreviewPoints(prev => {
          const next = [...prev, { offset, amplitude: Math.min(1, rms) }]
          const cutoff = Math.max(0, offset - 5)
          return next.filter(p => p.offset >= cutoff)
        })
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
      startCtxTime,
      stream,
      recorder,
      chunks,
      mimeType: mimeType || recorder.mimeType,
      lockedByUserId: uid,
      analyser,
      scriptProcessor,
      analysisCtx,
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
    setPreviewPoints([])
    setPreviewStartSec(startSec)

    // Ensure transport runs so metronome/playback can accompany recording.
    try {
      await requestTransportPlay()
    } catch (err) {
      console.warn('[useTrackRecording] requestTransportPlay failed', err)
    }

    return { ok: true, trackId }
  }

  const stopRecording = async () => {
    if (!activeCtx) return
    try {
      if (activeCtx.recorder.state !== 'inactive') {
        activeCtx.recorder.stop()
      }
    } catch (err) {
      console.error('[useTrackRecording] recorder.stop failed', err)
    }
    if (finalizePromise) {
      try {
        await finalizePromise
      } catch (err) {
        console.error('[useTrackRecording] finalize recording failed', err)
      }
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
