import { batch, createSignal, onCleanup, type Accessor } from 'solid-js'

import { createLocalAudioClip, createUploadedAudioClip, pushClipCreateHistory } from '~/lib/clip-create'
import type { ClipCreateSnapshot } from '@daw-browser/shared'
import type { ClipBufferWriter } from '~/lib/clip-buffer-cache'
import { createAudioAssetKey, getAudioSourceMetadata } from '~/lib/audio-source'
import type { AudioEngine } from '@daw-browser/audio-engine/audio-engine'
import { createLocalAsset, deleteLocalAsset, LocalAssetWriteError } from '~/lib/local-assets'
import { trackColorForClip } from '~/lib/clip-color'
import { isLocalId } from '@daw-browser/shared'
import type { OptimisticGrantScope } from '~/lib/optimistic-grant-scope'
import { isSharedOutboxQueuedError } from '~/lib/shared-outbox'
import { publishSharedTimelineOperation } from '~/lib/shared-timeline-operations-api'
import { createLocalTimelineRepository } from '~/lib/timeline-repository/local-timeline-repository'
import {
  acquireTrackRecordingLock,
  cleanupRecordingSession,
  createStopPromise,
  ensureRecordingAudioContext,
  getRecordingSupport,
  getProductionRecordingSupport,
  haltRecordingPreview,
  releaseTrackRecordingLock,
  startRecordingLockHeartbeat,
  clearRecordingLockHeartbeat,
  type RecordingContext,
} from '~/lib/track-recording-session'
import { createRecordingTransport } from '~/lib/recording/recording-transport'
import { createRecordingTempStorage } from '~/lib/recording/recording-temp-storage'
import { encodeRecordingWav } from '~/lib/recording/encode-recording-wav'
import {
  ensureTrackForRecording,
  finalizeAutoCreatedTrackFailure,
} from '~/lib/track-recording-target'
import { canTrackReceiveAudioClip } from '@daw-browser/timeline-core/track-routing'
import { calcNonOverlapStart, willOverlap } from '~/lib/timeline-utils'
import { buildTrackClipCreateHistoryEntry } from '~/lib/undo/builders'
import { getTrackHistoryRef } from '~/lib/undo/refs'
import type { HistoryEntry } from '~/lib/undo/types'
import type { UploadToR2 } from '~/hooks/useClipBuffers'
import type { Track } from '@daw-browser/timeline-core/types'
import type { AudioPreferences, RecordingPreferences } from '~/lib/preferences/app-preferences'
import { buildRecordingConstraints } from '~/lib/audio-settings-core'

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
  removeLocalClips: (clipIds: Iterable<string>) => void
  selection: TimelineSelectionController
  playheadSec: Accessor<number>
  uploadToR2: UploadToR2
  audioBufferCache: ClipBufferWriter
  projectId: Accessor<string | undefined>
  userId: Accessor<string | undefined>
  convexClient: ConvexClientType
  convexApi: ConvexApiType
  requestTransportPlay: () => Promise<void>
  createTrackForRecording: () => Promise<Track | null>
  notify: (message: string) => void
  historyPush: (entry: HistoryEntry, mergeKey?: string, mergeWindowMs?: number) => void
  grantClipWrite?: (clipId: string, scope?: OptimisticGrantScope | null) => void
  audioPreferences: Accessor<AudioPreferences>
  recordingPreferences: Accessor<RecordingPreferences>
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
    removeLocalClips,
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
    notify,
    historyPush,
    grantClipWrite,
    audioPreferences,
    recordingPreferences,
  } = options
  void createRecordingTempStorage().cleanupStale().catch((error) => {
    console.warn('[useTrackRecording] stale recording cleanup failed', error)
  })

  const [isRecordingInternal, setIsRecordingInternal] = createSignal(false)
  const [recordArmTrackId, setRecordArmTrackId] = createSignal<Track['id'] | null>(null)
  const livePreviewPoints: { offset: number; amplitude: number }[] = []
  let livePreviewStartIndex = 0
  const [previewPoints, setPreviewPoints] = createSignal<{ offset: number; amplitude: number }[]>([], { equals: false })
  const [previewStartSec, setPreviewStartSec] = createSignal<number | null>(null)
  const [currentRecordingTrackId, setCurrentRecordingTrackId] = createSignal<Track['id'] | null>(null)

  let activeCtx: RecordingContext | null = null
  let lockHeartbeatTimer: number | null = null
  let previewContextStartFrame = 0
  let previewSampleRate = 1

  const unsubscribeRecordingStatus = audioEngine.subscribeRecordingStatus((status) => {
    if (status.state === 'failed' && activeCtx?.engineCaptureActive && status.sessionId === activeCtx.engineCaptureSessionId) {
      const failedContext = activeCtx
      void (async () => {
        await createRecordingTempStorage().remove(failedContext.engineCaptureSessionId).catch(() => undefined)
        await cleanupRecording()
        await handleAutoCreatedTrackFailure(failedContext.createdTrack, failedContext)
      })()
      return
    }
    if (status.state !== 'recording' || !activeCtx?.engineCaptureActive || status.sessionId !== activeCtx.engineCaptureSessionId) return
    const offset = Math.max(0, (status.contextFrame - previewContextStartFrame) / previewSampleRate)
    const cutoff = Math.max(0, offset - 5)
    livePreviewPoints.push({ offset, amplitude: Math.min(1, status.rms) })
    while (livePreviewStartIndex < livePreviewPoints.length && livePreviewPoints[livePreviewStartIndex].offset < cutoff) {
      livePreviewStartIndex++
    }
    if (livePreviewStartIndex > 128) {
      livePreviewPoints.splice(0, livePreviewStartIndex)
      livePreviewStartIndex = 0
    }
    setPreviewPoints(livePreviewStartIndex === 0 ? livePreviewPoints : livePreviewPoints.slice(livePreviewStartIndex))
  })

  const emit = (message: string) => {
    console.warn('[useTrackRecording]', message)
    try {
      notify(message)
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

  const releaseTrackLock = async (trackId: Track['id'], locker: string | undefined, isLocalProject?: boolean) => {
    const rid = projectId()
    if (isLocalProject ?? (rid ? isLocalId('project', rid) : false)) {
      clearTrackLock(trackId)
      return
    }
    if (!rid) {
      clearTrackLock(trackId)
      return
    }
    await releaseTrackRecordingLock({
      projectId: rid,
      trackId,
      locker,
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
    if (ctx?.engineCaptureActive) audioEngine.cancelRecordingCapture()
    await cleanupRecordingSession({
      activeCtx: ctx,
      clearLockHeartbeat: () => {
        lockHeartbeatTimer = clearRecordingLockHeartbeat(lockHeartbeatTimer)
      },
      releaseTrackLock,
      setIsRecording: setIsRecordingInternal,
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
      livePreviewPoints,
      setPreviewPoints,
      setPreviewStartSec,
    })
    livePreviewStartIndex = 0
  }

  const handleAutoCreatedTrackFailure = async (
    track: Track | null,
    context?: { projectId: string; userId: string | undefined; tracks: Track[] },
  ) => {
    const targetProjectId = context?.projectId ?? projectId()
    await finalizeAutoCreatedTrackFailure({
      track,
      tracks: targetProjectId === projectId() ? tracks() : context?.tracks ?? tracks(),
      projectId: targetProjectId,
      userId: context?.userId ?? userId(),
      historyPush,
      convexClient,
      convexApi,
      removeLocalTrack,
      clearRecordArmForTrack,
      emit,
    })
  }

  const pushTrackClipCreateHistory = (projectId: string, track: Track, clipId: string, clip: ClipCreateSnapshot) => {
    historyPush(buildTrackClipCreateHistoryEntry({ projectId, track, tracks: tracks(), clipId, clip }))
  }

  const finalizeRecording = async () => {
    if (!activeCtx) return
    const ctx = activeCtx
    const rid = ctx.projectId
    const uid = ctx.userId
    const isLocalProject = ctx.isLocalProject
    const discardRecording = async (message: string) => {
      emit(message)
      if (ctx.savedAudioSource === 'worklet-pcm-f32') {
        await createRecordingTempStorage().remove(ctx.engineCaptureSessionId).catch(() => undefined)
      }
      await cleanupRecording()
      await handleAutoCreatedTrackFailure(ctx.createdTrack, ctx)
    }
    if (!isLocalProject && !uid) {
      await discardRecording('Missing project or user context; recording discarded.')
      return
    }

    let file: File
    let sourceMetadata: ReturnType<typeof getAudioSourceMetadata>
    let decoded: AudioBuffer | undefined
    let removeTemp = async () => {}
    if (ctx.savedAudioSource === 'worklet-pcm-f32') {
      const descriptor = await createRecordingTempStorage().open(ctx.engineCaptureSessionId)
      if (!descriptor || descriptor.capturedFrames === 0) {
        await discardRecording('Recording contained no audio data.')
        return
      }
      try {
        const encoded = await encodeRecordingWav(descriptor)
        file = encoded.file
        removeTemp = encoded.remove
        sourceMetadata = {
          durationSec: descriptor.capturedFrames / descriptor.sampleRate,
          sampleRate: descriptor.sampleRate,
          channelCount: descriptor.channelCount,
        }
      } catch (error) {
        console.error('[useTrackRecording] WAV encoding failed', error)
        await discardRecording('Failed to encode recorded audio; skipping clip creation.')
        return
      }
    } else {
      const blob = new Blob(ctx.chunks, { type: ctx.mimeType || 'audio/webm' })
      if (!blob.size) {
        await discardRecording('Recording contained no audio data.')
        return
      }
      const extension = blob.type.includes('ogg') ? 'ogg' : blob.type.includes('mp4') ? 'm4a' : 'webm'
      file = new File([blob], `recording-${Date.now()}.${extension}`, { type: blob.type })
      try {
        decoded = await audioEngine.decodeAudioData(await file.arrayBuffer())
        sourceMetadata = getAudioSourceMetadata(decoded)
      } catch (err) {
        console.error('[useTrackRecording] decodeAudioData failed', err)
        await discardRecording('Failed to decode recorded audio; skipping clip creation.')
        return
      }
    }

    const existingTracks = projectId() === ctx.projectId ? tracks() : ctx.tracks
    const targetTrack = existingTracks.find((entry) => entry.id === ctx.trackId)
    if (!targetTrack) {
      await discardRecording('Recording target track missing; clip skipped.')
      return
    }

    const baseDuration = sourceMetadata.durationSec
    const sourceAssetKey = createAudioAssetKey()
    const desiredStart = Math.max(0, ctx.startSec + ctx.manualOffsetFrames / ctx.sampleRate)
    const nonOverlapStart = willOverlap(targetTrack.clips, null, desiredStart, baseDuration)
      ? calcNonOverlapStart(targetTrack.clips, null, desiredStart, baseDuration)
      : desiredStart

    if (isLocalProject) {
      let assetId: string | undefined
      try {
        const asset = await createLocalAsset({
          projectId: rid,
          file,
          metadata: sourceMetadata,
        })
        assetId = asset.id
        const created = await createLocalAudioClip({
          projectId: rid,
          trackId: ctx.trackId,
          trackRef: getTrackHistoryRef(targetTrack),
          startSec: nonOverlapStart,
          fileName: file.name,
          decoded,
          durationSec: baseDuration,
          source: sourceMetadata,
          sourceAssetKey: asset.id,
          sourceKind: 'recording',
          insertLocalClip,
          selectClip: (trackId, clipId) => {
            selection.selectPrimaryClip({ trackId, clipId })
          },
          historyPush,
          skipHistory: Boolean(ctx.createdTrack),
          audioBufferCache,
          color: trackColorForClip(targetTrack.color) ?? 'clip-recording',
          canProject: () => projectId() === rid && tracks().some((entry) => entry.id === ctx.trackId),
        })
        await cleanupRecording()
        await removeTemp().catch(() => undefined)
        if (ctx.createdTrack && projectId() === rid && tracks().some((entry) => entry.id === ctx.trackId)) {
          pushTrackClipCreateHistory(rid, ctx.createdTrack, created.clipId, created.clip)
        }
      } catch (err) {
        if (assetId) {
          await deleteLocalAsset(rid, assetId).catch(() => null)
        }
        console.error('[useTrackRecording] local recording clip creation failed', err)
        emit(err instanceof LocalAssetWriteError
          ? `${err.message} Free browser storage or choose a project folder, then retry.`
          : 'Failed to save recorded audio locally.')
        await cleanupRecording()
        await removeTemp().catch(() => undefined)
        await handleAutoCreatedTrackFailure(ctx.createdTrack, ctx)
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
        durationSec: baseDuration,
        source: sourceMetadata,
        sourceAssetKey,
        sourceKind: 'recording',
        createServerClip: async (payload) => {
          const result = await publishSharedTimelineOperation(rid, {
            kind: 'clips.create',
            payload,
          })
          return typeof result === 'string' ? result : null
        },
        insertLocalClip,
        removeLocalClips,
        selectClip: (trackId, clipId) => {
          selection.selectPrimaryClip({ trackId, clipId })
        },
        uploadToR2,
        audioBufferCache,
        grantClipWrite,
        grantScope: uid ? { projectId: rid, userId: uid } : undefined,
        color: trackColorForClip(targetTrack.color) ?? 'clip-recording',
        pushHistory: false,
        canProject: () => projectId() === rid && tracks().some((entry) => entry.id === ctx.trackId),
      })
      await cleanupRecording()
      await removeTemp().catch(() => undefined)
      if (projectId() !== rid || !tracks().some((entry) => entry.id === ctx.trackId)) return
      if (ctx.createdTrack) {
        pushTrackClipCreateHistory(rid, ctx.createdTrack, createdClip.clipId, createdClip.clip)
        return
      }
      pushClipCreateHistory({
        historyPush,
        projectId: rid,
        trackId: ctx.trackId,
        trackRef: getTrackHistoryRef(targetTrack),
        clipId: createdClip.clipId,
        clip: createdClip.clip,
      })
    } catch (err) {
      if (isSharedOutboxQueuedError(err)) {
        emit('Recorded audio was queued and will retry when sync resumes.')
      } else if (err instanceof Error && err.message === 'sample-upload-failed') {
        emit('Failed to upload recorded audio.')
      } else {
        if (!(err instanceof Error && err.message === 'clip-create-failed')) {
          console.error('[useTrackRecording] clips.create failed', err)
        }
        emit('Failed to create recorded clip on server.')
      }
      await cleanupRecording()
      await removeTemp().catch(() => undefined)
      if (!isSharedOutboxQueuedError(err)) {
        await handleAutoCreatedTrackFailure(ctx.createdTrack, ctx)
      }
      return
    }
  }

  const startRecording = async (trackId: Track['id'], createdTrack: Track | null = null): Promise<StartRecordingResult> => {
    if (isRecordingInternal()) return { ok: false, reason: 'Already recording' }
    const uid = userId()
    const rid = projectId()
    const isLocalProject = rid ? isLocalId('project', rid) : false
    if (!rid) {
      emit('You must be inside a project to record.')
      return { ok: false, reason: 'Missing session context' }
    }
    if (!isLocalProject && !uid) {
      emit('You must be signed in and inside a project to record.')
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
    const productionSupported = getProductionRecordingSupport()
    if (!productionSupported && !recordingSupport.supported) {
      emit('Recording is not supported in this browser.')
      return { ok: false, reason: 'Recorder unsupported' }
    }

    if (!isLocalProject) {
      const lockRes = await acquireTrackRecordingLock({
        projectId: rid,
        trackId,
        locker: uid ?? '',
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
      stream = await navigator.mediaDevices.getUserMedia({
        audio: buildRecordingConstraints(audioPreferences(), navigator.mediaDevices.getSupportedConstraints())
      })
    } catch (error) {
      const missingDevice = error instanceof DOMException && (error.name === 'NotFoundError' || error.name === 'OverconstrainedError')
      const permissionDenied = error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'SecurityError')
      emit(missingDevice ? 'The selected microphone is unavailable.' : permissionDenied ? 'Microphone access denied.' : 'Unable to capture microphone audio.')
      await releaseTrackLock(trackId, uid, isLocalProject)
      return { ok: false, reason: missingDevice ? 'Device unavailable' : permissionDenied ? 'Permission denied' : 'Capture failed' }
    }

    const mimeType = recordingSupport.mimeType
    let recorder: MediaRecorder | null = null
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
    const startSec = Math.max(0, playheadSec())

    let engineCaptureActive = false
    const engineCaptureSessionId = `take-${Date.now()}`
    const requestedSettings = recordingPreferences()
    ensureRecordingAudioContext(audioEngine)
    const engineContext = audioEngine.getAudioContext()
    const trackSampleRate = stream.getAudioTracks()[0]?.getSettings().sampleRate
    let sampleRate = Number.isFinite(trackSampleRate) && trackSampleRate !== undefined
      ? trackSampleRate
      : engineContext?.sampleRate ?? 1
    if (productionSupported) try {
      await audioEngine.resume()
      const captureContext = audioEngine.getAudioContext()
      if (!captureContext) throw new Error('Audio engine context unavailable.')
      sampleRate = captureContext.sampleRate
      previewSampleRate = captureContext.sampleRate
      previewContextStartFrame = Math.floor(captureContext.currentTime * captureContext.sampleRate)
      await audioEngine.startRecordingCapture({
        sessionId: engineCaptureSessionId,
        stream,
        trackId,
        layout: requestedSettings.layout,
        inputChannel: requestedSettings.inputChannel,
        gain: 10 ** (requestedSettings.gainDb / 20),
        polarity: requestedSettings.invertPolarity ? -1 : 1,
        monitor: requestedSettings.monitor,
        armed: true,
        epoch: {
          timelineFrame: Math.floor(startSec * captureContext.sampleRate),
          contextFrame: previewContextStartFrame,
        },
        punchInContextFrame: previewContextStartFrame,
        createTransport: (transportOptions) => createRecordingTransport(transportOptions).transport,
      })
      engineCaptureActive = true
    } catch (err) {
      console.warn('[useTrackRecording] production PCM capture unavailable; using compressed fallback', err)
    }

    if (!engineCaptureActive) {
      if (!recordingSupport.supported) {
        stream.getTracks().forEach(track => track.stop())
        await releaseTrackLock(trackId, uid, isLocalProject)
        return { ok: false, reason: 'Recorder unsupported' }
      }
      try {
        recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      } catch (err) {
        console.error('[useTrackRecording] failed to create MediaRecorder', err)
        stream.getTracks().forEach(track => track.stop())
        await releaseTrackLock(trackId, uid, isLocalProject)
        return { ok: false, reason: 'Recorder unsupported' }
      }
    }
    recorder?.addEventListener('dataavailable', onDataAvailable)
    recorder?.addEventListener('stop', onStop)

    activeCtx = {
      projectId: rid,
      userId: uid,
      isLocalProject,
      trackId,
      tracks: tracks(),
      createdTrack,
      startSec,
      stream,
      recorder,
      chunks,
      mimeType: mimeType || recorder?.mimeType || '',
      lockedByUserId: uid ?? '',
      engineCaptureActive,
      engineCaptureSessionId,
      savedAudioSource: engineCaptureActive ? 'worklet-pcm-f32' : 'media-recorder-compressed',
      sampleRate,
      manualOffsetFrames: requestedSettings.manualOffsetFrames,
      onDataAvailable,
      onStop,
      stopPromise: stopCompletion.promise,
      rejectStopPromise: stopCompletion.reject,
    }

    lockHeartbeatTimer = clearRecordingLockHeartbeat(lockHeartbeatTimer)
    if (!isLocalProject) {
      lockHeartbeatTimer = startRecordingLockHeartbeat({
        projectId: rid,
        trackId,
        locker: uid ?? '',
        onError: (error) => {
          console.warn('[useTrackRecording] failed to refresh track lock', error)
        },
      })
    }

    try {
      recorder?.start()
    } catch (err) {
      console.error('[useTrackRecording] recorder.start failed', err)
      emit('Failed to start recording.')
      await cleanupRecording()
      return { ok: false, reason: 'Recorder failed to start' }
    }

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
      if (ctx.recorder && ctx.recorder.state !== 'inactive') {
        ctx.recorder.stop()
      }
      if (ctx.engineCaptureActive) {
        await audioEngine.stopRecordingCapture()
        haltLivePreview()
        await finalizeRecording()
        return
      }
    } catch (err) {
      console.error('[useTrackRecording] recorder.stop failed', err)
      ctx.rejectStopPromise(err)
      await cleanupRecording()
      await handleAutoCreatedTrackFailure(ctx.createdTrack, ctx)
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
      await handleAutoCreatedTrackFailure(target.track)
    }
    return result
  }

  onCleanup(() => {
    unsubscribeRecordingStatus()
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
