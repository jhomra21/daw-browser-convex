import { createLocalProject, deleteLocalProject } from "../../../src/lib/local-project-db"
import { createLocalAsset } from "../../../src/lib/local-assets"
import { exportDawProjectArchive } from "../../../src/lib/project-archive"
import { createLocalTimelineRepository } from "../../../src/lib/timeline-repository/local-timeline-repository"
import { encodePlanarFloat32Wav } from "@daw-browser/audio-engine/recording-encode-wav"
import {
  assertThirtyTrackSemanticManifest,
  assertThirtyTrackSemanticManifestExact,
  sampleThirtyTrackSource,
  thirtyTrackClipGain,
  thirtyTrackCount,
  thirtyTrackClipAt,
  thirtyTrackProjectName,
  thirtyTrackSampleRate,
  thirtyTrackSemanticManifest,
  thirtyTrackSourceDurationSec,
  thirtyTrackTrackAt,
  thirtyTrackTimelineDurationSec,
} from "./spec"

const uploadUrl = new URLSearchParams(location.search).get("upload")
if (!uploadUrl) throw new Error("Fixture generator upload URL is missing.")

const createWavFile = async () => {
  const capturedFrames = thirtyTrackSampleRate * thirtyTrackSourceDurationSec
  const maxBytes = capturedFrames * 2 * Float32Array.BYTES_PER_ELEMENT + 4096
  const chunkSize = 1024 * 1024
  const chunks = new Map<number, Uint8Array>()
  let byteLength = 0
  const sink = {
    write: async (chunk: { position: number; data: Uint8Array }) => {
      if (chunk.position < 0) throw new Error("WAV sink received a negative position.")
      if (chunk.position + chunk.data.byteLength > maxBytes) throw new Error("WAV sink exceeded its bounded output.")
      let offset = 0
      while (offset < chunk.data.byteLength) {
        const position = chunk.position + offset
        const chunkIndex = Math.floor(position / chunkSize)
        const chunkOffset = position % chunkSize
        const writable = chunks.get(chunkIndex) ?? new Uint8Array(chunkSize)
        chunks.set(chunkIndex, writable)
        const copyLength = Math.min(chunk.data.byteLength - offset, chunkSize - chunkOffset)
        writable.set(chunk.data.subarray(offset, offset + copyLength), chunkOffset)
        offset += copyLength
      }
      byteLength = Math.max(byteLength, chunk.position + chunk.data.byteLength)
    },
    close: async () => undefined,
    abort: async () => undefined,
  }
  const blockSize = 16_384
  const blocks = async function* () {
    for (let start = 0; start < capturedFrames; start += blockSize) {
      const frameCount = Math.min(blockSize, capturedFrames - start)
      const left = new Float32Array(frameCount)
      const right = new Float32Array(frameCount)
      for (let index = 0; index < frameCount; index += 1) {
        const sample = sampleThirtyTrackSource(start + index)
        left[index] = sample.left
        right[index] = sample.right
      }
      yield { frameCount, channels: [left, right] }
    }
  }
  await encodePlanarFloat32Wav({
    sampleRate: thirtyTrackSampleRate,
    channelCount: 2,
    capturedFrames,
    blocks: blocks(),
    sink,
  })
  const bytes = new Uint8Array(byteLength)
  for (const [chunkIndex, chunk] of chunks) {
    const start = chunkIndex * chunkSize
    bytes.set(chunk.subarray(0, Math.min(chunk.byteLength, byteLength - start)), start)
  }
  return new File([bytes], "30-track-source.wav", { type: "audio/wav" })
}

const run = async () => {
  const project = await createLocalProject(thirtyTrackProjectName)
  try {
    const source = await createWavFile()
    const asset = await createLocalAsset({
      projectId: project.id,
      file: source,
      metadata: {
        sourceKind: "recording",
        durationSec: thirtyTrackSourceDurationSec,
        sampleRate: thirtyTrackSampleRate,
        channelCount: 2,
      },
    })
    const repository = createLocalTimelineRepository(project.id)
    const initial = await repository.loadSnapshot()
    const tracks = [...initial.tracks]
    const firstTrack = tracks[0]
    if (!firstTrack) throw new Error("Generated project is missing its seeded first track.")
    await repository.updateTrack({
      trackId: firstTrack.id,
      name: thirtyTrackTrackAt(0).name,
      volume: 1,
      color: thirtyTrackTrackAt(0).color,
      index: 0,
    })
    tracks[0] = (await repository.loadSnapshot()).tracks[0]!
    while (tracks.length < thirtyTrackCount) {
      tracks.push(await repository.createTrack({
        index: tracks.length,
        kind: "audio",
        name: thirtyTrackTrackAt(tracks.length).name,
        volume: 1,
        color: thirtyTrackTrackAt(tracks.length).color,
      }))
    }
    for (const [index, track] of tracks.entries()) {
      await repository.createClip({
        trackId: track.id,
        name: thirtyTrackClipAt(index).name,
        startSec: 0,
        duration: thirtyTrackTimelineDurationSec,
        sourceAssetId: asset.id,
        sourceAssetKey: asset.id,
        sourceKind: "recording",
        sourceDurationSec: thirtyTrackSourceDurationSec,
        sourceSampleRate: thirtyTrackSampleRate,
        sourceChannelCount: 2,
        bufferOffsetSec: index,
        gain: thirtyTrackClipGain,
        color: thirtyTrackSemanticManifest.timeline.colors[index % thirtyTrackSemanticManifest.timeline.colors.length],
      })
    }
    const snapshot = await repository.loadSnapshot()
    if (snapshot.tracks.length !== thirtyTrackCount || snapshot.clips.length !== thirtyTrackCount) {
      throw new Error("Generated project does not contain exactly 30 tracks and 30 clips.")
    }
    const semanticManifest = {
      fixtureVersion: thirtyTrackSemanticManifest.fixtureVersion,
      sampleRate: thirtyTrackSemanticManifest.sampleRate,
      projectName: project.name,
      source: thirtyTrackSemanticManifest.source,
      timeline: {
        ...thirtyTrackSemanticManifest.timeline,
        tracks: snapshot.tracks.map((track) => ({
          index: track.index,
          name: track.name,
          kind: track.kind,
          volume: track.volume,
          color: track.color,
        })),
        clips: [...snapshot.clips]
          .sort((left, right) => (left.bufferOffsetSec ?? -1) - (right.bufferOffsetSec ?? -1))
          .map((clip, index) => ({
          index,
          name: clip.name,
          trackIndex: snapshot.tracks.find((track) => track.id === clip.trackId)?.index ?? -1,
          startSec: clip.startSec,
          durationSec: clip.duration,
          sourceOffsetSec: clip.bufferOffsetSec ?? -1,
          gain: clip.gain,
          color: clip.color,
          sourceKind: clip.sourceKind,
          sourceDurationSec: clip.sourceDurationSec,
          sourceSampleRate: clip.sourceSampleRate,
          sourceChannelCount: clip.sourceChannelCount,
          })),
      },
      asset: {
        name: asset.name,
        sourceKind: asset.sourceKind,
        durationSec: asset.durationSec,
        sampleRate: asset.sampleRate,
        channelCount: asset.channelCount,
      },
    }
    assertThirtyTrackSemanticManifest(semanticManifest)
    assertThirtyTrackSemanticManifestExact(semanticManifest)
    const archive = await exportDawProjectArchive(project.id)
    const response = await fetch(uploadUrl, {
      method: "POST",
      headers: { "content-type": "application/vnd.dawproject" },
      body: archive,
    })
    if (!response.ok) throw new Error(`Fixture archive upload failed with HTTP ${response.status}.`)
    Object.defineProperty(globalThis, "__thirtyTrackFixtureResult", {
      configurable: true,
      value: {
        semanticManifest,
        projectId: project.id,
        assetId: asset.id,
        tracks: snapshot.tracks.length,
        clips: snapshot.clips.length,
      },
    })
  } finally {
    if (project.id) await deleteLocalProject(project.id).catch(() => undefined)
  }
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters
void run().catch((error: unknown) => {
  Object.defineProperty(globalThis, "__thirtyTrackFixtureResult", {
    configurable: true,
    value: { error: error instanceof Error ? error.message : String(error) },
  })
})
