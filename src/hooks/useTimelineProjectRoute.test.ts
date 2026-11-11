import { expect, test } from 'bun:test'

import {
  createProjectFromDashboard,
  openProjectFromDashboard,
  settlePopstateProjectTransition,
} from './useTimelineProjectRoute'

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

test('closes the dashboard only after a project is mounted, including the current project', async () => {
  let mountedProjectId = 'project-a'
  let dashboard: string | null = 'projects'
  const latestRequest = { current: 0 }
  const url = new URL('https://daw.test/?projectId=project-a&dashboard=projects')
  const closeDashboard = () => {
    dashboard = null
    url.searchParams.delete('dashboard')
  }

  await openProjectFromDashboard({
    nextProjectId: 'project-b',
    open: async () => {},
    mountedProjectId: () => mountedProjectId,
    closeDashboard,
    latestRequest,
  })
  expect(dashboard).toBe('projects')
  expect(url.searchParams.get('dashboard')).toBe('projects')

  mountedProjectId = 'project-b'
  await openProjectFromDashboard({
    nextProjectId: 'project-b',
    open: async () => {},
    mountedProjectId: () => mountedProjectId,
    closeDashboard,
    latestRequest,
  })
  expect(dashboard).toBeNull()
  expect(url.searchParams.has('dashboard')).toBe(false)

  dashboard = 'projects'
  url.searchParams.set('dashboard', 'projects')
  mountedProjectId = 'project-a'
  await openProjectFromDashboard({
    nextProjectId: 'project-a',
    open: async () => {},
    mountedProjectId: () => mountedProjectId,
    closeDashboard,
    latestRequest,
  })
  expect(dashboard).toBeNull()
  expect(url.searchParams.has('dashboard')).toBe(false)
})

test('closes the dashboard after successful creation but preserves it on failure', async () => {
  let dashboard: string | null = 'projects'
  const latestRequest = { current: 0 }
  const url = new URL('https://daw.test/?dashboard=projects')
  const closeDashboard = () => {
    dashboard = null
    url.searchParams.delete('dashboard')
  }

  await createProjectFromDashboard({
    create: async () => ({ status: 'error' }),
    closeDashboard,
    latestRequest,
  })
  expect(dashboard).toBe('projects')
  expect(url.searchParams.get('dashboard')).toBe('projects')

  const outcome = await createProjectFromDashboard({
    create: async () => ({ status: 'success' }),
    closeDashboard,
    latestRequest,
  })
  expect(outcome.status).toBe('success')
  expect(dashboard).toBeNull()
  expect(url.searchParams.has('dashboard')).toBe(false)
})

test('only the latest overlapping dashboard request may close the dashboard', async () => {
  let dashboard: string | null = 'projects'
  let mountedProjectId = 'project-a'
  const latestRequest = { current: 0 }
  let finishB: (() => void) | undefined
  let finishC: (() => void) | undefined
  const closeDashboard = () => { dashboard = null }

  const openB = openProjectFromDashboard({
    nextProjectId: 'project-b',
    open: () => new Promise<void>((resolve) => { finishB = resolve }),
    mountedProjectId: () => mountedProjectId,
    closeDashboard,
    latestRequest,
  })
  const openC = openProjectFromDashboard({
    nextProjectId: 'project-c',
    open: () => new Promise<void>((resolve) => { finishC = resolve }),
    mountedProjectId: () => mountedProjectId,
    closeDashboard,
    latestRequest,
  })

  mountedProjectId = 'project-b'
  finishB?.()
  await openB
  expect(dashboard).toBe('projects')

  mountedProjectId = 'project-c'
  finishC?.()
  await openC
  expect(dashboard).toBeNull()

  dashboard = 'projects'
  await expect(createProjectFromDashboard({
    create: async () => ({ status: 'error' }),
    closeDashboard,
    latestRequest,
  })).resolves.toEqual({ status: 'error' })
  expect(dashboard).toBe('projects')
})

test('keeps the dashboard open when the latest overlapping open fails', async () => {
  let dashboard: string | null = 'projects'
  let mountedProjectId = 'project-a'
  const latestRequest = { current: 0 }
  let finishB: (() => void) | undefined
  let failC: ((error: Error) => void) | undefined
  const closeDashboard = () => { dashboard = null }

  const openB = openProjectFromDashboard({
    nextProjectId: 'project-b',
    open: () => new Promise<void>((resolve) => { finishB = resolve }),
    mountedProjectId: () => mountedProjectId,
    closeDashboard,
    latestRequest,
  })
  const openC = openProjectFromDashboard({
    nextProjectId: 'project-c',
    open: () => new Promise<void>((_resolve, reject) => { failC = reject }),
    mountedProjectId: () => mountedProjectId,
    closeDashboard,
    latestRequest,
  })

  mountedProjectId = 'project-b'
  finishB?.()
  await openB
  expect(dashboard).toBe('projects')
  failC?.(new Error('open failed'))
  await expect(openC).rejects.toThrow('open failed')
  expect(dashboard).toBe('projects')
})

test('an overlapping New request supersedes an earlier Open request', async () => {
  let dashboard: string | null = 'projects'
  let mountedProjectId = 'project-a'
  const latestRequest = { current: 0 }
  let finishOpen: (() => void) | undefined
  let failCreate: ((outcome: { status: 'error' }) => void) | undefined
  const closeDashboard = () => { dashboard = null }

  const open = openProjectFromDashboard({
    nextProjectId: 'project-b',
    open: () => new Promise<void>((resolve) => { finishOpen = resolve }),
    mountedProjectId: () => mountedProjectId,
    closeDashboard,
    latestRequest,
  })
  const create = createProjectFromDashboard({
    create: () => new Promise<{ status: 'error' }>((resolve) => { failCreate = resolve }),
    closeDashboard,
    latestRequest,
  })

  mountedProjectId = 'project-b'
  finishOpen?.()
  await open
  expect(dashboard).toBe('projects')
  failCreate?.({ status: 'error' })
  await expect(create).resolves.toEqual({ status: 'error' })
  expect(dashboard).toBe('projects')
})
