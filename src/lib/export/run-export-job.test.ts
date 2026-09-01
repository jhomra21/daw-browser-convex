import { expect, test } from "bun:test"
import "fake-indexeddb/auto"
import { createDefaultDrumRackParams } from "@daw-browser/shared"
import type { ExportFx } from "@daw-browser/audio-engine/export-mixdown"

import { createLocalProject, deleteLocalProject } from "~/lib/local-project-db"
import { createLocalAsset, deleteLocalAsset } from "~/lib/local-assets"
import { loadInstrumentExportBuffers, runStemExport, runTimelineExport } from "~/lib/export/run-export-job"
import { NativeOfflineRenderError } from "~/lib/export/desktop-native-offline-pcm-renderer"
import type { ExportOutputTargetFactory } from "~/lib/export/export-output-targets"
import type { ExportEncodingSettings, ExportRenderSettings } from "~/lib/export/export-settings"
import type { RuntimeTrack } from "~/lib/timeline-runtime-types"

const render: ExportRenderSettings = {
  sampleRate: 44_100,
  numberOfChannels: 2,
  normalization: { mode: "none" },
  tail: { mode: "none" },
}
const encoding: ExportEncodingSettings = {
  bitrateByFormat: {},
  wav: { codec: "pcm-s16", dither: "none" },
}
const renderStateSnapshot = {
  fx: { trackFx: {}, masterFxInstances: [], masterVolume: 1 },
  automationEnvelopes: [],
}
const desktopLimits: NonNullable<ExportOutputTargetFactory["resourceLimits"]> = {
  maximumFiles: 1_024,
  maximumBytes: 8 * 1024 * 1024 * 1024,
  streaming: true,
}

const outputTargets = (opened: () => void): ExportOutputTargetFactory => ({
  resourceLimits: desktopLimits,
  async createMixdownTarget() {
    opened()
    throw new Error("target should not open")
  },
  async createStemTarget() {
    opened()
    throw new Error("target should not open")
  },
})

const aliasLocalProject = async (source: Awaited<ReturnType<typeof createLocalProject>>, id: string) => {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("daw-browser-projects", 1)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  const transaction = db.transaction("projects", "readwrite")
  transaction.objectStore("projects").put({ ...source, id })
  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
  db.close()
}

test("mixdown preflight runs before output target creation and clip hydration", async () => {
  let targetOpened = false
  let bufferHydrated = false
  const outcome = await runTimelineExport({
    getTracks: () => [{
      id: "track-1",
      name: "Track",
      volume: 1,
      clips: [{
        id: "clip-1",
        name: "Clip",
        color: "#fff",
        startSec: 0,
        duration: 12_000,
        sampleUrl: "/sample.wav",
      }],
    }],
    bpm: 120,
    projectGeneration: 1,
    getProjectGeneration: () => 1,
    masterVolume: 1,
    range: { mode: "whole" },
    formats: ["mp3"],
    render: { ...render, sampleRate: 96_000 },
    encoding,
    projectId: "project:preflight",
    userId: "user-1",
    sidechainRoutes: [],
    loadCapturedClipBuffer: async () => {
      bufferHydrated = true
    },
    signal: new AbortController().signal,
    outputTargets: outputTargets(() => {
      targetOpened = true
    }),
    renderStateSnapshot,
  })

  expect(outcome.type).toBe("error")
  expect(targetOpened).toBeFalse()
  expect(bufferHydrated).toBeFalse()
})

test("stem export preloads local sampled instruments for a cloud-shaped local project", async () => {
  const originalStorage = Object.getOwnPropertyDescriptor(navigator, "storage")
  const originalOfflineAudioContext = Object.getOwnPropertyDescriptor(globalThis, "OfflineAudioContext")
  const originalFetch = globalThis.fetch
  const files = new Map<string, File>()
  const assets = {
    getFileHandle: async (name: string) => ({
      createWritable: async () => ({
        write: async (file: File) => {
          files.set(name, file)
        },
        close: async () => undefined,
        abort: async () => undefined,
      }),
      getFile: async () => {
        const file = files.get(name)
        if (!file) throw new Error(`Missing retained file ${name}`)
        return file
      },
    }),
  }
  const root = {
    getDirectoryHandle: async (name: string) => name === "assets" ? assets : root,
  }
  Object.defineProperty(navigator, "storage", {
    configurable: true,
    value: { getDirectory: async () => root },
  })
  Object.defineProperty(globalThis, "OfflineAudioContext", {
    configurable: true,
    value: TestOfflineAudioContext,
  })
  const fetchCalls: string[] = []
  TestOfflineAudioContext.decodeCalls = 0
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, _init?: RequestInit) => {
    fetchCalls.push(String(input))
    throw new Error("cloud-shaped local stem export must not fetch")
  }, { preconnect: originalFetch.preconnect })

  const sourceProject = await createLocalProject(`Stem ${crypto.randomUUID()}`)
  const projectId = `cloud-project-${crypto.randomUUID()}`
  await aliasLocalProject(sourceProject, projectId)
  const asset = await createLocalAsset({
    projectId,
    file: new File(["stem"], "sample.wav", { type: "audio/wav" }),
  })
  const drumRack = createDefaultDrumRackParams()
  const firstPad = drumRack.pads[0]
  if (!firstPad) throw new Error("Expected a default drum-rack pad.")

  try {
    const outcome = await runStemExport({
      getTracks: () => [{
        id: "track-stem",
        name: "Stem",
        volume: 1,
        clips: [{
          id: "clip-stem",
          name: "MIDI",
          color: "#fff",
          startSec: 0,
          duration: 1,
          midi: { wave: "sine", notes: [] },
        }],
      }],
      bpm: 120,
      projectGeneration: 1,
      getProjectGeneration: () => 1,
      masterVolume: 1,
      range: { mode: "whole" },
      formats: ["wav"],
      render,
      encoding,
      projectId,
      userId: "user-1",
      sidechainRoutes: [],
      loadCapturedClipBuffer: async () => undefined,
      signal: new AbortController().signal,
      outputTargets: {
        resourceLimits: desktopLimits,
        async createMixdownTarget() {
          throw new Error("unexpected mixdown target")
        },
        async createStemTarget() {
          return {
            openFile: async () => {
              throw new Error("render should fail before opening a stem file")
            },
          }
        },
      },
      renderStateSnapshot: {
        fx: {
          trackFx: {
            "track-stem": {
              instances: [],
              instrument: {
                kind: "drum-rack",
                instanceId: "instrument:stem",
                params: {
                  ...drumRack,
                  pads: [{
                    ...firstPad,
                    sample: {
                      assetKey: asset.id,
                      url: `local-asset:${asset.id}`,
                      sourceKind: "upload",
                      source: { durationSec: 1, sampleRate: 48_000, channelCount: 1 },
                    },
                  }, ...drumRack.pads.slice(1)],
                },
              },
            },
          },
          masterFxInstances: [],
          masterVolume: 1,
        },
        automationEnvelopes: [],
      },
      stemSelection: "all-tracks",
      stemMode: "dry-source",
    })

    expect(outcome.type).toBe("error")
    expect(fetchCalls).toEqual([])
    expect(TestOfflineAudioContext.decodeCalls).toBe(1)
  } finally {
    globalThis.fetch = originalFetch
    if (originalStorage) Object.defineProperty(navigator, "storage", originalStorage)
    else Reflect.deleteProperty(navigator, "storage")
    if (originalOfflineAudioContext) Object.defineProperty(globalThis, "OfflineAudioContext", originalOfflineAudioContext)
    else Reflect.deleteProperty(globalThis, "OfflineAudioContext")
    await deleteLocalProject(projectId)
    await deleteLocalProject(sourceProject.id)
  }
})

test("stem preflight uses the renderer stem selection before opening output", async () => {
  const tracks: RuntimeTrack[] = Array.from({ length: 1_025 }, (_, index) => ({
    id: `track-${index}`,
    name: `Track ${index}`,
    volume: 1,
    clips: [{
      id: `clip-${index}`,
      name: `Clip ${index}`,
      color: "#fff",
      startSec: 0,
      duration: 1,
      midi: { wave: "sine", notes: [] },
    }],
  }))
  let targetOpened = false
  const outcome = await runStemExport({
    getTracks: () => tracks,
    bpm: 120,
    projectGeneration: 1,
    getProjectGeneration: () => 1,
    masterVolume: 1,
    range: { mode: "whole" },
    formats: ["wav"],
    render,
    encoding,
    projectId: "project:preflight",
    userId: "user-1",
    sidechainRoutes: [],
    loadCapturedClipBuffer: async () => undefined,
    signal: new AbortController().signal,
    outputTargets: outputTargets(() => {
      targetOpened = true
    }),
    renderStateSnapshot,
    stemSelection: "all-tracks",
    stemMode: "dry-source",
  })

  expect(outcome).toEqual({
    type: "error",
    message: "Export produces more than 1024 output files.",
    outputs: [],
  })
  expect(targetOpened).toBeFalse()
})

test("instrument hydration settles as canceled when its sample fetch stalls", async () => {
  const audioContextDescriptor = Object.getOwnPropertyDescriptor(globalThis, "AudioContext")
  const fetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch")
  let notifyFetchStarted: (() => void) | undefined
  const fetchStarted = new Promise<void>((resolve) => {
    notifyFetchStarted = resolve
  })
  class ExportAudioContext {
    async decodeAudioData(_data: ArrayBuffer) {
      throw new Error("stalled fetch should not decode")
    }
    async close() {}
  }
  Object.defineProperty(globalThis, "AudioContext", {
    configurable: true,
    value: ExportAudioContext,
  })
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async () => {
      notifyFetchStarted?.()
      return await new Promise<Response>(() => undefined)
    },
  })
  const drumRack = createDefaultDrumRackParams()
  const firstPad = drumRack.pads[0]
  if (!firstPad) throw new Error("Expected a default drum-rack pad.")
  const controller = new AbortController()
  try {
    const outcome = runTimelineExport({
      getTracks: () => [{
        id: "track-instrument",
        name: "Instrument",
        volume: 1,
        clips: [{
          id: "clip-midi",
          name: "MIDI",
          color: "#fff",
          startSec: 0,
          duration: 1,
          midi: { wave: "sine", notes: [] },
        }],
      }],
      bpm: 120,
      projectGeneration: 1,
      getProjectGeneration: () => 1,
      masterVolume: 1,
      range: { mode: "whole" },
      formats: ["wav"],
      render,
      encoding,
      projectId: "project:instrument-cancel",
      userId: "user-1",
      sidechainRoutes: [],
      loadCapturedClipBuffer: async () => undefined,
      signal: controller.signal,
      outputTargets: {
        async createMixdownTarget() {
          return {
            openFile: async () => undefined,
            saveBuffer: async () => ({ destination: "cloud", name: "unused.wav", url: "https://example.test/unused.wav" }),
          }
        },
        async createStemTarget() {
          throw new Error("unexpected stem target")
        },
      },
      renderStateSnapshot: {
        fx: {
          trackFx: {
            "track-instrument": {
              instances: [],
              instrument: {
                kind: "drum-rack",
                instanceId: "instrument:stalled",
                params: {
                  ...drumRack,
                  pads: [{
                    ...firstPad,
                    sample: {
                      assetKey: "asset:stalled",
                      url: "https://samples.example/stalled.wav",
                      sourceKind: "url",
                      source: { durationSec: 1, sampleRate: 44_100, channelCount: 1 },
                    },
                  }, ...drumRack.pads.slice(1)],
                },
              },
            },
          },
          masterFxInstances: [],
          masterVolume: 1,
        },
        automationEnvelopes: [],
      },
    })
    await fetchStarted
    controller.abort()
    expect(await outcome).toEqual({ type: "canceled", outputs: [] })
  } finally {
    if (audioContextDescriptor) Object.defineProperty(globalThis, "AudioContext", audioContextDescriptor)
    else Reflect.deleteProperty(globalThis, "AudioContext")
    if (fetchDescriptor) Object.defineProperty(globalThis, "fetch", fetchDescriptor)
    else Reflect.deleteProperty(globalThis, "fetch")
  }
})

class TestDecodedAudioBuffer implements AudioBuffer {
  readonly duration: number
  readonly length: number
  readonly numberOfChannels: number
  readonly sampleRate: number
  private readonly channels: Float32Array<ArrayBuffer>[]

  constructor(length = 48_000, sampleRate = 48_000, numberOfChannels = 2) {
    this.length = length
    this.sampleRate = sampleRate
    this.numberOfChannels = numberOfChannels
    this.duration = length / sampleRate
    this.channels = Array.from(
      { length: numberOfChannels },
      () => new Float32Array(length),
    )
  }

  copyFromChannel(destination: Float32Array, channel: number, bufferOffset = 0) {
    destination.set(this.getChannelData(channel).subarray(bufferOffset, bufferOffset + destination.length))
  }

  copyToChannel(source: Float32Array, channel: number, bufferOffset = 0) {
    this.getChannelData(channel).set(source, bufferOffset)
  }

  getChannelData(channel: number) {
    const data = this.channels[channel]
    if (!data) throw new Error("Missing channel")
    return data
  }
}

class TestOfflineAudioContext {
  static decodeCalls = 0
  readonly sampleRate: number

  constructor(_channels: number, _length: number, sampleRate: number) {
    this.sampleRate = sampleRate
  }

  async decodeAudioData(_data: ArrayBuffer) {
    TestOfflineAudioContext.decodeCalls += 1
    return new TestDecodedAudioBuffer()
  }
}

test("instrument export preload reads local-asset bytes with the project context", async () => {
  const originalStorage = Object.getOwnPropertyDescriptor(navigator, "storage")
  const originalOfflineAudioContext = Object.getOwnPropertyDescriptor(globalThis, "OfflineAudioContext")
  const originalFetch = globalThis.fetch
  const files = new Map<string, File>()
  const assets = {
    getFileHandle: async (name: string) => ({
      createWritable: async () => ({
        write: async (file: File) => {
          files.set(name, file)
        },
        close: async () => undefined,
        abort: async () => undefined,
      }),
      getFile: async () => {
        const file = files.get(name)
        if (!file) throw new Error(`Missing retained file ${name}`)
        return file
      },
    }),
  }
  const root = {
    getDirectoryHandle: async (name: string) => name === "assets" ? assets : root,
  }
  Object.defineProperty(navigator, "storage", {
    configurable: true,
    value: { getDirectory: async () => root },
  })
  Object.defineProperty(globalThis, "OfflineAudioContext", {
    configurable: true,
    value: TestOfflineAudioContext,
  })
  const fetchCalls: string[] = []
  TestOfflineAudioContext.decodeCalls = 0
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, _init?: RequestInit) => {
    fetchCalls.push(String(input))
    return new Response("remote", { status: 200 })
  }, { preconnect: originalFetch.preconnect })

  const project = await createLocalProject(`Export ${crypto.randomUUID()}`)
  const file = new File(["retained"], "sample.wav", { type: "audio/wav" })
  const asset = await createLocalAsset({ projectId: project.id, file })
  const drumRack = createDefaultDrumRackParams()
  const firstPad = drumRack.pads[0]
  if (!firstPad) throw new Error("Expected a default drum-rack pad.")
  const instrumentKind = "drum-rack" as const
  const sampleSourceKind = "upload" as const
  const fx: ExportFx = {
    trackFx: {
      "track-local": {
        instances: [],
        instrument: {
          kind: instrumentKind,
          instanceId: "instrument-local",
          params: {
            ...drumRack,
            pads: [{
              ...firstPad,
              sample: {
                assetKey: asset.id,
                url: `local-asset:${asset.id}`,
                sourceKind: sampleSourceKind,
                source: { durationSec: 1, sampleRate: 48_000, channelCount: 2 },
              },
            }, ...drumRack.pads.slice(1)],
          },
        },
      },
    },
    masterFxInstances: [],
    masterVolume: 1,
  }

  try {
    await loadInstrumentExportBuffers(fx, new AbortController().signal, undefined, project.id)
    expect(fx.trackFx?.["track-local"]?.drumRackBuffers?.get(firstPad.id)).toBeInstanceOf(TestDecodedAudioBuffer)
    expect(fetchCalls).toEqual([])
    expect(TestOfflineAudioContext.decodeCalls).toBe(1)

    const entry = fx.trackFx?.["track-local"]
    if (!entry || entry.instrument?.kind !== "drum-rack") throw new Error("Expected the local drum-rack export entry.")
    const secondPad = entry.instrument.params.pads[1]
    if (!secondPad) throw new Error("Expected a second drum-rack pad.")
    const hydratedBuffer = new TestDecodedAudioBuffer()
    entry.instrument = {
      ...entry.instrument,
      params: {
        ...entry.instrument.params,
        pads: [{
          ...entry.instrument.params.pads[0],
          sample: {
            assetKey: asset.id,
            url: `local-asset:${asset.id}`,
            sourceKind: sampleSourceKind,
            source: { durationSec: 1, sampleRate: 48_000, channelCount: 2 },
          },
        }, {
          ...secondPad,
          sample: {
            assetKey: "asset:missing",
            url: "https://samples.example/missing.wav",
            sourceKind: "url",
            source: { durationSec: 1, sampleRate: 48_000, channelCount: 2 },
          },
        }, ...entry.instrument.params.pads.slice(2)],
      },
    }
    entry.drumRackBuffers = new Map([[firstPad.id, hydratedBuffer]])
    await deleteLocalAsset(project.id, asset.id)
    await loadInstrumentExportBuffers(fx, new AbortController().signal, undefined, project.id)
    expect(entry.drumRackBuffers?.get(firstPad.id)).toBe(hydratedBuffer)
    expect(entry.drumRackBuffers?.get(secondPad.id)).toBeInstanceOf(TestDecodedAudioBuffer)
    expect(fetchCalls).toEqual(["https://samples.example/missing.wav"])
    expect(TestOfflineAudioContext.decodeCalls).toBe(2)

    let nativeAssetCount = 0
    const nativeOutcome = await runTimelineExport({
      nativeRendererRequired: true,
      getTracks: () => [{
        id: "track-local",
        name: "Local instrument",
        volume: 1,
        kind: "instrument",
        clips: [{
          id: "clip-local",
          name: "Audio",
          color: "#fff",
          startSec: 0,
          duration: 1,
          sourceAssetKey: "asset:captured-clip",
          buffer: hydratedBuffer,
        }],
      }],
      bpm: 120,
      projectGeneration: 1,
      getProjectGeneration: () => 1,
      masterVolume: 1,
      range: { mode: "whole" },
      formats: ["wav"],
      render,
      encoding,
      projectId: project.id,
      userId: "user-1",
      sidechainRoutes: [],
      loadCapturedClipBuffer: async () => undefined,
      signal: new AbortController().signal,
      outputTargets: {
        resourceLimits: desktopLimits,
        async createMixdownTarget() {
          return {
            openFile: async () => undefined,
            saveBuffer: async () => ({ destination: "local", name: "unused.wav" }),
          }
        },
        async createStemTarget() {
          throw new Error("unexpected stem target")
        },
      },
      renderStateSnapshot: {
        fx,
        automationEnvelopes: [],
      },
      nativeOfflinePcmRenderer: async (plan) => {
        nativeAssetCount = plan.assets.length
        throw new NativeOfflineRenderError("render reached with the captured sampled buffer")
      },
    })
    expect(nativeOutcome).toEqual({
      type: "error",
      message: "render reached with the captured sampled buffer",
      failureOwner: "native",
      outputs: [],
    })
    expect(nativeAssetCount).toBeGreaterThan(0)
    expect(fetchCalls).toEqual(["https://samples.example/missing.wav"])
    expect(TestOfflineAudioContext.decodeCalls).toBe(2)
  } finally {
    globalThis.fetch = originalFetch
    if (originalStorage) Object.defineProperty(navigator, "storage", originalStorage)
    else Reflect.deleteProperty(navigator, "storage")
    if (originalOfflineAudioContext) Object.defineProperty(globalThis, "OfflineAudioContext", originalOfflineAudioContext)
    else Reflect.deleteProperty(globalThis, "OfflineAudioContext")
    await deleteLocalProject(project.id)
  }
})

test("native export prepares Stretch after hydration and normalizes its PCM", async () => {
  const originalAudioBuffer = Object.getOwnPropertyDescriptor(globalThis, "AudioBuffer")
  let preparedAsset: {
    sampleRateHz: number
    frameCount: number
    planarPcm: Uint8Array
  } | undefined
  const source = new TestDecodedAudioBuffer()
  try {
    const outcome = await runTimelineExport({
      nativeRendererRequired: true,
      getTracks: () => [{
        id: "track-stretch",
        name: "Stretch",
        volume: 1,
        clips: [{
          id: "clip-stretch",
          name: "Stretch clip",
          color: "#fff",
          startSec: 0,
          duration: 1,
          sourceAssetKey: "asset:stretch",
          audioWarp: { enabled: true, mode: "stretch", sourceBpm: 120 },
          buffer: source,
        }],
      }],
      bpm: 120,
      projectGeneration: 7,
      getProjectGeneration: () => 7,
      masterVolume: 1,
      range: { mode: "whole" },
      formats: ["wav"],
      render,
      encoding,
      projectId: undefined,
      userId: undefined,
      sidechainRoutes: [],
      loadCapturedClipBuffer: async () => undefined,
      signal: new AbortController().signal,
      outputTargets: {
        resourceLimits: desktopLimits,
        async createMixdownTarget() {
          return {
            openFile: async () => undefined,
            saveBuffer: async () => ({ destination: "local", name: "unused.wav" }),
          }
        },
        async createStemTarget() {
          throw new Error("unexpected stem target")
        },
      },
      renderStateSnapshot,
      createBuffer: (channels, frames, sampleRate) => new TestDecodedAudioBuffer(frames, sampleRate, channels),
      nativeOfflinePcmRenderer: async (plan) => {
        const asset = plan.assets[0]
        if (asset) {
          preparedAsset = {
            sampleRateHz: asset.sampleRateHz,
            frameCount: asset.frameCount,
            planarPcm: asset.planarPcm,
          }
        }
        throw new NativeOfflineRenderError("stop after native Stretch planning")
      },
    })

    expect(outcome).toEqual({
      type: "error",
      message: "stop after native Stretch planning",
      failureOwner: "native",
      outputs: [],
    })
    expect(preparedAsset?.sampleRateHz).toBe(render.sampleRate)
    expect(preparedAsset?.frameCount).toBe(render.sampleRate)
    expect(preparedAsset?.planarPcm.byteLength).toBe(render.sampleRate * 2 * Float32Array.BYTES_PER_ELEMENT)
  } finally {
    if (originalAudioBuffer) Object.defineProperty(globalThis, "AudioBuffer", originalAudioBuffer)
    else Reflect.deleteProperty(globalThis, "AudioBuffer")
  }
})

test("native Stretch preparation hydrates first and surfaces structured diagnostics", async () => {
  const source = new TestDecodedAudioBuffer(48_000, 48_000, 3)
  const clip: RuntimeTrack["clips"][number] = {
    id: "clip-stretch-diagnostic",
    name: "Stretch clip",
    color: "#fff",
    startSec: 0,
    duration: 1,
    sourceAssetKey: "asset:stretch",
    audioWarp: { enabled: true, mode: "stretch", sourceBpm: 120 },
  }
  let hydrated = false
  let opened = false
  const outcome = await runTimelineExport({
    nativeRendererRequired: true,
    getTracks: () => [{
      id: "track-stretch-diagnostic",
      name: "Stretch",
      volume: 1,
      clips: [clip],
    }],
    bpm: 120,
    projectGeneration: 7,
    getProjectGeneration: () => 7,
    masterVolume: 1,
    range: { mode: "whole" },
    formats: ["wav"],
    render,
    encoding,
    projectId: undefined,
    userId: undefined,
    sidechainRoutes: [],
    loadCapturedClipBuffer: async (capturedClip) => {
      capturedClip.buffer = source
      hydrated = true
    },
    signal: new AbortController().signal,
    outputTargets: {
      resourceLimits: desktopLimits,
      async createMixdownTarget() {
        opened = true
        return {
          openFile: async () => undefined,
          saveBuffer: async () => ({ destination: "local", name: "unused.wav" }),
        }
      },
      async createStemTarget() {
        throw new Error("unexpected stem target")
      },
    },
    renderStateSnapshot,
    createBuffer: (channels, frames, sampleRate) => new TestDecodedAudioBuffer(frames, sampleRate, channels),
    nativeOfflinePcmRenderer: async () => {
      throw new Error("native renderer should not run")
    },
  })

  expect(hydrated).toBe(true)
  expect(opened).toBe(false)
  expect(outcome).toMatchObject({
    type: "error",
    message: "clip-stretch-diagnostic: Stretch source audio must be mono or stereo.",
  })
})

test("native custom-range export ignores out-of-range Stretch preparation", async () => {
  const source = new TestDecodedAudioBuffer(48_000, 48_000, 2)
  let hydrated = false
  const outcome = await runTimelineExport({
    nativeRendererRequired: true,
    getTracks: () => [{
      id: "track-stretch-range",
      name: "Stretch range",
      volume: 1,
      clips: [{
        id: "clip-stretch-in-range",
        name: "In range",
        color: "#fff",
        startSec: 0,
        duration: 1,
        sourceAssetKey: "asset:in-range",
        audioWarp: { enabled: true, mode: "stretch", sourceBpm: 120 },
        buffer: source,
      }, {
        id: "clip-stretch-out-of-range",
        name: "Out of range",
        color: "#fff",
        startSec: 2,
        duration: 1,
        sourceAssetKey: "asset:out-of-range",
        audioWarp: { enabled: true, mode: "stretch", sourceBpm: 120 },
      }],
    }],
    bpm: 120,
    projectGeneration: 7,
    getProjectGeneration: () => 7,
    masterVolume: 1,
    range: { mode: "custom", startSec: 0, endSec: 1 },
    formats: ["wav"],
    render,
    encoding,
    projectId: undefined,
    userId: undefined,
    sidechainRoutes: [],
    loadCapturedClipBuffer: async (clip) => {
      hydrated = true
      clip.buffer = source
    },
    signal: new AbortController().signal,
    outputTargets: {
      resourceLimits: desktopLimits,
      async createMixdownTarget() {
        return {
          openFile: async () => undefined,
          saveBuffer: async () => ({ destination: "local", name: "unused.wav" }),
        }
      },
      async createStemTarget() {
        throw new Error("unexpected output target")
      },
    },
    renderStateSnapshot,
    createBuffer: (channels, frames, sampleRate) => new TestDecodedAudioBuffer(frames, sampleRate, channels),
    nativeOfflinePcmRenderer: async () => {
      throw new NativeOfflineRenderError("stop after native custom-range planning")
    },
  })

  expect(hydrated).toBeFalse()
  expect(outcome).toEqual({
    type: "error",
    message: "stop after native custom-range planning",
    failureOwner: "native",
    outputs: [],
  })
})

test("native export rejects a stale project generation after Stretch preparation", async () => {
  const source = new TestDecodedAudioBuffer(48_000, 48_000, 2)
  let generation = 7
  const outcome = await runTimelineExport({
    nativeRendererRequired: true,
    getTracks: () => [{
      id: "track-stretch-stale",
      name: "Stretch",
      volume: 1,
      clips: [{
        id: "clip-stretch-stale",
        name: "Stretch clip",
        color: "#fff",
        startSec: 0,
        duration: 1,
        sourceAssetKey: "asset:stretch",
        audioWarp: { enabled: true, mode: "stretch", sourceBpm: 120 },
        buffer: source,
      }],
    }],
    bpm: 120,
    projectGeneration: 7,
    getProjectGeneration: () => generation,
    masterVolume: 1,
    range: { mode: "whole" },
    formats: ["wav"],
    render: { ...render, sampleRate: 44_100 },
    encoding,
    projectId: undefined,
    userId: undefined,
    sidechainRoutes: [],
    loadCapturedClipBuffer: async () => undefined,
    signal: new AbortController().signal,
    outputTargets: {
      resourceLimits: desktopLimits,
      async createMixdownTarget() {
        throw new Error("unexpected output target")
      },
      async createStemTarget() {
        throw new Error("unexpected stem target")
      },
    },
    renderStateSnapshot,
    createBuffer: (channels, frames, sampleRate) => {
      generation = 8
      return new TestDecodedAudioBuffer(frames, sampleRate, channels)
    },
    nativeOfflinePcmRenderer: async () => {
      throw new Error("native renderer should not run")
    },
  })

  expect(outcome).toEqual({
    type: "error",
    message: "Project changed while preparing export.",
    outputs: [],
  })
})
