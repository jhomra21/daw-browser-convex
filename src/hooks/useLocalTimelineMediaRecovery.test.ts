import "fake-indexeddb/auto"
import { createRoot, createSignal } from "solid-js"
import { expect, test } from "bun:test"
import { AudioEngine } from "@daw-browser/audio-engine/audio-engine"
import { createLocalProject } from "~/lib/local-project-db"
import { createLocalTimelineRepository } from "~/lib/timeline-repository/local-timeline-repository"
import { createLocalControlService } from "~/lib/local-control/local-control-service"
import { createLocalAsset } from "~/lib/local-assets"
import type { Track } from "@daw-browser/timeline-core/types"
import { useClipBuffers } from "./useClipBuffers"
import { useMissingMediaRecovery } from "./useLocalTimelineMediaRecovery"

class TestAudioBuffer implements AudioBuffer {
  readonly duration = 1
  readonly length = 44_100
  readonly numberOfChannels = 1
  readonly sampleRate = 44_100
  copyFromChannel(destination: Float32Array, _channelNumber: number, _bufferOffset?: number) {
    destination.fill(0)
  }
  copyToChannel(_source: Float32Array, _channelNumber: number, _bufferOffset?: number) {}
  getChannelData(_channel: number) {
    return new Float32Array(this.length)
  }
}

const createAssetStorage = () => {
  const files = new Map<string, File>()
  const assets = {
    getFileHandle: async (name: string) => ({
      getFile: async () => files.get(name) ?? new File([], name),
      createWritable: async () => {
        let written: File | undefined
        return {
          write: async (file: File) => { written = file },
          close: async () => { if (written) files.set(name, written) },
          abort: async () => undefined,
        }
      },
    }),
    removeEntry: async (name: string) => { files.delete(name) },
  }
  const root = {
    getDirectoryHandle: async (name: string) => name === "assets" ? assets : root,
  }
  return { root }
}

test("reconciliation reloads the canonical local repository snapshot", async () => {
  const project = await createLocalProject(`Timeline reconciliation ${crypto.randomUUID()}`)
  const repository = createLocalTimelineRepository(project.id)
  const track = (await repository.loadSnapshot()).tracks[0]
  if (!track) throw new Error("Expected default track.")

  await createRoot(async (dispose) => {
    const [projectId] = createSignal(project.id)
    const [generation] = createSignal(3)
    const [reloadVersion] = createSignal(0)
    const recovery = useMissingMediaRecovery({
      projectId,
      mountedProjectGeneration: generation,
      remoteTimelineAvailable: () => false,
      localTimelineReloadVersion: reloadVersion,
      userId: () => undefined,
      renderTracks: () => [],
      audioEngine: new AudioEngine(),
      audioBufferCache: {
        storeBuffer: () => undefined,
        storeBuffers: () => undefined,
        removeBuffer: () => undefined,
      },
      getClipBuffer: () => undefined,
      preloadClipBuffer: async () => undefined,
      removeClip: async () => false,
      projection: {
        insertLocalClip: () => undefined,
        removeLocalClips: () => undefined,
      },
      selection: {
        selectedClip: () => null,
        setSelectedClip: () => undefined,
        setSelectedClipIds: () => undefined,
        selectTrackTarget: () => undefined,
      },
    })
    await recovery.reloadLocalTimeline({
      projectId: project.id,
      mountedProjectGeneration: 3,
      signal: new AbortController().signal,
    })
    expect(recovery.localTimelineSnapshot()?.tracks[0]).toMatchObject({
      id: track.id,
      name: "Track 1",
    })

    await createLocalControlService({
      actor: { subject: "reconciliation-test" },
    }).commit({
      version: "v1",
      projectId: project.id,
      idempotencyKey: "reconciliation-test",
      actions: [{
        kind: "track.rename",
        track: { source: "persisted", id: track.id },
        name: "Drums Acceptance",
      }],
    })
    await recovery.reloadLocalTimeline({
      projectId: project.id,
      mountedProjectGeneration: 3,
      signal: new AbortController().signal,
    })
    expect(recovery.localTimelineSnapshot()?.tracks[0]).toMatchObject({
      id: track.id,
      name: "Drums Acceptance",
    })

    await createLocalControlService({
      actor: { subject: "reconciliation-test" },
    }).commit({
      version: "v1",
      projectId: project.id,
      idempotencyKey: "reconciliation-stale-test",
      actions: [{
        kind: "track.rename",
        track: { source: "persisted", id: track.id },
        name: "Stale Should Not Apply",
      }],
    })
    await recovery.reloadLocalTimeline({
      projectId: project.id,
      mountedProjectGeneration: 2,
      signal: new AbortController().signal,
    })
    expect(recovery.localTimelineSnapshot()?.tracks[0]?.name).toBe("Drums Acceptance")
    dispose()
  })
})

test("mount hydration restores persisted local media through the canonical asset ID", async () => {
  const storage = Object.getOwnPropertyDescriptor(navigator, "storage")
  const { root } = createAssetStorage()
  Object.defineProperty(navigator, "storage", {
    configurable: true,
    value: { getDirectory: async () => root },
  })
  try {
    const project = await createLocalProject(`Hydration ${crypto.randomUUID()}`)
    const repository = createLocalTimelineRepository(project.id)
    const track = (await repository.loadSnapshot()).tracks[0]
    if (!track) throw new Error("Expected default track.")
    const asset = await createLocalAsset({
      projectId: project.id,
      file: new File(["wav"], "imported.wav", { type: "audio/wav" }),
      metadata: { sourceKind: "upload", durationSec: 1, sampleRate: 44_100, channelCount: 1 },
    })
    const clip = await repository.createClip({
      trackId: track.id,
      name: "imported.wav",
      startSec: 0,
      duration: 1,
      sourceAssetId: asset.id,
      sourceAssetKey: asset.id,
      sourceKind: "upload",
      sourceDurationSec: 1,
      sourceSampleRate: 44_100,
      sourceChannelCount: 1,
    })
    await createRoot(async (dispose) => {
      const [projectId] = createSignal(project.id)
      const [generation] = createSignal(4)
      const [reloadVersion] = createSignal(0)
      const [runtimeTracks] = createSignal<Track<AudioBuffer>[]>([])
      const audioEngine = new AudioEngine()
      const hydratedBuffer = new TestAudioBuffer()
      audioEngine.decodeAudioData = async () => hydratedBuffer
      const clipBuffers = useClipBuffers({
        audioEngine,
        projectId,
        tracks: runtimeTracks,
        onBufferChange: () => undefined,
      })
      const recovery = useMissingMediaRecovery({
        projectId,
        mountedProjectGeneration: generation,
        remoteTimelineAvailable: () => false,
        localTimelineReloadVersion: reloadVersion,
        userId: () => undefined,
        renderTracks: runtimeTracks,
        audioEngine,
        audioBufferCache: {
          storeBuffer: () => undefined,
          storeBuffers: () => undefined,
          removeBuffer: () => undefined,
        },
        getClipBuffer: clipBuffers.getBuffer,
        preloadClipBuffer: clipBuffers.preload,
        removeClip: async () => false,
        projection: {
          insertLocalClip: () => undefined,
          removeLocalClips: () => undefined,
        },
        selection: {
          selectedClip: () => null,
          setSelectedClip: () => undefined,
          setSelectedClipIds: () => undefined,
          selectTrackTarget: () => undefined,
        },
      })
      const preProjectionLoad = clipBuffers.preload(clip.id)
      await recovery.reloadLocalTimeline({
        projectId: project.id,
        mountedProjectGeneration: 4,
        signal: new AbortController().signal,
      })
      await preProjectionLoad
      expect(clipBuffers.getBuffer(clip.id)).toBe(hydratedBuffer)
      expect(recovery.localTimelineSnapshot()?.clips.find((entry) => entry.id === clip.id)?.sourceAssetKey).toBe(asset.id)
      expect(recovery.mountedLocalMediaReady()).toBe(true)
      dispose()
    })
  } finally {
    if (storage) Object.defineProperty(navigator, "storage", storage)
    else Reflect.deleteProperty(navigator, "storage")
  }
})

test("mount hydration aborts stale project work before loading the next generation", async () => {
  const first = await createLocalProject(`Hydration A ${crypto.randomUUID()}`)
  const second = await createLocalProject(`Hydration B ${crypto.randomUUID()}`)
  const [firstTrack] = (await createLocalTimelineRepository(first.id).loadSnapshot()).tracks
  const [secondTrack] = (await createLocalTimelineRepository(second.id).loadSnapshot()).tracks
  if (!firstTrack || !secondTrack) throw new Error("Expected default tracks.")
  const firstClip = await createLocalTimelineRepository(first.id).createClip({
    trackId: firstTrack.id,
    name: "A",
    startSec: 0,
    duration: 1,
    sourceAssetKey: "asset:a",
    sourceKind: "upload",
    sourceDurationSec: 1,
    sourceSampleRate: 44_100,
    sourceChannelCount: 1,
  })
  const secondClip = await createLocalTimelineRepository(second.id).createClip({
    trackId: secondTrack.id,
    name: "B",
    startSec: 0,
    duration: 1,
    sourceAssetKey: "asset:b",
    sourceKind: "upload",
    sourceDurationSec: 1,
    sourceSampleRate: 44_100,
    sourceChannelCount: 1,
  })
  const gate = Promise.withResolvers<void>()
  const hydrated: string[] = []
  const [projectId, setProjectId] = createSignal(first.id)
  const [generation, setGeneration] = createSignal(1)
  const [reloadVersion] = createSignal(0)
  await createRoot(async (dispose) => {
    const recovery = useMissingMediaRecovery({
      projectId,
      mountedProjectGeneration: generation,
      remoteTimelineAvailable: () => false,
      localTimelineReloadVersion: reloadVersion,
      userId: () => undefined,
      renderTracks: () => [],
      audioEngine: new AudioEngine(),
      audioBufferCache: {
        storeBuffer: () => undefined,
        storeBuffers: () => undefined,
        removeBuffer: () => undefined,
      },
      getClipBuffer: () => undefined,
      preloadClipBuffer: async (clipId, _sampleUrl, signal) => {
        if (clipId === firstClip.id) {
          await gate.promise
          signal?.throwIfAborted()
        }
        hydrated.push(clipId)
      },
      removeClip: async () => false,
      projection: {
        insertLocalClip: () => undefined,
        removeLocalClips: () => undefined,
      },
      selection: {
        selectedClip: () => null,
        setSelectedClip: () => undefined,
        setSelectedClipIds: () => undefined,
        selectTrackTarget: () => undefined,
      },
    })
    const firstController = new AbortController()
    const firstLoad = recovery.reloadLocalTimeline({
      projectId: first.id,
      mountedProjectGeneration: 1,
      signal: firstController.signal,
    })
    firstController.abort()
    setProjectId(second.id)
    setGeneration(2)
    gate.resolve()
    await firstLoad
    await recovery.reloadLocalTimeline({
      projectId: second.id,
      mountedProjectGeneration: 2,
      signal: new AbortController().signal,
    })
    expect(hydrated).toEqual([secondClip.id])
    expect(recovery.localTimelineSnapshot()?.projectId).toBe(second.id)
    expect(recovery.mountedLocalMediaReady()).toBe(false)
    await expect(recovery.ensureMountedLocalMedia({
      projectId: second.id,
      mountedProjectGeneration: 2,
      signal: new AbortController().signal,
    })).rejects.toThrow("Mounted local media is unavailable.")
    dispose()
  })
})

test("mount hydration bounds concurrent media loads", async () => {
  const project = await createLocalProject(`Hydration concurrency ${crypto.randomUUID()}`)
  const repository = createLocalTimelineRepository(project.id)
  const [track] = (await repository.loadSnapshot()).tracks
  if (!track) throw new Error("Expected default track.")
  for (let index = 0; index < 6; index += 1) {
    await repository.createClip({
      trackId: track.id,
      name: `Clip ${index}`,
      startSec: index,
      duration: 1,
      sourceAssetKey: `asset:${index}`,
      sourceKind: "upload",
      sourceDurationSec: 1,
      sourceSampleRate: 44_100,
      sourceChannelCount: 1,
    })
  }

  let activeLoads = 0
  let maximumActiveLoads = 0
  await createRoot(async (dispose) => {
    const [projectId] = createSignal(project.id)
    const [generation] = createSignal(1)
    const [reloadVersion] = createSignal(0)
    const buffer = new TestAudioBuffer()
    const recovery = useMissingMediaRecovery({
      projectId,
      mountedProjectGeneration: generation,
      remoteTimelineAvailable: () => false,
      localTimelineReloadVersion: reloadVersion,
      userId: () => undefined,
      renderTracks: () => [],
      audioEngine: new AudioEngine(),
      audioBufferCache: {
        storeBuffer: () => undefined,
        storeBuffers: () => undefined,
        removeBuffer: () => undefined,
      },
      getClipBuffer: () => buffer,
      preloadClipBuffer: async () => {
        activeLoads += 1
        maximumActiveLoads = Math.max(maximumActiveLoads, activeLoads)
        await Promise.resolve()
        activeLoads -= 1
      },
      removeClip: async () => false,
      projection: {
        insertLocalClip: () => undefined,
        removeLocalClips: () => undefined,
      },
      selection: {
        selectedClip: () => null,
        setSelectedClip: () => undefined,
        setSelectedClipIds: () => undefined,
        selectTrackTarget: () => undefined,
      },
    })
    await recovery.reloadLocalTimeline({
      projectId: project.id,
      mountedProjectGeneration: 1,
      signal: new AbortController().signal,
    })
    expect(maximumActiveLoads).toBe(4)
    dispose()
  })
})
