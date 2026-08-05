import { createRoot } from "solid-js"
import { expect, test } from "bun:test"

import { convexApi, convexClient } from "~/lib/convex"
import { useTrackRecording } from "./useTrackRecording"
import type { DesktopAudioLifecycle } from "~/lib/desktop-audio-lifecycle"
import type { Track } from "@daw-browser/timeline-core/types"
import { AudioEngine } from "@daw-browser/audio-engine/audio-engine"

const track: Track = {
  id: "audio-track",
  kind: "audio",
  name: "Audio",
  volume: 1,
  clips: [],
}

const audioPreferences = () => ({
  inputDeviceId: "",
  outputDeviceId: "",
  sampleRate: 48_000 as const,
  latencyMode: "balanced" as const,
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  nativePlaybackEnabled: true,
  portableBrowserPlaybackEnabled: true,
})

const recordingPreferences = () => ({
  layout: "mono" as const,
  inputChannel: 0,
  monitor: "off" as const,
  gainDb: 0,
  invertPolarity: false,
  portableEnabled: true,
  manualOffsetFrames: 0,
  calibrations: [],
})

const flushLifecycle = async () => {
  for (let index = 0; index < 5; index += 1) await Promise.resolve()
}

const createHarness = (
  initialLifecycle: DesktopAudioLifecycle,
  nativeEnabled = true,
  requiresNativeAudio = false,
  nativeStartFails = false,
) => {
  const previousWindow = globalThis.window
  const previousNavigator = globalThis.navigator
  const lifecycleListeners: Array<(lifecycle: DesktopAudioLifecycle) => void> = []
  const calls: string[] = []
  const mediaTrack = Object.assign(Object.create(null), {
    readyState: "live",
    getSettings: () => ({ channelCount: 1, sampleRate: 48_000 }),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    stop: () => calls.push("stream-stop"),
  })
  const stream: MediaStream = Object.assign(Object.create(null), {
    getTracks: () => [mediaTrack],
    getAudioTracks: () => [mediaTrack],
  })
  const context: AudioContext = Object.assign(Object.create(null), {
    currentTime: 0,
    sampleRate: 48_000,
  })
  const audioEngine = new AudioEngine()
  audioEngine.ensureAudio = () => undefined
  audioEngine.resume = async () => undefined
  audioEngine.getAudioContext = () => context
  audioEngine.subscribeRecordingStatus = () => () => true
  audioEngine.cancelRecordingCapture = () => calls.push("legacy-cancel")
  const emptyStorageDirectory = {
    getDirectoryHandle: async () => emptyStorageDirectory,
    entries: async function* () {},
  }
  const nativeController = {
    start: async () => {
      calls.push("native-start")
      if (nativeStartFails) throw new Error("native-start-failed")
      return { sampleRate: 48_000, channelCount: 1, startFrame: 0 }
    },
    stop: async () => {
      calls.push("native-stop")
      return { capturedFrames: 1 }
    },
    cancel: async () => {
      calls.push("native-cancel")
    },
    isActive: () => true,
    sampleRate: () => 48_000,
  }
  const portableController = {
    start: async () => {
      calls.push("portable-start")
      return { sampleRate: 48_000, channelCount: 1, startFrame: 0 }
    },
    stop: async () => {
      calls.push("portable-stop")
      return { capturedFrames: 1 }
    },
    cancel: async () => {
      calls.push("portable-cancel")
    },
    isActive: () => true,
  }
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      MediaRecorder: Object.assign(() => undefined, {
        isTypeSupported: () => true,
      }),
      dawDesktop: {
        audioHost: {
          getLifecycle: async () => initialLifecycle,
          onLifecycle: (listener: (lifecycle: DesktopAudioLifecycle) => void) => {
            lifecycleListeners.push(listener)
            return () => undefined
          },
        },
      },
    },
  })
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      platform: "test",
      userAgent: "test",
      userAgentData: undefined,
      mediaDevices: {
        getSupportedConstraints: () => ({}),
        getUserMedia: async () => {
          calls.push("get-user-media")
          return stream
        },
      },
      storage: {
        getDirectory: async () => emptyStorageDirectory,
      },
    },
  })
  const selection = {
    selectedTrackId: () => "",
    selectedClip: () => null,
    selectedClipIds: () => new Set<string>(),
    selectedFXTarget: () => "master" as const,
    rangeSelection: () => null,
    selectPrimaryClip: () => undefined,
    appendClipToSelection: () => undefined,
    selectClipGroup: () => undefined,
    selectTrackTarget: () => undefined,
    selectMasterTarget: () => undefined,
    selectTimeRange: () => undefined,
    clearTimeRange: () => undefined,
    setSelectedClipIds: () => undefined,
    setSelectedClip: () => undefined,
    setSelectedTrackId: () => undefined,
    setSelectedFXTarget: () => undefined,
  }
  const recording = useTrackRecording({
    audioEngine,
    requiresNativeAudio,
    tracks: () => [track],
    setTrackLock: () => undefined,
    clearTrackLock: () => undefined,
    removeLocalTrack: () => undefined,
    insertLocalClip: () => undefined,
    removeLocalClips: () => undefined,
    selection,
    playheadSec: () => 0,
    uploadToR2: async () => null,
    audioBufferCache: {
      storeBuffer: () => undefined,
      storeBuffers: () => undefined,
      removeBuffer: () => undefined,
    },
    projectId: () => "project:test",
    userId: () => undefined,
    convexClient,
    convexApi,
    requestTransportPlay: async () => {
      calls.push("transport-play")
    },
    requestTransportStop: async () => {
      calls.push("transport-stop")
    },
    portableRecording: {
      enabled: () => true,
      controller: portableController,
    },
    nativeRecording: {
      enabled: () => nativeEnabled,
      controller: nativeController,
    },
    createTrackForRecording: async () => null,
    notify: () => undefined,
    historyPush: () => undefined,
    audioPreferences,
    recordingPreferences,
  })
  return {
    recording,
    calls,
    emit: (lifecycle: DesktopAudioLifecycle) => {
      for (const listener of lifecycleListeners) listener(lifecycle)
    },
    restore: () => {
      Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
      Object.defineProperty(globalThis, "navigator", { configurable: true, value: previousNavigator })
    },
  }
}

test("uses portable recording while native lifecycle is recovering or failed", async () => {
  for (const state of ["recovering", "failed"] as const) {
    const harness = createHarness({ state, powerGeneration: 1 })
    await createRoot(async (dispose) => {
      await flushLifecycle()
      await expect(harness.recording.startRecording(track.id)).resolves.toMatchObject({ ok: true })
      expect(harness.calls).toContain("portable-start")
      expect(harness.calls).not.toContain("native-start")
      await harness.recording.stopRecording()
      dispose()
    })
    harness.restore()
  }
})

test("preserves portable recording when native lifecycle fails", async () => {
  const harness = createHarness({ state: "ready", powerGeneration: 1 }, false)
  await createRoot(async (dispose) => {
    await flushLifecycle()
    await expect(harness.recording.startRecording(track.id)).resolves.toMatchObject({ ok: true })
    expect(harness.calls).toContain("portable-start")
    harness.emit({ state: "failed", powerGeneration: 2 })
    await Promise.resolve()
    expect(harness.recording.isRecording()).toBeTrue()
    expect(harness.calls).not.toContain("portable-cancel")
    await harness.recording.stopRecording()
    dispose()
  })
  harness.restore()
})

test("cancels portable recording on suspension", async () => {
  const harness = createHarness({ state: "recovering", powerGeneration: 1 })
  await createRoot(async (dispose) => {
    await flushLifecycle()
    await expect(harness.recording.startRecording(track.id)).resolves.toMatchObject({ ok: true })
    harness.emit({ state: "suspended", powerGeneration: 2 })
    await flushLifecycle()
    expect(harness.recording.isRecording()).toBeFalse()
    expect(harness.calls).toContain("portable-cancel")
    dispose()
  })
  harness.restore()
})

test("cancels native recording on native lifecycle failure", async () => {
  const harness = createHarness({ state: "ready", powerGeneration: 1 })
  await createRoot(async (dispose) => {
    await flushLifecycle()
    await expect(harness.recording.startRecording(track.id)).resolves.toMatchObject({ ok: true })
    harness.emit({ state: "failed", powerGeneration: 2 })
    await flushLifecycle()
    expect(harness.recording.isRecording()).toBeFalse()
    expect(harness.calls).toContain("native-cancel")
    expect(harness.calls).not.toContain("portable-cancel")
    dispose()
  })
  harness.restore()
})

test("desktop native-only recording never falls back to browser capture", async () => {
  const harness = createHarness({ state: "ready", powerGeneration: 1 }, true, true, true)
  await createRoot(async (dispose) => {
    await flushLifecycle()
    await expect(harness.recording.startRecording(track.id)).resolves.toMatchObject({ ok: false })
    expect(harness.calls).toContain("native-start")
    expect(harness.calls).toContain("transport-stop")
    expect(harness.calls).not.toContain("portable-start")
    expect(harness.calls).not.toContain("get-user-media")
    dispose()
  })
  harness.restore()
})
