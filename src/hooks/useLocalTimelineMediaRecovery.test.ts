import "fake-indexeddb/auto"
import { createRoot, createSignal } from "solid-js"
import { expect, test } from "bun:test"
import { AudioEngine } from "@daw-browser/audio-engine/audio-engine"
import { createLocalProject } from "~/lib/local-project-db"
import { createLocalTimelineRepository } from "~/lib/timeline-repository/local-timeline-repository"
import { createLocalControlService } from "~/lib/local-control/local-control-service"
import { useMissingMediaRecovery } from "./useLocalTimelineMediaRecovery"

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
