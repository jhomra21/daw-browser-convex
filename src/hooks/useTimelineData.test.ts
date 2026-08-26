import { expect, test } from 'bun:test'

import { deleteCurrentCloudProjectAccess, leaveCloudProjectAccess } from './useTimelineData'

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
