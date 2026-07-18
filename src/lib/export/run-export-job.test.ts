import { expect, test } from "bun:test"
import { createDefaultDrumRackParams } from "@daw-browser/shared"

import { runStemExport, runTimelineExport } from "~/lib/export/run-export-job"
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
