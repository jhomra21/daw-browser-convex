import { batch, createSignal, onCleanup, type Accessor } from 'solid-js'

import { createLocalAudioClip, createUploadedAudioClip, pushClipCreateHistory } from '~/lib/clip-create'
import type { ClipCreateSnapshot } from '@daw-browser/shared'
import type { ClipBufferWriter } from '~/lib/clip-buffer-cache'
import { createAudioAssetKey, getAudioSourceMetadata } from '~/lib/audio-source'
import type { AudioEngine } from '@daw-browser/audio-engine/audio-engine'
import { createLocalAsset, deleteLocalAsset, LocalAssetWriteError } from '~/lib/local-assets'
import { trackColorForClip } from '~/lib/clip-color'
import { isClipKindCompatibleWithTrack, isLocalId } from '@daw-browser/shared'
import type { OptimisticGrantScope } from '~/lib/optimistic-grant-scope'
import { isSharedOutboxQueuedError } from '~/lib/shared-outbox'
import { publishSharedTimelineOperation } from '~/lib/shared-timeline-operations-api'
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
import { resetRecordingDiagnostics, updateRecordingDiagnostics } from '~/lib/recording/recording-diagnostics'
import { createRecordingTempStorage } from '~/lib/recording/recording-temp-storage'
import { encodeRecordingWav } from '~/lib/recording/encode-recording-wav'
import {
  createDesktopAudioLifecycleReconciler,
  isNativeRecordingLifecycleEligible,
  shouldCancelRecordingForLifecycle,
} from '~/lib/desktop-audio-lifecycle'
import {
  ensureTrackForRecording,
  finalizeAutoCreatedTrackFailure,
} from '~/lib/track-recording-target'
import { canTrackReceiveAudioClip } from '@daw-browser/timeline-core/track-routing'
import { calcNonOverlapStart, willOverlap } from '~/lib/timeline-utils'
import { buildTrackClipCreateHistoryEntry } from '~/lib/undo/builders'
import { getTrackHistoryRef } from '~/lib/undo/refs'
import type { HistoryEntry } from '~/lib/undo/types'
import type { convexApi, convexClient } from '~/lib/convex'
import type { UploadToR2 } from '~/hooks/useClipBuffers'
const isString = (cause: unknown): cause is string => typeof cause === 'string'

import type { Track } from '@daw-browser/timeline-core/types'
import type { AudioPreferences, RecordingPreferences } from '~/lib/preferences/app-preferences'
import { buildRecordingConstraints } from '~/lib/audio-settings-core'
import { resolveCalibrationPlatformIdentity, resolveRecordingOffsetFrames } from '~/lib/recording/recording-calibration'
import type { PortableRecordingDiagnostics } from '~/lib/portable-browser-playback-controller'
import type { NativeRecordingDiagnostics } from '~/lib/desktop/native-playback-controller'

import type { TimelineSelectionController } from './useTimelineSelectionState'

type ConvexClientType = typeof convexClient

type ConvexApiType = typeof convexApi

type UseTrackRecordingOptions = {
  audioEngine: AudioEngine
  requiresNativeAudio?: boolean
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
  requestTransportStop?: () => Promise<void>
  portableRecording?: {
    enabled: Accessor<boolean>
    controller: {
      start: (input: {
        appSessionId: string
        stream: MediaStream
        layout: "mono" | "stereo"
        inputChannel: number
        gain: number
        polarity: 1 | -1
        monitoring: boolean
        punchStartFrame: number
        punchEndFrame?: number
        onDiagnostics?: (diagnostics: PortableRecordingDiagnostics) => void
        onFailure?: (error: Error) => void
      }) => Promise<{ sampleRate: number; channelCount: number; startFrame: number }>
      stop: () => Promise<{ capturedFrames: number }>
      cancel: () => Promise<void>
      isActive: () => boolean
    }
  }
  nativeRecording?: {
    enabled: Accessor<boolean>
    controller: {
      start: (input: {
        appSessionId: string
        layout: "mono" | "stereo"
        inputChannel: number
        gain: number
        polarity: 1 | -1
        monitoring: boolean
        punchStartFrame: number
        punchEndFrame?: number
        onDiagnostics?: (diagnostics: NativeRecordingDiagnostics) => void
        onFailure?: (error: Error) => void
      }) => Promise<{ sampleRate: number; channelCount: number; startFrame: number }>
      stop: () => Promise<{ capturedFrames: number }>
      cancel: () => Promise<void>
      isActive: () => boolean
      sampleRate: () => number
    }
  }
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
    requiresNativeAudio = false,
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
    requestTransportStop,
    portableRecording,
    nativeRecording,
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
  const audioHostBridge = globalThis.window?.dawDesktop?.audioHost
  const hasAudioLifecycle = audioHostBridge !== undefined
  let audioLifecycleState: "suspended" | "recovering" | "ready" | "failed" = hasAudioLifecycle ? "recovering" : "ready"
  let recordingStartGeneration = 0
  let lockHeartbeatTimer: number | null = null
  let previewContextStartFrame = 0
  let previewSampleRate = 1

  const publishLivePreview = (offset: number, amplitude: number) => {
    const cutoff = Math.max(0, offset - 5)
    livePreviewPoints.push({ offset, amplitude: Math.min(1, amplitude) })
    while (livePreviewStartIndex < livePreviewPoints.length && livePreviewPoints[livePreviewStartIndex].offset < cutoff) {
      livePreviewStartIndex++
    }
    if (livePreviewStartIndex > 128) {
      livePreviewPoints.splice(0, livePreviewStartIndex)
      livePreviewStartIndex = 0
    }
    setPreviewPoints(livePreviewStartIndex === 0 ? livePreviewPoints : livePreviewPoints.slice(livePreviewStartIndex))
  }

  const unsubscribeRecordingStatus = audioEngine.subscribeRecordingStatus((status) => {
    if (status.state === 'recording') {
      updateRecordingDiagnostics({
        capturedFrames: Math.max(0, status.contextFrame - previewContextStartFrame),
        muted: status.muted,
        deviceLost: false,
      })
    } else if (status.state === 'complete') {
      updateRecordingDiagnostics({ capturedFrames: status.capturedFrames, queuedFrames: 0 })
    } else if (status.state === 'failed') {
      updateRecordingDiagnostics({
        deviceLost: status.reason === 'recording-device-ended',
        lastFailure: status.reason,
      })
    }
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
    publishLivePreview(offset, status.rms)
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
    if (!canTrackReceiveAudioClip(targetTrack) && !isClipKindCompatibleWithTrack(targetTrack, 'midi')) return
    if (targetTrack?.lockedBy && targetTrack.lockedBy !== uid) return
    setRecordArmTrackId((current) => current === trackId ? null : trackId)
  }

  const reconcileRecordArm = (nextTracks: Track[]) => {
    const armedTrackId = recordArmTrackId()
    if (!armedTrackId) return
    const uid = userId()
    const availableTrack = nextTracks.find((track) => track.id === armedTrackId)
    if (!availableTrack || (!canTrackReceiveAudioClip(availableTrack) && !isClipKindCompatibleWithTrack(availableTrack, 'midi')) || (availableTrack.lockedBy && availableTrack.lockedBy !== uid)) {
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
    if (ctx?.nativeCaptureActive) {
      await nativeRecording?.controller.cancel().catch(() => undefined)
    } else if (ctx?.portableCaptureActive) {
      await portableRecording?.controller.cancel().catch(() => undefined)
    } else if (ctx?.engineCaptureActive) {
      audioEngine.cancelRecordingCapture()
    }
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
    const desiredStart = Math.max(0, ctx.startSec + ctx.recordingOffsetFrames / ctx.sampleRate)
    const nonOverlapStart = willOverlap(targetTrack.clips, null, desiredStart, baseDuration)
      ? calcNonOverlapStart(targetTrack.clips, null, desiredStart, baseDuration)
      : desiredStart

    if (isLocalProject) {
      let assetId: string | undefined
      try {
        const asset = await createLocalAsset({
          projectId: rid,
          file,
          metadata: { ...sourceMetadata, sourceKind: 'recording' },
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
          return isString(result) ? result : null
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
    if (audioLifecycleState === "suspended") return { ok: false, reason: 'Audio lifecycle is suspended' }
    const startGeneration = recordingStartGeneration
    const isStartCurrent = () => (
      startGeneration === recordingStartGeneration
      && audioLifecycleState !== 'suspended'
    )
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
    let nativeRequested = requiresNativeAudio || isNativeRecordingLifecycleEligible(
      audioLifecycleState,
      nativeRecording?.enabled() ?? false,
    )
    let portableRequested = !nativeRequested && (portableRecording?.enabled() ?? false)
    if (requiresNativeAudio && !nativeRecording?.controller) {
      emit('Native audio recording is unavailable.')
      return { ok: false, reason: 'Native recorder unavailable' }
    }
    if (!requiresNativeAudio && !nativeRequested && !portableRequested && !productionSupported && !recordingSupport.supported) {
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

    let stream: MediaStream | null = null
    const acquireStream = async () => {
      if (stream) return stream
      stream = await navigator.mediaDevices.getUserMedia({
        audio: buildRecordingConstraints(audioPreferences(), navigator.mediaDevices.getSupportedConstraints())
      })
      return stream
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
    let startSec = Math.max(0, playheadSec())

    let engineCaptureActive = false
    let portableCaptureActive = false
    let nativeCaptureActive = false
    let transportStarted = false
    const engineCaptureSessionId = `take-${Date.now()}`
    const requestedSettings = recordingPreferences()
    await resolveCalibrationPlatformIdentity(navigator)
    if (!requiresNativeAudio) ensureRecordingAudioContext(audioEngine)
    const engineContext = requiresNativeAudio ? undefined : audioEngine.getAudioContext()
    let sampleRate = engineContext?.sampleRate ?? 1
    if (nativeRequested) try {
      await requestTransportPlay()
      if (!isStartCurrent() || audioLifecycleState !== 'ready') throw new Error('Native audio lifecycle is unavailable.')
      transportStarted = true
      if (!nativeRecording?.controller.isActive()) throw new Error('Native playback is unavailable.')
      const nativeSampleRate = nativeRecording.controller.sampleRate()
      if (nativeSampleRate <= 0) throw new Error('Native playback sample rate is unavailable.')
      resetRecordingDiagnostics()
      previewSampleRate = nativeSampleRate
      previewContextStartFrame = Math.floor(startSec * nativeSampleRate)
      const native = await nativeRecording.controller.start({
        appSessionId: engineCaptureSessionId,
        layout: requestedSettings.layout,
        inputChannel: requestedSettings.inputChannel,
        gain: 10 ** (requestedSettings.gainDb / 20),
        polarity: requestedSettings.invertPolarity ? -1 : 1,
        monitoring: requestedSettings.monitor === 'on' || requestedSettings.monitor === 'auto',
        punchStartFrame: previewContextStartFrame,
        onDiagnostics: (diagnostics) => {
          updateRecordingDiagnostics({
            capturedFrames: diagnostics.capturedFrames,
            overrunFrames: diagnostics.droppedFrames,
            droppedFrames: diagnostics.droppedFrames,
            queuedFrames: diagnostics.queuedBlocks * 2048,
            muted: false,
            lastFailure: diagnostics.fatal ? 'native-recording-overflow' : null,
          })
          publishLivePreview(diagnostics.capturedFrames / previewSampleRate, diagnostics.rms)
        },
        onFailure: (error) => {
          const failedContext = activeCtx
          if (!failedContext?.nativeCaptureActive || failedContext.engineCaptureSessionId !== engineCaptureSessionId) return
          updateRecordingDiagnostics({ deviceLost: true, lastFailure: error.message })
          void (async () => {
            await createRecordingTempStorage().remove(engineCaptureSessionId).catch(() => undefined)
            await cleanupRecording()
            await handleAutoCreatedTrackFailure(failedContext.createdTrack, failedContext)
          })()
        },
      })
      if (!isStartCurrent() || audioLifecycleState !== 'ready') {
        await nativeRecording.controller.cancel().catch(() => undefined)
        throw new Error('Native audio lifecycle is unavailable.')
      }
      sampleRate = native.sampleRate
      startSec = native.startFrame / native.sampleRate
      const requestedSampleRate = audioPreferences().sampleRate
      updateRecordingDiagnostics({
        requestedFormat: 'pcm',
        activeFormat: 'pcm',
        requestedLayout: requestedSettings.layout,
        activeChannels: native.channelCount,
        requestedSampleRate: requestedSampleRate === 'default' ? null : requestedSampleRate,
        activeSampleRate: native.sampleRate,
        transport: 'transferable',
        queuedFrames: 0,
        overrunFrames: 0,
        droppedFrames: 0,
      })
      nativeCaptureActive = true
      engineCaptureActive = true
    } catch (err) {
      console.warn('[useTrackRecording] native PCM capture unavailable; using compatibility fallback', err)
      if (requiresNativeAudio) {
        await nativeRecording?.controller.cancel().catch(() => undefined)
        if (transportStarted) await requestTransportStop?.().catch(() => undefined)
        await releaseTrackLock(trackId, uid, isLocalProject)
        emit(err instanceof Error ? err.message : 'Native audio recording is unavailable.')
        return { ok: false, reason: 'Native recorder unavailable' }
      }
      if (hasAudioLifecycle && audioLifecycleState !== 'ready') {
        nativeRequested = false
        portableRequested = portableRecording?.enabled() ?? false
      }
      if (!isStartCurrent()) {
        await releaseTrackLock(trackId, uid, isLocalProject)
        return { ok: false, reason: 'Audio lifecycle is suspended' }
      }
    }

    if (!nativeCaptureActive && !requiresNativeAudio) try {
      stream = await acquireStream()
      const trackSampleRate = stream.getAudioTracks()[0]?.getSettings().sampleRate
      if (Number.isFinite(trackSampleRate) && trackSampleRate !== undefined) sampleRate = trackSampleRate
    } catch (error) {
      const missingDevice = error instanceof DOMException && (error.name === 'NotFoundError' || error.name === 'OverconstrainedError')
      const permissionDenied = error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'SecurityError')
      emit(missingDevice ? 'The selected microphone is unavailable.' : permissionDenied ? 'Microphone access denied.' : 'Unable to capture microphone audio.')
      await releaseTrackLock(trackId, uid, isLocalProject)
      return { ok: false, reason: missingDevice ? 'Device unavailable' : permissionDenied ? 'Permission denied' : 'Capture failed' }
    }

    if (portableRequested && !requiresNativeAudio) try {
      await requestTransportPlay()
      if (!isStartCurrent()) throw new Error('Audio lifecycle is suspended.')
      transportStarted = true
      if (!portableRecording?.controller.isActive()) throw new Error('Portable playback is unavailable.')
      resetRecordingDiagnostics()
      const captureContext = audioEngine.getAudioContext()
      if (!captureContext) throw new Error('Audio engine context unavailable.')
      if (!stream) throw new Error('Microphone capture is unavailable.')
      previewSampleRate = captureContext.sampleRate
      previewContextStartFrame = Math.floor(startSec * captureContext.sampleRate)
      const portable = await portableRecording.controller.start({
        appSessionId: engineCaptureSessionId,
        stream,
        layout: requestedSettings.layout,
        inputChannel: requestedSettings.inputChannel,
        gain: 10 ** (requestedSettings.gainDb / 20),
        polarity: requestedSettings.invertPolarity ? -1 : 1,
        monitoring: requestedSettings.monitor === 'on' || requestedSettings.monitor === 'auto',
        punchStartFrame: previewContextStartFrame,
        onDiagnostics: (diagnostics) => {
          updateRecordingDiagnostics({
            capturedFrames: diagnostics.capturedFrames,
            overrunFrames: diagnostics.droppedFrames,
            droppedFrames: diagnostics.droppedFrames,
            queuedFrames: diagnostics.queuedBlocks * 2048,
            muted: false,
            lastFailure: diagnostics.fatal ? 'portable-recording-overflow' : null,
          })
          const offset = diagnostics.capturedFrames / previewSampleRate
          publishLivePreview(offset, diagnostics.rms)
        },
        onFailure: (error) => {
          const failedContext = activeCtx
          if (!failedContext?.portableCaptureActive || failedContext.engineCaptureSessionId !== engineCaptureSessionId) return
          updateRecordingDiagnostics({
            deviceLost: error.message === 'Portable recording device ended.',
            lastFailure: error.message,
          })
          void (async () => {
            await createRecordingTempStorage().remove(engineCaptureSessionId).catch(() => undefined)
            await cleanupRecording()
            await handleAutoCreatedTrackFailure(failedContext.createdTrack, failedContext)
          })()
        },
      })
      if (!isStartCurrent()) {
        await portableRecording.controller.cancel().catch(() => undefined)
        throw new Error('Audio lifecycle is suspended.')
      }
      sampleRate = portable.sampleRate
      startSec = portable.startFrame / portable.sampleRate
      const requestedSampleRate = audioPreferences().sampleRate
      updateRecordingDiagnostics({
        requestedFormat: 'pcm',
        activeFormat: 'pcm',
        requestedLayout: requestedSettings.layout,
        activeChannels: portable.channelCount,
        requestedSampleRate: requestedSampleRate === 'default' ? null : requestedSampleRate,
        activeSampleRate: portable.sampleRate,
        transport: 'transferable',
        queuedFrames: 0,
        overrunFrames: 0,
        droppedFrames: 0,
      })
      portableCaptureActive = true
      engineCaptureActive = true
    } catch (err) {
      console.warn('[useTrackRecording] portable PCM capture unavailable; using compatibility fallback', err)
      if (!isStartCurrent()) {
        stream?.getTracks().forEach((mediaTrack) => mediaTrack.stop())
        await releaseTrackLock(trackId, uid, isLocalProject)
        return { ok: false, reason: 'Audio lifecycle is suspended' }
      }
    }

    if (!requiresNativeAudio && !engineCaptureActive && productionSupported) try {
      resetRecordingDiagnostics()
      await audioEngine.resume()
      if (!isStartCurrent()) throw new Error('Audio lifecycle is suspended.')
      const captureContext = audioEngine.getAudioContext()
      if (!captureContext) throw new Error('Audio engine context unavailable.')
      if (!stream) throw new Error('Microphone capture is unavailable.')
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
        createTransport: (transportOptions) => {
          const selected = createRecordingTransport({
            ...transportOptions,
            onDiagnostics: (next) => updateRecordingDiagnostics(next),
          })
          const requestedSampleRate = audioPreferences().sampleRate
          updateRecordingDiagnostics({
            requestedFormat: 'pcm',
            activeFormat: 'pcm',
            requestedLayout: requestedSettings.layout,
            activeChannels: requestedSettings.layout === 'stereo' ? 2 : 1,
            requestedSampleRate: requestedSampleRate === 'default' ? null : requestedSampleRate,
            activeSampleRate: transportOptions.sampleRate,
            transport: selected.diagnostics.active,
            queuedFrames: selected.diagnostics.active === 'transferable' ? 0 : null,
            overrunFrames: null,
            droppedFrames: null,
          })
          return selected.transport
        },
      })
      engineCaptureActive = true
    } catch (err) {
      console.warn('[useTrackRecording] production PCM capture unavailable; using compressed fallback', err)
      if (!isStartCurrent()) {
        stream?.getTracks().forEach((mediaTrack) => mediaTrack.stop())
        await releaseTrackLock(trackId, uid, isLocalProject)
        return { ok: false, reason: 'Audio lifecycle is suspended' }
      }
    }

    if (!engineCaptureActive) {
      if (requiresNativeAudio) {
        await releaseTrackLock(trackId, uid, isLocalProject)
        emit('Native audio recording did not start.')
        return { ok: false, reason: 'Native recorder unavailable' }
      }
      if (!isStartCurrent()) {
        stream?.getTracks().forEach((mediaTrack) => mediaTrack.stop())
        await releaseTrackLock(trackId, uid, isLocalProject)
        return { ok: false, reason: 'Audio lifecycle is suspended' }
      }
      if (!stream) {
        await releaseTrackLock(trackId, uid, isLocalProject)
        return { ok: false, reason: 'Capture failed' }
      }
      const requestedSampleRate = audioPreferences().sampleRate
      updateRecordingDiagnostics({
        requestedFormat: 'pcm',
        activeFormat: 'compressed',
        requestedLayout: requestedSettings.layout,
        activeChannels: stream.getAudioTracks()[0]?.getSettings().channelCount ?? null,
        requestedSampleRate: requestedSampleRate === 'default' ? null : requestedSampleRate,
        activeSampleRate: stream.getAudioTracks()[0]?.getSettings().sampleRate ?? null,
        transport: null,
      })
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
      portableCaptureActive,
      nativeCaptureActive,
      engineCaptureSessionId,
      savedAudioSource: engineCaptureActive ? 'worklet-pcm-f32' : 'media-recorder-compressed',
      sampleRate,
      recordingOffsetFrames: resolveRecordingOffsetFrames(
        requestedSettings.calibrations,
        {
          inputDeviceId: audioPreferences().inputDeviceId,
          outputDeviceId: audioPreferences().outputDeviceId,
          sampleRate,
          platform: navigator.platform,
          userAgent: navigator.userAgent,
          userAgentData: navigator.userAgentData,
        },
        requestedSettings.manualOffsetFrames,
      ).frames,
      onDataAvailable,
      onStop,
      stopPromise: stopCompletion.promise,
      rejectStopPromise: stopCompletion.reject,
    }
    if (!isStartCurrent()) {
      await cleanupRecording()
      return { ok: false, reason: 'Audio lifecycle is suspended' }
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

    if (!transportStarted) {
      try {
        await requestTransportPlay()
      } catch (err) {
        console.warn('[useTrackRecording] requestTransportPlay failed', err)
      }
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
        if (ctx.nativeCaptureActive) {
          await nativeRecording?.controller.stop()
        } else if (ctx.portableCaptureActive) {
          await portableRecording?.controller.stop()
        } else {
          await audioEngine.stopRecordingCapture()
        }
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

  const removeAudioLifecycle = audioHostBridge
    ? createDesktopAudioLifecycleReconciler(audioHostBridge, (lifecycle) => {
      audioLifecycleState = lifecycle.state
      if (lifecycle.state === 'suspended') recordingStartGeneration += 1
      if (!activeCtx || !shouldCancelRecordingForLifecycle(lifecycle.state, activeCtx.nativeCaptureActive)) return
      const interruptedContext = activeCtx
      void cleanupRecording()
        .then(() => handleAutoCreatedTrackFailure(interruptedContext.createdTrack, interruptedContext))
        .catch(() => undefined)
    })
    : undefined

  onCleanup(() => {
    removeAudioLifecycle?.()
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
