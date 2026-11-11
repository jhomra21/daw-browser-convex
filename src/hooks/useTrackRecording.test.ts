import { createRoot } from "solid-js"
import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import type { createLocalAsset } from "~/lib/local-assets"
import { SharedOutboxQueuedError } from "~/lib/shared-outbox"
import { createRecordingTempStorage } from "~/lib/recording/recording-temp-storage"
import type { NativeRecordingScope, NativeRecordingRelease, NativeRecordingImportedTake } from "~/types/desktop-bridge"

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

test("keeps bounded PCM recording as the only browser recording path", async () => {
  const source = await readFile(new URL("./useTrackRecording.ts", import.meta.url), "utf8")
  expect(source).toContain("if (!requiresNativeAudio && !engineCaptureActive && productionSupported) try")
  expect(source).not.toContain("productionSupported && !portableRequested")
  expect(source).not.toContain("new MediaRecorder")
  expect(source).not.toContain("new Blob(ctx.chunks")
  expect(source).not.toContain("file.arrayBuffer()")
})

const createHarness = (
  initialLifecycle: DesktopAudioLifecycle,
  nativeEnabled = true,
  requiresNativeAudio = false,
  nativeStartFails = false,
  locksAvailable = true,
  finalization?: Parameters<typeof useTrackRecording>[0]["finalization"],
  behavior?: {
    projectId?: () => string
    userId?: string
    notify?: (message: string) => void
    tracks?: () => Track[]
    createTrackForRecording?: () => Promise<Track | null>
    historyPush?: Parameters<typeof useTrackRecording>[0]["historyPush"]
  },
) => {
  // Bun has no global window; redefining it by value would leave a non-writable `undefined` behind for later files.
  const previousWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window")
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
  const recordingLocks = {
    request: async (
      _name: string,
      _options: { mode: "exclusive"; ifAvailable?: boolean },
      callback: (lock: { name: string; mode: "exclusive" }) => Promise<void>,
    ): Promise<void> => {
      await callback({ name: "recording-test", mode: "exclusive" })
    },
  }
  const navigatorValue = {
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
    locks: locksAvailable ? recordingLocks : undefined,
  }
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      setInterval: () => 1,
      clearInterval: () => undefined,
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
    value: navigatorValue,
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
    tracks: behavior?.tracks ?? (() => [track]),
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
    projectId: behavior?.projectId ?? (() => "project:test"),
    finalization,
    userId: () => behavior?.userId,
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
    createTrackForRecording: behavior?.createTrackForRecording ?? (async () => null),
    notify: behavior?.notify ?? (() => undefined),
    onLocalSaveFailed: () => undefined,
    historyPush: behavior?.historyPush ?? (() => undefined),
    audioPreferences,
    recordingPreferences,
  })
  return {
    recording,
    nativeController,
    calls,
    emit: (lifecycle: DesktopAudioLifecycle) => {
      for (const listener of lifecycleListeners) listener(lifecycle)
    },
    restore: () => {
      if (previousWindowDescriptor) Object.defineProperty(globalThis, "window", previousWindowDescriptor)
      else Reflect.deleteProperty(globalThis, "window")
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

test("reports unsupported recording before starting any capture without Web Locks", async () => {
  const harness = createHarness({ state: "ready", powerGeneration: 1 }, true, false, false, false)
  await createRoot(async (dispose) => {
    await flushLifecycle()
    await expect(harness.recording.startRecording(track.id)).resolves.toEqual({
      ok: false,
      reason: "Recording storage unsupported",
    })
    expect(harness.calls).not.toContain("native-start")
    expect(harness.calls).not.toContain("portable-start")
    expect(harness.calls).not.toContain("get-user-media")
    dispose()
  })
  harness.restore()
})

// Behavioral save regressions use the actual hook with narrow I/O dependencies.
const nativeProof: NativeRecordingImportedTake = { takeId: "opaque", scope: { projectId: "project:test", projectGeneration: 1 },
  acknowledgment: { reason: "imported", sessionId: "opfs", frames: 1, bytes: 8, blocks: 1,
    sampleRateHz: 48000, channelCount: 1, finalized: true } }

const savedAsset = (): Awaited<ReturnType<typeof createLocalAsset>> => ({ id: "asset:saved", name: "take.wav", mimeType: "audio/wav", sizeBytes: 8,
  storagePath: "take.wav", sourceKind: "recording", createdAt: 1, updatedAt: 1 })

// The fixture uses actual native source/asset/clip files at I/O boundaries. The
// hook's stop/save/release orchestration remains the production implementation.
test("M1 WAV/asset/clip/queued/scope failures retain native source until confirmed save", async () => {
  for (const projectKind of ["local", "shared"]) for (const failure of ["wav", "asset", "clip", "queued", "scope"]) {
    const directory = await mkdtemp("/private/tmp/daw-hook-retention-")
    const source = `${directory}/native.pcm`
    await writeFile(source, Uint8Array.of(1, 2, 3), { mode: 0o600 })
    const calls: string[] = []; const notifications: string[] = []
    let currentProject = projectKind === "local" ? "project:test" : "cloud-project"
    const createAsset = async () => {
      calls.push("asset")
      if (failure === "asset") throw new Error("asset failure")
      await writeFile(`${directory}/asset.wav`, Uint8Array.of(4, 5, 6))
      return savedAsset()
    }
    const createClip = async () => {
      calls.push("clip")
      if (failure === "queued") throw new SharedOutboxQueuedError("clips.create", "test-operation")
      throw new Error("clip failure")
    }
    const finalization: NonNullable<Parameters<typeof useTrackRecording>[0]["finalization"]> = {
      acquireTrackLock: async () => ({ ok: true }),
      releaseTrackLock: async () => undefined,
      storage: { ...createRecordingTempStorage(), open: async (sessionId) => ({ version: 1, sessionId,
        format: "planar-float32-blocks", sampleRate: 48000, channelCount: 1, capturedFrames: 1,
        byteLength: 8, createdAtMs: 1, finalizedAtMs: 2 }) },
      encodeWav: async () => {
        calls.push("wav")
        if (failure === "wav") throw new Error("wav failure")
        if (failure === "scope") currentProject = "project:switched"
        return { file: new File([new Uint8Array(8)], "take.wav"), fileName: "take.wav", mimeType: "audio/wav", remove: async () => {} }
      },
      createLocalAsset: createAsset,
      deleteLocalAsset: async () => { calls.push("asset-delete") },
      createLocalAudioClip: createClip,
      createUploadedAudioClip: async () => { await createAsset(); return createClip() },
    }
    const harness = createHarness({ state: "ready", powerGeneration: 1 }, true, false, false, true, finalization,
      { projectId: () => currentProject, userId: "test-user", notify: (message) => notifications.push(message) })
    harness.nativeController.stop = async () => ({ capturedFrames: 1, nativeTake: nativeProof })
    const host = globalThis.window?.dawDesktop?.audioHost
    Object.defineProperty(globalThis, "window", { configurable: true, value: { ...globalThis.window, dawDesktop: { audioHost: {
      ...host, recordingSpool: { release: async () => { calls.push("release"); await rm(source) } },
    } } } })
    try {
      await createRoot(async (dispose) => {
        await flushLifecycle(); expect(await harness.recording.startRecording(track.id)).toMatchObject({ ok: true })
        await harness.recording.stopRecording()
        expect(calls).not.toContain("release")
        expect(calls).toContain("wav")
        if (failure !== "wav" && failure !== "scope") expect(calls).toContain("asset")
        if (failure === "clip" || failure === "queued") expect(calls).toContain("clip")
        expect(await readFile(source)).toEqual(Buffer.from([1, 2, 3]))
        expect(notifications.some((message) => message.includes("native recording source remains retained"))).toBeTrue()
        if (failure === "queued" && projectKind === "shared") expect(notifications.some((message) => message.includes("queued"))).toBeTrue()
        dispose()
      })
    } finally { harness.restore(); await rm(directory, { recursive: true, force: true }) }
  }
})

test("M4 concurrent stop calls share one native Finish and one save; cleanup during save cannot erase context", async () => {
  for (const cleanupFails of [true, false]) {
    const directory = await mkdtemp("/private/tmp/daw-hook-save-")
    const source = `${directory}/native.pcm`; await writeFile(source, Uint8Array.of(1, 2, 3), { mode: 0o600 })
    const gate = Promise.withResolvers<void>(); const entered = Promise.withResolvers<void>()
    let encoded = 0; let assets = 0; let clips = 0; let releases = 0; let rollbacks = 0
    const notifications: string[] = []
    const finalization: NonNullable<Parameters<typeof useTrackRecording>[0]["finalization"]> = {
      storage: { ...createRecordingTempStorage(), open: async (sessionId) => ({ version: 1, sessionId,
        format: "planar-float32-blocks", sampleRate: 48000, channelCount: 1, capturedFrames: 1,
        byteLength: 8, createdAtMs: 1, finalizedAtMs: 2 }) },
      encodeWav: async () => {
        encoded++; entered.resolve(); await gate.promise
        return { file: new File([new Uint8Array(8)], "take.wav"), fileName: "take.wav", mimeType: "audio/wav", remove: async () => {} }
      },
      createLocalAsset: async () => { assets++; await writeFile(`${directory}/asset.wav`, Uint8Array.of(4, 5, 6)); return savedAsset() },
      createLocalAudioClip: async () => { clips++; await writeFile(`${directory}/clip.json`, JSON.stringify({ asset: "asset:saved" }));
        return { clipId: "clip:saved", clip: { name: "take", startSec: 0, duration: 1 / 48000, sourceAssetKey: "asset:saved" } } },
      deleteLocalAsset: async () => { rollbacks++ },
    }
    const harness = createHarness({ state: "ready", powerGeneration: 1 }, true, false, false, true, finalization,
      { notify: (message) => notifications.push(message) })
    harness.nativeController.stop = async () => { harness.calls.push("native-stop"); return { capturedFrames: 1, nativeTake: nativeProof } }
    const host = globalThis.window?.dawDesktop?.audioHost
    Object.defineProperty(globalThis, "window", { configurable: true, value: { ...globalThis.window, dawDesktop: { audioHost: {
      ...host, recordingSpool: { release: async () => {
        expect(await readFile(`${directory}/asset.wav`)).toEqual(Buffer.from([4, 5, 6]))
        expect(JSON.parse(await readFile(`${directory}/clip.json`, "utf8"))).toEqual({ asset: "asset:saved" })
        releases++
        if (cleanupFails) throw new Error("release unavailable")
        await rm(source)
      } },
    } } } })
    try {
      await createRoot(async (dispose) => {
        await flushLifecycle(); expect(await harness.recording.startRecording(track.id)).toMatchObject({ ok: true })
        const first = harness.recording.stopRecording(); const second = harness.recording.stopRecording()
        expect(second).toBe(first)
        await entered.promise
        expect(harness.calls.filter((call) => call === "native-stop")).toHaveLength(1)
        harness.emit({ state: "failed", powerGeneration: 2 }); await flushLifecycle()
        gate.resolve(); await Promise.all([first, second])
        expect(encoded).toBe(1); expect(assets).toBe(1); expect(clips).toBe(1); expect(releases).toBe(1); expect(rollbacks).toBe(0)
        if (cleanupFails) {
          expect(await readFile(source)).toEqual(Buffer.from([1, 2, 3]))
          expect(notifications.some((message) => message.includes("clip was saved"))).toBeTrue()
        } else {
          await expect(readFile(source)).rejects.toThrow("ENOENT")
          expect(notifications.some((message) => message.includes("remains retained"))).toBeFalse()
        }
        expect(notifications.some((message) => message.includes("could not be saved"))).toBeFalse()
        await harness.recording.stopRecording(); expect(clips).toBe(1)
        dispose()
      })
    } finally { gate.resolve(); harness.restore(); await rm(directory, { recursive: true, force: true }) }
  }
})


test("M1 exact zero native source releases without asset/clip creation or false retained notification", async () => {
  const directory = await mkdtemp("/private/tmp/daw-hook-zero-")
  const source = `${directory}/native.pcm`; await writeFile(source, new Uint8Array(), { mode: 0o600 })
  const notifications: string[] = []; let releases = 0
  const proof = { ...nativeProof, acknowledgment: { ...nativeProof.acknowledgment, frames: 0, bytes: 0, blocks: 0 } }
  const finalization: NonNullable<Parameters<typeof useTrackRecording>[0]["finalization"]> = {
    storage: { ...createRecordingTempStorage(), open: async (sessionId) => ({ version: 1, sessionId,
      format: "planar-float32-blocks", sampleRate: 48000, channelCount: 1, capturedFrames: 0,
      byteLength: 0, createdAtMs: 1, finalizedAtMs: 2 }) },
    encodeWav: async () => { throw new Error("zero take must never encode WAV") },
    createLocalAsset: async () => { throw new Error("zero take must never create asset") },
    createLocalAudioClip: async () => { throw new Error("zero take must never create clip") },
  }
  const harness = createHarness({ state: "ready", powerGeneration: 1 }, true, false, false, true, finalization,
    { notify: (message) => notifications.push(message) })
  harness.nativeController.stop = async () => ({ capturedFrames: 0, nativeTake: proof })
  const host = globalThis.window?.dawDesktop?.audioHost
  Object.defineProperty(globalThis, "window", { configurable: true, value: { ...globalThis.window, dawDesktop: { audioHost: {
    ...host, recordingSpool: { release: async (_scope: NativeRecordingScope, _take: string, receipt: NativeRecordingRelease) => {
      expect(receipt).toEqual({ ...proof.acknowledgment, savedClip: undefined })
      expect(await readFile(source)).toEqual(Buffer.alloc(0)); releases++; await rm(source)
    } },
  } } } })
  try {
    await createRoot(async (dispose) => {
      await flushLifecycle(); expect(await harness.recording.startRecording(track.id)).toMatchObject({ ok: true })
      await harness.recording.stopRecording(); expect(releases).toBe(1)
      expect(notifications).toContain("Recording contained no audio data.")
      expect(notifications.some((message) => message.includes("remains retained"))).toBeFalse()
      dispose()
    })
  } finally { harness.restore(); await rm(directory, { recursive: true, force: true }) }
})

test("a take whose target was removed is kept on a new track as one undoable entry, local and cloud", async () => {
  for (const projectKind of ["local", "shared"]) {
    let current: Track[] = [track]
    const keptTrack: Track = { id: "kept-track", kind: "audio", name: "Audio 2", volume: 1, clips: [] }
    const notifications: string[] = []
    const history: Array<{ type: string; data?: unknown }> = []
    const clipInputs: Array<{ trackId: string; startSec: number; skipHistory?: boolean; pushHistory?: boolean }> = []
    const saved = { clipId: "clip:saved", clip: { name: "take", startSec: 0, duration: 1 / 48000, sourceAssetKey: "asset:saved" } }
    const finalization: NonNullable<Parameters<typeof useTrackRecording>[0]["finalization"]> = {
      storage: { ...createRecordingTempStorage(), open: async (sessionId) => ({ version: 1, sessionId,
        format: "planar-float32-blocks", sampleRate: 48000, channelCount: 1, capturedFrames: 1,
        byteLength: 8, createdAtMs: 1, finalizedAtMs: 2 }) },
      encodeWav: async () => ({ file: new File([new Uint8Array(8)], "take.wav"), fileName: "take.wav", mimeType: "audio/wav", remove: async () => {} }),
      acquireTrackLock: async () => ({ ok: true }),
      releaseTrackLock: async () => undefined,
      createLocalAsset: async () => savedAsset(),
      createLocalAudioClip: async (input) => { clipInputs.push(input); return saved },
      createUploadedAudioClip: async (input) => { clipInputs.push(input); return saved },
    }
    const harness = createHarness({ state: "ready", powerGeneration: 1 }, true, false, false, true, finalization, {
      projectId: () => projectKind === "local" ? "project:test" : "cloud-project",
      userId: "test-user",
      tracks: () => current,
      notify: (message) => notifications.push(message),
      historyPush: (entry) => history.push(entry),
      createTrackForRecording: async () => { current = [keptTrack]; return keptTrack },
    })
    harness.nativeController.stop = async () => ({ capturedFrames: 1, nativeTake: nativeProof })
    const host = globalThis.window?.dawDesktop?.audioHost
    Object.defineProperty(globalThis, "window", { configurable: true, value: { ...globalThis.window, dawDesktop: { audioHost: {
      ...host, recordingSpool: { release: async () => undefined },
    } } } })
    try {
      await createRoot(async (dispose) => {
        await flushLifecycle(); expect(await harness.recording.startRecording(track.id)).toMatchObject({ ok: true })
        current = []
        await harness.recording.stopRecording()
        expect(clipInputs.map((input) => input.trackId)).toEqual(["kept-track"])
        expect(clipInputs[0]?.startSec).toBe(0)
        expect(notifications).toContain("The recording target was removed, so the take was kept on a new track.")
        expect(notifications).not.toContain("Recording target track missing; clip skipped.")
        expect(history).toHaveLength(1)
        expect(history[0]?.type).toBe("track-clip-create")
        dispose()
      })
    } finally { harness.restore() }
  }
})
