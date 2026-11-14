import { expect, test } from 'bun:test'
import { mkdir, rm } from 'node:fs/promises'
import { z } from 'zod'
import { build } from 'vite'
import solidPlugin from 'vite-plugin-solid'
import tailwindcss from '@tailwindcss/vite'

const fixture = `
import { createComponent, createEffect, createRoot, createSignal, onCleanup } from 'solid-js'
import { render } from 'solid-js/web'
import { useTrackRecording } from './useTrackRecording'
import { useTimelinePlayback } from './useTimelinePlayback'
import { createRecordingTransportPolicy, dispatchRecordingToggle, dispatchTransportSpace, retryPendingRecordingCleanup } from './recording-dispatch'
import { createMidiTrackRecordingController } from '../lib/midi/midi-recording-controller'
import { useMidiTrackRecording } from './useMidiTrackRecording'
import { createMidiRecordingCheckpointController } from '../lib/midi/recording-checkpoint'
import { TransportBar } from '../components/timeline/TransportControls'
import * as recordingTarget from '../lib/track-recording-target'
import TrackLane from '../components/timeline/TrackLane'
import TrackSidebarRow from '../components/timeline/TrackSidebarRow'
import '~/index.css'

const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
const settle = async () => { for (let index = 0; index < 32; index += 1) await Promise.resolve() }
// Chromium queues unhandledrejection as a task, so reads must follow one macrotask.
const macrotask = () => new Promise(resolve => setTimeout(resolve, 0))

window.recordingScenarios = async () => {
  const results = {}
  window.recordingDeltas = {}
  const track = { id: 'track-audio', kind: 'audio', name: 'Audio', volume: 1, clips: [] }
  const captureGate = deferred()
  const micGate = deferred()
  const micRequested = deferred()
  const captureEntered = deferred()
  const calls = []
  const audioNotices = []
  let activeUserId
  let lockGate = deferred()
  let lockRequested = deferred()
  let releasedStaleLocks = 0
  let captureStarts = 0
  let takes = 0
  let audioHistoryCount = 0
  let tracksEnded = 0
  let dispose
  const streamTrack = { readyState: 'live', stop: () => { tracksEnded += 1 }, getSettings: () => ({ sampleRate: 48000 }) }
  const stream = { getTracks: () => [streamTrack], getAudioTracks: () => [streamTrack] }
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
    getSupportedConstraints: () => ({}),
    getUserMedia: () => { calls.push('mic'); micRequested.resolve(); return micGate.promise },
  } })
  const audioEngine = {
    ensureAudio: () => {},
    resume: async () => {},
    getAudioContext: () => ({ sampleRate: 48000, currentTime: 0 }),
    subscribeRecordingStatus: () => () => {},
    cancelRecordingCapture: () => calls.push('capture-cancel'),
    stopRecordingCapture: async () => {},
  }
  const portableController = {
    start: async () => {
      captureStarts += 1
      calls.push('capture-start')
      captureEntered.resolve()
      await captureGate.promise
      return { sampleRate: 48000, channelCount: 1, startFrame: 0 }
    },
    stop: async () => ({ capturedFrames: 1 }),
    cancel: async () => { calls.push('capture-cancel') },
    isActive: () => true,
  }
  const selection = {
    selectTrackTarget: () => {}, selectPrimaryClip: () => {}, selectedClip: () => null,
    selectedClipIds: () => new Set(), selectedTrackId: () => '', selectedFXTarget: () => 'master',
    rangeSelection: () => null, appendClipToSelection: () => {}, selectClipGroup: () => {},
    selectMasterTarget: () => {}, selectTimeRange: () => {}, clearTimeRange: () => {},
    setSelectedClipIds: () => {}, setSelectedClip: () => {}, setSelectedTrackId: () => {},
    setSelectedFXTarget: () => {},
  }
  const [projectId, setProjectId] = createSignal('project:test')
  const hook = createRoot(cleanup => {
    dispose = cleanup
    return useTrackRecording({
      audioEngine, tracks: () => window.audioTracksUnavailable ? [] : [track], setTrackLock: () => {}, clearTrackLock: () => {},
      removeLocalTrack: () => {}, insertLocalClip: () => {}, removeLocalClips: () => {},
      selection, playheadSec: () => 0, uploadToR2: async () => null,
      audioBufferCache: { storeBuffer: () => {}, storeBuffers: () => {}, removeBuffer: () => {} },
      projectId, userId: () => activeUserId, convexClient: {}, convexApi: {},
      requestTransportPlay: async () => { calls.push('play'); await window.livePlayback?.handlePlay([track]) },
      requestTransportStop: async () => { calls.push('stop'); await window.livePlayback?.handleStop() },
      portableRecording: { enabled: () => true, controller: portableController },
      nativeRecording: { enabled: () => false, controller: {
        start: async () => ({ sampleRate: 48000, channelCount: 1, startFrame: 0 }),
        stop: async () => ({ capturedFrames: 1 }), cancel: async () => {},
        isActive: () => false, sampleRate: () => 48000,
      } },
      createTrackForRecording: () => window.createRecordingTrack?.() ?? Promise.resolve(null), notify: message => audioNotices.push(message), onLocalSaveFailed: () => {},
      historyPush: () => { audioHistoryCount += 1 }, audioPreferences: () => ({
        inputDeviceId: '', outputDeviceId: '', sampleRate: 48000, latencyMode: 'balanced',
        echoCancellation: false, noiseSuppression: false, autoGainControl: false, nativePlaybackEnabled: false,
      }),
      recordingPreferences: () => ({
        layout: 'mono', inputChannel: 0, monitor: 'off', gainDb: 0, invertPolarity: false,
        portableEnabled: true, manualOffsetFrames: 0, calibrations: [],
      }),
      finalization: {
        acquireTrackLock: () => {
          lockRequested.resolve()
          return lockGate.promise
        },
        releaseTrackLock: async () => { releasedStaleLocks += 1 },
        storage: { open: async () => ({ version: 1, sessionId: 'take', format: 'planar-float32-blocks',
          sampleRate: 48000, channelCount: 1, capturedFrames: 1, byteLength: 8, createdAtMs: 0, finalizedAtMs: 0 }),
          remove: async () => {}, cleanupStale: async () => {} },
        encodeWav: async () => ({ file: new File([new Uint8Array(8)], 'take.wav'), fileName: 'take.wav',
          mimeType: 'audio/wav', remove: async () => {} }),
        createLocalAsset: async () => ({ id: 'asset:take', name: 'take.wav', mimeType: 'audio/wav',
          sizeBytes: 8, storagePath: 'take.wav', sourceKind: 'recording', createdAt: 0, updatedAt: 0 }),
        createLocalAudioClip: async () => { window.transportOrdering?.push('take-finalized'); takes += 1; return { clipId: 'clip:take', clip: { name: 'take', startSec: 0, duration: 1 / 48000 } } },
        deleteLocalAsset: async () => null,
      },
    })
  })

  const first = hook.toggleRecording()
  const second = hook.toggleRecording()
  const firstResult = first
  const secondResult = second
  results['double-record-busy'] = hook.isStarting()
  await micRequested.promise
  results['one-mic-request'] = calls.filter(call => call === 'mic').length === 1
  micGate.resolve(stream)
  await captureEntered.promise
  results['one-capture-start'] = captureStarts === 1
  captureGate.resolve()
  const [firstOutcome, secondOutcome] = await Promise.all([firstResult, secondResult])
  results['start-succeeded'] = firstOutcome.ok && secondOutcome.ok
  results['one-take'] = takes === 0 && hook.isRecording()
  results['start-busy-cleared'] = !hook.isStarting()
  await hook.stopRecording()
  results['one-finalized-take'] = takes === 1
  results['audio-normal-stop-clears-recording-state'] = !hook.isRecording() && !hook.isStarting()

  activeUserId = 'user-audio'
  setProjectId('cloud-project-audio')
  hook.toggleRecordArm(track.id)
  const refusedLockStart = hook.toggleRecording()
  await lockRequested.promise
  const refusedLockStop = hook.stopRecording()
  lockGate.resolve({ ok: false, reason: 'Server refused lock.' })
  await Promise.all([refusedLockStart, refusedLockStop])
  results['cancelled-cloud-lock-refusal-is-silent'] = audioNotices.length === 0
    && !hook.isRecording()
  window.recordingDeltas['cancelled-cloud-lock-refusal'] = {
    noticeDelta: audioNotices.length,
  }

  lockGate = deferred()
  lockRequested = deferred()
  const staleLockStart = hook.toggleRecording()
  await lockRequested.promise
  const staleLockStop = hook.stopRecording()
  lockGate.resolve({ ok: true })
  await Promise.all([staleLockStart, staleLockStop])
  results['cancelled-cloud-lock-is-released'] = releasedStaleLocks === 1
    && !hook.isRecording()
  window.recordingDeltas['cancelled-cloud-lock-release'] = {
    releaseCount: releasedStaleLocks,
  }
  setProjectId('project:test')
  activeUserId = undefined
  window.liveAudioRecording = hook
  window.disposeAudioRecording = dispose
  window.audioTakeCount = () => takes
  window.audioHistoryCount = () => audioHistoryCount
  window.audioNoticeCount = () => audioNotices.length
  window.audioNotices = audioNotices
  window.recordingStream = stream
  if (hook.recordArmTrackId() !== 'track-audio') hook.toggleRecordArm('track-audio')

  // Stop during capture configuration cancels transport/capture and releases
  // the acquired stream before the deferred setup promise settles.
  const setupGate = deferred()
  const setupCalls = []
  const setupNotices = []
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
    getSupportedConstraints: () => ({}), getUserMedia: async () => stream,
  } })
  const setupController = {
    start: async () => { setupCalls.push('capture-start'); await setupGate.promise; return { sampleRate: 48000, channelCount: 1, startFrame: 0 } },
    stop: async () => ({ capturedFrames: 1 }),
    cancel: async () => { setupCalls.push('capture-cancel') },
    isActive: () => true,
  }
  let setupDispose
  const setupHook = createRoot(cleanup => {
    setupDispose = cleanup
    return useTrackRecording({
      audioEngine, tracks: () => [track], setTrackLock: () => {}, clearTrackLock: () => {},
      removeLocalTrack: () => {}, insertLocalClip: () => {}, removeLocalClips: () => {},
      selection, playheadSec: () => 0, uploadToR2: async () => null,
      audioBufferCache: { storeBuffer: () => {}, storeBuffers: () => {}, removeBuffer: () => {} },
      projectId, userId: () => undefined, convexClient: {}, convexApi: {},
      requestTransportPlay: async () => { setupCalls.push('play') },
      requestTransportStop: async () => { setupCalls.push('stop') },
      portableRecording: { enabled: () => true, controller: setupController },
      nativeRecording: { enabled: () => false, controller: {
        start: async () => ({ sampleRate: 48000, channelCount: 1, startFrame: 0 }),
        stop: async () => ({ capturedFrames: 1 }), cancel: async () => {},
        isActive: () => false, sampleRate: () => 48000,
      } },
      createTrackForRecording: async () => null, notify: message => setupNotices.push(message), onLocalSaveFailed: () => {},
      historyPush: () => {}, audioPreferences: () => ({
        inputDeviceId: '', outputDeviceId: '', sampleRate: 48000, latencyMode: 'balanced',
        echoCancellation: false, noiseSuppression: false, autoGainControl: false, nativePlaybackEnabled: false,
      }),
      recordingPreferences: () => ({
        layout: 'mono', inputChannel: 0, monitor: 'off', gainDb: 0, invertPolarity: false,
        portableEnabled: true, manualOffsetFrames: 0, calibrations: [],
      }),
    })
  })
  const captureCancelCountBeforeSetup = setupCalls.filter(call => call === 'capture-cancel').length
  const stopCountBeforeSetup = setupCalls.filter(call => call === 'stop').length
  const pendingSetup = setupHook.toggleRecording()
  await settle()
  const stop = setupHook.stopRecording()
  results['stop-immediate-transport'] = setupCalls.filter(call => call === 'stop').length > stopCountBeforeSetup
  results['stop-immediate-capture-cancel'] = setupCalls.filter(call => call === 'capture-cancel').length > captureCancelCountBeforeSetup
  results['stream-released-before-settlement'] = tracksEnded > 0
  setupGate.resolve()
  await Promise.all([pendingSetup, stop])
  results['cancelled-start-stays-stopped'] = !setupHook.isRecording() && !setupHook.isStarting()
  const tracksEndedBeforeMicCancel = tracksEnded
  const lateMic = deferred()
  const micEntered = deferred()
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
    getSupportedConstraints: () => ({}),
    getUserMedia: () => { micEntered.resolve(); return lateMic.promise },
  } })
  const captureCountBeforeMicCancel = setupCalls.filter(call => call === 'capture-start').length
  const pendingMic = setupHook.toggleRecording()
  await micEntered.promise
  const micStopCountBefore = setupCalls.filter(call => call === 'stop').length
  const micStop = setupHook.stopRecording()
  results['mic-stage-stop-immediate'] = setupCalls.filter(call => call === 'stop').length > micStopCountBefore
  lateMic.reject(new DOMException('Permission denied', 'NotAllowedError'))
  await Promise.all([pendingMic, micStop])
  results['permission-rejection-after-cancel-is-silent'] = setupNotices.length === 0
    && setupCalls.filter(call => call === 'capture-start').length === captureCountBeforeMicCancel
    && !setupHook.isRecording()
  window.recordingDeltas['permission-rejection-after-cancel'] = {
    noticeCount: setupNotices.length,
    captureStartDelta: setupCalls.filter(call => call === 'capture-start').length - captureCountBeforeMicCancel,
  }
  results['mic-stage-busy-cleared'] = !setupHook.isStarting()

  const nativeStartGate = deferred()
  const nativeStartEntered = deferred()
  const nativeCalls = []
  let nativeDispose
  const nativeHook = createRoot(cleanup => {
    nativeDispose = cleanup
    return useTrackRecording({
      requiresNativeAudio: true,
      audioEngine,
      tracks: () => [track],
      setTrackLock: () => {},
      clearTrackLock: () => {},
      removeLocalTrack: () => {},
      insertLocalClip: () => {},
      removeLocalClips: () => {},
      selection,
      playheadSec: () => 0,
      uploadToR2: async () => null,
      audioBufferCache: { storeBuffer: () => {}, storeBuffers: () => {}, removeBuffer: () => {} },
      projectId,
      userId: () => undefined,
      convexClient: {},
      convexApi: {},
      requestTransportPlay: async () => { nativeCalls.push('play') },
      requestTransportStop: async () => { nativeCalls.push('stop') },
      portableRecording: { enabled: () => false, controller: setupController },
      nativeRecording: { enabled: () => true, controller: {
        start: async () => {
          nativeStartEntered.resolve()
          await nativeStartGate.promise
          return { sampleRate: 48000, channelCount: 1, startFrame: 0 }
        },
        stop: async () => ({ capturedFrames: 1 }),
        cancel: async () => { nativeCalls.push('cancel') },
        isActive: () => true,
        sampleRate: () => 48000,
      } },
      createTrackForRecording: async () => null,
      notify: () => {},
      onLocalSaveFailed: () => {},
      historyPush: () => {},
      audioPreferences: () => ({
        inputDeviceId: '', outputDeviceId: '', sampleRate: 48000, latencyMode: 'balanced',
        echoCancellation: false, noiseSuppression: false, autoGainControl: false, nativePlaybackEnabled: true,
      }),
      recordingPreferences: () => ({
        layout: 'mono', inputChannel: 0, monitor: 'off', gainDb: 0, invertPolarity: false,
        portableEnabled: false, manualOffsetFrames: 0, calibrations: [],
      }),
    })
  })
  const nativeCancelCountBefore = nativeCalls.filter(call => call === 'cancel').length
  const nativePending = nativeHook.toggleRecording()
  await nativeStartEntered.promise
  const nativeStopCountBefore = nativeCalls.filter(call => call === 'stop').length
  const nativeStop = nativeHook.stopRecording()
  results['native-stop-cancels-in-flight-start'] = nativeCalls.filter(call => call === 'stop').length > nativeStopCountBefore
  nativeStartGate.resolve()
  await Promise.all([nativePending, nativeStop])
  results['native-start-cancelled-once-without-resurrection'] =
    nativeCalls.filter(call => call === 'cancel').length - nativeCancelCountBefore === 1
    && nativeCalls.filter(call => call === 'play').length === 1
    && !nativeHook.isRecording()
  nativeDispose()
  setupDispose()

  const midiPermission = deferred()
  const midiPermissionEntered = deferred()
  let midiClipSetup = deferred()
  const midiClipSetupEntered = deferred()
  const successfulCancelledClipCreateEntered = deferred()
  const cancelledClipCreateEntered = deferred()
  const overlappingCleanupCreateEntered = deferred()
  const midiCalls = []
  const midiOperations = []
  const midiNotices = []
  let midiPlayhead = 12
  let provisionalClip = null
  let failMidiClipDeletion = false
  let midiClipCreateCount = 0
  let midiDeleteCount = 0
  let midiHistoryCount = 0
  const midiLocks = []
  let midiControllerIsRecording = () => false
  let setMidiControllerIsRecording = () => {}
  let midiControllerRecordingTrackId = () => null
  let setMidiControllerRecordingTrackId = () => {}
  window.fetch = async (_url, init) => {
    const body = JSON.parse(init.body)
    midiOperations.push(body.kind)
    if (body.kind === 'clips.removeMany' && failMidiClipDeletion) {
      midiDeleteCount += 1
      return new Response('{}', { status: 400 })
    }
    if (body.kind === 'clips.removeMany') midiDeleteCount += 1
    if (body.kind === 'tracks.lock') midiLocks.push(body.trackId)
    if (body.kind === 'tracks.unlock') midiLocks.splice(midiLocks.indexOf(body.trackId), 1)
    if (body.kind === 'tracks.lock' || body.kind === 'tracks.unlock' || body.kind === 'clips.removeMany') {
      return new Response(JSON.stringify({ ok: true }))
    }
    if (body.kind === 'clips.create') {
      midiClipCreateCount += 1
      if (midiClipCreateCount === 1) midiClipSetupEntered.resolve()
      if (midiClipCreateCount === 2) cancelledClipCreateEntered.resolve()
      if (midiClipCreateCount === 3) overlappingCleanupCreateEntered.resolve()
      if (midiClipCreateCount === 5) successfulCancelledClipCreateEntered.resolve()
      await midiClipSetup.promise
      return new Response(JSON.stringify('clip-midi-' + midiClipCreateCount))
    }
    return new Response('{}', { status: 500 })
  }
  let midiController
  let midiDispose
  const midiAccess = {
    inputs: () => [],
    requestAccess: () => {
      midiPermissionEntered.resolve()
      return midiPermission.promise
    },
    setInputSelected: () => {},
      subscribe: () => () => {},
    subscribeSourceReset: () => () => {},
    panic: () => {},
  }
  const instrumentTrack = { ...track, id: 'track-midi', kind: 'instrument' }
  createRoot(cleanup => {
    midiDispose = cleanup
    const [recording, setRecording] = createSignal(false)
    const [recordingTrackId, setRecordingTrackId] = createSignal(null)
    midiControllerIsRecording = recording
    setMidiControllerIsRecording = setRecording
    midiControllerRecordingTrackId = recordingTrackId
    setMidiControllerRecordingTrackId = setRecordingTrackId
    midiController = createMidiTrackRecordingController({
      audioEngine: { midiEventTimes: () => null },
      tracks: () => [instrumentTrack],
      projectId: () => 'cloud-project',
      userId: () => 'user-midi',
      playheadSec: () => midiPlayhead,
      bpm: () => 120,
      loopEnabled: () => false,
      recordArmTrackId: () => instrumentTrack.id,
      setTrackLock: (trackId, lockedBy) => {
        if (lockedBy) midiLocks.push(trackId)
        else midiLocks.splice(midiLocks.indexOf(trackId), 1)
      },
      clearTrackLock: () => {},
      insertLocalClip: () => midiCalls.push('take-created'),
      removeLocalClips: () => {},
      selection: { selectPrimaryClip: () => {} },
      requestTransportPlay: async () => { midiCalls.push('play'); await window.livePlayback?.handlePlay([instrumentTrack]) },
      pauseTransport: () => { midiCalls.push('stop'); midiPlayhead = 0; void window.livePlayback?.handlePause() },
      notify: message => midiNotices.push(message),
      historyPush: () => { midiHistoryCount += 1 },
      setActiveRecordingTarget: () => {},
      setProvisionalClipId: clipId => { provisionalClip = clipId },
      isRecording: midiControllerIsRecording,
      setIsRecording: setMidiControllerIsRecording,
      recordingTrackId: midiControllerRecordingTrackId,
      setRecordingTrackId: setMidiControllerRecordingTrackId,
    }, midiAccess)
  })
  const midiStart = midiController.startRecording()
  await midiPermissionEntered.promise
  midiPermission.resolve()
  await midiClipSetupEntered.promise
  const midiStop = midiController.stopRecording()
  results['midi-stop-invalidates-permission-start'] = midiCalls.includes('stop') && midiController.isStarting()
    && midiPlayhead === 0
  midiClipSetup.resolve()
  await Promise.all([midiStart, midiStop])
  results['midi-cancelled-setup-creates-no-take-or-play'] =
    !midiCalls.includes('take-created')
    && !midiCalls.includes('play')
    && midiOperations.includes('clips.removeMany')
    && !midiController.isRecording()
    && provisionalClip === null

  const nextPermission = deferred()
  const nextPermissionEntered = deferred()
  const noticesBeforeLatePermission = midiNotices.length
  midiAccess.requestAccess = () => {
    nextPermissionEntered.resolve()
    return nextPermission.promise
  }
  const staleStart = midiController.startRecording()
  await nextPermissionEntered.promise
  const immediateMidiStopCount = midiCalls.filter(call => call === 'stop').length
  const staleStop = midiController.stopRecording()
  results['pending-midi-permission-stops-at-start'] = midiCalls.filter(call => call === 'stop').length > immediateMidiStopCount
    && midiPlayhead === 0
  window.recordingDeltas['pending-midi-permission-stop'] = {
    stopDelta: midiCalls.filter(call => call === 'stop').length - immediateMidiStopCount,
    playheadAfterStop: midiPlayhead,
  }
  midiPlayhead = 7
  midiCalls.push('play')
  nextPermission.reject(new DOMException('Permission denied', 'NotAllowedError'))
  await Promise.all([staleStart, staleStop])
  results['stale-midi-handler-does-not-stop-later-play'] = midiPlayhead === 7
    && midiCalls.filter(call => call === 'play').length === 1
    && midiNotices.length === noticesBeforeLatePermission
  window.recordingDeltas['stale-midi-handler'] = {
    playheadAfterLatePermissionRejection: midiPlayhead,
    noticeDelta: midiNotices.length - noticesBeforeLatePermission,
    stopCountAfterLaterPlay: midiCalls.filter(call => call === 'stop').length - immediateMidiStopCount,
  }

  failMidiClipDeletion = true
  const deletionPermission = deferred()
  const deletionPermissionEntered = deferred()
  midiAccess.requestAccess = () => {
    deletionPermissionEntered.resolve()
    return deletionPermission.promise
  }
  const cancelledClipStart = midiController.startRecording()
  await deletionPermissionEntered.promise
  deletionPermission.resolve()
  await cancelledClipCreateEntered.promise
  const cancelledClipStop = midiController.stopRecording()
  const [cancelledClipOutcome, cancelledClipSettlement] = await Promise.all([
    cancelledClipStart,
    cancelledClipStop.then(() => true, () => false),
  ])
  results['failed-cancelled-clip-deletion-retains-protection'] = provisionalClip === 'clip-midi-2'
    && midiNotices.some(message => message.includes('could not be removed'))
    && !cancelledClipOutcome
    && !cancelledClipSettlement
  window.recordingDeltas['failed-cancelled-clip-deletion'] = {
    provisionalClipRetained: provisionalClip === 'clip-midi-2',
    failureNoticeCount: midiNotices.filter(message => message.includes('could not be removed')).length,
  }
  const noticesBeforeBlockedRecord = midiNotices.length
  let blockedAudioStarts = 0
  const cleanupGuardOptions = {
    cleanupPending: midiController.hasPendingCleanup,
    stopRecording: midiController.stopRecording,
  }
  const blockedRecord = await dispatchRecordingToggle({
    audioStarting: () => false,
    midiStarting: () => false,
    cleanupPending: cleanupGuardOptions.cleanupPending,
    isRecording: midiController.isRecording,
    recordingTrackId: midiController.recordingTrackId,
    armedTrack: () => ({ id: 'audio-target', kind: 'audio' }),
    stopRecording: midiController.stopRecording,
    toggleAudioRecording: async () => { blockedAudioStarts += 1; return { ok: true } },
    startMidiRecording: midiController.startRecording,
  })
  results['record-while-cleanup-retained-notifies'] = !blockedRecord.ok
    && midiNotices.length - noticesBeforeBlockedRecord === 1
    && blockedAudioStarts === 0
  results['audio-record-guard-shares-retained-cleanup'] = !blockedRecord.ok && blockedAudioStarts === 0
  failMidiClipDeletion = false
  const cleanupRecovered = await retryPendingRecordingCleanup(cleanupGuardOptions)
  results['guarded-stop-retries-cancelled-clip-cleanup'] = provisionalClip === null
    && midiOperations.filter(kind => kind === 'clips.removeMany').length >= 2
  results['guarded-cleanup-clears-project-transition-protection'] = cleanupRecovered
    && !midiController.hasPendingCleanup()
    && provisionalClip === null

  failMidiClipDeletion = true
  const overlappingPermission = deferred()
  const overlappingPermissionEntered = deferred()
  midiAccess.requestAccess = () => {
    overlappingPermissionEntered.resolve()
    return overlappingPermission.promise
  }
  const overlappingStart = midiController.startRecording()
  await overlappingPermissionEntered.promise
  overlappingPermission.resolve()
  await overlappingCleanupCreateEntered.promise
  const deletesBeforeStops = midiDeleteCount
  const firstOverlappingStop = midiController.stopRecording()
  const secondOverlappingStop = midiController.stopRecording()
  midiClipSetup.resolve()
  const overlappingSettlements = await Promise.all([
    firstOverlappingStop.then(() => false, () => true),
    secondOverlappingStop.then(() => false, () => true),
    overlappingStart.then(() => false, () => true),
  ])
  results['overlapping-stops-share-failed-cleanup'] = overlappingSettlements[0]
    && overlappingSettlements[1]
    && !overlappingSettlements[2]
    && midiDeleteCount - deletesBeforeStops === 1
    && midiController.hasPendingCleanup()
  failMidiClipDeletion = false
  const overlappingCleanupRecovered = await retryPendingRecordingCleanup({
    cleanupPending: midiController.hasPendingCleanup,
    stopRecording: midiController.stopRecording,
  })
  const newTakeStarted = await midiController.startRecording()
  results['new-take-retains-provisional-protection-and-lock'] = overlappingCleanupRecovered
    && newTakeStarted
    && provisionalClip === 'clip-midi-4'
    && midiLocks.includes(instrumentTrack.id)
  await midiController.stopRecording()

  failMidiClipDeletion = false
  midiClipSetup = deferred()
  midiAccess.requestAccess = async () => {}
  const saveFailureNoticesBeforeDeferredCleanup = midiNotices.filter(message => message.includes('could not be removed')).length
  const deferredCleanupStart = midiController.startRecording()
  await successfulCancelledClipCreateEntered.promise
  const deferredCleanupStop = midiController.stopRecording()
  midiClipSetup.resolve()
  const deferredCleanupOutcome = await deferredCleanupStart
  await deferredCleanupStop
  results['deferred-cancelled-clip-cleanup-succeeds-silently'] =
    !deferredCleanupOutcome
    && !midiController.hasPendingCleanup()
    && midiNotices.filter(message => message.includes('could not be removed')).length === saveFailureNoticesBeforeDeferredCleanup
  window.recordingDeltas['deferred-cancelled-clip-cleanup'] = {
    pendingCleanupAfterSettlement: midiController.hasPendingCleanup(),
    saveFailureNoticeDelta: midiNotices.filter(message => message.includes('could not be removed')).length - saveFailureNoticesBeforeDeferredCleanup,
  }

  const checkpointGate = deferred()
  const checkpointEntered = deferred()
  let checkpointActive = true
  let projectedCancelledClip = false
  const checkpoints = createMidiRecordingCheckpointController({
    snapshot: () => ({ checkpoint: 'cancelled-take', eventCount: 64, version: 64 }),
    state: () => ({ eventCount: 64, version: 64 }),
    persist: async () => {
      checkpointEntered.resolve()
      await checkpointGate.promise
      if (checkpointActive) projectedCancelledClip = true
    },
    isActive: () => checkpointActive,
    setTimer: () => 1,
    clearTimer: () => {},
  })
  const delayedCheckpoint = checkpoints.request()
  await checkpointEntered.promise
  checkpointActive = false
  const drainedCheckpoint = checkpoints.cancel()
  let checkpointDrained = false
  void drainedCheckpoint.then(() => { checkpointDrained = true })
  await settle()
  results['checkpoint-cancel-does-not-wait-on-hung-write'] = checkpointDrained
  checkpointGate.resolve()
  await Promise.all([delayedCheckpoint, drainedCheckpoint])
  results['standalone-checkpoint-cancel-remains-inactive'] = !projectedCancelledClip && !checkpoints.shouldRequest()
  window.recordingDeltas['standalone-checkpoint-cancel'] = {
    cancelSettledBeforeWrite: checkpointDrained,
    remainsInactive: !projectedCancelledClip,
  }
  window.liveMidiAccess = midiAccess
  window.midiHistoryCount = () => midiHistoryCount
  window.liveMidiNotices = midiNotices
  window.liveMidiProvisionalClip = () => provisionalClip
  window.liveMidiRecording = midiController
  window.disposeMidiRecording = midiDispose
  window.midiTakeProjectionCount = () => midiCalls.filter(call => call === 'take-created').length
  const persistenceGate = deferred()
  const persistenceEntered = deferred()
  const transportGate = deferred()
  const transportEntered = deferred()
  let checkpointMidiHandler = null
  let projectedClipCount = 0
  const checkpointOperations = []
  window.fetch = async (_url, init) => {
    const body = JSON.parse(init.body)
    checkpointOperations.push(body.kind)
    if (body.kind === 'clips.setMidiAndTiming') {
      persistenceEntered.resolve()
      await persistenceGate.promise
    }
    if (body.kind === 'tracks.lock' || body.kind === 'tracks.unlock' || body.kind === 'clips.removeMany') {
      return new Response(JSON.stringify({ ok: true }))
    }
    if (body.kind === 'clips.create') return new Response(JSON.stringify('clip-checkpoint'))
    return new Response('{}', { status: 500 })
  }
  const checkpointAccess = {
    inputs: () => [],
    requestAccess: async () => {},
    setInputSelected: () => {},
    subscribe: handler => { checkpointMidiHandler = handler; return () => { checkpointMidiHandler = null } },
    subscribeSourceReset: () => () => {},
    panic: () => {},
  }
  let checkpointController
  let disposeCheckpoint
  createRoot(cleanup => {
    disposeCheckpoint = cleanup
    checkpointController = createMidiTrackRecordingController({
      audioEngine: { midiEventTimes: () => null },
      tracks: () => [instrumentTrack],
      projectId: () => 'cloud-project',
      userId: () => 'user-midi',
      playheadSec: () => 0,
      bpm: () => 120,
      loopEnabled: () => false,
      recordArmTrackId: () => instrumentTrack.id,
      setTrackLock: () => {},
      clearTrackLock: () => {},
      insertLocalClip: () => { projectedClipCount += 1 },
      removeLocalClips: () => {},
      selection: { selectPrimaryClip: () => {} },
      requestTransportPlay: async () => { transportEntered.resolve(); await transportGate.promise },
      pauseTransport: () => {},
      notify: () => {},
      historyPush: () => {},
      setActiveRecordingTarget: () => {},
      setProvisionalClipId: () => {},
      isRecording: () => false,
      setIsRecording: () => {},
      recordingTrackId: () => null,
      setRecordingTrackId: () => {},
    }, checkpointAccess)
  })
  const checkpointStart = checkpointController.startRecording()
  await transportEntered.promise
  for (let index = 0; index < 64; index += 1) {
    checkpointMidiHandler?.({
      kind: 'pitch-bend', sourceId: 'input-checkpoint', channel: 0, value: index / 64, timeStamp: performance.now(),
    })
  }
  await persistenceEntered.promise
  const checkpointStop = checkpointController.stopRecording()
  transportGate.resolve()
  await settle()
  let checkpointStopSettled = false
  void checkpointStop.then(() => { checkpointStopSettled = true })
  await settle()
  const deleteBeforeCheckpointSettles = checkpointOperations.includes('clips.removeMany')
  await checkpointStop
  const restartAfterHungCheckpoint = await checkpointController.startRecording()
  const projectedCountAfterRestart = projectedClipCount
  persistenceGate.resolve()
  await Promise.all([checkpointStart, checkpointStop])
  await settle()
  results['cancel-settles-before-hung-checkpoint'] = checkpointStopSettled && deleteBeforeCheckpointSettles
  results['new-recording-starts-before-old-checkpoint-completes'] = restartAfterHungCheckpoint
  results['late-checkpoint-does-not-project-cancelled-clip'] = projectedClipCount === projectedCountAfterRestart
  window.recordingDeltas['controller-checkpoint-cancel'] = {
    stopSettledWithWritePending: checkpointStopSettled,
    deleteStartedBeforeWriteSettled: deleteBeforeCheckpointSettles,
    newTakeStartedBeforeOldWriteCompleted: restartAfterHungCheckpoint,
    projectionCountAfterRestart: projectedCountAfterRestart,
    projectionCountAfterOldWrite: projectedClipCount,
  }
  await checkpointController.stopRecording()
  disposeCheckpoint()
  const unmountPermission = deferred()
  const unmountPermissionEntered = deferred()
  const unmountAccess = {
    inputs: () => [],
    requestAccess: () => { unmountPermissionEntered.resolve(); return unmountPermission.promise },
    setInputSelected: () => {},
    subscribe: () => () => {},
    subscribeSourceReset: () => () => {},
    panic: () => {},
  }
  let unmountController
  let disposeUnmount
  createRoot(cleanup => {
    disposeUnmount = cleanup
    unmountController = createMidiTrackRecordingController({
      audioEngine: { midiEventTimes: () => null },
      tracks: () => [instrumentTrack],
      projectId: () => 'cloud-project',
      userId: () => 'user-midi',
      playheadSec: () => midiPlayhead,
      bpm: () => 120,
      loopEnabled: () => false,
      recordArmTrackId: () => instrumentTrack.id,
      setTrackLock: () => {},
      clearTrackLock: () => {},
      insertLocalClip: () => {},
      removeLocalClips: () => {},
      selection: { selectPrimaryClip: () => {} },
      requestTransportPlay: async () => {},
      pauseTransport: () => { midiCalls.push('unmount-stop') },
      notify: () => {},
      historyPush: () => {},
      setActiveRecordingTarget: () => {},
      setProvisionalClipId: () => {},
      isRecording: () => false,
      setIsRecording: () => {},
      recordingTrackId: () => null,
      setRecordingTrackId: () => {},
    }, unmountAccess)
    onCleanup(() => { void unmountController.stopRecording() })
  })
  const unmountOperationsBefore = midiOperations.length
  const unmountPendingStart = unmountController.startRecording()
  await unmountPermissionEntered.promise
  disposeUnmount()
  unmountPermission.resolve()
  await unmountPendingStart
  await settle()
  results['pending-recording-unmount-has-no-late-effects'] =
    !unmountController.isRecording()
    && midiOperations.length === unmountOperationsBefore
    && midiCalls.includes('unmount-stop')
  return results
}

window.playScenarios = async () => {
  const results = {}
  const playCalls = []
  const track = { id: 'track-play', kind: 'audio', name: 'Play', volume: 1, clips: [] }
  window.transportBarCalls = { play: 0, pause: 0, stop: 0, record: 0 }
  let livePlayback
  const [transportPlayback, setTransportPlayback] = createSignal()
  let recordingMode = 'audio'
  const policyNotices = []
  const navigations = []
  const noticeTotal = () => policyNotices.length + window.liveMidiNotices.length
  let disposePolicy
  const policy = createRoot(cleanup => {
    disposePolicy = cleanup
    return createRecordingTransportPolicy({
      audio: window.liveAudioRecording,
      midi: window.liveMidiRecording,
      playback: {
        isPlaying: () => livePlayback?.isPlaying() ?? false,
        play: () => livePlayback.handlePlay([track]),
        pause: () => livePlayback.handlePause(),
        stop: () => livePlayback.handleStop(),
      },
      armedTrack: () => recordingMode === 'midi'
        ? { id: 'track-midi', kind: 'instrument' }
        : { id: 'track-audio', kind: 'audio' },
      notify: (title, message) => policyNotices.push(title + ': ' + message),
      project: {
        id: () => 'cloud-project',
        provisionalClipId: window.liveMidiProvisionalClip,
        cancelImports: () => {},
        navigate: async id => { navigations.push(id) },
      },
    })
  })
  const transportHost = document.createElement('div')
  document.body.append(transportHost)
  const transportRoot = createRoot(cleanup => {
    const node = createComponent(TransportBar, {
      transport: {
        get isRecording() {
          return window.liveAudioRecording.isRecording() || window.liveMidiRecording.isRecording()
        },
        get isRecordingPending() {
          return window.liveAudioRecording.isStarting() || window.liveMidiRecording.isStarting()
        },
        onToggleRecord: () => {
          window.transportBarCalls.record += 1
          window.lastRecordAction = policy.record()
        },
        get isPlaying() {
          return transportPlayback()?.isPlaying() ?? false
        },
        get isPlayPending() {
          return transportPlayback()?.isPlayPending() ?? false
        },
        onPlay: () => {
          window.transportBarCalls.play += 1
          window.lastTransportAction = policy.play()
        },
        onPause: () => {
          window.transportBarCalls.pause += 1
          window.lastTransportAction = policy.pause()
        },
        onStop: () => {
          window.transportBarCalls.stop += 1
          window.lastTransportAction = policy.stop()
        },
        tempoDraft: () => '120',
        setTempoDraft: () => {},
        tempoEditing: () => false,
        setTempoEditing: () => {},
        commitTempo: () => {},
        beginTempoDrag: () => {},
        updateTempoDrag: () => {},
        endTempoDrag: () => {},
        metronomeEnabled: false,
        onToggleMetronome: () => {},
        loopEnabled: false,
        onToggleLoop: () => {},
        gridEnabled: true,
        onToggleGrid: () => {},
        gridDenominator: 4,
        onChangeGridDenominator: () => {},
        bpm: 120,
      },
    })
    transportHost.append(node)
    return cleanup
  })
  window.transportBarUnmount = () => {
    transportRoot()
    transportHost.remove()
  }
  const clickTransport = label => {
    const button = transportHost.querySelector('[aria-label="' + label + '"]')
    if (!button) throw new Error('Transport button missing: ' + label + '; found ' + [...transportHost.querySelectorAll('button')].map(item => item.getAttribute('aria-label')).join(', ')
      + '; audio=' + window.liveAudioRecording.isRecording() + '/' + window.liveAudioRecording.isStarting()
      + '; midi=' + window.liveMidiRecording.isRecording() + '/' + window.liveMidiRecording.isStarting()
      + '; cleanup=' + window.liveMidiRecording.hasPendingCleanup())
    button.click()
  }
  const preflightGate = deferred()
  const preflightEntered = deferred()
  let preflightCount = 0
  let gate = deferred()
  const engine = {
    currentTimelineSec: 0,
    ensureAudio: () => {},
    resume: () => { playCalls.push('start'); return gate.promise },
    onTransportPause: () => playCalls.push('pause'),
    onTransportSeek: () => {},
    onTransportStart: () => {},
    onTransportStop: () => { window.transportOrdering?.push('transport-stop'); playCalls.push('stop') },
    applyAutomationAtTimelineSec: () => {},
    cancelAutomationSchedules: () => {},
    scheduleAllClipsFromPlayhead: () => ({ deferredStretchWindows: [] }),
    scheduleAutomationFromPlayhead: () => {},
    stopAllSources: () => playCalls.push('stop-sources'),
    subscribeStretchRenderState: () => () => {},
  }
  const button = document.createElement('button')
  button.setAttribute('aria-label', 'Play')
  document.body.append(button)
  const [label, setLabel] = createSignal('Play')
  let dispose
  const playback = createRoot(cleanup => {
    dispose = cleanup
    const controller = useTimelinePlayback(engine, {
      getTracks: () => [track],
      preflightPlayback: () => {
        preflightCount += 1
        preflightEntered.resolve()
        return preflightGate.promise
      },
    })
    createEffect(() => {
      const playing = controller.isPlaying()
      const pending = controller.isPlayPending()
      setLabel(playing ? 'Pause' : 'Play')
      button.setAttribute('aria-label', label())
      button.setAttribute('aria-busy', String(pending))
    })
    return controller
  })
  livePlayback = playback
  setTransportPlayback(playback)
  window.livePlayback = playback
  button.addEventListener('click', () => {
    if (playback.isPlaying()) { void playback.handlePause(); return }
    if (!playback.isPlayPending()) void playback.handlePlay([track]).catch(() => {})
  })
  button.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      button.click()
    }
  })
  button.click()
  await preflightEntered.promise
  results['play-pending-exposed'] = button.getAttribute('aria-busy') === 'true'
  button.click()
  button.focus()
  button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  button.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
  results['play-start-coalesced'] = preflightCount === 1 && playCalls.filter(call => call === 'start').length === 0
  preflightGate.resolve(true)
  await settle()
  results['preflight-success-starts-play'] = playCalls.filter(call => call === 'start').length === 1
  gate.resolve()
  await settle()
  results['play-success-label'] = button.getAttribute('aria-label') === 'Pause'
  results['play-success-busy-cleared'] = button.getAttribute('aria-busy') === 'false'
  await playback.handleStop()

  const cancelledPreflight = deferred()
  const cancelledPreflightEntered = deferred()
  const cancellation = useTimelinePlayback(engine, {
    getTracks: () => [track],
    preflightPlayback: () => {
      cancelledPreflightEntered.resolve()
      return cancelledPreflight.promise
    },
  })
  const pendingPreflight = cancellation.handlePlay([track])
  await cancelledPreflightEntered.promise
  results['preflight-pending-exposed'] = cancellation.isPlayPending()
  await cancellation.handleStop()
  cancelledPreflight.resolve(true)
  await pendingPreflight
  results['stop-cancels-late-preflight'] = !cancellation.isPlaying()
    && !cancellation.isPlayPending()
    && playCalls.filter(call => call === 'start').length === 1
  const invalidatedPreflight = deferred()
  const invalidatedPreflightEntered = deferred()
  const invalidatedPlayback = useTimelinePlayback(engine, {
    getTracks: () => [track],
    preflightPlayback: () => {
      invalidatedPreflightEntered.resolve()
      return invalidatedPreflight.promise
    },
  })
  const invalidatedPlay = invalidatedPlayback.handlePlay([track])
  await invalidatedPreflightEntered.promise
  await invalidatedPlayback.handlePause()
  const replacementAfterInvalidation = invalidatedPlayback.handlePlay([track])
  const stopAfterInvalidation = invalidatedPlayback.handleStop()
  invalidatedPreflight.resolve(true)
  await Promise.all([invalidatedPlay, replacementAfterInvalidation, stopAfterInvalidation])
  results['replacement-play-waiting-on-invalidated-attempt-stays-stopped'] =
    !invalidatedPlayback.isPlaying()
    && !invalidatedPlayback.isPlayPending()
    && playCalls.filter(call => call === 'start').length === 1

  gate = deferred()
  gate.reject(new Error('playback startup rejected'))
  const rejected = playback.handlePlay([track]).catch(() => {})
  await rejected
  results['play-rejection-clears-busy'] = !playback.isPlayPending()
  gate = deferred()
  const retry = playback.handlePlay([track])
  await settle()
  results['play-retry-pending'] = playback.isPlayPending()
  await playback.handlePause()
  gate.resolve()
  await retry
  results['pause-cancels-late-play'] = !playback.isPlaying() && !playback.isPlayPending()
  results['play-retry-count'] = playCalls.filter(call => call === 'start').length === 3
  const unmountedStarts = playCalls.filter(call => call === 'start').length
  const unmountedGate = deferred()
  const unmountedEntered = deferred()
  const unmounted = createRoot(cleanup => {
    const controller = useTimelinePlayback({
      ...engine,
      resume: () => {
        unmountedEntered.resolve()
        return unmountedGate.promise
      },
    })
    return { controller, dispose: cleanup }
  })
  const unmountedPending = unmounted.controller.handlePlay([track])
  await unmountedEntered.promise
  unmounted.dispose()
  unmountedGate.resolve()
  await unmountedPending
  results['unmount-cancels-pending-start'] =
    !unmounted.controller.isPlaying()
    && playCalls.filter(call => call === 'start').length === unmountedStarts

  const rebuildGate = deferred()
  const rebuildEntered = deferred()
  const rebuildStarts = []
  let rebuildDispose
  const duringRebuild = createRoot(cleanup => {
    rebuildDispose = cleanup
    return useTimelinePlayback({
      ...engine,
      onTransportStart: () => { rebuildStarts.push('start') },
      getAudioContext: () => ({ sampleRate: 48000, currentTime: 0 }),
    }, undefined, undefined, {
      compileSnapshot: async () => {
        rebuildEntered.resolve()
        await rebuildGate.promise
        return { supported: false, reasons: ['fixture'] }
      },
    })
  })
  const rebuilding = duringRebuild.restartTimelineSchedule([track], {
    rebuildBackend: true, resumePlayback: true, owner: 'portable-browser',
  })
  const nestedRebuild = duringRebuild.restartTimelineSchedule([track], { rebuildBackend: true })
  await rebuildEntered.promise
  const playDuringRebuild = duringRebuild.handlePlay([track])
  results['play-during-rebuild-pending-exposed'] = duringRebuild.isPlayPending()
  rebuildGate.resolve()
  await Promise.all([rebuilding, nestedRebuild, playDuringRebuild])
  results['play-during-rebuild-start-count'] = rebuildStarts.filter(call => call === 'start').length === 1
  results['nested-rebuild-starts-once-and-clears-busy'] = rebuildStarts.filter(call => call === 'start').length === 1
    && !duringRebuild.isPlayPending()
  results['play-during-rebuild-active'] = duringRebuild.isPlaying()
  results['play-during-rebuild-clears-busy'] = !duringRebuild.isPlayPending()
  window.recordingDeltas['play-during-rebuild'] = {
    startDelta: rebuildStarts.filter(call => call === 'start').length,
    playheadBusyCleared: !duringRebuild.isPlayPending(),
  }
  await duringRebuild.handleStop()
  rebuildDispose()

  const stopRebuildGate = deferred()
  const stopRebuildEntered = deferred()
  const stopRebuildStarts = []
  let stopRebuildDispose
  const stopDuringRebuild = createRoot(cleanup => {
    stopRebuildDispose = cleanup
    return useTimelinePlayback({
      ...engine,
      onTransportStart: () => { stopRebuildStarts.push('start') },
      getAudioContext: () => ({ sampleRate: 48000, currentTime: 0 }),
    }, undefined, undefined, {
      compileSnapshot: async () => {
        stopRebuildEntered.resolve()
        await stopRebuildGate.promise
        return { supported: false, reasons: ['fixture'] }
      },
    })
  })
  const stopRebuilding = stopDuringRebuild.restartTimelineSchedule([track], {
    rebuildBackend: true, resumePlayback: true, owner: 'portable-browser',
  })
  await stopRebuildEntered.promise
  const stoppedPlay = stopDuringRebuild.handlePlay([track])
  const replacementPlay = stopDuringRebuild.handlePlay([track])
  const stopping = stopDuringRebuild.handleStop()
  stopRebuildGate.resolve()
  await Promise.all([stopRebuilding, stoppedPlay, replacementPlay, stopping])
  results['stop-during-rebuild-no-start'] = stopRebuildStarts.length === 0
  results['stop-during-rebuild-inactive'] = !stopDuringRebuild.isPlaying()
  results['stop-during-rebuild-clears-busy'] = !stopDuringRebuild.isPlayPending()
  results['replacement-play-after-stop-stays-stopped'] = stopRebuildStarts.length === 0
    && !stopDuringRebuild.isPlaying()
  window.recordingDeltas['stop-during-rebuild'] = {
    startDelta: stopRebuildStarts.length,
    busyCleared: !stopDuringRebuild.isPlayPending(),
  }
  stopRebuildDispose()
  await cancellation.handleStop()

  clickTransport('Play')
  await settle()
  results['transport-play-uses-live-playback-controller'] = livePlayback.isPlaying()
  clickTransport('Pause')
  await settle()
  results['transport-pause-uses-live-playback-controller'] = !livePlayback.isPlaying()

  // These scenarios click the same TransportBar and policy that Timeline wires.
  const rapidAudioPermission = deferred()
  const rapidAudioEntered = deferred()
  let rapidAudioRequests = 0
  const rapidAudioTakesBefore = window.audioTakeCount()
  const rapidAudioHistoryBefore = window.audioHistoryCount()
  const rapidAudioNoticesBefore = window.audioNoticeCount()
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
    getSupportedConstraints: () => ({}),
    getUserMedia: () => {
      rapidAudioRequests += 1
      rapidAudioEntered.resolve()
      return rapidAudioRequests === 1 ? rapidAudioPermission.promise : Promise.resolve(window.recordingStream)
    },
  } })
  clickTransport('Start recording')
  const cancelledAudioRecord = window.lastRecordAction
  await rapidAudioEntered.promise
  clickTransport('Stop')
  const immediateAudioStop = window.lastTransportAction
  results['policy-pending-audio-stop-is-immediate'] = !livePlayback.isPlaying()
  clickTransport('Start recording')
  const restartedAudioRecord = window.lastRecordAction
  rapidAudioPermission.reject(new DOMException('Permission denied', 'NotAllowedError'))
  const rapidAudioOutcomes = await Promise.all([cancelledAudioRecord, restartedAudioRecord, immediateAudioStop])
  results['policy-rapid-audio-record-stop-record-starts-fresh'] = !rapidAudioOutcomes[0].ok
    && rapidAudioOutcomes[1].ok && window.liveAudioRecording.isRecording() && rapidAudioRequests === 2
  results['policy-rapid-audio-cancel-has-no-take-or-notice'] = window.audioTakeCount() === rapidAudioTakesBefore
    && window.audioNoticeCount() === rapidAudioNoticesBefore && window.audioHistoryCount() === rapidAudioHistoryBefore
  window.recordingDeltas['policy-rapid-audio'] = {
    permissionRequests: rapidAudioRequests, takeDelta: window.audioTakeCount() - rapidAudioTakesBefore,
    noticeDelta: window.audioNoticeCount() - rapidAudioNoticesBefore,
    historyDelta: window.audioHistoryCount() - rapidAudioHistoryBefore,
  }
  window.transportOrdering = []
  clickTransport('Stop')
  const establishedStop = window.lastTransportAction
  clickTransport('Stop recording')
  const establishedRestart = window.lastRecordAction
  await Promise.all([establishedStop, establishedRestart])
  results['policy-established-audio-finalizes-before-transport-stop'] = window.transportOrdering.join(',') === 'take-finalized,transport-stop'
  results['policy-record-during-established-stop-starts-fresh'] = window.liveAudioRecording.isRecording()
    && (await establishedRestart).ok
  window.recordingDeltas['policy-established-stop'] = { ordering: window.transportOrdering.join(',') }
  delete window.transportOrdering
  clickTransport('Stop')
  await window.lastTransportAction

  const trackCreation = deferred()
  const trackCreationEntered = deferred()
  window.audioTracksUnavailable = true
  window.createRecordingTrack = () => { trackCreationEntered.resolve(); return trackCreation.promise }
  const noticesBeforeTrackCreation = window.audioNoticeCount()
  const takesBeforeTrackCreation = window.audioTakeCount()
  clickTransport('Start recording')
  const cancelledTrackRecord = window.lastRecordAction
  await trackCreationEntered.promise
  clickTransport('Stop')
  trackCreation.reject(new Error('Automatic track creation failed'))
  await Promise.all([cancelledTrackRecord, window.lastTransportAction])
  results['policy-cancelled-auto-track-rejection-is-silent'] = window.audioNoticeCount() === noticesBeforeTrackCreation
    && window.audioTakeCount() === takesBeforeTrackCreation && !window.liveAudioRecording.isRecording()
  window.recordingDeltas['policy-cancelled-auto-track'] = {
    noticeDelta: window.audioNoticeCount() - noticesBeforeTrackCreation,
    takeDelta: window.audioTakeCount() - takesBeforeTrackCreation,
  }
  window.audioTracksUnavailable = false
  delete window.createRecordingTrack

  recordingMode = 'midi'
  const midiRequestAccess = window.liveMidiAccess.requestAccess
  const rapidMidiPermission = deferred()
  const rapidMidiEntered = deferred()
  let rapidMidiRequests = 0
  window.liveMidiAccess.requestAccess = () => {
    rapidMidiRequests += 1
    rapidMidiEntered.resolve()
    return rapidMidiRequests === 1 ? rapidMidiPermission.promise : Promise.resolve()
  }
  const midiProjectionsBeforeRapid = window.midiTakeProjectionCount()
  const midiNoticesBeforeRapid = window.liveMidiNotices.length
  const midiHistoryBeforeRapid = window.midiHistoryCount()
  clickTransport('Start recording')
  const cancelledMidiRecord = window.lastRecordAction
  await rapidMidiEntered.promise
  clickTransport('Stop')
  const immediateMidiStop = window.lastTransportAction
  clickTransport('Stop recording')
  const restartedMidiRecord = window.lastRecordAction
  rapidMidiPermission.reject(new DOMException('Permission denied', 'NotAllowedError'))
  const rapidMidiOutcomes = await Promise.all([cancelledMidiRecord, restartedMidiRecord, immediateMidiStop])
  results['policy-rapid-midi-record-stop-record-starts-fresh'] = !rapidMidiOutcomes[0].ok
    && rapidMidiOutcomes[1].ok && window.liveMidiRecording.isRecording() && rapidMidiRequests === 2
  results['policy-rapid-midi-only-second-start-projects'] = window.midiTakeProjectionCount() - midiProjectionsBeforeRapid === 1
    && window.liveMidiNotices.length === midiNoticesBeforeRapid && window.midiHistoryCount() === midiHistoryBeforeRapid
  window.recordingDeltas['policy-rapid-midi'] = {
    permissionRequests: rapidMidiRequests, projectionDelta: window.midiTakeProjectionCount() - midiProjectionsBeforeRapid,
    noticeDelta: window.liveMidiNotices.length - midiNoticesBeforeRapid,
    historyDelta: window.midiHistoryCount() - midiHistoryBeforeRapid,
  }
  clickTransport('Stop')
  await window.lastTransportAction
  window.liveMidiAccess.requestAccess = midiRequestAccess

  const audioUnmountPermission = deferred()
  const audioUnmountEntered = deferred()
  let audioUnmountRequests = 0
  const audioUnmountTakesBefore = window.audioTakeCount()
  const audioUnmountHistoryBefore = window.audioHistoryCount()
  const audioUnmountNoticesBefore = window.audioNoticeCount()
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
    getSupportedConstraints: () => ({}),
    getUserMedia: () => {
      audioUnmountRequests += 1
      audioUnmountEntered.resolve()
      return audioUnmountPermission.promise
    },
  } })
  let disposeAudioPolicy
  const audioPolicy = createRoot(cleanup => {
    disposeAudioPolicy = cleanup
    return createRecordingTransportPolicy({
      audio: window.liveAudioRecording,
      midi: window.liveMidiRecording,
      playback: { isPlaying: () => false, play: async () => {}, pause: () => {}, stop: () => {} },
      armedTrack: () => ({ id: 'track-audio', kind: 'audio' }),
      notify: (title, message) => window.audioNotices.push(title + ': ' + message),
      project: {
        id: () => 'project:test',
        provisionalClipId: window.liveMidiProvisionalClip,
        cancelImports: () => {},
        navigate: () => {},
      },
    })
  })
  const audioUnmountFirst = audioPolicy.record()
  await audioUnmountEntered.promise
  const audioUnmountStop = audioPolicy.stop()
  const audioUnmountQueued = audioPolicy.record()
  disposeAudioPolicy()
  audioUnmountPermission.resolve(window.recordingStream)
  await Promise.all([audioUnmountFirst, audioUnmountStop, audioUnmountQueued])
  results['policy-audio-queued-record-after-unmount-does-not-restart'] =
    audioUnmountRequests === 1
    && !window.liveAudioRecording.isRecording()
    && window.audioTakeCount() === audioUnmountTakesBefore
    && window.audioHistoryCount() === audioUnmountHistoryBefore
    && window.audioNoticeCount() === audioUnmountNoticesBefore
  window.recordingDeltas['policy-audio-unmount-queued-record'] = {
    permissionRequests: audioUnmountRequests,
    takeDelta: window.audioTakeCount() - audioUnmountTakesBefore,
    historyDelta: window.audioHistoryCount() - audioUnmountHistoryBefore,
    noticeDelta: window.audioNoticeCount() - audioUnmountNoticesBefore,
  }

  recordingMode = 'midi'
  const midiUnmountPermission = deferred()
  const midiUnmountEntered = deferred()
  let midiUnmountRequests = 0
  const midiUnmountProjectionsBefore = window.midiTakeProjectionCount()
  const midiUnmountHistoryBefore = window.midiHistoryCount()
  const midiUnmountNoticesBefore = window.liveMidiNotices.length
  window.liveMidiAccess.requestAccess = () => {
    midiUnmountRequests += 1
    midiUnmountEntered.resolve()
    return midiUnmountPermission.promise
  }
  let disposeMidiPolicy
  const midiPolicy = createRoot(cleanup => {
    disposeMidiPolicy = cleanup
    return createRecordingTransportPolicy({
      audio: window.liveAudioRecording,
      midi: window.liveMidiRecording,
      playback: { isPlaying: () => false, play: async () => {}, pause: () => {}, stop: () => {} },
      armedTrack: () => ({ id: 'track-midi', kind: 'instrument' }),
      notify: message => window.liveMidiNotices.push(message),
      project: {
        id: () => 'project:test',
        provisionalClipId: window.liveMidiProvisionalClip,
        cancelImports: () => {},
        navigate: () => {},
      },
    })
  })
  const midiUnmountFirst = midiPolicy.record()
  await midiUnmountEntered.promise
  const midiUnmountStop = midiPolicy.stop()
  const midiUnmountQueued = midiPolicy.record()
  disposeMidiPolicy()
  midiUnmountPermission.resolve()
  await Promise.all([midiUnmountFirst, midiUnmountStop, midiUnmountQueued])
  results['policy-midi-queued-record-after-unmount-does-not-restart'] =
    midiUnmountRequests === 1
    && !window.liveMidiRecording.isRecording()
    && window.midiTakeProjectionCount() === midiUnmountProjectionsBefore
    && window.midiHistoryCount() === midiUnmountHistoryBefore
    && window.liveMidiNotices.length === midiUnmountNoticesBefore
  window.recordingDeltas['policy-midi-unmount-queued-record'] = {
    permissionRequests: midiUnmountRequests,
    projectionDelta: window.midiTakeProjectionCount() - midiUnmountProjectionsBefore,
    historyDelta: window.midiHistoryCount() - midiUnmountHistoryBefore,
    noticeDelta: window.liveMidiNotices.length - midiUnmountNoticesBefore,
  }
  window.liveMidiAccess.requestAccess = midiRequestAccess

  const previousFetch = window.fetch
  let cancelledCreateGate = deferred()
  let cancelledCreateEntered = deferred()
  let heldDeleteGate
  let heldDeleteEntered
  let deletionFails = true
  let policyDeleteCount = 0
  window.fetch = async (_url, init) => {
    const body = JSON.parse(init.body)
    if (body.kind === 'clips.create') {
      cancelledCreateEntered.resolve()
      await cancelledCreateGate.promise
      return new Response(JSON.stringify('policy-cancelled-clip'))
    }
    if (body.kind === 'clips.removeMany') {
      policyDeleteCount += 1
      if (heldDeleteGate && heldDeleteEntered) {
        heldDeleteEntered.resolve()
        await heldDeleteGate.promise
      }
      return new Response(JSON.stringify({ ok: !deletionFails }), { status: deletionFails ? 400 : 200 })
    }
    return new Response(JSON.stringify({ ok: true }))
  }
  clickTransport('Start recording')
  const retainedRecord = window.lastRecordAction
  await cancelledCreateEntered.promise
  clickTransport('Stop')
  cancelledCreateGate.resolve()
  await retainedRecord
  await policy.stopRecording().catch(() => {})
  results['policy-cancelled-clip-retains-cleanup'] = window.liveMidiRecording.hasPendingCleanup()
  await policy.play()
  deletionFails = false
  heldDeleteGate = deferred()
  heldDeleteEntered = deferred()
  clickTransport('Pause')
  await heldDeleteEntered.promise
  await window.lastTransportAction
  results['policy-pause-does-not-wait-for-retained-cleanup'] = !livePlayback.isPlaying()
    && window.liveMidiRecording.hasPendingCleanup()
  heldDeleteGate.resolve()
  heldDeleteGate = undefined
  heldDeleteEntered = undefined
  await policy.stopRecording().catch(() => {})
  results['policy-pause-successful-cleanup-clears-protection'] =
    !window.liveMidiRecording.hasPendingCleanup()

  deletionFails = true
  if (window.liveMidiRecording.isRecording()) await policy.stopRecording()
  await settle()
  cancelledCreateGate = deferred()
  cancelledCreateEntered = deferred()
  clickTransport('Start recording')
  const failedPauseRecord = window.lastRecordAction
  await cancelledCreateEntered.promise
  clickTransport('Stop')
  cancelledCreateGate.resolve()
  await Promise.all([failedPauseRecord, window.lastTransportAction])
  await policy.stopRecording().catch(() => {})
  const failurePauseNoticeCount = policyNotices.length
  const failurePauseControllerNoticeCount = window.liveMidiNotices.length
  const failurePauseDeletesBefore = policyDeleteCount
  heldDeleteGate = deferred()
  heldDeleteEntered = deferred()
  await policy.play()
  clickTransport('Pause')
  await heldDeleteEntered.promise
  await window.lastTransportAction
  results['policy-pause-reports-failed-retained-cleanup'] =
    !livePlayback.isPlaying() && window.liveMidiRecording.hasPendingCleanup()
  // Joins the Pause's in-flight settlement so the notice window covers only that failure.
  const failedPauseSettlement = policy.stopRecording()
  heldDeleteGate.resolve()
  heldDeleteGate = undefined
  heldDeleteEntered = undefined
  await failedPauseSettlement.catch(() => {})
  results['policy-pause-failed-cleanup-notifies'] =
    window.liveMidiRecording.hasPendingCleanup() && window.liveMidiNotices.length > failurePauseControllerNoticeCount
  results['policy-pause-failed-cleanup-single-notice'] = policyNotices.length - failurePauseNoticeCount
    + window.liveMidiNotices.length - failurePauseControllerNoticeCount === 1
  window.recordingDeltas['policy-pause-retained-cleanup'] = {
    paused: !livePlayback.isPlaying(),
    policyNoticeDelta: policyNotices.length - failurePauseNoticeCount,
    controllerNoticeDelta: window.liveMidiNotices.length - failurePauseControllerNoticeCount,
    deleteDelta: policyDeleteCount - failurePauseDeletesBefore,
  }
  await policy.stopRecording().catch(() => {})
  const navigationCount = navigations.length
  await policy.leaveProject('next-project')
  results['policy-project-leave-blocked-by-retained-cleanup'] = navigations.length === navigationCount
  deletionFails = false
  clickTransport('Stop')
  await window.lastTransportAction
  await policy.leaveProject('next-project')
  results['policy-project-leave-allowed-after-stop-retry'] = !window.liveMidiRecording.hasPendingCleanup()
    && navigations.length - navigationCount === 1 && navigations.at(-1) === 'next-project'
  window.recordingDeltas['policy-project-leave'] = { navigationDelta: navigations.length - navigationCount, deleteAttempts: policyDeleteCount }

  // Retained-cleanup scenarios: Stop never waits for cleanup, and one failed deletion reports once.
  // Counted at page load: an unhandledrejection listener added inside an eval is not reliably delivered.
  const unhandledBeforeRetained = window.unhandledRejectionCount
  const retainCancelledClip = async () => {
    deletionFails = true
    heldDeleteGate = undefined
    heldDeleteEntered = undefined
    cancelledCreateGate = deferred()
    cancelledCreateEntered = deferred()
    clickTransport('Start recording')
    const retainedRecord = window.lastRecordAction
    await cancelledCreateEntered.promise
    clickTransport('Stop')
    cancelledCreateGate.resolve()
    await Promise.all([retainedRecord, window.lastTransportAction])
    await policy.stopRecording().catch(() => {})
    return window.liveMidiRecording.hasPendingCleanup()
  }
  results['policy-stop-retained-cleanup-setup'] = await retainCancelledClip()
  await policy.play()
  const stopGate = deferred()
  const stopEntered = deferred()
  heldDeleteGate = stopGate
  heldDeleteEntered = stopEntered
  deletionFails = false
  clickTransport('Stop')
  await stopEntered.promise
  await window.lastTransportAction
  results['policy-stop-does-not-wait-for-retained-cleanup'] = !livePlayback.isPlaying()
    && window.liveMidiRecording.hasPendingCleanup()
  const stopSettlement = policy.stopRecording()
  stopGate.resolve()
  await stopSettlement
  results['policy-stop-retained-cleanup-clears-after-resolve'] = !window.liveMidiRecording.hasPendingCleanup()
  heldDeleteGate = undefined
  heldDeleteEntered = undefined

  results['policy-concurrent-retained-setup'] = await retainCancelledClip()
  await policy.play()
  const failGate = deferred()
  const failEntered = deferred()
  heldDeleteGate = failGate
  heldDeleteEntered = failEntered
  deletionFails = true
  const concurrentNotices = noticeTotal()
  const concurrentDeletes = policyDeleteCount
  const pausedFirst = policy.pause()
  await failEntered.promise
  // Second Pause and Stop must resolve while the delete is still held.
  let pausedSecondDone = false
  let stoppedSecondDone = false
  const pausedSecond = policy.pause().then(() => { pausedSecondDone = true })
  const stoppedSecond = policy.stop().then(() => { stoppedSecondDone = true })
  await settle()
  results['policy-concurrent-second-pause-resolves-while-delete-held'] = pausedSecondDone
  results['policy-concurrent-second-stop-resolves-while-delete-held'] = stoppedSecondDone
  const recordedThird = policy.record()
  failGate.resolve()
  const [, , , recordOutcome] = await Promise.all([pausedFirst, pausedSecond, stoppedSecond, recordedThird])
  results['policy-concurrent-waiters-single-failure-notice'] = policyDeleteCount - concurrentDeletes === 1
    && noticeTotal() - concurrentNotices === 1
    && !recordOutcome.ok
    && window.liveMidiRecording.hasPendingCleanup()
  window.recordingDeltas['policy-concurrent-waiters'] = {
    deleteDelta: policyDeleteCount - concurrentDeletes,
    noticeDelta: noticeTotal() - concurrentNotices,
    recordReason: recordOutcome.reason ?? '',
  }
  heldDeleteGate = undefined
  heldDeleteEntered = undefined
  deletionFails = false
  await policy.stopRecording()
  const clearRetainedCleanup = async () => {
    deletionFails = false
    heldDeleteGate = undefined
    heldDeleteEntered = undefined
    await policy.stopRecording().catch(() => {})
  }
  const holdNextDelete = () => {
    const gate = deferred()
    const entered = deferred()
    heldDeleteGate = gate
    heldDeleteEntered = entered
    return { gate, entered }
  }

  // Record starts the retry, then Stop joins it and resolves while the delete is still held.
  await retainCancelledClip()
  const recordHold = holdNextDelete()
  const noticesBeforeRecordThenStop = noticeTotal()
  const recordedFirst = policy.record()
  await recordHold.entered.promise
  let stoppedAfterRecordDone = false
  const stoppedAfterRecord = policy.stop().then(() => { stoppedAfterRecordDone = true })
  await settle()
  results['policy-record-then-stop-resolves-while-delete-held'] = stoppedAfterRecordDone
  recordHold.gate.resolve()
  const recordedFirstOutcome = await recordedFirst
  await stoppedAfterRecord
  results['policy-record-then-stop-single-failure-notice'] = recordedFirstOutcome.reason === 'cleanup-pending'
    && noticeTotal() - noticesBeforeRecordThenStop === 1
  await clearRetainedCleanup()

  // Stop starts the retry, then Pause resolves while the delete is still held.
  await retainCancelledClip()
  await policy.play()
  const stopHold = holdNextDelete()
  const noticesBeforeStopThenPause = noticeTotal()
  const deletesBeforeStopThenPause = policyDeleteCount
  const stoppedFirst = policy.stop()
  await stopHold.entered.promise
  let pausedAfterStopDone = false
  const pausedAfterStop = policy.pause().then(() => { pausedAfterStopDone = true })
  await settle()
  results['policy-stop-then-pause-resolves-while-delete-held'] = pausedAfterStopDone
  stopHold.gate.resolve()
  await Promise.all([stoppedFirst, pausedAfterStop])
  await policy.stopRecording().catch(() => {})
  results['policy-stop-then-pause-single-failure-notice'] = noticeTotal() - noticesBeforeStopThenPause === 1
    && policyDeleteCount - deletesBeforeStopThenPause === 1
  await clearRetainedCleanup()

  // Record with failed retained cleanup retries once and reports exactly one notice.
  await retainCancelledClip()
  const noticesBeforeRecord = noticeTotal()
  const failedRecordOutcome = await policy.record()
  results['policy-record-failed-cleanup-single-notice'] = failedRecordOutcome.reason === 'cleanup-pending'
    && noticeTotal() - noticesBeforeRecord === 1
  await clearRetainedCleanup()

  // Space plays a stopped transport and pauses a playing one, even while cleanup is retained.
  await retainCancelledClip()
  await livePlayback.handleStop()
  const startsBeforeSpace = playCalls.filter(call => call === 'start').length
  policy.space()
  await settle()
  results['space-stopped-with-retained-cleanup-plays'] = livePlayback.isPlaying()
    && playCalls.filter(call => call === 'start').length === startsBeforeSpace + 1
    && window.liveMidiRecording.hasPendingCleanup()
  policy.space()
  await settle()
  results['space-playing-with-retained-cleanup-pauses'] = !livePlayback.isPlaying()
    && window.liveMidiRecording.hasPendingCleanup()
  await clearRetainedCleanup()

  // A failed audio finalize reports only the audio failure while MIDI cleanup is retained.
  let fakeAudioLive = true
  let disposeFakeAudio = () => {}
  const fakeAudioPolicy = createRoot(cleanup => {
    disposeFakeAudio = cleanup
    return createRecordingTransportPolicy({
      audio: {
        isRecording: () => fakeAudioLive,
        isStarting: () => false,
        recordingTrackId: () => null,
        toggleRecording: async () => ({ ok: true }),
        stopRecording: async () => {
          fakeAudioLive = false
          throw new Error('audio finalize failed')
        },
      },
      midi: window.liveMidiRecording,
      playback: {
        isPlaying: () => livePlayback.isPlaying(),
        play: () => livePlayback.handlePlay([track]),
        pause: () => livePlayback.handlePause(),
        stop: () => livePlayback.handleStop(),
      },
      armedTrack: () => ({ id: 'track-midi', kind: 'instrument' }),
      notify: (title, message) => policyNotices.push(title + ': ' + message),
      project: {
        id: () => 'cloud-project',
        provisionalClipId: window.liveMidiProvisionalClip,
        cancelImports: () => {},
        navigate: () => {},
      },
    })
  })
  await retainCancelledClip()
  deletionFails = false
  await fakeAudioPolicy.play()
  const policyNoticesBeforeAudio = policyNotices.length
  const noticesBeforeAudio = noticeTotal()
  await fakeAudioPolicy.pause()
  await fakeAudioPolicy.stopRecording()
  results['audio-finalize-failure-reports-audio-notice-only'] = policyNotices.slice(policyNoticesBeforeAudio).join(' | ')
      === 'Recording: Recording could not be finalized.'
    && noticeTotal() - noticesBeforeAudio === 1
    && !livePlayback.isPlaying()
    && !window.liveMidiRecording.hasPendingCleanup()
  disposeFakeAudio()

  // Unmounting the real MIDI hook with a retained cleanup must not leak an unhandled rejection.
  const hookTrack = { id: 'track-hook-midi', kind: 'instrument', name: 'Hook MIDI', volume: 1, clips: [] }
  let disposeHookMidi = () => {}
  const hookMidi = createRoot(cleanup => {
    disposeHookMidi = cleanup
    return useMidiTrackRecording({
      audioEngine: { midiEventTimes: () => null },
      tracks: () => [hookTrack],
      projectId: () => 'cloud-project',
      userId: () => 'user-midi',
      playheadSec: () => 0,
      bpm: () => 120,
      loopEnabled: () => false,
      recordArmTrackId: () => hookTrack.id,
      setTrackLock: () => {},
      clearTrackLock: () => {},
      insertLocalClip: () => {},
      removeLocalClips: () => {},
      selection: { selectPrimaryClip: () => {} },
      requestTransportPlay: async () => {},
      pauseTransport: () => {},
      notify: () => {},
      historyPush: () => {},
      setActiveRecordingTarget: () => {},
      setProvisionalClipId: () => {},
    })
  })
  deletionFails = true
  cancelledCreateGate = deferred()
  cancelledCreateEntered = deferred()
  const hookStart = hookMidi.startRecording()
  await cancelledCreateEntered.promise
  const hookStop = hookMidi.stopRecording().catch(() => undefined)
  cancelledCreateGate.resolve()
  await Promise.all([hookStart, hookStop])
  const hookRetained = hookMidi.hasPendingCleanup()
  const hookGate = deferred()
  const hookEntered = deferred()
  const policyFetch = window.fetch
  // A plain-object reply settles in microtasks, so one macrotask observes the rejection.
  window.fetch = async (url, init) => {
    if (JSON.parse(init.body).kind !== 'clips.removeMany') return policyFetch(url, init)
    hookEntered.resolve()
    await hookGate.promise
    return { ok: false, status: 400, text: async () => '{}', json: async () => ({}) }
  }
  const unhandledBeforeHook = window.unhandledRejectionCount
  disposeHookMidi()
  await hookEntered.promise
  hookGate.resolve()
  await macrotask()
  window.fetch = policyFetch

  // Read after the final macrotask: the rejection's unhandledrejection event can trail the first wait.
  await settle()
  await macrotask()
  results['unmounted-midi-hook-failed-cleanup-no-unhandled-rejection'] = hookRetained
    && window.unhandledRejectionCount === unhandledBeforeHook
  window.recordingDeltas['unmounted-midi-hook'] = { unhandledRejections: window.unhandledRejectionCount - unhandledBeforeHook }
  results['policy-retained-scenarios-no-unhandled-rejections'] = window.unhandledRejectionCount === unhandledBeforeRetained
  window.recordingDeltas['policy-retained-scenarios-unhandled'] = { unhandledRejections: window.unhandledRejectionCount - unhandledBeforeRetained }

  // Capture the existing heartbeat callback without waiting for its interval.
  const nativeSetInterval = window.setInterval
  let heartbeatCallback
  window.setInterval = callback => { heartbeatCallback = callback; return 999999 }
  const heartbeatRequest = deferred()
  const heartbeatEntered = deferred()
  let lockRequests = 0
  window.fetch = async (_url, init) => {
    const body = JSON.parse(init.body)
    if (body.kind === 'tracks.lock' && ++lockRequests > 1) {
      heartbeatEntered.resolve()
      await heartbeatRequest.promise
    }
    if (body.kind === 'clips.create') return new Response(JSON.stringify('policy-heartbeat-clip'))
    return new Response(JSON.stringify({ ok: true }))
  }
  const startupGate = deferred()
  const startupEntered = deferred()
  const normalResume = engine.resume
  engine.resume = () => { startupEntered.resolve(); return startupGate.promise }
  const heartbeatNoticesBefore = window.liveMidiNotices.length
  const heartbeatPolicyNoticesBefore = policyNotices.length
  clickTransport('Start recording')
  const heartbeatRecord = window.lastRecordAction
  await startupEntered.promise
  window.setInterval = nativeSetInterval
  heartbeatCallback()
  await heartbeatEntered.promise
  clickTransport('Stop')
  startupGate.resolve()
  await Promise.all([heartbeatRecord, window.lastTransportAction])
  await policy.stopRecording()
  heartbeatRequest.reject(new Error('Late heartbeat failure'))
  await settle()
  results['policy-cancelled-startup-heartbeat-rejection-is-silent'] = window.liveMidiNotices.length === heartbeatNoticesBefore
    && policyNotices.length === heartbeatPolicyNoticesBefore && !window.liveMidiRecording.isRecording()
  window.recordingDeltas['policy-late-heartbeat'] = {
    noticeDelta: window.liveMidiNotices.length - heartbeatNoticesBefore,
    policyNoticeDelta: policyNotices.length - heartbeatPolicyNoticesBefore,
  }
  engine.resume = normalResume
  window.fetch = previousFetch
  recordingMode = 'audio'

  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
    getSupportedConstraints: () => ({}),
    getUserMedia: async () => window.recordingStream,
  } })
  const recordButton = transportHost.querySelector('[aria-label="Start recording"]')
  if (!recordButton) throw new Error('Transport record button was not mounted.')
  clickTransport('Start recording')
  const audioUiFirstStart = await window.lastRecordAction
  results['transport-audio-record-starts-real-hook'] = window.liveAudioRecording.isRecording()
  window.recordingDeltas['transport-audio-first-start'] = {
    startOk: audioUiFirstStart.ok,
    reason: audioUiFirstStart.reason ?? '',
    isRecording: window.liveAudioRecording.isRecording(),
    noticeCount: window.audioNoticeCount(),
    notices: window.audioNotices.join(' | '),
  }
  const audioTakeCountBeforeUiStop = window.audioTakeCount()
  recordButton.click()
  await window.lastRecordAction
  results['transport-audio-stop-settles-real-hook'] = !window.liveAudioRecording.isRecording()
  recordButton.click()
  const audioUiRestart = await window.lastRecordAction
  results['transport-audio-record-restarts-after-stop'] = window.liveAudioRecording.isRecording()
    && window.audioTakeCount() === audioTakeCountBeforeUiStop + 1
  window.recordingDeltas['transport-audio-restart'] = {
    startOk: audioUiRestart.ok,
    isRecording: window.liveAudioRecording.isRecording(),
    takeDelta: window.audioTakeCount() - audioTakeCountBeforeUiStop,
  }
  recordButton.click()
  await window.lastRecordAction

  recordingMode = 'midi'
  recordButton.click()
  await window.lastRecordAction
  results['transport-midi-record-starts-real-controller'] = window.liveMidiRecording.isRecording()
  const midiProjectionCountBeforeUiRestart = window.midiTakeProjectionCount()
  recordButton.click()
  await window.lastRecordAction
  results['transport-midi-stop-clears-recording-state'] = !window.liveMidiRecording.isRecording()
  recordButton.click()
  const midiUiRestart = await window.lastRecordAction
  results['transport-midi-record-restarts-after-cancelled-start-and-stop'] =
    window.liveMidiRecording.isRecording()
    && window.midiTakeProjectionCount() === midiProjectionCountBeforeUiRestart + 1
  window.recordingDeltas['transport-midi-restart'] = {
    startOk: midiUiRestart.ok,
    isRecording: window.liveMidiRecording.isRecording(),
    projectionDelta: window.midiTakeProjectionCount() - midiProjectionCountBeforeUiRestart,
  }
  recordButton.click()
  await window.lastRecordAction

  const directAudioPermission = deferred()
  const directAudioEntered = deferred()
  let directAudioRequests = 0
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
    getSupportedConstraints: () => ({}),
    getUserMedia: () => {
      directAudioRequests += 1
      directAudioEntered.resolve()
      return directAudioRequests === 1 ? directAudioPermission.promise : Promise.resolve(window.recordingStream)
    },
  } })
  const directAudioFirst = window.liveAudioRecording.toggleRecording()
  await directAudioEntered.promise
  const directAudioStop = window.liveAudioRecording.stopRecording(false)
  const directAudioRestart = window.liveAudioRecording.toggleRecording()
  const directAudioDuplicate = window.liveAudioRecording.toggleRecording()
  directAudioPermission.resolve(window.recordingStream)
  const directAudioOutcomes = await Promise.all([directAudioFirst, directAudioRestart, directAudioDuplicate, directAudioStop])
  results['audio-controller-cancelled-start-restarts-and-joins-duplicates'] = !directAudioOutcomes[0].ok
    && directAudioOutcomes[1].ok && directAudioOutcomes[2].ok && directAudioRequests === 2
    && window.liveAudioRecording.isRecording()
  window.recordingDeltas['direct-audio-restart'] = { permissionRequests: directAudioRequests }
  await policy.stop()

  const directMidiPermission = deferred()
  const directMidiEntered = deferred()
  const directMidiReplacementPermission = deferred()
  const directMidiReplacementEntered = deferred()
  let directMidiRequests = 0
  window.liveMidiAccess.requestAccess = () => {
    directMidiRequests += 1
    if (directMidiRequests === 1) {
      directMidiEntered.resolve()
      return directMidiPermission.promise
    }
    if (directMidiRequests === 2) {
      directMidiReplacementEntered.resolve()
      return directMidiReplacementPermission.promise
    }
    return Promise.resolve()
  }
  const directMidiFirst = window.liveMidiRecording.startRecording()
  await directMidiEntered.promise
  const directMidiStop = window.liveMidiRecording.stopRecording(false)
  const directMidiRestart = window.liveMidiRecording.startRecording()
  const directMidiDuplicate = window.liveMidiRecording.startRecording()
  directMidiPermission.resolve()
  await directMidiReplacementEntered.promise
  const directMidiSecondStop = window.liveMidiRecording.stopRecording(false)
  const directMidiFinal = window.liveMidiRecording.startRecording()
  directMidiReplacementPermission.resolve()
  const directMidiOutcomes = await Promise.all([
    directMidiFirst, directMidiRestart, directMidiDuplicate, directMidiFinal, directMidiStop, directMidiSecondStop,
  ])
  results['midi-controller-repeated-cancelled-starts-end-with-fresh-take'] = !directMidiOutcomes[0]
    && !directMidiOutcomes[1] && !directMidiOutcomes[2] && directMidiOutcomes[3]
    && directMidiRequests === 3 && window.liveMidiRecording.isRecording()
  window.recordingDeltas['direct-midi-repeated-restart'] = { permissionRequests: directMidiRequests }
  await policy.stop()
  window.liveMidiAccess.requestAccess = midiRequestAccess

  dispose()
  window.disposeAudioRecording()
  window.disposeMidiRecording()
  button.remove()
  return results
}

// The recording-target lock: a take keeps its track, group chain and output route until Finish; every other edit stays live.
window.lockScenarios = async () => {
  const results = {}
  const scenario = async (name, run) => {
    try { results[name] = (await run()) === true } catch (error) { console.error(name, error); results[name] = false }
  }
  const reason = 'Finish recording to delete this track or change its routing.'
  const tracks = [
    { id: 'group-a', kind: 'audio', channelRole: 'group', name: 'Group', volume: 1, clips: [], sends: [] },
    { id: 'return-a', kind: 'audio', channelRole: 'return', name: 'Return', volume: 1, clips: [], sends: [] },
    { id: 'track-audio', kind: 'audio', channelRole: 'track', name: 'Audio', volume: 1, clips: [], sends: [], groupId: 'group-a', outputTargetId: 'group-a' },
    { id: 'track-other', kind: 'audio', channelRole: 'track', name: 'Other', volume: 1, clips: [], sends: [] },
    { id: 'track-midi', kind: 'instrument', channelRole: 'track', name: 'MIDI', volume: 1, clips: [], sends: [] },
  ]
  const streamTrack = { readyState: 'live', stop: () => {}, getSettings: () => ({ sampleRate: 48000 }) }
  const stream = { getTracks: () => [streamTrack], getAudioTracks: () => [streamTrack] }
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
    getSupportedConstraints: () => ({}), getUserMedia: async () => stream,
  } })
  const selection = {
    selectTrackTarget: () => {}, selectPrimaryClip: () => {}, selectedClip: () => null,
    selectedClipIds: () => new Set(), selectedTrackId: () => '', selectedFXTarget: () => 'master',
    rangeSelection: () => null, appendClipToSelection: () => {}, selectClipGroup: () => {},
    selectMasterTarget: () => {}, selectTimeRange: () => {}, clearTimeRange: () => {},
    setSelectedClipIds: () => {}, setSelectedClip: () => {}, setSelectedTrackId: () => {},
    setSelectedFXTarget: () => {},
  }
  const audioEngine = {
    ensureAudio: () => {}, resume: async () => {},
    getAudioContext: () => ({ sampleRate: 48000, currentTime: 0 }),
    subscribeRecordingStatus: () => () => {},
    cancelRecordingCapture: () => {}, stopRecordingCapture: async () => {},
  }
  const audioHook = (native) => {
    const calls = []
    const startGate = deferred()
    const startEntered = deferred()
    const stopEntered = deferred()
    const stopGate = deferred()
    const lock = recordingTarget.createRecordingTargetLock(() => tracks)
    const states = []
    const capture = {
      start: async () => {
        startEntered.resolve()
        await startGate.promise
        return { sampleRate: 48000, channelCount: 1, startFrame: 0 }
      },
      stop: async () => {
        states.push(lock.state())
        stopEntered.resolve()
        await stopGate.promise
        return { capturedFrames: 1 }
      },
      cancel: async () => { calls.push('capture-cancel') },
      isActive: () => true,
      sampleRate: () => 48000,
    }
    let dispose = () => {}
    const hook = createRoot(cleanup => {
      dispose = cleanup
      return useTrackRecording({
        requiresNativeAudio: native,
        audioEngine, tracks: () => tracks, setTrackLock: () => {}, clearTrackLock: () => {},
        removeLocalTrack: () => {}, insertLocalClip: () => {}, removeLocalClips: () => {},
        selection, playheadSec: () => 0, uploadToR2: async () => null,
        audioBufferCache: { storeBuffer: () => {}, storeBuffers: () => {}, removeBuffer: () => {} },
        projectId: () => 'project:test', userId: () => undefined, convexClient: {}, convexApi: {},
        requestTransportPlay: async () => { calls.push('play') },
        requestTransportStop: async () => { calls.push('stop') },
        portableRecording: { enabled: () => !native, controller: capture },
        nativeRecording: { enabled: () => native, controller: capture },
        createTrackForRecording: async () => null, notify: () => {}, onLocalSaveFailed: () => {},
        historyPush: () => {}, targetLock: lock,
        audioPreferences: () => ({
          inputDeviceId: '', outputDeviceId: '', sampleRate: 48000, latencyMode: 'balanced',
          echoCancellation: false, noiseSuppression: false, autoGainControl: false, nativePlaybackEnabled: native,
        }),
        recordingPreferences: () => ({
          layout: 'mono', inputChannel: 0, monitor: 'off', gainDb: 0, invertPolarity: false,
          portableEnabled: !native, manualOffsetFrames: 0, calibrations: [],
        }),
        finalization: {
          acquireTrackLock: async () => ({ ok: true }),
          releaseTrackLock: async () => {},
          storage: { open: async () => ({ version: 1, sessionId: 'take', format: 'planar-float32-blocks',
            sampleRate: 48000, channelCount: 1, capturedFrames: 1, byteLength: 8, createdAtMs: 0, finalizedAtMs: 0 }),
            remove: async () => {}, cleanupStale: async () => {} },
          encodeWav: async () => ({ file: new File([new Uint8Array(8)], 'take.wav'), fileName: 'take.wav',
            mimeType: 'audio/wav', remove: async () => {} }),
          createLocalAsset: async () => ({ id: 'asset:take', name: 'take.wav', mimeType: 'audio/wav',
            sizeBytes: 8, storagePath: 'take.wav', sourceKind: 'recording', createdAt: 0, updatedAt: 0 }),
          createLocalAudioClip: async () => ({ clipId: 'clip:take', clip: { name: 'take', startSec: 0, duration: 1 / 48000 } }),
          deleteLocalAsset: async () => null,
        },
      })
    })
    hook.toggleRecordArm('track-audio')
    return { hook, lock, calls, states, startGate, startEntered, stopEntered, stopGate, dispose }
  }
  const entry = (type, data) => ({ type, projectId: 'project:test', data })
  const sectionEdit = (...entries) => entry('section-edit', { entries })
  const routingEntry = (trackRef, fromOutput, toOutput) => entry('track-routing', {
    trackRef, from: { sends: [], outputTargetRef: fromOutput }, to: { sends: [], outputTargetRef: toOutput },
  })
  const createEntry = (trackRef) => entry('track-create', { trackRef, index: 0 })
  const deleteEntry = (trackRef) => entry('track-delete', { track: { trackRef, index: 0, name: trackRef, volume: 1, routing: { sends: [] } }, clips: [] })
  const reorderEntry = (trackRef, fromGroupRef, toGroupRef) => entry('track-reorder', {
    patches: [{ trackRef, fromIndex: 0, toIndex: 0, fromGroupRef, toGroupRef }],
  })
  const refusals = (lock) => ({
    deleteTarget: lock.refuseDelete(['track-audio']),
    deleteGroup: lock.refuseDelete(['group-a', 'track-audio']),
    deleteOutputRoute: lock.refuseDelete(['group-a']),
    deleteOther: lock.refuseDelete(['track-other']),
    reroute: lock.refuseChange([{ trackId: 'track-audio', outputTargetId: 'return-a' }]),
    group: lock.refuseChange([{ trackId: 'track-audio', groupId: 'group-b', outputTargetId: 'group-b' }]),
    ungroup: lock.refuseChange([{ trackId: 'track-audio', groupId: undefined }, { trackId: 'track-other', groupId: undefined }]),
    rerouteOther: lock.refuseChange([{ trackId: 'track-other', outputTargetId: 'return-a' }]),
    groupOther: lock.refuseChange([{ trackId: 'track-other', groupId: 'group-a', outputTargetId: 'group-a' }]),
    undoRoute: lock.refuseHistory(sectionEdit(routingEntry('track-audio', 'return-a', 'group-a')), 'undo'),
    redoRoute: lock.refuseHistory(routingEntry('track-audio', 'group-a', 'return-a'), 'redo'),
    undoCreate: lock.refuseHistory(createEntry('track-audio'), 'undo'),
    undoReorder: lock.refuseHistory(reorderEntry('track-audio', undefined, 'group-a'), 'undo'),
    undoOtherCreate: lock.refuseHistory(createEntry('track-other'), 'undo'),
    undoOtherRoute: lock.refuseHistory(routingEntry('track-other', 'return-a', 'group-a'), 'undo'),
    undoOtherReorder: lock.refuseHistory(reorderEntry('track-other', undefined, 'group-a'), 'undo'),
    undoOtherSection: lock.refuseHistory(sectionEdit(createEntry('track-other'), routingEntry('track-other', 'return-a', undefined)), 'undo'),
    redoOtherDelete: lock.refuseHistory(deleteEntry('track-other'), 'redo'),
    undoClip: lock.refuseHistory({ type: 'clip-timing', projectId: 'project:test', data: {} }, 'undo'),
    commitDelete: lock.refuseTransition(tracks, tracks.filter(track => track.id !== 'track-audio')),
    commitReroute: lock.refuseTransition(tracks, tracks.map(track => track.id === 'track-audio' ? { ...track, outputTargetId: 'return-a' } : track)),
    commitUnrelated: lock.refuseTransition(tracks, [...tracks.filter(track => track.id !== 'track-other'), { ...tracks[3], outputTargetId: 'return-a' }]),
  })
  const expectLocked = (found) => found.deleteTarget === reason && found.deleteGroup === reason
    && found.deleteOutputRoute === reason && found.reroute === reason && found.group === reason
    && found.ungroup === reason && found.undoRoute === reason && found.redoRoute === reason
    && found.undoCreate === reason && found.undoReorder === reason && found.commitDelete === reason
    && found.commitReroute === reason
  const expectLive = (found) => found.deleteOther === undefined && found.rerouteOther === undefined
    && found.groupOther === undefined && found.undoClip === undefined && found.commitUnrelated === undefined
    && found.undoOtherCreate === undefined && found.undoOtherRoute === undefined && found.undoOtherReorder === undefined
    && found.undoOtherSection === undefined && found.redoOtherDelete === undefined

  for (const native of [false, true]) {
    const backend = native ? 'native' : 'portable'
    await scenario('lock-' + backend + '-starting-refuses-and-cancel-releases', async () => {
      const take = audioHook(native)
      const pending = take.hook.toggleRecording()
      await take.startEntered.promise
      const starting = take.lock.state() === 'starting' && take.lock.targetId() === 'track-audio'
        && expectLocked(refusals(take.lock)) && expectLive(refusals(take.lock))
      const stop = take.hook.stopRecording()
      take.startGate.resolve()
      await Promise.all([pending, stop])
      const released = take.lock.state() === 'released' && take.lock.targetId() === null
        && take.lock.refuseDelete(['track-audio']) === undefined
      take.dispose()
      return starting && released
    })
    await scenario('lock-' + backend + '-start-finish-race-ends-released-and-restarts', async () => {
      const take = audioHook(native)
      take.stopGate.resolve()
      const first = take.hook.toggleRecording()
      const second = take.hook.stopRecording()
      const third = take.hook.toggleRecording()
      take.startGate.resolve()
      await Promise.all([first, second, third])
      await take.hook.stopRecording()
      const settled = take.lock.state() === 'released'
      const again = take.hook.toggleRecording()
      await settle()
      const restarted = take.lock.state() !== 'released' && take.lock.targetId() === 'track-audio'
      await take.hook.stopRecording()
      await again.catch(() => undefined)
      take.dispose()
      return settled && restarted && take.lock.state() === 'released'
    })
  }

  await scenario('lock-portable-take-refuses-edits-and-never-stops-recording', async () => {
    const take = audioHook(false)
    const pending = take.hook.toggleRecording()
    await take.startEntered.promise
    take.startGate.resolve()
    await pending
    const recording = take.lock.state() === 'recording' && take.hook.isRecording()
      && take.lock.holds('track-audio') && take.lock.holds('group-a') && !take.lock.holds('track-other')
    const found = refusals(take.lock)
    const survived = take.hook.isRecording() && !take.calls.includes('stop') && !take.calls.includes('capture-cancel')
    const finishing = take.hook.stopRecording()
    await take.stopEntered.promise
    const whileFinishing = take.states[0] === 'finishing' && take.lock.refuseDelete(['track-audio']) === reason
    take.stopGate.resolve()
    await finishing
    const released = take.lock.state() === 'released' && take.lock.refuseDelete(['track-audio']) === undefined
      && take.lock.refuseChange([{ trackId: 'track-audio', outputTargetId: 'return-a' }]) === undefined
    take.dispose()
    return recording && expectLocked(found) && expectLive(found) && survived && whileFinishing && released
  })

  await scenario('lock-midi-take-holds-target-until-settled', async () => {
    const fetchBefore = window.fetch
    window.fetch = async (_url, init) => {
      const body = JSON.parse(init.body)
      if (body.kind === 'clips.create') return new Response(JSON.stringify('clip-lock-midi'))
      return new Response(JSON.stringify({ ok: true }))
    }
    const lock = recordingTarget.createRecordingTargetLock(() => tracks)
    const [isRecording, setIsRecording] = createSignal(false)
    const [recordingTrackId, setRecordingTrackId] = createSignal(null)
    let dispose = () => {}
    let controller
    createRoot(cleanup => {
      dispose = cleanup
      controller = createMidiTrackRecordingController({
        audioEngine: { midiEventTimes: () => null },
        tracks: () => tracks, projectId: () => 'cloud-project', userId: () => 'user-midi',
        playheadSec: () => 0, bpm: () => 120, loopEnabled: () => false, recordArmTrackId: () => 'track-midi',
        setTrackLock: () => {}, clearTrackLock: () => {}, insertLocalClip: () => {}, removeLocalClips: () => {},
        selection: { selectPrimaryClip: () => {} }, requestTransportPlay: async () => {}, pauseTransport: () => {},
        notify: () => {}, historyPush: () => {}, setActiveRecordingTarget: () => {}, setProvisionalClipId: () => {},
        isRecording, setIsRecording, recordingTrackId, setRecordingTrackId, targetLock: lock,
      }, {
        inputs: () => [], requestAccess: async () => {}, setInputSelected: () => {},
        subscribe: () => () => {}, subscribeSourceReset: () => () => {}, panic: () => {},
      })
    })
    try {
      const started = await controller.startRecording()
      const holding = started && lock.state() === 'recording' && lock.targetId() === 'track-midi'
        && lock.refuseDelete(['track-midi']) === reason
        && lock.refuseChange([{ trackId: 'track-midi', outputTargetId: 'return-a' }]) === reason
        && lock.refuseChange([{ trackId: 'track-other', outputTargetId: 'return-a' }]) === undefined
      await controller.stopRecording()
      return holding && lock.state() === 'released' && lock.refuseDelete(['track-midi']) === undefined
    } finally {
      dispose()
      window.fetch = fetchBefore
    }
  })

  return results
}

// The real sidebar row and lane, mounted with stubbed props, driven through the take lifecycle.
const surfaceReason = 'Finish recording to delete this track or change its routing.'
const surfaceTracks = [
  { id: 'group-a', kind: 'audio', channelRole: 'group', name: 'Group', volume: 1, clips: [], sends: [] },
  { id: 'return-a', kind: 'audio', channelRole: 'return', name: 'Return', volume: 1, clips: [], sends: [] },
  { id: 'track-audio', kind: 'audio', channelRole: 'track', name: 'Audio', volume: 1, clips: [], sends: [], groupId: 'group-a', outputTargetId: 'group-a' },
  { id: 'track-other', kind: 'audio', channelRole: 'track', name: 'Other', volume: 1, clips: [], sends: [] },
]
const surfaceLock = recordingTarget.createRecordingTargetLock(() => surfaceTracks)
const noop = () => {}
const surfaceRowModel = {
  sidebar: () => ({
    currentUserId: 'user', recordArmTrackId: null, selectedTrackId: '', selectedTrackIds: [], recordingTargetLock: surfaceLock,
    onToggleTrackCollapsed: noop, onTrackClick: noop, onGroupTracks: noop, onMoveTrackToGroup: noop, onUngroupTrack: noop,
    onSelectAllClipsInGroup: noop, onSetTrackColor: noop, onResetTrackColor: noop, onAssignTrackColorToClips: noop,
    onResetClipColors: noop, onToggleMute: noop, onToggleSolo: noop, onToggleRecordArm: noop, onDeleteTrack: noop, onVolumePreview: noop,
  }),
  automation: () => ({
    lanes: { selectedTargetsByOwnerKey: {}, visibleByTrackId: {}, visibleTargetKeysByTrackId: {}, heightsByLaneOwnerKey: {}, effectInstancesByOwnerKey: {} },
    actions: { toggleTrackVisibility: noop, addTrackLane: noop },
  }),
  automationMetaByTrackId: () => new Map(),
  appPreferences: { timeline: {
    defaultTrackColor: () => '#3b82f6', defaultTrackColorInput: () => '#3b82f6',
    defaultGroupColor: () => '#a3a3a3', defaultGroupColorInput: () => '#a3a3a3',
  } },
  depthByTrackId: () => new Map(), trackNumbersById: () => new Map(surfaceTracks.map((track, index) => [track.id, index + 1])),
  layoutByTrackId: () => new Map(), ancestorGroupColorBandsByTrackId: () => new Map(),
  defaultGroupColor: () => '#a3a3a3', resolveGroupColor: color => color ?? '#a3a3a3',
  displayTrackName: track => track.name, outputTargetName: () => 'Group', sendTargetName: () => 'None',
  groupTracks: () => [surfaceTracks[0]], canWriteTrackRouting: () => true,
  selectedOutputTargetId: track => track.outputTargetId ?? '', selectedSendTargetId: () => '',
  returnTracks: () => [surfaceTracks[1]], handleTrackCollapseClick: noop, isTrackDragBlockedTarget: () => false,
  startTrackDrag: noop, updateTrackDrag: noop, finishTrackDrag: noop, cancelTrackDrag: noop,
  suppressTrackClickId: () => undefined, setSuppressTrackClickId: noop, meters: {},
  displayVolume: () => 1, displayMeterLevel: () => 0, quantizeVolume: volume => volume,
  trackVolumeAutomationTargetKey: id => 'track:' + id, previewTrackVolume: noop, commitTrackVolume: noop,
  startAutomationResize: noop, handleOutputTargetChange: noop, handleSendTargetChange: noop,
}
const surfaceLaneProps = track => ({
  track, layout: { topPx: 0, heightPx: 48, clipLaneHeightPx: 48, automationHeightPx: 0 }, groupClipOverview: [],
  selectedClipIds: new Set(), rangeSelection: null, onClipPointerDown: noop, onClipPointerUp: noop, onClipResizeStart: noop,
  clipContextMenu: {}, onRetryMedia: noop, onReplaceMedia: noop, onRemoveMissingMedia: noop, resolveAudioSource: noop,
  onDeleteTrack: noop, recordingTargetLock: surfaceLock, bpm: 120, pixelsPerSecond: 100,
  visibleRange: { startSec: 0, endSec: 8 }, clipVisibleRange: { startSec: 0, endSec: 8 }, viewportWidthPx: 800,
  timeToX: time => time * 100, clientXToTime: clientX => clientX / 100, gridEnabled: false, gridDenominator: 4,
  viewportRedrawVersion: 0, devicePixelRatio: 1, canEditClipFades: () => false, onCommitClipFades: noop,
  automation: {
    projectId: 'project:test', visible: false, selections: [], laneHeightPx: 48, envelopeForSelection: () => undefined,
    durationSec: 8, onPreview: noop, onCommit: noop, onCancelPreview: noop,
  },
})
const mountSurface = (component, props, style) => {
  const host = document.createElement('div')
  host.style.cssText = style
  document.body.append(host)
  const dispose = render(() => createComponent(component, props), host)
  return { host, dispose: () => { dispose(); host.remove() } }
}
const openMenu = async element => {
  element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 60, clientY: 30, button: 2 }))
  await macrotask()
  await macrotask()
  return [...document.querySelectorAll('[role="menuitem"]')]
}
const itemDisabled = (items, label) => {
  const item = items.find(entry => entry.textContent.includes(label))
  return item ? item.hasAttribute('data-disabled') || item.getAttribute('aria-disabled') === 'true' : undefined
}
const menuHasReason = () => [...document.querySelectorAll('[role="menu"] *')].some(node => node.textContent === surfaceReason)
const surfaceHosts = {}

window.surfaceMount = () => {
  surfaceHosts.row = mountSurface(TrackSidebarRow, { track: surfaceTracks[2], model: surfaceRowModel }, 'width:260px')
  surfaceHosts.other = mountSurface(TrackSidebarRow, { track: surfaceTracks[3], model: surfaceRowModel }, 'width:260px')
  surfaceHosts.lane = mountSurface(TrackLane, surfaceLaneProps(surfaceTracks[2]), 'position:relative;width:800px;height:48px')
}

window.surfaceSet = async phase => {
  if (phase === 'starting') surfaceLock.start('track-audio')
  if (phase === 'recording') surfaceLock.recording()
  if (phase === 'finishing') surfaceLock.finishing()
  if (phase === 'released') surfaceLock.release()
  await macrotask()
  const selects = host => [...host.querySelectorAll('select')]
  const status = host => host.querySelector('[role="status"]')?.textContent.trim() ?? ''
  const badge = host => [...host.querySelectorAll('span[title]')].find(node => node.title === surfaceReason)?.textContent.trim() ?? ''
  const rowMenu = mountSurface(TrackSidebarRow, { track: surfaceTracks[2], model: surfaceRowModel }, 'width:260px')
  const rowItems = await openMenu(rowMenu.host.firstElementChild)
  const sidebarMenu = { delete: itemDisabled(rowItems, 'Delete track'), ungroup: itemDisabled(rowItems, 'Remove from group'), reason: menuHasReason() }
  rowMenu.dispose()
  await macrotask()
  const laneMenu = mountSurface(TrackLane, surfaceLaneProps(surfaceTracks[2]), 'position:relative;width:800px;height:48px')
  const laneItems = await openMenu(laneMenu.host.firstElementChild)
  const laneMenuState = { delete: itemDisabled(laneItems, 'Delete track'), reason: menuHasReason() }
  laneMenu.dispose()
  await macrotask()
  return {
    outputs: selects(surfaceHosts.row.host).map(select => ({ disabled: select.disabled, title: select.title })),
    otherOutputs: selects(surfaceHosts.other.host).map(select => select.disabled),
    status: status(surfaceHosts.row.host),
    otherStatus: status(surfaceHosts.other.host),
    badge: badge(surfaceHosts.lane.host),
    sidebarMenu,
    laneMenu: laneMenuState,
  }
}
window.surfaceUnmount = () => { for (const host of Object.values(surfaceHosts)) host.dispose() }

window.dispatchScenarios = async () => {
  let audioStarts = 0
  let midiStarts = 0
  let stopped = 0
  let keyboardPauses = 0
  let keyboardPlays = 0
  const audioPending = await dispatchRecordingToggle({
    audioStarting: () => true,
    midiStarting: () => false,
    cleanupPending: () => false,
    isRecording: () => false,
    recordingTrackId: () => null,
    armedTrack: () => ({ id: 'instrument-a', kind: 'instrument' }),
    stopRecording: async () => { stopped += 1 },
    toggleAudioRecording: async () => { audioStarts += 1; return { ok: true, trackId: 'audio-a' } },
    startMidiRecording: async () => { midiStarts += 1; return true },
  })
  const pendingAudioJoined = audioPending.ok && audioStarts === 1 && midiStarts === 0
  const midiPending = await dispatchRecordingToggle({
    audioStarting: () => false,
    midiStarting: () => true,
    cleanupPending: () => false,
    isRecording: () => false,
    recordingTrackId: () => null,
    armedTrack: () => ({ id: 'audio-a', kind: 'audio' }),
    stopRecording: async () => { stopped += 1 },
    toggleAudioRecording: async () => { audioStarts += 1; return { ok: true } },
    startMidiRecording: async () => { midiStarts += 1; return true },
  })
  dispatchTransportSpace({
    recordingBusy: () => true,
    isPlaying: () => false,
    pauseRecording: () => { keyboardPauses += 1 },
    pausePlayback: () => {},
    play: () => { keyboardPlays += 1 },
  })
  return {
    'pending-audio-joins-after-arm-change': pendingAudioJoined,
    'pending-midi-joins-after-arm-change': midiPending.ok && midiStarts === 1 && audioStarts === 1,
    'pending-start-does-not-stop-either-recording': stopped === 0,
    'pending-audio-space-pauses-without-play': keyboardPauses === 1 && keyboardPlays === 0,
  }
}

`

test('recording startup joins duplicate requests and stop cancels setup immediately', async () => {
  const directory = `/tmp/daw-recording-lifecycle-${crypto.randomUUID()}`
  const session = `daw-recording-${crypto.randomUUID()}`
  const browser = async (...args: string[]) => {
    const env = { ...process.env }
    delete env.AGENT_BROWSER_CDP
    delete env.AGENT_BROWSER_SESSION
    const child = Bun.spawn(['agent-browser', '--session', session, ...args], { env, stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
    if (await child.exited !== 0) throw new Error(stderr || stdout)
    return stdout.trim()
  }
  await mkdir(directory, { recursive: true })
  try {
    const bundledFixture = fixture
      .replaceAll("'./useTrackRecording'", `'${import.meta.dir}/useTrackRecording.ts'`)
      .replaceAll("'./useTimelinePlayback'", `'${import.meta.dir}/useTimelinePlayback.ts'`)
      .replaceAll("'./recording-dispatch'", `'${import.meta.dir}/recording-dispatch.ts'`)
      .replaceAll("'./useMidiTrackRecording'", `'${import.meta.dir}/useMidiTrackRecording.ts'`)
      .replaceAll("'../lib/midi/midi-recording-controller'", `'${import.meta.dir}/../lib/midi/midi-recording-controller.ts'`)
      .replaceAll("'../lib/midi/recording-checkpoint'", `'${import.meta.dir}/../lib/midi/recording-checkpoint.ts'`)
      .replaceAll("'../lib/track-recording-target'", `'${import.meta.dir}/../lib/track-recording-target.ts'`)
      .replaceAll("'../components/timeline/TransportControls'", `'${import.meta.dir}/../components/timeline/TransportControls.tsx'`)
      .replaceAll("'../components/timeline/TrackLane'", `'${import.meta.dir}/../components/timeline/TrackLane.tsx'`)
      .replaceAll("'../components/timeline/TrackSidebarRow'", `'${import.meta.dir}/../components/timeline/TrackSidebarRow.tsx'`)
    await Bun.write(`${directory}/fixture.js`, bundledFixture)
    const output = await build({
      configFile: false,
      root: new URL('../../', import.meta.url).pathname,
      logLevel: 'silent',
      plugins: [
        solidPlugin(),
        tailwindcss(),
        {
          name: 'recording-browser-boundaries',
          enforce: 'pre',
          resolveId(id) {
            if (id.endsWith('recording-temp-storage')) return '\0recording-test:temp-storage'
            if (/context\/midi-access(\.tsx?)?$/.test(id)) return '\0recording-test:midi-access'
            if (/context\/app-preferences(\.tsx?)?$/.test(id)) return '\0recording-test:app-preferences'
            return undefined
          },
          load(id) {
            if (id === '\0recording-test:midi-access') return `export const useMidiAccess = () => window.liveMidiAccess`
            if (id === '\0recording-test:app-preferences') return `export const useAppPreferences = () => ({ appearance: { themeTokens: () => ({}) } })`
            if (id !== '\0recording-test:temp-storage') return undefined
            return `export const decodePlanarPcmBlocks = () => []
export const isRecordingTempStorageSupported = () => true
export const createRecordingTempStorage = () => ({ cleanupStale: async () => {}, remove: async () => {}, open: async () => null })`
          },
        },
      ],
      resolve: {
        alias: [
          { find: /^solid-js$/, replacement: `${new URL('../../node_modules/solid-js/dist/solid.js', import.meta.url).pathname}` },
          { find: /^solid-js\/web$/, replacement: `${new URL('../../node_modules/solid-js/web/dist/web.js', import.meta.url).pathname}` },
          { find: '~', replacement: `${new URL('../../src/', import.meta.url).pathname}` },
        ],
      },
      define: { 'import.meta.env': '{}' },
      build: {
        write: false,
        rollupOptions: {
          input: `${directory}/fixture.js`,
          output: { format: 'iife', inlineDynamicImports: true },
        },
      },
    })
    if (!('output' in output)) throw new Error('Recording lifecycle browser build returned no output.')
    const bundle = output.output.find((entry) => entry.type === 'chunk')
    if (!bundle || bundle.type !== 'chunk') throw new Error('Recording lifecycle browser bundle was not emitted.')
    const stylesheet = output.output.find((entry) => entry.type === 'asset' && entry.fileName.endsWith('.css'))
    if (stylesheet?.type === 'asset') await Bun.write(`${directory}/style.css`, stylesheet.source)
    await Bun.write(`${directory}/index.html`, `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="style.css"><body><script>window.addEventListener('error', event => document.body.dataset.error = event.message)</script><script>window.unhandledRejectionCount = 0; window.addEventListener('unhandledrejection', () => { window.unhandledRejectionCount += 1 })</script><script>${bundle.code}</script>`)
    await browser('open', `file://${directory}/index.html`)
    await browser('wait', '--fn', '!!window.recordingScenarios')
    const results = z.record(z.string(), z.boolean()).parse(JSON.parse(await browser('eval', 'window.recordingScenarios()')))
    const playResults = z.record(z.string(), z.boolean()).parse(JSON.parse(await browser('eval', 'window.playScenarios()')))
    Object.assign(results, playResults)
    const lockResults = z.record(z.string(), z.boolean()).parse(JSON.parse(await browser('eval', 'window.lockScenarios()')))
    Object.assign(results, lockResults)
    const surfaceState = z.object({
      outputs: z.array(z.object({ disabled: z.boolean(), title: z.string() })),
      otherOutputs: z.array(z.boolean()),
      status: z.string(),
      otherStatus: z.string(),
      badge: z.string(),
      sidebarMenu: z.object({ delete: z.boolean().optional(), ungroup: z.boolean().optional(), reason: z.boolean() }),
      laneMenu: z.object({ delete: z.boolean().optional(), reason: z.boolean() }),
    })
    const reason = 'Finish recording to delete this track or change its routing.'
    await browser('eval', 'window.surfaceMount()')
    const surfaceStates: Record<string, z.infer<typeof surfaceState>> = {}
    for (const phase of ['starting', 'recording', 'finishing', 'released'] as const) {
      const state = surfaceState.parse(JSON.parse(await browser('eval', `window.surfaceSet('${phase}')`)))
      surfaceStates[phase] = state
      await browser('screenshot', `${directory}/lock-${phase}.png`)
      const locked = phase !== 'released'
      results[`surface-${phase}-sidebar-routing-controls`] = state.outputs.length >= 2
        && state.outputs.every(output => output.disabled === locked && (output.title === reason) === locked)
        && state.otherOutputs.every(disabled => !disabled)
      results[`surface-${phase}-sidebar-menu`] = state.sidebarMenu.delete === locked && state.sidebarMenu.ungroup === locked
        && state.sidebarMenu.reason === locked
      results[`surface-${phase}-lane-menu`] = state.laneMenu.delete === locked && state.laneMenu.reason === locked
      results[`surface-${phase}-badge-and-status`] = locked
        ? state.badge.startsWith('Recording target locked') && state.status.includes('Recording target locked. ' + reason)
          && state.badge.includes('Finishing recording…') === (phase === 'finishing')
          && state.status.includes('Finishing recording…') === (phase === 'finishing')
          && state.otherStatus === ''
        : state.badge === '' && state.status === '' && state.otherStatus === ''
    }
    await Bun.write(`${directory}/surface-states.json`, JSON.stringify(surfaceStates, null, 2))
    await browser('eval', 'window.surfaceUnmount()')
    const dispatchResults = z.record(z.string(), z.boolean()).parse(JSON.parse(await browser('eval', 'window.dispatchScenarios()')))
    Object.assign(results, dispatchResults)
    const deltas = z.record(z.string(), z.record(z.string(), z.union([z.boolean(), z.number(), z.string()])))
      .parse(JSON.parse(await browser('eval', 'window.recordingDeltas')))
    await Bun.write(`${directory}/results.json`, JSON.stringify({ scenarios: results, deltas }, null, 2))
    console.log(`Recording lifecycle evidence: ${directory}/results.json`)
    expect(Object.entries(results).filter(([, passed]) => !passed)).toEqual([])
    await browser('eval', 'window.transportBarUnmount()')
  } finally {
    await browser('close').catch(() => undefined)
    await rm(`${directory}/index.html`, { force: true })
  }
}, 60_000)
