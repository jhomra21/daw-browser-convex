import { batch, createSignal, onCleanup, type Accessor, type Setter } from 'solid-js'

import { createLocalAudioClip, createUploadedAudioClip, pushClipCreateHistory } from '~/lib/clip-create'
import { createAudioAssetKey, getAudioSourceMetadata } from '~/lib/audio-source'
import type { AudioEngine } from '~/lib/audio-engine'
import { createLocalAsset, LocalAssetWriteError } from '~/lib/local-assets'
import { isLocalId } from '~/lib/local-ids'
import type { OptimisticGrantScope } from '~/lib/optimistic-grant-scope'
import { createLocalTimelineRepository } from '~/lib/timeline-repository/local-timeline-repository'
import {
  acquireTrackRecordingLock,
  cleanupRecordingSession,
  createStopPromise,
  ensureRecordingAudioContext,
  getRecordingSupport,
  haltRecordingPreview,
  releaseTrackRecordingLock,
  startRecordingLockHeartbeat,
  clearRecordingLockHeartbeat,
  type RecordingContext,
} from '~/lib/track-recording-session'
import {
  ensureTrackForRecording,
  finalizeAutoCreatedTrackFailure,
  commitAutoCreatedTrack,
} from '~/lib/track-recording-target'
import { canTrackReceiveAudioClip } from '~/lib/track-routing'
import { calcNonOverlapStart, willOverlap } from '~/lib/timeline-utils'
import { getTrackHistoryRef } from '~/lib/undo/refs'
import type { HistoryEntry } from '~/lib/undo/types'
import type { UploadToR2 } from '~/hooks/useClipBuffers'
import type { Track } from '~/types/timeline'

import type { TimelineSelectionController } from './useTimelineSelectionState'

type ConvexClientType = typeof import('~/lib/convex').convexClient

type ConvexApiType = typeof import('~/lib/convex').convexApi

type UseTrackRecordingOptions = {
  audioEngine: AudioEngine
  tracks: Accessor<Track[]>
  setTrackLock: (trackId: Track['id'], lockedBy: string | null) => void
  clearTrackLock: (trackId: Track['id']) => void
  removeLocalTrack: (trackId: Track['id']) => void
  insertLocalClip: (trackId: Track['id'], clip: Track['clips'][number]) => void
  selection: TimelineSelectionController
  playheadSec: Accessor<number>
  uploadToR2: UploadToR2
  audioBufferCache: Map<string, AudioBuffer>
  projectId: Accessor<string | undefined>
  userId: Accessor<string | undefined>
  convexClient: ConvexClientType
  convexApi: ConvexApiType
  requestTransportPlay: () => Promise<void>
  createTrackForRecording: () => Promise<Track | null>
  setIsRecording: Setter<boolean>
  notify?: (message: string) => void
  historyPush?: (entry: HistoryEntry, mergeKey?: string, mergeWindowMs?: number) => void
  grantClipWrite?: (clipId: string, scope?: OptimisticGrantScope | null) => void
}

type StartRecordingResult = {
  ok: boolean
  trackId?: Track['id']
  reason?: string
}

type UseTrackRecordingReturn = {
  isRecording: Accessor<boolean>
  recordArmTrackId: Accessor<Track['id'] | null>
  previewPoints: Accessor<{ offset: number; amplitude: number }[]>
  previewStartSec: Accessor<number | null>
  recordingTrackId: Accessor<Track['id'] | null>
  toggleRecordArm: (trackId: Track['id']) => void
  reconcileRecordArm: (nextTracks: Track[]) => void
  startRecording: (trackId: Track['id']) => Promise<StartRecordingResult>
  stopRecording: () => Promise<void>
  toggleRecording: () => Promise<StartRecordingResult>
}

export function useTrackRecording(options: UseTrackRecordingOptions): UseTrackRecordingReturn {
  const {
    audioEngine,
    tracks,
    setTrackLock,
    clearTrackLock,
    removeLocalTrack,
    insertLocalClip,
    selection,
    playheadSec,
    uploadToR2,
    audioBufferCache,
    projectId,
    userId,
    convexClient,
    convexApi,
    requestTransportPlay,
    createTrackForRecording,
    setIsRecording,
    notify,
    historyPush,
    grantClipWrite,
  } = options

  const [isRecordingInternal, setIsRecordingInternal] = createSignal(false)
  const [recordArmTrackId, setRecordArmTrackId] = createSignal<Track['id'] | null>(null)
  const livePreviewPoints: { offset: number; amplitude: number }[] = []
  let livePreviewStartIndex = 0
  const [previewPoints, setPreviewPoints] = createSignal<{ offset: number; amplitude: number }[]>([], { equals: false })
  const [previewStartSec, setPreviewStartSec] = createSignal<number | null>(null)
  const [currentRecordingTrackId, setCurrentRecordingTrackId] = createSignal<Track['id'] | null>(null)

  let activeCtx: RecordingContext | null = null
  let lockHeartbeatTimer: number | null = null

  const emit = (message: string) => {
    console.warn('[useTrackRecording]', message)
    try {
      notify?.(message)
    } catch (err) {
      console.warn('[useTrackRecording] notify handler failed', err)
    }
  }

  const selectRecordingTrack = (trackId: Track['id']) => {
    batch(() => {
      selection.selectTrackTarget(trackId)
      setRecordArmTrackId(trackId)
    })
  }

  const clearRecordArmForTrack = (trackId: Track['id']) => {
    setRecordArmTrackId((current) => current === trackId ? null : current)
  }

  const toggleRecordArm = (trackId: Track['id']) => {
    if (isRecordingInternal()) return
    const uid = userId()
    const targetTrack = tracks().find((track) => track.id === trackId)
    if (!canTrackReceiveAudioClip(targetTrack)) return
    if (targetTrack?.lockedBy && targetTrack.lockedBy !== uid) return
    setRecordArmTrackId((current) => current === trackId ? null : trackId)
  }

  const reconcileRecordArm = (nextTracks: Track[]) => {
    const armedTrackId = recordArmTrackId()
    if (!armedTrackId) return
    const uid = userId()
    const availableTrack = nextTracks.find((track) => track.id === armedTrackId)
    if (!availableTrack || !canTrackReceiveAudioClip(availableTrack) || (availableTrack.lockedBy && availableTrack.lockedBy !== uid)) {
      setRecordArmTrackId(null)
    }
  }

  const releaseTrackLock = async (trackId: Track['id'], locker: string | undefined) => {
    const rid = projectId()
    if (rid && isLocalId('project', rid)) {
      clearTrackLock(trackId)
      return
    }
    await releaseTrackRecordingLock({
      trackId,
      locker,
      convexClient,
      convexApi,
      setTrackLock,
      clearTrackLock,
    })
  }

  const resetPreviewState = () => {
    livePreviewPoints.length = 0
    livePreviewStartIndex = 0
    setPreviewPoints(livePreviewPoints)
  }

  const cleanupRecording = async () => {
    const ctx = activeCtx
    activeCtx = null
    await cleanupRecordingSession({
      activeCtx: ctx,
      clearLockHeartbeat: () => {
        lockHeartbeatTimer = clearRecordingLockHeartbeat(lockHeartbeatTimer)
      },
      releaseTrackLock,
      setIsRecording,
      setIsRecordingInternal,
      livePreviewPoints,
      setPreviewPoints,
      setPreviewStartSec,
      setCurrentRecordingTrackId,
    })
    livePreviewStartIndex = 0
  }

  const haltLivePreview = () => {
    haltRecordingPreview({
      activeCtx,
      setIsRecording,
      livePreviewPoints,
      setPreviewPoints,
      setPreviewStartSec,
    })
    livePreviewStartIndex = 0
  }

  const handleAutoCreatedTrackFailure = async (track: Track | null) => {
    await finalizeAutoCreatedTrackFailure({
      track,
      tracks: tracks(),
      projectId: projectId(),
      userId: userId(),
      historyPush,
      convexClient,
      convexApi,
      removeLocalTrack,
      clearRecordArmForTrack,
      emit,
    })
  }

  const commitCreatedTrack = (track: Track | null) => {
    commitAutoCreatedTrack({
      historyPush,
      projectId: projectId(),
      tracks: tracks(),
      track,
    })
  }

  const finalizeRecording = async () => {
    if (!activeCtx) return
    const ctx = activeCtx
    const rid = projectId()
    const uid = userId()
    const isLocalProject = rid ? isLocalId('project', rid) : false
    if (!rid || (!isLocalProject && !uid)) {
      emit(isLocalProject ? 'Missing project context; recording discarded.' : 'Missing project or user context; recording discarded.')
      await cleanupRecording()
      await handleAutoCreatedTrackFailure(ctx.createdTrack)
      return
    }

    const blob = new Blob(ctx.chunks, { type: ctx.mimeType || 'audio/webm' })
    if (!blob.size) {
      emit('Recording contained no audio data.')
      await cleanupRecording()
      await handleAutoCreatedTrackFailure(ctx.createdTrack)
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
      await handleAutoCreatedTrackFailure(ctx.createdTrack)
      return
    }

    const existingTracks = tracks()
    const targetTrack = existingTracks.find(t => t.id === ctx.trackId)
    if (!targetTrack) {
      emit('Recording target track missing; clip skipped.')
      await cleanupRecording()
      await handleAutoCreatedTrackFailure(ctx.createdTrack)
      return
    }

    const baseDuration = decoded.duration
    const sourceMetadata = getAudioSourceMetadata(decoded)
    const sourceAssetKey = createAudioAssetKey()
    const desiredStart = Math.max(0, ctx.startSec)
    const nonOverlapStart = willOverlap(targetTrack.clips, null, desiredStart, baseDuration)
      ? calcNonOverlapStart(targetTrack.clips, null, desiredStart, baseDuration)
      : desiredStart

    if (isLocalProject) {
      try {
        const asset = await createLocalAsset({
          projectId: rid,
          file,
          metadata: {
            durationSec: sourceMetadata.durationSec,
            sampleRate: sourceMetadata.sampleRate,
            originalFileName: file.name,
            originalLastModified: file.lastModified,
          },
        })
        await createLocalAudioClip({
          projectId: rid,
          trackId: ctx.trackId,
          trackRef: getTrackHistoryRef(tracks().find((entry) => entry.id === ctx.trackId) ?? targetTrack),
          startSec: nonOverlapStart,
          fileName: file.name,
          decoded,
          source: sourceMetadata,
          sourceAssetKey: asset.id,
          sourceKind: 'recording',
          insertLocalClip,
          selectClip: (trackId, clipId) => {
            selection.selectPrimaryClip({ trackId, clipId })
          },
          historyPush,
          audioBufferCache,
          color: 'clip-recording',
        })
        await cleanupRecording()
        if (ctx.createdTrack) commitCreatedTrack(ctx.createdTrack)
      } catch (err) {
        console.error('[useTrackRecording] local recording clip creation failed', err)
        emit(err instanceof LocalAssetWriteError
          ? `${err.message} Free browser storage or choose a project folder, then retry.`
          : 'Failed to save recorded audio locally.')
        await cleanupRecording()
        await handleAutoCreatedTrackFailure(ctx.createdTrack)
      }
      return
    }

    try {
      const createdClip = await createUploadedAudioClip({
        projectId: rid,
        userId: uid ?? '',
        trackId: ctx.trackId,
        trackRef: getTrackHistoryRef(targetTrack),
        startSec: nonOverlapStart,
        file,
        decoded,
        source: sourceMetadata,
        sourceAssetKey,
        sourceKind: 'recording',
        createServerClip: async (payload) => await convexClient.mutation(convexApi.clips.create, payload),
        insertLocalClip,
        selectClip: (trackId, clipId) => {
          selection.selectPrimaryClip({ trackId, clipId })
        },
        uploadToR2,
        audioBufferCache,
        grantClipWrite,
        grantScope: uid ? { projectId: rid, userId: uid } : undefined,
        color: 'clip-recording',
        pushHistory: false,
      })
      await cleanupRecording()
      if (ctx.createdTrack) {
        commitCreatedTrack(ctx.createdTrack)
      }
      pushClipCreateHistory({
        historyPush,
        projectId: rid,
        trackId: ctx.trackId,
        trackRef: getTrackHistoryRef(tracks().find((entry) => entry.id === ctx.trackId) ?? targetTrack),
        clipId: createdClip.clipId,
        clip: createdClip.clip,
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
      await handleAutoCreatedTrackFailure(ctx.createdTrack)
      return
    }
  }

  const startRecording = async (trackId: Track['id'], createdTrack: Track | null = null): Promise<StartRecordingResult> => {
    if (isRecordingInternal()) return { ok: false, reason: 'Already recording' }
    const uid = userId()
    const rid = projectId()
    const isLocalProject = rid ? isLocalId('project', rid) : false
    if (!rid || (!isLocalProject && !uid)) {
      emit(isLocalProject ? 'You must be inside a project to record.' : 'You must be signed in and inside a project to record.')
      return { ok: false, reason: 'Missing session context' }
    }

    const track = tracks().find(t => t.id === trackId)
    if (!track) {
      emit('Selected track no longer exists.')
      return { ok: false, reason: 'Track not found' }
    }
    if (!isLocalProject && track.lockedBy && track.lockedBy !== uid) {
      emit('Track is locked by another collaborator.')
      return { ok: false, reason: 'Track locked' }
    }

    const recordingSupport = getRecordingSupport()
    if (!recordingSupport.supported) {
      emit('Recording is not supported in this browser.')
      return { ok: false, reason: 'Recorder unsupported' }
    }

    if (!isLocalProject) {
      const lockRes = await acquireTrackRecordingLock({
        trackId,
        locker: uid ?? '',
        convexClient,
        convexApi,
        setTrackLock,
        clearTrackLock,
      })
      if (!lockRes.ok) {
        emit(lockRes.reason ?? 'Unable to lock track for recording.')
        return { ok: false, reason: lockRes.reason }
      }
    }

    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      emit('Microphone access denied.')
      await releaseTrackLock(trackId, uid)
      return { ok: false, reason: 'Permission denied' }
    }

    const mimeType = recordingSupport.mimeType
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
        const ctxTime = ctxRef.currentTime
        const offset = Math.max(0, ctxTime - startCtxTime)
        const cutoff = Math.max(0, offset - 5)
        livePreviewPoints.push({ offset, amplitude: Math.min(1, rms) })
        while (livePreviewStartIndex < livePreviewPoints.length && livePreviewPoints[livePreviewStartIndex].offset < cutoff) {
          livePreviewStartIndex++
        }
        if (livePreviewStartIndex > 128) {
          livePreviewPoints.splice(0, livePreviewStartIndex)
          livePreviewStartIndex = 0
        }
        setPreviewPoints(livePreviewStartIndex === 0 ? livePreviewPoints : livePreviewPoints.slice(livePreviewStartIndex))
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
      createdTrack,
      startSec,
      stream,
      recorder,
      chunks,
      mimeType: mimeType || recorder.mimeType,
      lockedByUserId: uid ?? '',
      analyser,
      scriptProcessor,
      analysisCtx,
      onDataAvailable,
      onStop,
      stopPromise: stopCompletion.promise,
      rejectStopPromise: stopCompletion.reject,
    }

    ensureRecordingAudioContext(audioEngine)
    lockHeartbeatTimer = clearRecordingLockHeartbeat(lockHeartbeatTimer)
    if (!isLocalProject) {
      lockHeartbeatTimer = startRecordingLockHeartbeat({
        trackId,
        locker: uid ?? '',
        convexClient,
        convexApi,
        onError: (error) => {
          console.warn('[useTrackRecording] failed to refresh track lock', error)
        },
      })
    }

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
    resetPreviewState()
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
      await handleAutoCreatedTrackFailure(ctx.createdTrack)
    }
    haltLivePreview()
    try {
      await ctx.stopPromise
    } catch (err) {
      console.error('[useTrackRecording] finalize recording failed', err)
    }
  }

  const toggleRecording = async (): Promise<StartRecordingResult> => {
    if (isRecordingInternal()) {
      const activeTrackId = currentRecordingTrackId() ?? recordArmTrackId() ?? undefined
      await stopRecording()
      return { ok: true, trackId: activeTrackId }
    }
    const target = await ensureTrackForRecording({
      projectId: projectId(),
      userId: userId(),
      tracks: tracks(),
      recordArmTrackId: recordArmTrackId(),
      setRecordArmTrackId,
      createTrackForRecording,
      emit,
    })
    if (!target) return { ok: false, reason: 'No available track for recording' }
    const result = await startRecording(target.track.id, target.createdDuringSetup ? target.track : null)
    if (result.ok) {
      selectRecordingTrack(target.track.id)
      return result
    }
    if (target.createdDuringSetup) {
      await finalizeAutoCreatedTrackFailure({
        track: target.track,
        tracks: tracks(),
        projectId: projectId(),
        userId: userId(),
        historyPush,
        convexClient,
        convexApi,
        removeLocalTrack,
        clearRecordArmForTrack,
        emit,
      })
    }
    return result
  }

  onCleanup(() => {
    lockHeartbeatTimer = clearRecordingLockHeartbeat(lockHeartbeatTimer)
    void stopRecording()
  })

  return {
    isRecording: isRecordingInternal,
    recordArmTrackId,
    previewPoints,
    previewStartSec,
    recordingTrackId: currentRecordingTrackId,
    toggleRecordArm,
    reconcileRecordArm,
    startRecording,
    stopRecording,
    toggleRecording,
  }
}
