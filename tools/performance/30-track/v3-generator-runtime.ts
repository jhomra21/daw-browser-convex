import { createLocalProject, deleteLocalProject } from "../../../src/lib/local-project-db"
import { createLocalAsset, listLocalAssets, readLocalAssetBytes } from "../../../src/lib/local-assets"
import { createLocalTimelineRepository } from "../../../src/lib/timeline-repository/local-timeline-repository"
import { listLocalEffects, setLocalEffect } from "../../../src/lib/local-effects"
import { createDefaultSynthParams } from "@daw-browser/shared"
import { exportDawProjectArchiveStreamed, importDawProjectArchiveStreamed } from "../../../src/lib/project-archive"
import { planThirtyTrackV3 } from "./v3-spec"
import { writeThirtyTrackV3MediaFile } from "./v3-media-file"
import { assertThirtyTrackV3ArchiveBudget, assertThirtyTrackV3Fixture, assertThirtyTrackV3Midi, assertThirtyTrackV3WavSamples } from "./v3-fixture"

const uploadUrl = new URLSearchParams(location.search).get("upload")
if (!uploadUrl) throw new Error("V3 fixture upload URL is missing.")

const stage = (value: string) => {
  Object.defineProperty(globalThis, "__thirtyTrackV3Stage", { configurable: true, value })
}

const verify = async (projectId: string) => {
  const plan = planThirtyTrackV3()
  const assets = await listLocalAssets(projectId)
  const clips = await createLocalTimelineRepository(projectId).loadSnapshot()
  const assetIndexes = new Map(assets.map((asset) => [asset.id, Number(/^30-track-v3-source-(\d+)\.wav$/.exec(asset.name)?.[1])]))
  const clipsByTrack = new Map(clips.clips.map((clip) => [clip.trackId, clip]))
  assertThirtyTrackV3Fixture(plan, clips.tracks.map((track) => {
    const clip = clipsByTrack.get(track.id)
    return {
      index: track.index,
      kind: track.kind,
      asset: clip?.sourceAssetId ? assetIndexes.get(clip.sourceAssetId) ?? null : null,
      notes: clip?.midi?.notes.length ?? 0,
    }
  }), assets.length)
  if (clips.clips.length !== 30) throw new Error("V3 requires exactly 30 active clips.")
  for (const source of plan.audio) {
    const asset = assets.find((item) => assetIndexes.get(item.id) === source.trackIndex)
    if (!asset || asset.sizeBytes !== source.uncompressedBytes + 44
      || asset.sampleRate !== source.sampleRate || asset.channelCount !== source.channelCount
      || asset.durationSec !== source.durationSec) throw new Error(`V3 source ${source.trackIndex} metadata mismatch.`)
    const bytes = await readLocalAssetBytes(projectId, asset.id)
    if (bytes.status !== "ready" || bytes.file.size !== source.uncompressedBytes + 44) {
      throw new Error(`V3 source ${source.trackIndex} bytes unavailable.`)
    }
    const header = new DataView(await bytes.file.slice(0, 44).arrayBuffer())
    if (header.getUint32(24, true) !== source.sampleRate
      || header.getUint16(22, true) !== source.channelCount
      || header.getUint32(40, true) !== source.uncompressedBytes) {
      throw new Error(`V3 source ${source.trackIndex} WAV header mismatch.`)
    }
    await assertThirtyTrackV3WavSamples(source, bytes.file)
  }
  for (const instrument of plan.instruments) {
    const track = clips.tracks.find((item) => item.index === instrument.index)
    const clip = track ? clipsByTrack.get(track.id) : undefined
    if (!clip?.midi) throw new Error(`V3 instrument ${instrument.index} MIDI clip missing.`)
    assertThirtyTrackV3Midi(instrument, clip.midi.notes)
    if (!(await listLocalEffects(projectId)).some((effect) => effect.targetId === track.id && effect.effect === "instrument")) {
      throw new Error(`V3 instrument ${instrument.index} has no persisted native instrument.`)
    }
  }
  return { tracks: clips.tracks.length, clips: clips.clips.length, assets: assets.length }
}

const run = async () => {
  const plan = planThirtyTrackV3()
  stage("create-project")
  const project = await createLocalProject("30-track-v3")
  let restoredId: string | undefined
  const scratch = await navigator.storage.getDirectory()
  const directoryName = `v3-fixture-${crypto.randomUUID()}`
  const directory = await scratch.getDirectoryHandle(directoryName, { create: true })
  try {
    const repository = createLocalTimelineRepository(project.id)
    const seeded = (await repository.loadSnapshot()).tracks[0]
    if (!seeded) throw new Error("V3 project has no seeded track.")
    for (const source of plan.audio) {
      stage(`source-${source.trackIndex}`)
      const file = await writeThirtyTrackV3MediaFile(source, directory)
      try {
        const asset = await createLocalAsset({
          projectId: project.id,
          file,
          metadata: {
            sourceKind: "recording",
            durationSec: source.durationSec,
            sampleRate: source.sampleRate,
            channelCount: source.channelCount,
          },
        })
        const track = source.trackIndex === 0
          ? await repository.updateTrack({ trackId: seeded.id, name: `Audio ${source.trackIndex + 1}`, index: 0 })
          : await repository.createTrack({ index: source.trackIndex, kind: "audio", name: `Audio ${source.trackIndex + 1}` })
        if (!track) throw new Error("V3 seeded audio track is missing.")
        await repository.createClip({
          trackId: track.id,
          name: `Source ${source.trackIndex + 1}`,
          startSec: 0,
          duration: Math.min(60, source.durationSec),
          sourceAssetId: asset.id,
          sourceAssetKey: asset.id,
          sourceKind: "recording",
          sourceDurationSec: source.durationSec,
          sourceSampleRate: source.sampleRate,
          sourceChannelCount: source.channelCount,
          gain: 0.1,
        })
      } finally {
        await directory.removeEntry(file.name)
      }
    }
    stage("midi")
    for (const instrument of plan.instruments) {
      const track = await repository.createTrack({
        index: instrument.index, kind: "instrument", name: `Instrument ${instrument.index - 23}`,
      })
      await setLocalEffect(project.id, track.id, "instrument", {
        kind: "synth",
        instanceId: `instrument:v3-${instrument.index}`,
        params: createDefaultSynthParams(),
      })
      await repository.createClip({
        trackId: track.id,
        name: `MIDI ${instrument.index - 23}`,
        startSec: 0,
        duration: 8,
        midi: { wave: "sine", notes: instrument.notes },
      })
    }
    await verify(project.id)
    stage("export")
    const archiveName = `${directoryName}.dawproject`
    const archiveHandle = await directory.getFileHandle(archiveName, { create: true })
    const writable = await archiveHandle.createWritable()
    try {
      await exportDawProjectArchiveStreamed(project.id, (chunk) => writable.write(chunk))
      await writable.close()
    } catch (error) {
      await writable.abort().catch(() => undefined)
      throw error
    }
    const archive = await archiveHandle.getFile()
    assertThirtyTrackV3ArchiveBudget(archive.size)
    stage("verify-import")
    restoredId = await importDawProjectArchiveStreamed(new File([archive], archiveName, { type: "application/vnd.dawproject" }))
    await verify(restoredId)
    await deleteLocalProject(restoredId)
    restoredId = undefined
    stage("upload")
    const response = await fetch(uploadUrl, {
      method: "POST",
      headers: { "content-type": "application/vnd.dawproject" },
      body: archive,
    })
    if (!response.ok) throw new Error(`V3 stream upload failed: HTTP ${response.status}.`)
    Object.defineProperty(globalThis, "__thirtyTrackV3Result", {
      configurable: true,
      value: { version: plan.version, ...await verify(project.id), bytes: archive.size },
    })
  } finally {
    if (restoredId) await deleteLocalProject(restoredId).catch(() => undefined)
    await deleteLocalProject(project.id).catch(() => undefined)
    await scratch.removeEntry(directoryName, { recursive: true }).catch(() => undefined)
  }
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters
void run().catch((error: unknown) => {
  Object.defineProperty(globalThis, "__thirtyTrackV3Result", {
    configurable: true,
    value: { error: error instanceof Error ? error.message : String(error) },
  })
})
