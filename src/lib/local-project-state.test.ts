import 'fake-indexeddb/auto'
import { expect, spyOn, test } from 'bun:test'

import { subscribeToLocalProjectChanges, subscribeToLocalProjectStateChanges } from './local-project-changes'
import { loadLocalProjectState, saveLocalProjectState } from './local-project-state'

test('isolates project-state persistence notifications while retaining final durability', async () => {
  const projectId = `project:state-notification-${crypto.randomUUID()}`
  let projectChanges = 0
  let projectStateChanges = 0
  const unsubscribeProjectChanges = subscribeToLocalProjectChanges(projectId, () => {
    projectChanges += 1
  })
  const unsubscribeProjectStateChanges = subscribeToLocalProjectStateChanges(projectId, () => {
    projectStateChanges += 1
  })

  try {
    await saveLocalProjectState(projectId, 'timelineScale', 128)
    await saveLocalProjectState(projectId, 'timelineScale', 256)

    expect(projectChanges).toBe(0)
    expect(projectStateChanges).toBe(2)
    expect(await loadLocalProjectState<number>(projectId, 'timelineScale')).toBe(256)
  } finally {
    unsubscribeProjectChanges()
    unsubscribeProjectStateChanges()
  }
})
test('coalesces concurrent project-state reads and refreshes after the burst', async () => {
  const projectId = `project:state-burst-${crypto.randomUUID()}`
  await saveLocalProjectState(projectId, 'timelineScale', 128)

  const getAllSpy = spyOn(IDBObjectStore.prototype, 'getAll')
  try {
    const loaded = await Promise.all([
      loadLocalProjectState<number>(projectId, 'timelineScale'),
      loadLocalProjectState<number>(projectId, 'missing'),
      loadLocalProjectState<number>(projectId, 'timelineScale'),
    ])

    expect(loaded).toEqual([128, undefined, 128])
    expect(getAllSpy).toHaveBeenCalledTimes(1)

    await expect(loadLocalProjectState<number>(projectId, 'timelineScale')).resolves.toBe(128)
    expect(getAllSpy).toHaveBeenCalledTimes(2)

    await saveLocalProjectState(projectId, 'timelineScale', 256)
    await expect(loadLocalProjectState<number>(projectId, 'timelineScale')).resolves.toBe(256)
    expect(getAllSpy).toHaveBeenCalledTimes(3)
  } finally {
    getAllSpy.mockRestore()
  }
})

test('keeps concurrent project-state loads isolated by project', async () => {
  const firstProjectId = `project:state-isolation-first-${crypto.randomUUID()}`
  const secondProjectId = `project:state-isolation-second-${crypto.randomUUID()}`
  await saveLocalProjectState(firstProjectId, 'timelineScale', 128)
  await saveLocalProjectState(secondProjectId, 'timelineScale', 256)

  const getAllSpy = spyOn(IDBObjectStore.prototype, 'getAll')
  try {
    await expect(Promise.all([
      loadLocalProjectState<number>(firstProjectId, 'timelineScale'),
      loadLocalProjectState<number>(secondProjectId, 'timelineScale'),
    ])).resolves.toEqual([128, 256])
    expect(getAllSpy).toHaveBeenCalledTimes(2)
  } finally {
    getAllSpy.mockRestore()
  }
})
