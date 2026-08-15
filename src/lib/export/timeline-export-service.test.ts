import "fake-indexeddb/auto"
import { expect, test } from "bun:test"
import { untrack } from "solid-js"
import { createMutable, createStore } from "solid-js/store"
import {
  AUDIO_EFFECT_CONTRACTS,
  automationTargetKey,
  createDefaultArpeggiatorParams,
  createDefaultSamplerParams,
  createDefaultSynthParams,
  resolveClipSampleUrl,
  type AutomationEnvelope,
  type AutomationTarget,
  type TrackInstrumentParams,
} from "@daw-browser/shared"
import type { ExportFx } from "@daw-browser/audio-engine/export-mixdown"

import { createExportQueue } from "~/lib/export/export-queue"
import type { ExportOutputTargetFactory } from "~/lib/export/export-output-targets"
import { createExportRenderStateSnapshot, type ExportRenderStateSnapshot } from "~/lib/export/run-export-job"
import { createTimelineExportService, type TimelineExportInput } from "~/lib/export/timeline-export-service"
import { createCapturedClipMediaLoader } from "~/hooks/useClipBuffers"
import { setLocalAutomationEnvelope } from "~/lib/local-automation"
import { setLocalEffect, setLocalEffectInstance } from "~/lib/local-effects"
import { setLocalExternalProcessor } from "~/lib/external-plugins"
import { importLocalProject, LOCAL_PROJECT_SCHEMA_VERSION } from "~/lib/local-project-db"
import { registerPendingLocalProjectWriteFlusher } from "~/lib/local-project-pending-writes"
import type { RuntimeTrack } from "~/lib/timeline-runtime-types"
import { externalProcessorSchema } from "@daw-browser/external-plugins"
import { nativeAudioHostMaximumInMemoryPcmBytes } from "@daw-browser/desktop-protocol/native-audio-host"

const settings: TimelineExportInput = {
  range: { mode: "whole" },
  formats: ["wav"],
  render: {
    sampleRate: 44_100,
    numberOfChannels: 2,
    normalization: { mode: "none" },
    tail: { mode: "none" },
  },
  encoding: {
    bitrateByFormat: {},
    wav: { codec: "pcm-s16", dither: "none" },
  },
}

const createExternalProcessor = () => externalProcessorSchema.parse({
  instanceId: 'a7a0b9ac-7884-492c-8b68-80f15802442c',
  targetId: 'track-1',
  index: 0,
  manifest: {
    identity: {
      format: 'vst3',
      classId: 'class-1',
      vendor: 'Vendor',
      name: 'Plugin',
      version: '1',
      architecture: 'arm64',
      discoveredPath: '/Plugins/Plugin.vst3',
      binaryFingerprint: 'a'.repeat(64),
    },
    role: 'effect',
    audioInputs: [],
    audioOutputs: [{ name: 'main', channels: 2, enabled: true }],
    sidechainInputs: [],
    parameters: [],
    latencyFrames: 0,
    tailFrames: 0,
    supportsBypass: true,
    supportsEditor: false,
    supportsState: false,
  },
  parameterOverrides: {},
  latencyFrames: 0,
  tailFrames: 0,
  bypassed: false,
  health: { state: 'ready', updatedAt: 1 },
  updatedAt: 1,
})

class TestAudioBuffer implements AudioBuffer {
  readonly duration = 0.001
  readonly length = 44
  readonly numberOfChannels = 2
  readonly sampleRate = 44_100
  copyFromChannel(destination: Float32Array, _channelNumber: number, _bufferOffset?: number) {
    destination.fill(0)
  }
  copyToChannel(_source: Float32Array, _channelNumber: number, _bufferOffset?: number) {}
  getChannelData(_channel: number) {
    return new Float32Array(this.length)
  }
}

test("local export snapshot flushes pending writes and remains submission-consistent", async () => {
  const projectId = "project:export-snapshot"
  const trackId = "track:export-snapshot"
  const target: AutomationTarget = { kind: "track", trackId }
  const envelope = (id: string, value: number, updatedAt: number): AutomationEnvelope => ({
    id,
    projectId,
    target,
    targetKey: automationTargetKey(target, "volume"),
    parameterId: "volume",
    enabled: true,
    points: [{ id: `${id}-point`, timeSec: 0, value, interpolation: "linear" }],
    updatedAt,
  })
  const utilityParams = (gainDb: number) => {
    const defaults = AUDIO_EFFECT_CONTRACTS.utility.createDefaultParams()
    return { ...defaults, state: { ...defaults.state, gainDb } }
  }
  const unregister = registerPendingLocalProjectWriteFlusher("effects", projectId, async () => {
    await Promise.all([
      setLocalEffectInstance(projectId, trackId, "utility", utilityParams(3), { instanceId: "utility-1" }),
      setLocalAutomationEnvelope(projectId, envelope("submission", 0.25, 1)),
    ])
  })

  const snapshot = await createExportRenderStateSnapshot({
    projectId,
    userId: "user-1",
    masterVolume: 0.75,
    cloudRows: undefined,
  })
  unregister()
  await Promise.all([
    setLocalEffectInstance(projectId, trackId, "utility", utilityParams(9), { instanceId: "utility-1" }),
    setLocalAutomationEnvelope(projectId, envelope("live", 0.9, 2)),
  ])

  expect(snapshot.fx.masterVolume).toBe(0.75)
  expect(snapshot.fx.trackFx?.[trackId]?.instances).toEqual([
    expect.objectContaining({
      id: "utility-1",
      kind: "utility",
      params: expect.objectContaining({ state: expect.objectContaining({ gainDb: 3 }) }),
    }),
  ])
  expect(snapshot.automationEnvelopes).toEqual([
    expect.objectContaining({
      id: "submission",
      points: [expect.objectContaining({ value: 0.25 })],
    }),
  ])
})

test('blocks export for a restored cloud project with a persisted live external plugin', async () => {
  const projectId = `cloud-project-${crypto.randomUUID()}`
  await importLocalProject({
    id: projectId,
    name: 'Restored cloud project',
    schemaVersion: LOCAL_PROJECT_SCHEMA_VERSION,
    mode: 'backup',
    storageKind: 'opfs',
    createdAt: 1,
    updatedAt: 1,
    lastOpenedAt: 1,
  }, {
    entities: [],
    assets: [],
    projectState: [],
    syncState: [],
  })
  await setLocalExternalProcessor(projectId, createExternalProcessor())

  await expect(createExportRenderStateSnapshot({
    projectId,
    userId: 'user-1',
    masterVolume: 1,
    cloudRows: undefined,
  })).rejects.toThrow('must be frozen or bypassed')
})

test('allows native playback snapshots to retain live external plugins', async () => {
  const projectId = `native-project-${crypto.randomUUID()}`
  await importLocalProject({
    id: projectId,
    name: 'Native playback project',
    schemaVersion: LOCAL_PROJECT_SCHEMA_VERSION,
    mode: 'backup',
    storageKind: 'opfs',
    createdAt: 1,
    updatedAt: 1,
    lastOpenedAt: 1,
  }, {
    entities: [],
    assets: [],
    projectState: [],
    syncState: [],
  })
  await setLocalExternalProcessor(projectId, createExternalProcessor())

  const snapshot = await createExportRenderStateSnapshot({
    projectId,
    userId: 'user-1',
    masterVolume: 1,
    cloudRows: undefined,
    externalPluginPolicy: 'native-playback',
  })

  expect(snapshot.fx.masterVolume).toBe(1)
})

test("persisted devices and automation survive absent and intentionally empty audio projections", async () => {
  const projectId = "project:export-projection-merge"
  const ownedTrackId = "track:owned"
  const unvisitedTrackId = "track:unvisited"
  const instrument: TrackInstrumentParams = {
    kind: "synth",
    instanceId: "instrument:unvisited",
    params: createDefaultSynthParams(),
  }
  const arp = createDefaultArpeggiatorParams()
  const target: AutomationTarget = { kind: "track", trackId: unvisitedTrackId }
  const envelope: AutomationEnvelope = {
    id: "automation:unvisited",
    projectId,
    target,
    targetKey: automationTargetKey(target, "volume"),
    parameterId: "volume",
    enabled: true,
    points: [],
    updatedAt: 1,
  }
  await Promise.all([
    setLocalEffectInstance(projectId, ownedTrackId, "utility", AUDIO_EFFECT_CONTRACTS.utility.createDefaultParams(), { instanceId: "utility:owned" }),
    setLocalEffectInstance(projectId, unvisitedTrackId, "delay", AUDIO_EFFECT_CONTRACTS.delay.createDefaultParams(), { instanceId: "delay:unvisited" }),
    setLocalEffect(projectId, unvisitedTrackId, "instrument", instrument),
    setLocalEffect(projectId, unvisitedTrackId, "arp", arp),
    setLocalAutomationEnvelope(projectId, envelope),
  ])

  const persisted = await createExportRenderStateSnapshot({
    projectId,
    userId: "user-1",
    masterVolume: 1,
    cloudRows: undefined,
  })
  expect(persisted.fx.trackFx?.[unvisitedTrackId]?.instances).toEqual([
    expect.objectContaining({ id: "delay:unvisited", kind: "delay" }),
  ])
  expect(persisted.fx.trackFx?.[unvisitedTrackId]?.instrument).toEqual(instrument)
  expect(persisted.fx.trackFx?.[unvisitedTrackId]?.arp).toEqual(arp)
  expect(persisted.automationEnvelopes).toEqual([expect.objectContaining({ id: envelope.id })])

  const projected = await createExportRenderStateSnapshot({
    projectId,
    userId: "user-1",
    masterVolume: 1,
    cloudRows: undefined,
    effectsProjection: {
      replaceAudioEffectTargets: [{ targetId: ownedTrackId, rows: [] }],
      upsertDeviceRows: [],
    },
    automationPatches: [],
  })
  expect(projected.fx.trackFx?.[ownedTrackId]?.instances).toEqual([])
  expect(projected.fx.trackFx?.[unvisitedTrackId]?.instances).toEqual([
    expect.objectContaining({ id: "delay:unvisited", kind: "delay" }),
  ])
  expect(projected.fx.trackFx?.[unvisitedTrackId]?.instrument).toEqual(instrument)
  expect(projected.fx.trackFx?.[unvisitedTrackId]?.arp).toEqual(arp)
  expect(projected.automationEnvelopes).toEqual([expect.objectContaining({ id: envelope.id })])

  const patchedAutomation = await createExportRenderStateSnapshot({
    projectId,
    userId: "user-1",
    masterVolume: 1,
    cloudRows: undefined,
    automationPatches: [{ targetKey: envelope.targetKey, envelope: undefined }],
  })
  expect(patchedAutomation.automationEnvelopes).toEqual([])
})

test("normalizes projected Solid EQ params at the export snapshot boundary", async () => {
  const defaults = AUDIO_EFFECT_CONTRACTS.eq.createDefaultParams()
  const [projectedEq] = createStore({
    ...defaults,
    bands: defaults.bands.map((band) => ({
      ...band,
      onChange: () => undefined,
    })),
  })
  const snapshot = await createExportRenderStateSnapshot({
    projectId: "cloud-project-solid-eq",
    userId: "user-1",
    masterVolume: 1,
    cloudRows: { effects: [], automationEnvelopes: [] },
    effectsProjection: {
      replaceAudioEffectTargets: [{
        targetId: "track-solid-eq",
        rows: [{
          targetId: "track-solid-eq",
          effect: "eq",
          instanceId: "eq-solid",
          index: 0,
          params: projectedEq,
        }],
      }],
      upsertDeviceRows: [],
    },
  })

  expect(snapshot.fx.trackFx?.["track-solid-eq"]?.instances[0]?.params).toEqual(defaults)
  expect(() => structuredClone(snapshot.fx)).not.toThrow()
})

test("detaches Solid-wrapped local runtime domains before export submission", async () => {
  const defaults = AUDIO_EFFECT_CONTRACTS.eq.createDefaultParams()
  const [tracks] = createStore([{
    id: "track-solid-runtime",
    name: "Solid runtime track",
    volume: 1,
    clips: [{
      id: "clip-solid-runtime",
      name: "Solid runtime clip",
      color: "#fff",
      startSec: 0,
      duration: 1,
      fades: {
        fadeInSec: 0,
        fadeOutSec: 0,
        fadeInCurve: 0,
        fadeOutCurve: 0,
        onChange: () => undefined,
      },
    }],
  }])
  const [projectedEq] = createStore({
    ...defaults,
    bands: defaults.bands.map((band) => ({
      ...band,
      onChange: () => undefined,
    })),
  })
  const routes = createMutable([{
    sourceTrackId: "track-solid-runtime",
    targetTrackId: "track-solid-runtime",
    effectInstanceId: "eq-solid-runtime",
  }])
  const automation = createMutable([{
    targetKey: "track:solid-runtime",
    envelope: {
      id: "automation-solid-runtime",
      projectId: "cloud-solid-runtime",
      target: { kind: "track", trackId: "track-solid-runtime" },
      targetKey: "track:solid-runtime",
      parameterId: "volume",
      enabled: true,
      points: [{
        id: "point-solid-runtime",
        timeSec: 0,
        value: 1,
        interpolation: "linear",
      }],
      updatedAt: 1,
      onChange: () => undefined,
    } satisfies AutomationEnvelope & { onChange: () => void },
  }])
  const [exportSettings] = createStore({
    ...settings,
    render: {
      ...settings.render,
      onChange: () => undefined,
    },
  })
  const clip = untrack(() => tracks[0]?.clips[0])
  if (!clip?.fades) throw new Error("Expected the reactive clip fades.")
  expect(() => structuredClone(projectedEq)).toThrow()
  expect(() => structuredClone(clip.fades)).toThrow()
  expect(() => structuredClone(exportSettings)).toThrow()

  const queue = createExportQueue(() => "job-solid-runtime")
  const service = createTimelineExportService({
    queue,
    getTracks: () => tracks,
    getBpm: () => 120,
    getMasterVolume: () => 1,
    getProjectId: () => "cloud-solid-runtime",
    getUserId: () => "user-1",
    getCloudRenderRows: () => createMutable({ effects: [], automationEnvelopes: [] }),
    getAutomationPatches: () => automation,
    getEffectsExportSnapshot: () => ({
      snapshotEffectsProjection: () => ({
        replaceAudioEffectTargets: [{
          targetId: "track-solid-runtime",
          rows: [{
            targetId: "track-solid-runtime",
            effect: "eq",
            instanceId: "eq-solid-runtime",
            index: 0,
            params: projectedEq,
          }],
        }],
        upsertDeviceRows: [],
      }),
      snapshotSidechainRoutes: () => routes,
      flushPending: async () => undefined,
    }),
    getSidechainRoutes: () => routes,
    loadCapturedClipBuffer: async () => ({ status: "missing" }),
  })

  const prepared = await service.prepareTimelineExport(exportSettings)
  expect(() => structuredClone(prepared.snapshot.settings)).not.toThrow()
  expect(() => structuredClone(prepared.snapshot.tracks)).not.toThrow()
  expect(() => structuredClone(prepared.snapshot.sidechainRoutes)).not.toThrow()
  expect(() => structuredClone(prepared.snapshot.renderStateSnapshot)).not.toThrow()
  expect(prepared.snapshot.tracks[0]?.clips[0]?.fades).toEqual({
    fadeInSec: 0,
    fadeOutSec: 0,
    fadeInCurve: 0,
    fadeOutCurve: 0,
  })
  expect(prepared.snapshot.renderStateSnapshot.fx.trackFx?.["track-solid-runtime"]?.instances[0]?.params).toEqual(defaults)
  queue.dispose()
})

test("uses one hydrated sampled render state for native planning and queued rendering", async () => {
  const trackId = "track-hydrated-sampler"
  const buffer = new TestAudioBuffer()
  const instrument: TrackInstrumentParams = {
    kind: "sampler",
    instanceId: "sampler-hydrated",
    params: createDefaultSamplerParams(),
  }
  let hydrationCalls = 0
  let nativeRenderState: ExportRenderStateSnapshot | undefined
  let queuedRenderState: ExportRenderStateSnapshot | undefined
  const queue = createExportQueue(() => "job-hydrated-sampler")
  const service = createTimelineExportService({
    queue,
    nativeRendererRequired: true,
    nativeOfflineRenderer: async () => buffer,
    runTimelineExport: async (input) => {
      queuedRenderState = input.renderStateSnapshot
      return { type: "success", outputs: [] }
    },
    getTracks: () => [{
      id: trackId,
      name: "Hydrated sampler",
      volume: 1,
      clips: [],
    }],
    getBpm: () => 120,
    getMasterVolume: () => 1,
    getProjectId: () => "project:hydrated-sampler",
    getUserId: () => "user-1",
    getCloudRenderRows: () => undefined,
    getAutomationPatches: () => [],
    getEffectsExportSnapshot: () => ({
      snapshotEffectsProjection: () => ({
        replaceAudioEffectTargets: [],
        upsertDeviceRows: [],
      }),
      snapshotSidechainRoutes: () => [],
      flushPending: async () => undefined,
      hydrateInstrumentBuffers: (snapshot) => {
        hydrationCalls += 1
        const trackFx = snapshot.fx.trackFx ?? {}
        const existing = trackFx[trackId] ?? { instances: [] }
        return {
          ...snapshot,
          fx: {
            ...snapshot.fx,
            trackFx: {
              ...trackFx,
              [trackId]: {
                ...existing,
                instrument,
                samplerBuffers: new Map([["zone-hydrated", buffer]]),
              },
            },
          },
        }
      },
    }),
    getSidechainRoutes: () => [],
    getNativeOfflineExternalAttachments: async ({ renderState }) => {
      nativeRenderState = renderState
      return undefined
    },
    loadCapturedClipBuffer: async () => ({ status: "missing" }),
  })

  const prepared = await service.prepareTimelineExport(settings)
  const preparedBuffers = prepared.snapshot.renderStateSnapshot.fx.trackFx?.[trackId]?.samplerBuffers
  expect(hydrationCalls).toBe(1)
  expect(preparedBuffers?.get("zone-hydrated")).toBe(buffer)
  expect(nativeRenderState).toBe(prepared.snapshot.renderStateSnapshot)

  const submitted = service.submitPreparedTimelineExport(prepared, {
    async createMixdownTarget() {
      return {
        openFile: async () => undefined,
        saveBuffer: async () => ({ destination: "local", name: "hydrated.wav" }),
      }
    },
    async createStemTarget() {
      throw new Error("unexpected stem target")
    },
  })
  expect((await submitted.completion).type).toBe("success")
  expect(queuedRenderState).toBe(prepared.snapshot.renderStateSnapshot)
  expect(queuedRenderState?.fx.trackFx?.[trackId]?.samplerBuffers?.get("zone-hydrated")).toBe(buffer)
  expect(hydrationCalls).toBe(1)
  queue.dispose()
})

test("snapshot failure rejects before queue insertion or output target creation", async () => {
  const queue = createExportQueue(() => "job-1")
  let targetCreated = false
  const outputTargets: ExportOutputTargetFactory = {
    async createMixdownTarget() {
      targetCreated = true
      throw new Error("target should not be created")
    },
    async createStemTarget() {
      targetCreated = true
      throw new Error("target should not be created")
    },
  }
  const service = createTimelineExportService({
    queue,
    getTracks: () => [],
    getBpm: () => 120,
    getMasterVolume: () => 1,
    getProjectId: () => "cloud-project",
    getUserId: () => "user-1",
    getCloudRenderRows: () => undefined,
    getAutomationPatches: () => [],
    getEffectsExportSnapshot: () => undefined,
    getSidechainRoutes: () => [],
    loadCapturedClipBuffer: async () => ({ status: "missing" }),
  })

  await expect(service.submitTimelineExport(settings, outputTargets)).rejects.toThrow(
    "Cloud timeline snapshot is unavailable.",
  )
  expect(queue.activeJob()).toBeUndefined()
  expect(service.status()).toBeUndefined()
  expect(targetCreated).toBeFalse()
  queue.dispose()
})

test("native desktop export rejects unavailable mixdown and unsupported stems before snapshot work", async () => {
  const queue = createExportQueue(() => "native-export")
  let trackReads = 0
  let effectsReads = 0
  let outputTargetCreates = 0
  const outputTargets: ExportOutputTargetFactory = {
    async createMixdownTarget() {
      outputTargetCreates += 1
      throw new Error("native export must not create a mixdown target")
    },
    async createStemTarget() {
      outputTargetCreates += 1
      throw new Error("native export must not create a stem target")
    },
  }
  const service = createTimelineExportService({
    queue,
    nativeRendererRequired: true,
    getTracks: () => {
      trackReads += 1
      return []
    },
    getBpm: () => 120,
    getMasterVolume: () => 1,
    getProjectId: () => "cloud-project",
    getUserId: () => "user-1",
    getCloudRenderRows: () => undefined,
    getAutomationPatches: () => [],
    getEffectsExportSnapshot: () => {
      effectsReads += 1
      return undefined
    },
    getSidechainRoutes: () => [],
    loadCapturedClipBuffer: async () => ({ status: "missing" }),
  })

  await expect(service.enqueueTimelineExport(settings, outputTargets)).rejects.toThrow(
    "Native desktop export is unavailable until native offline rendering is implemented.",
  )
  await expect(service.enqueueStemExport({
    ...settings,
    stemSelection: "all-tracks",
    stemMode: "full-master-contribution",
  }, outputTargets)).rejects.toThrow(
    "Native desktop stems are unavailable in Phase A; choose Main mixdown.",
  )
  expect(trackReads).toBe(0)
  expect(effectsReads).toBe(0)
  expect(outputTargetCreates).toBe(0)
  expect(queue.activeJob()).toBeUndefined()
  expect(service.status()).toBeUndefined()
  queue.dispose()
})

test("native export preflight rejects oversized PCM before external state capture", async () => {
  const queue = createExportQueue(() => "native-memory-limit")
  let externalStateCaptureCalls = 0
  const totalFrames = nativeAudioHostMaximumInMemoryPcmBytes
    / (2 * Float32Array.BYTES_PER_ELEMENT) + 1
  const service = createTimelineExportService({
    queue,
    nativeRendererRequired: true,
    nativeOfflineRenderer: async () => {
      throw new Error("unreachable")
    },
    getTracks: () => [{
      id: "track-1",
      name: "Track",
      volume: 1,
      clips: [{
        id: "clip-1",
        name: "Clip",
        color: "#fff",
        startSec: 0,
        duration: totalFrames,
        midi: { wave: "sine", notes: [] },
      }],
    }],
    getBpm: () => 120,
    getMasterVolume: () => 1,
    getProjectId: () => undefined,
    getUserId: () => undefined,
    getCloudRenderRows: () => undefined,
    getAutomationPatches: () => [],
    getEffectsExportSnapshot: () => undefined,
    getSidechainRoutes: () => [],
    getNativeOfflineExternalAttachments: async () => {
      externalStateCaptureCalls += 1
      return undefined
    },
    loadCapturedClipBuffer: async () => ({ status: "missing" as const }),
  })

  await expect(service.prepareTimelineExport({
    ...settings,
    range: { mode: "custom", startSec: 0, endSec: (totalFrames + 0.5) / 96_000 },
    render: { ...settings.render, sampleRate: 96_000 },
  })).rejects.toThrow("512 MiB in-memory PCM")
  expect(externalStateCaptureCalls).toBe(0)
  queue.dispose()
})

test("restarts export capture through successive project switches during MIDI flushing", async () => {
  let projectId = "project-a"
  let projectReads = 0
  const queue = createExportQueue(() => "job-project-switch")
  const service = createTimelineExportService({
    queue,
    getTracks: () => [{ id: `track-${projectId}`, name: projectId, volume: 1, clips: [] }],
    getBpm: () => 120,
    getMasterVolume: () => 1,
    getProjectId: () => {
      projectReads += 1
      if (projectReads === 2) projectId = "project-b"
      if (projectReads === 4) projectId = "project-c"
      return projectId
    },
    getUserId: () => "user-1",
    getCloudRenderRows: () => ({ effects: [], automationEnvelopes: [] }),
    getAutomationPatches: () => [],
    getEffectsExportSnapshot: () => undefined,
    getSidechainRoutes: () => [],
    loadCapturedClipBuffer: async () => ({ status: "missing" }),
  })
  const prepared = await service.prepareTimelineExport(settings)
  expect(prepared.snapshot.projectId).toBe("project-c")
  expect(prepared.snapshot.tracks).toEqual([
    expect.objectContaining({ id: "track-project-c" }),
  ])
  queue.dispose()
})

test("captures effects projection and routes after flushing effect persistence", async () => {
  const projectId = "cloud-project"
  const trackId = "track-pre-flush"
  let tracks: RuntimeTrack[] = [{ id: trackId, name: "before", volume: 0.5, clips: [] }]
  let bpm = 120
  let masterVolume = 0.5
  let routes = [{ sourceTrackId: trackId, targetTrackId: trackId, effectInstanceId: "utility-before" }]
  let automation: AutomationEnvelope[] = [{
    id: "before",
    projectId,
    target: { kind: "track", trackId },
    targetKey: "track:before",
    parameterId: "volume",
    enabled: true,
    points: [],
    updatedAt: 1,
  }]
  const utility = AUDIO_EFFECT_CONTRACTS.utility.createDefaultParams()
  let effects = [{ targetId: trackId, effect: "utility" as const, instanceId: "utility-before", index: 0, params: utility }]
  const queue = createExportQueue(() => "job-pre-flush")
  const service = createTimelineExportService({
    queue,
    getTracks: () => tracks,
    getBpm: () => bpm,
    getMasterVolume: () => masterVolume,
    getProjectId: () => projectId,
    getUserId: () => "user-1",
    getCloudRenderRows: () => ({ effects: [], automationEnvelopes: [] }),
    getAutomationPatches: () => automation.map((envelope) => ({ targetKey: envelope.targetKey, envelope })),
    getEffectsExportSnapshot: () => ({
      snapshotEffectsProjection: () => ({
        replaceAudioEffectTargets: [{ targetId: trackId, rows: effects }],
        upsertDeviceRows: [],
      }),
      snapshotSidechainRoutes: () => routes,
      flushPending: async () => {
        tracks = [{ id: trackId, name: "after", volume: 1, clips: [] }]
        bpm = 90
        masterVolume = 1
        routes = []
        automation = [{
          id: "after",
          projectId,
          target: { kind: "track", trackId },
          targetKey: "track:after",
          parameterId: "volume",
          enabled: true,
          points: [],
          updatedAt: 2,
        }]
        effects = []
      },
    }),
    getSidechainRoutes: () => routes,
    loadCapturedClipBuffer: async () => ({ status: "missing" }),
  })

  const prepared = await service.prepareTimelineExport(settings)
  expect(prepared.snapshot.tracks[0]?.name).toBe("before")
  expect(prepared.snapshot.bpm).toBe(90)
  expect(prepared.snapshot.masterVolume).toBe(1)
  expect(prepared.snapshot.sidechainRoutes).toHaveLength(0)
  expect(prepared.snapshot.renderStateSnapshot.fx.trackFx?.[trackId]?.instances).toEqual([])
  expect(prepared.snapshot.renderStateSnapshot.automationEnvelopes).toEqual([
    expect.objectContaining({ id: "after" }),
  ])
  queue.dispose()
})

test("rejects when effects flushing switches projects before capturing remaining domains", async () => {
  let projectId = "project-before"
  let queued = false
  const queue = createExportQueue(() => {
    queued = true
    return "job-project-race"
  })
  const service = createTimelineExportService({
    queue,
    getTracks: () => [{ id: "track-before", name: "before", volume: 1, clips: [] }],
    getBpm: () => 120,
    getMasterVolume: () => 1,
    getProjectId: () => projectId,
    getUserId: () => "user-1",
    getCloudRenderRows: () => ({ effects: [], automationEnvelopes: [] }),
    getAutomationPatches: () => [],
    getEffectsExportSnapshot: () => ({
      snapshotEffectsProjection: () => ({ replaceAudioEffectTargets: [], upsertDeviceRows: [] }),
      snapshotSidechainRoutes: () => [],
      flushPending: async () => {
        projectId = "project-after"
      },
    }),
    getSidechainRoutes: () => [],
    loadCapturedClipBuffer: async () => ({ status: "missing" }),
  })

  await expect(service.prepareTimelineExport(settings)).rejects.toThrow(
    "Project changed while preparing export.",
  )
  expect(queued).toBe(false)
  queue.dispose()
})

test("hydrates queued clips from captured media identity after live replacement", async () => {
  const renderedBuffer = new TestAudioBuffer()
  let renderedTracks: RuntimeTrack[] | undefined

  let tracks: RuntimeTrack[] = [{
    id: "track-captured",
    name: "Captured",
    volume: 1,
    clips: [{
      id: "clip-captured",
      name: "Captured clip",
      color: "#fff",
      startSec: 0,
      duration: renderedBuffer.duration,
      sampleUrl: "https://samples.example/captured.wav",
      sourceAssetKey: "asset:captured",
    }],
  }]
  const loadedReferences: Array<{
    projectId?: string
    sampleUrl?: string
    sourceAssetKey?: string
  }> = []
  const queue = createExportQueue(() => "job-captured")
  const service = createTimelineExportService({
    queue,
    runTimelineExport: async (input) => {
      renderedTracks = input.getTracks()
      for (const track of renderedTracks) {
        for (const clip of track.clips) {
          if (!clip.midi && !clip.buffer) await input.loadCapturedClipBuffer(clip, input.signal)
        }
      }
      return { type: "success", outputs: [] }
    },
    getTracks: () => tracks,
    getBpm: () => 120,
    getMasterVolume: () => 1,
    getProjectId: () => "cloud-project",
    getUserId: () => "user-1",
    getCloudRenderRows: () => ({ effects: [], automationEnvelopes: [] }),
    getAutomationPatches: () => [],
    getEffectsExportSnapshot: () => undefined,
    getSidechainRoutes: () => [],
    loadCapturedClipBuffer: async (reference) => {
      loadedReferences.push(reference)
      return { status: "ready", buffer: renderedBuffer }
    },
  })
  const prepared = await service.prepareTimelineExport(settings)
  tracks = [{
    id: "track-captured",
    name: "Live replacement",
    volume: 1,
    clips: [{
      id: "clip-captured",
      name: "Replacement clip",
      color: "#000",
      startSec: 0,
      duration: 1,
      sampleUrl: "https://samples.example/replacement.wav",
      sourceAssetKey: "asset:replacement",
    }],
  }]
  const submitted = service.submitPreparedTimelineExport(prepared, {
    async createMixdownTarget() {
      return {
        openFile: async () => undefined,
        saveBuffer: async () => ({
          destination: "cloud",
          name: "captured.wav",
          url: "https://samples.example/export.wav",
        }),
      }
    },
    async createStemTarget() {
      throw new Error("unexpected stem target")
    },
  })

  expect(await submitted.completion).toEqual(expect.objectContaining({ type: "success" }))
  expect(loadedReferences).toEqual([{
    projectId: "cloud-project",
    sampleUrl: "https://samples.example/captured.wav",
    sourceAssetKey: "asset:captured",
  }])
  expect(renderedTracks?.[0]?.clips[0]?.name).toBe("Captured clip")
  expect(renderedTracks?.[0]?.clips[0]?.buffer).toBe(renderedBuffer)
  queue.dispose()
})

test("derives a captured default sample URL without replacing its asset identity", async () => {
  const renderedBuffer = new TestAudioBuffer()
  const sourceAssetKey = "asset:default:test-kick"
  const loadedReferences: Array<{
    projectId?: string
    sampleUrl?: string
    sourceAssetKey?: string
  }> = []
  const queue = createExportQueue(() => "job-default-sample")
  const service = createTimelineExportService({
    queue,
    runTimelineExport: async (input) => {
      for (const track of input.getTracks()) {
        for (const clip of track.clips) {
          if (!clip.midi && !clip.buffer) await input.loadCapturedClipBuffer(clip, input.signal)
        }
      }
      return { type: "success", outputs: [] }
    },
    getTracks: () => [{
      id: "track-default",
      name: "Default sample",
      volume: 1,
      clips: [{
        id: "clip-default",
        name: "Default sample clip",
        color: "#fff",
        startSec: 0,
        duration: renderedBuffer.duration,
        sourceAssetKey,
      }],
    }],
    getBpm: () => 120,
    getMasterVolume: () => 1,
    getProjectId: () => "cloud-project",
    getUserId: () => "user-1",
    getCloudRenderRows: () => ({ effects: [], automationEnvelopes: [] }),
    getAutomationPatches: () => [],
    getEffectsExportSnapshot: () => undefined,
    getSidechainRoutes: () => [],
    loadCapturedClipBuffer: async (reference) => {
      loadedReferences.push(reference)
      return { status: "ready", buffer: renderedBuffer }
    },
  })
  const prepared = await service.prepareTimelineExport(settings)
  const detached = prepared.snapshot.tracks[0]?.clips[0]
  if (!detached) throw new Error("Expected a detached default sample clip.")
  const submitted = service.submitPreparedTimelineExport(prepared, {
    async createMixdownTarget() {
      return {
        openFile: async () => undefined,
        saveBuffer: async () => ({
          destination: "cloud",
          name: "default.wav",
          url: "https://samples.example/default-export.wav",
        }),
      }
    },
    async createStemTarget() {
      throw new Error("unexpected stem target")
    },
  })

  expect((await submitted.completion).type).toBe("success")
  expect(loadedReferences).toEqual([{
    projectId: "cloud-project",
    sampleUrl: resolveClipSampleUrl(detached),
    sourceAssetKey,
  }])
  queue.dispose()
})

test("a queued export renders the submission generation after live project mutation", async () => {
  const projectId = "project:queued-generation"
  const trackId = "track:queued-generation"
  const target: AutomationTarget = { kind: "track", trackId }
  const submissionAutomation: AutomationEnvelope = {
    id: "submission-envelope",
    projectId,
    target,
    targetKey: automationTargetKey(target, "volume"),
    parameterId: "volume",
    enabled: true,
    points: [{ id: "submission-point", timeSec: 0, value: 0.4, interpolation: "linear" }],
    updatedAt: 1,
  }
  const liveAutomation: AutomationEnvelope = {
    ...submissionAutomation,
    id: "live-envelope",
    points: [{ id: "live-point", timeSec: 0, value: 0.9, interpolation: "linear" }],
    updatedAt: 2,
  }
  const submissionUtility = AUDIO_EFFECT_CONTRACTS.utility.createDefaultParams()
  const liveUtility = {
    ...submissionUtility,
    state: { ...submissionUtility.state, gainDb: 9 },
  }
  await Promise.all([
    setLocalEffectInstance(projectId, trackId, "utility", submissionUtility, { instanceId: "utility-queued" }),
    setLocalAutomationEnvelope(projectId, submissionAutomation),
  ])

  let rendered: {
    tracks: RuntimeTrack[]
    bpm: number
    fx: ExportFx
    automationEnvelopes: AutomationEnvelope[]
    sidechainRoutes: { sourceTrackId: string; targetTrackId: string; effectInstanceId: string }[]
  } | undefined

  let nextId = 0
  const queue = createExportQueue(() => `job-${++nextId}`)
  let releaseBlocker: (() => void) | undefined
  const blocker = queue.submit({ name: "blocker" }, async () => {
    await new Promise<void>((resolve) => {
      releaseBlocker = resolve
    })
    return { type: "success", outputs: [] }
  })
  let tracks: RuntimeTrack[] = [{
    id: trackId,
    name: "Submission track",
    volume: 0.5,
    clips: [{
      id: "clip-queued",
      name: "Submission clip",
      color: "#fff",
      startSec: 0,
      duration: 0.001,
      midi: { wave: "sine", notes: [] },
    }],
  }]
  let bpm = 120
  let masterVolume = 0.7
  let sidechainRoutes = [{
    sourceTrackId: trackId,
    targetTrackId: trackId,
    effectInstanceId: "utility-queued",
  }]
  const service = createTimelineExportService({
    queue,
    runTimelineExport: async (input) => {
      rendered = {
        tracks: input.getTracks(),
        bpm: input.bpm,
        fx: input.renderStateSnapshot.fx,
        automationEnvelopes: [...input.renderStateSnapshot.automationEnvelopes],
        sidechainRoutes: input.sidechainRoutes,
      }
      return { type: "success", outputs: [] }
    },
    getTracks: () => tracks,
    getBpm: () => bpm,
    getMasterVolume: () => masterVolume,
    getProjectId: () => projectId,
    getUserId: () => "user-1",
    getCloudRenderRows: () => undefined,
    getAutomationPatches: () => [],
    getEffectsExportSnapshot: () => undefined,
    getSidechainRoutes: () => sidechainRoutes,
    loadCapturedClipBuffer: async () => ({ status: "missing" }),
  })
  const outputTargets: ExportOutputTargetFactory = {
    async createMixdownTarget() {
      return {
        openFile: async () => undefined,
        saveBuffer: async () => ({ destination: "local", name: "submission.wav" }),
      }
    },
    async createStemTarget() {
      throw new Error("unexpected stem target")
    },
  }
  await Promise.resolve()
  const submitted = await service.submitTimelineExport(settings, outputTargets)

  tracks = [{ id: trackId, name: "Live track", volume: 1, clips: [] }]
  bpm = 90
  masterVolume = 1
  sidechainRoutes = []
  await Promise.all([
    setLocalEffectInstance(projectId, trackId, "utility", liveUtility, { instanceId: "utility-queued" }),
    setLocalAutomationEnvelope(projectId, liveAutomation),
  ])
  releaseBlocker?.()
  await blocker.completion
  expect((await submitted.completion).type).toBe("success")
  if (!rendered) throw new Error("Export did not render.")
  expect(rendered.tracks[0]?.name).toBe("Submission track")
  expect(rendered.bpm).toBe(120)
  expect(rendered.fx.masterVolume).toBe(0.7)
  expect(rendered.fx.trackFx?.[trackId]?.instances).toEqual([
    expect.objectContaining({
      id: "utility-queued",
      params: expect.objectContaining({ state: expect.objectContaining({ gainDb: 0 }) }),
    }),
  ])
  expect(rendered.automationEnvelopes[0]?.id).toBe("submission-envelope")
  expect(rendered.sidechainRoutes).toHaveLength(1)
  queue.dispose()
})

test("active cancellation remains running until stalled clip loading settles", async () => {
  const queue = createExportQueue(() => "job-active-cancel")
  const stalledMediaLoader = createCapturedClipMediaLoader({
    readAsset: async () => ({ status: "missing" }),
    fetch: async () => await new Promise<Response>(() => undefined),
    decode: async () => new TestAudioBuffer(),
  })
  const service = createTimelineExportService({
    queue,
    getTracks: () => [{
      id: "track-stalled",
      name: "Stalled",
      volume: 1,
      clips: [{
        id: "clip-stalled",
        name: "Stalled clip",
        color: "#fff",
        startSec: 0,
        duration: 1,
        sampleUrl: "https://samples.example/stalled.wav",
      }],
    }],
    getBpm: () => 120,
    getMasterVolume: () => 1,
    getProjectId: () => "cloud-project",
    getUserId: () => "user-1",
    getCloudRenderRows: () => ({ effects: [], automationEnvelopes: [] }),
    getAutomationPatches: () => [],
    getEffectsExportSnapshot: () => undefined,
    getSidechainRoutes: () => [],
    loadCapturedClipBuffer: stalledMediaLoader.load,
  })
  const submitted = await service.submitTimelineExport(settings, {
    async createMixdownTarget() {
      return {
        openFile: async () => undefined,
        saveBuffer: async () => ({ destination: "cloud", name: "stalled.wav", url: "https://example.test/stalled.wav" }),
      }
    },
    async createStemTarget() {
      throw new Error("unexpected stem target")
    },
  })
  await Promise.resolve()
  expect(service.status(submitted.id)?.status).toBe("running")
  service.cancel(submitted.id)
  expect(service.status(submitted.id)?.status).toBe("running")
  expect(await submitted.completion).toEqual({ type: "canceled", outputs: [] })
  await Promise.resolve()
  expect(service.status(submitted.id)?.status).toBe("canceled")
  queue.dispose()
})

test("queued cancellation publishes canceled only after completion settlement", async () => {
  let releaseBlocker: (() => void) | undefined
  let nextId = 0
  const queue = createExportQueue(() => `job-queued-cancel-${++nextId}`)
  const blocker = queue.submit({ name: "blocker" }, async () => {
    await new Promise<void>((resolve) => {
      releaseBlocker = resolve
    })
    return { type: "success", outputs: [] }
  })
  const service = createTimelineExportService({
    queue,
    getTracks: () => [],
    getBpm: () => 120,
    getMasterVolume: () => 1,
    getProjectId: () => "cloud-project",
    getUserId: () => "user-1",
    getCloudRenderRows: () => ({ effects: [], automationEnvelopes: [] }),
    getAutomationPatches: () => [],
    getEffectsExportSnapshot: () => undefined,
    getSidechainRoutes: () => [],
    loadCapturedClipBuffer: async () => ({ status: "missing" }),
  })
  await Promise.resolve()
  const submitted = await service.submitTimelineExport(settings, {
    async createMixdownTarget() {
      throw new Error("queued target should not open")
    },
    async createStemTarget() {
      throw new Error("queued target should not open")
    },
  })
  expect(service.status(submitted.id)?.status).toBe("queued")
  service.cancel(submitted.id)
  expect(service.status(submitted.id)?.status).toBe("queued")
  expect(await submitted.completion).toEqual({ type: "canceled", outputs: [] })
  await Promise.resolve()
  expect(service.status(submitted.id)?.status).toBe("canceled")
  releaseBlocker?.()
  await blocker.completion
  queue.dispose()
})
