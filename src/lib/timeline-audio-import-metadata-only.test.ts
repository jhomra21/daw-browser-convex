import 'fake-indexeddb/auto'
import { expect, test } from 'bun:test'
import { createSignal, untrack } from 'solid-js'
import { mountStep5Playback, settleStep5Playback } from '../../tools/acceptance/b5c-playback-witness-support'
import { installHermeticWindow } from './test/hermetic-browser-environment'

import type { Clip, Track } from '@daw-browser/timeline-core/types'
import { createLocalProject } from './local-project-db'
import { createLocalTimelineRepository } from './timeline-repository/local-timeline-repository'
import { createAudioImportTransaction } from './timeline-audio-import'

const createAssetStorage = () => {
  const files = new Map<string, File>()
  const assets = {
    getFileHandle: async (name: string) => ({
      getFile: async () => files.get(name) ?? new File([], name),
      createWritable: async () => {
        const chunks: Uint8Array[] = []
        return {
          write: async (chunk: Uint8Array) => { chunks.push(chunk) },
          close: async () => {
            const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0))
            let offset = 0
            for (const chunk of chunks) {
              bytes.set(chunk, offset)
              offset += chunk.byteLength
            }
            files.set(name, new File([bytes], name))
          },
          abort: async () => undefined,
        }
      },
    }),
    removeEntry: async (name: string) => {
      files.delete(name)
    },
  }
  const root = {
    getDirectoryHandle: async (name: string) => name === 'assets' ? assets : root,
  }
  return { root }
}

test('creates a local audio clip from persisted metadata without an AudioBuffer', async () => {
  const storage = Object.getOwnPropertyDescriptor(navigator, 'storage')
  const { root } = createAssetStorage()
  Object.defineProperty(navigator, 'storage', {
    configurable: true,
    value: { getDirectory: async () => root },
  })

  try {
    const project = await createLocalProject(`Metadata import ${crypto.randomUUID()}`)
    const persistedTrack = (await createLocalTimelineRepository(project.id).loadSnapshot()).tracks[0]
    if (!persistedTrack) throw new Error('Expected a persisted track.')
    const track: Track = { ...persistedTrack, clips: [] }
    const inserted: Clip[] = []
    const transaction = createAudioImportTransaction({
      project: {
        projectId: () => project.id,
        userId: () => undefined,
        tracks: () => [track],
        isActiveProjectTrack: () => true,
      },
      clips: {
        buffers: {
          writer: {
            storeBuffer: () => { throw new Error('AudioBuffer cache must remain optional.') },
            storeBuffers: () => { throw new Error('AudioBuffer cache must remain optional.') },
            removeBuffer: () => undefined,
          },
          getBuffer: () => undefined,
          getMediaStatus: () => undefined,
          preload: async () => undefined,
        },
        insertLocalClip: (_trackId, clip) => inserted.push(clip),
        selectClip: () => undefined,
        pushTrackClipCreateHistory: () => undefined,
      },
      cloud: { uploadToR2: async () => null },
      rollback: {
        removeLocalTrack: async () => undefined,
        removeCloudTrack: async () => undefined,
      },
    })

    const result = await transaction.createUploadedFileClip({
      file: new File(['project-owned-source'], 'long-source.wav', { type: 'audio/wav' }),
      source: {
        durationSec: 6 * 60 * 60,
        sampleRate: 48_000,
        channelCount: 2,
      },
      track,
      startSec: 0,
    })

    expect(result.status).toBe('created')
    if (result.status !== 'created') throw new Error('Expected a created local clip.')
    expect(inserted[0]).toMatchObject({
      id: result.clipId,
      buffer: null,
      duration: 6 * 60 * 60,
      sourceAssetKey: result.assetId,
      sourceDurationSec: 6 * 60 * 60,
      sourceSampleRate: 48_000,
      sourceChannelCount: 2,
    })
  } finally {
    if (storage) Object.defineProperty(navigator, 'storage', storage)
    else Reflect.deleteProperty(navigator, 'storage')
  }
})

// C0f item 2: a desktop local import made while native plays inserts a metadata-only clip. The import asks for its
// projected decode, as the URL import does, so the decoded clip is staged and installed into the playing graph.
class ImportedAudioBuffer implements AudioBuffer {
  readonly sampleRate = 48_000
  readonly duration: number
  private readonly channel: Float32Array<ArrayBuffer>
  constructor(readonly length = 4, readonly numberOfChannels = 1) {
    this.duration = length / this.sampleRate
    this.channel = new Float32Array(length)
  }
  copyFromChannel(destination: Float32Array) { destination.set(this.channel.subarray(0, destination.length)) }
  copyToChannel(source: Float32Array) { this.channel.set(source.subarray(0, this.channel.length)) }
  getChannelData() { return this.channel }
}

test('C0F a local import during native playback is decoded, staged and installed live', async () => {
  const storage = Object.getOwnPropertyDescriptor(navigator, 'storage')
  // Electron's renderer has AudioBuffer and the hook fingerprints a clip buffer only as one; Bun has none.
  const audioBuffer = Object.getOwnPropertyDescriptor(globalThis, 'AudioBuffer')
  const { root } = createAssetStorage()
  Object.defineProperty(navigator, 'storage', { configurable: true, value: { getDirectory: async () => root } })
  if (!audioBuffer) Object.defineProperty(globalThis, 'AudioBuffer', { configurable: true, value: ImportedAudioBuffer })
  const fx = () => ({ masterVolume: 1, masterFxInstances: [], trackFx: {} })
  const inputs = () => ({ masterVolume: 1, automation: [], sidechains: [] })
  const retained: Track<AudioBuffer> = { id: 'track-c0f-retained', name: 'Retained', volume: 1, clips: [{ id: 'clip-c0f-retained',
    name: 'retained.wav', startSec: 0, duration: 1, color: '#fff', sourceAssetKey: 'asset-c0f-retained', buffer: new ImportedAudioBuffer() }] }
  let mounted: Awaited<ReturnType<typeof mountStep5Playback>> | undefined
  // The repository attaches its lifecycle flush to the first window it sees; the playback fixture's window has no events.
  const restoreWindow = installHermeticWindow({ clearTimeout, setTimeout })
  try {
    const project = await createLocalProject(`Live import ${crypto.randomUUID()}`)
    const persistedTrack = (await createLocalTimelineRepository(project.id).loadSnapshot()).tracks[0]
    if (!persistedTrack) throw new Error('Expected a persisted track.')
    const target: Track = { ...persistedTrack, clips: [] }
    // The renderer's projection: inserted clips take their buffer from the clip buffer cache, as resolveTimelineTracks does.
    const [inserted, setInserted] = createSignal<Clip[]>([])
    const [decoded, setDecoded] = createSignal(new Map<string, AudioBuffer>())
    const tracks = () => [retained, { ...target, clips: inserted().map((clip) => ({ ...clip, buffer: decoded().get(clip.id) ?? null })) }]
    const preloaded: string[] = []
    const f = await mountStep5Playback({ projectId: project.id, tracks, playbackInputs: inputs, desiredFx: fx,
      renderState: async () => ({ fx: fx(), automationEnvelopes: [] }) })
    mounted = f
    await f.playback.handlePlay(untrack(tracks)); await f.frame()
    const transaction = createAudioImportTransaction({
      project: { projectId: () => project.id, userId: () => undefined, tracks: () => [target], isActiveProjectTrack: () => true },
      clips: {
        buffers: {
          writer: { storeBuffer: () => undefined, storeBuffers: () => undefined, removeBuffer: () => undefined },
          getBuffer: (clipId) => decoded().get(clipId),
          getMediaStatus: () => undefined,
          // What useClipBuffers delivers once the clip's local asset decodes.
          preload: async (clipId) => {
            preloaded.push(clipId)
            setDecoded((current) => new Map(current).set(clipId, new ImportedAudioBuffer(12_000, 2)))
          },
        },
        insertLocalClip: (_trackId, clip) => setInserted((current) => [...current, clip]),
        selectClip: () => undefined,
        pushTrackClipCreateHistory: () => undefined,
      },
      cloud: { uploadToR2: async () => null },
      rollback: { removeLocalTrack: async () => undefined, removeCloudTrack: async () => undefined },
    })
    const edit = f.mark()
    const result = await transaction.createUploadedFileClip({
      file: new File(['project-owned-source'], 'changed.wav', { type: 'audio/wav' }),
      source: { durationSec: 0.25, sampleRate: 48_000, channelCount: 2 },
      track: target,
      startSec: 0,
    })
    await settleStep5Playback(); await f.frame(); await settleStep5Playback()
    if (result.status !== 'created') throw new Error('Expected a created local clip.')
    const calls = f.host.calls.slice(edit.calls)
    expect({ preloaded, buffered: untrack(tracks)[1]?.clips.every((clip) => clip.buffer instanceof ImportedAudioBuffer),
      counts: f.counts(edit), installed: calls.includes('install'), published: calls.includes('revision.publish'), faults: f.faults })
      .toEqual({ preloaded: [result.clipId], buffered: true,
        counts: { scheduleCompiles: 1, previewCompiles: 0, publishes: 1, teardowns: 0, liveSends: 0, previewDisposals: 0 },
        installed: true, published: true, faults: [] })
  } finally {
    await mounted?.close()
    restoreWindow()
    if (!audioBuffer) Reflect.deleteProperty(globalThis, 'AudioBuffer')
    if (storage) Object.defineProperty(navigator, 'storage', storage)
    else Reflect.deleteProperty(navigator, 'storage')
  }
})
