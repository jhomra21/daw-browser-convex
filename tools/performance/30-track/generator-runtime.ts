import { createLocalProject, deleteLocalProject } from "../../../src/lib/local-project-db"
import { createLocalAsset } from "../../../src/lib/local-assets"
import { exportDawProjectArchive, importDawProjectArchive } from "../../../src/lib/project-archive"
import { createLocalTimelineRepository } from "../../../src/lib/timeline-repository/local-timeline-repository"
import { encodePlanarFloat32Wav } from "@daw-browser/audio-engine/recording-encode-wav"
import { localControlCapabilitiesV2 } from "@daw-browser/control"
import {
  sampleThirtyTrackSource,
  thirtyTrackClipGain,
  thirtyTrackCount,
  thirtyTrackClipAt,
  thirtyTrackProjectName,
  thirtyTrackSampleRate,
  thirtyTrackSemanticManifest,
  thirtyTrackSourceDurationSec,
  thirtyTrackTotalClipCount,
  thirtyTrackTotalTrackCount,
  thirtyTrackTrackAt,
  thirtyTrackTimelineDurationSec,
} from "./spec"
import {
  assertThirtyTrackSnapshot,
  createTierTwoControlClient,
  createTierTwoControlRequest,
  tierTwoRequiredActionKinds,
} from "./tier-two"

const uploadUrl = new URLSearchParams(location.search).get("upload")
if (!uploadUrl) throw new Error("Fixture generator upload URL is missing.")

const setStage = (stage: string) => {
  Object.defineProperty(globalThis, "__thirtyTrackFixtureStage", {
    configurable: true,
    value: stage,
  })
}

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
  setStage("create-project")
  const project = await createLocalProject(thirtyTrackProjectName)
  try {
    setStage("create-wav")
    const source = await createWavFile()
    setStage("create-asset")
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
    setStage("bootstrap-audio-tracks")
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
    const control = createTierTwoControlClient(project.id)
    setStage("capabilities")
    for (const action of tierTwoRequiredActionKinds) {
      if (!localControlCapabilitiesV2.actionKinds.includes(action)) throw new Error(`Tier 2 fixture requires unsupported action ${action}.`)
    }
    setStage("snapshot-before-tier2")
    const beforeTierTwo = await control.snapshotV2()
    const request = createTierTwoControlRequest(project.id, beforeTierTwo.project.revision)
    setStage("preview-tier2")
    const preview = await control.previewV1(request)
    if (!preview.applied) throw new Error("Tier 2 control preview did not apply any changes.")
    const approvalToken = preview.approval?.required
      ? (await control.requestApprovalV1(request)).approvalToken
      : undefined
    setStage("commit-tier2")
    const commit = await control.commitV1({
      ...request,
      idempotencyKey: "fixture-30-track-v2-tier2",
      approvalToken,
    })
    if (!commit.applied) throw new Error("Tier 2 control commit did not apply any changes.")
    setStage("snapshot-after-tier2")
    const persisted = await control.snapshotV2()
    if (persisted.tracks.length !== thirtyTrackTotalTrackCount || persisted.clips.length !== thirtyTrackTotalClipCount) {
      throw new Error("Generated project does not contain exactly 31 tracks and 31 clips.")
    }
    assertThirtyTrackSnapshot(persisted)
    const semanticManifest = thirtyTrackSemanticManifest
    setStage("export")
    const archive = await exportDawProjectArchive(project.id)
    setStage("verify-import")
    const restoredProjectId = await importDawProjectArchive(new File(
      [archive],
      `${thirtyTrackSemanticManifest.fixtureVersion}.dawproject`,
      { type: "application/vnd.dawproject" },
    ))
    try {
      const restoredControl = createTierTwoControlClient(restoredProjectId)
      assertThirtyTrackSnapshot(await restoredControl.snapshotV2())
    } finally {
      await deleteLocalProject(restoredProjectId)
    }
    setStage("upload")
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
        tracks: persisted.tracks.length,
        clips: persisted.clips.length,
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
