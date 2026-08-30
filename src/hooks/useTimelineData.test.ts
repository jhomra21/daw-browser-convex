import { expect, test } from 'bun:test'

import {
  deleteCurrentCloudProjectAccess,
  deleteCurrentLocalProjectAccess,
  leaveCloudProjectAccess,
} from './useTimelineData'

test('settles recording before revoking cloud project membership', async () => {
  const events: string[] = []
  await leaveCloudProjectAccess({
    settleActiveRecording: async () => { events.push('settle') },
    flushMidiWrites: async () => { events.push('flush') },
    revokeAccess: async () => { events.push('revoke') },
    purgeCache: async () => { events.push('purge') },
    reloadProjects: async () => { events.push('reload') },
  })
  expect(events).toEqual(['settle', 'flush', 'revoke', 'purge', 'reload'])
})

test('persists final MIDI before deleting and navigating from the current cloud project', async () => {
  const events: string[] = []
  await deleteCurrentCloudProjectAccess({
    settleActiveRecording: async () => { events.push('final-midi-persist') },
    deleteCurrentProject: async () => {
      events.push('delete')
      return { status: 'deleted', destinationProjectId: 'next-project' }
    },
    navigate: async () => { events.push('navigate') },
  })
  expect(events).toEqual(['final-midi-persist', 'delete', 'navigate'])
})

test('cancels current cloud project deletion when MIDI settlement fails', async () => {
  const events: string[] = []
  await expect(deleteCurrentCloudProjectAccess({
    settleActiveRecording: async () => {
      events.push('settle')
      throw new Error('MIDI recording could not be saved.')
    },
    deleteCurrentProject: async () => {
      events.push('delete')
      return { status: 'deleted', destinationProjectId: 'next-project' }
    },
    navigate: async () => { events.push('navigate') },
  })).rejects.toThrow('MIDI recording could not be saved.')
  expect(events).toEqual(['settle'])
})

test('navigates to a prepared local replacement before deleting the current local project', async () => {
  const events: string[] = []
  await deleteCurrentLocalProjectAccess({
    flushPendingWrites: async () => { events.push('flush') },
    createDestination: async () => {
      events.push('create')
      return 'next-project'
    },
    reloadProjects: async () => { events.push('reload') },
    navigate: async (projectId) => { events.push(`navigate:${projectId}`) },
    deleteCurrentProject: async () => { events.push('delete') },
  })
  expect(events).toEqual([
    'flush',
    'create',
    'reload',
    'navigate:next-project',
    'flush',
    'delete',
    'reload',
  ])
})

test('keeps the current local project when replacement navigation fails', async () => {
  const events: string[] = []
  await expect(deleteCurrentLocalProjectAccess({
    flushPendingWrites: async () => { events.push('flush') },
    createDestination: async () => {
      events.push('create')
      return 'next-project'
    },
    reloadProjects: async () => { events.push('reload') },
    navigate: async () => {
      events.push('navigate')
      throw new Error('Project transition failed.')
    },
    deleteCurrentProject: async () => { events.push('delete') },
  })).rejects.toThrow('Project transition failed.')
  expect(events).toEqual(['flush', 'create', 'reload', 'navigate'])
})
