import { expect, test } from 'bun:test'

import { settlePopstateProjectTransition } from './useTimelineProjectRoute'

test('settles recording before resolving a popstate project transition', async () => {
  const events: string[] = []
  let settle: (() => void) | undefined
  const transition = settlePopstateProjectTransition({
    currentProjectId: 'project-a',
    nextProjectId: 'project-b',
    settle: () => new Promise<void>((resolve) => {
      events.push('settle')
      settle = resolve
    }),
    resolve: () => { events.push('resolve') },
    restore: () => { events.push('restore') },
  })

  expect(events).toEqual(['settle'])
  settle?.()
  await transition
  expect(events).toEqual(['settle', 'resolve'])
})

test('restores the current URL when recording settlement rejects during popstate', async () => {
  const events: string[] = []
  await settlePopstateProjectTransition({
    currentProjectId: 'project-a',
    nextProjectId: 'project-b',
    settle: async () => { throw new Error('finalization failed') },
    resolve: () => { events.push('resolve') },
    restore: () => { events.push('restore') },
  })
  expect(events).toEqual(['restore'])
})
