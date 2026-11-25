import "fake-indexeddb/auto"
import { createRoot, createSignal, flush } from "solid-js"
import { expect, test } from "bun:test"
import type { ExternalSidechainRoute } from "@daw-browser/timeline-core/types"
import { setLocalEffectInstance } from "~/lib/local-effects"
import { createLocalTimelineRepository } from "~/lib/timeline-repository/local-timeline-repository"
import { useLocalSidechainRoutes } from "./useLocalSidechainRoutes"

const waitFor = async (read: () => ExternalSidechainRoute[], expected: ExternalSidechainRoute[]) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (JSON.stringify(read()) === JSON.stringify(expected)) return
    await Bun.sleep(5)
  }

  expect(read()).toEqual(expected)
}

test("follows local sidechain route writes, source deletion, and project switches", async () => {
  const projectId = `project:sidechain-routes-${crypto.randomUUID()}`
  const repository = createLocalTimelineRepository(projectId)
  await repository.createTrack({ id: "drums", kind: "audio" })
  await repository.createTrack({ id: "perc", kind: "audio" })
  await repository.createTrack({ id: "bass", kind: "audio" })
  await setLocalEffectInstance(projectId, "drums", "gate", {}, { instanceId: "gate-1" })
  const [id, setId] = createSignal(projectId)
  const routes = createRoot(() => useLocalSidechainRoutes(id, () => null))
  flush()
  await waitFor(routes, [])

  const perc = { sourceTrackId: "perc", targetTrackId: "drums", effectInstanceId: "gate-1" }
  await repository.setSidechainRoute(perc)
  await waitFor(routes, [perc])

  const bass = { ...perc, sourceTrackId: "bass" }
  await repository.setSidechainRoute(bass)
  await waitFor(routes, [bass])

  await repository.removeSidechainRoute("drums", "gate-1")
  await waitFor(routes, [])

  await repository.setSidechainRoute(perc)
  await waitFor(routes, [perc])
  await repository.deleteTrack("perc")
  await waitFor(routes, [])

  await repository.setSidechainRoute(bass)
  await waitFor(routes, [bass])
  setId("cloud-project")
  flush()
  await waitFor(routes, [])
})

test("shows the loaded snapshot's routes until the first read of the project lands", async () => {
  const projectId = `project:sidechain-seed-${crypto.randomUUID()}`
  const repository = createLocalTimelineRepository(projectId)
  await repository.createTrack({ id: "drums", kind: "audio" })
  await repository.createTrack({ id: "perc", kind: "audio" })
  await setLocalEffectInstance(projectId, "drums", "gate", {}, { instanceId: "gate-1" })
  const perc = { sourceTrackId: "perc", targetTrackId: "drums", effectInstanceId: "gate-1" }
  await repository.setSidechainRoute(perc)

  const [snapshot, setSnapshot] = createSignal<{ projectId: string; sidechainRoutes: ExternalSidechainRoute[] } | null>(
    { projectId, sidechainRoutes: [perc] },
  )
  const routes = createRoot(() => useLocalSidechainRoutes(() => projectId, snapshot))
  flush()
  expect(routes()).toEqual([perc])

  await repository.removeSidechainRoute("drums", "gate-1")
  await waitFor(routes, [])
  setSnapshot({ projectId, sidechainRoutes: [perc] })
  flush()
  expect(routes()).toEqual([])

  const [otherProject] = createSignal(`project:sidechain-seed-other-${crypto.randomUUID()}`)
  const other = createRoot(() => useLocalSidechainRoutes(otherProject, snapshot))
  flush()
  expect(other()).toEqual([])
})
