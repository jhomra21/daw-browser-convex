import tailwindcss from '@tailwindcss/vite'
import { expect, test } from 'bun:test'
import { mkdir } from 'node:fs/promises'
import { build } from 'vite'
import solidPlugin from 'vite-plugin-solid'
import { z } from 'zod'

const repositoryRoot = new URL('../../../', import.meta.url).pathname
const evidenceDirectory = `/tmp/daw-project-dashboard-${crypto.randomUUID()}`
const fixtureId = 'virtual:project-dashboard-fixture'

const buildFixture = async () => {
  const source = `
import { render } from 'solid-js/web'
import { createSignal } from 'solid-js'
import { DashboardProjectsView } from '~/components/dashboard/projects-view'

let rootDispose
const pending = new Map()
const localPending = []
const calls = { create: 0, rename: 0, delete: 0 }
const deferred = (key) => new Promise((resolve, reject) => pending.set(key, { resolve, reject }))
window.projectFixture = {
  mount: () => {
    rootDispose?.()
    document.body.replaceChildren()
    calls.create = 0
    calls.rename = 0
    calls.delete = 0
    pending.clear()
    localPending.length = 0
    const [projects, setProjects] = createSignal([{ projectId: 'shared-other', name: 'Other project' }])
    const outcome = (key, update) => deferred(key).then((result) => {
      if (result.status === 'success') update()
      return result
    })
    const model = {
      projectMenu: {
        currentProjectId: 'shared-current',
        currentUserId: 'user',
        canManageSharing: false,
        get projects() { return projects() },
        onOpenProject: () => {},
        onCreateProject: () => {
          calls.create += 1
          return outcome('create', () => setProjects((current) => [...current, { projectId: 'shared-created', name: 'Created project' }]))
        },
        onRenameProject: (_projectId, name) => {
          calls.rename += 1
          return outcome('rename', () => setProjects((current) => current.map((project) => (
            project.projectId === _projectId ? { ...project, name } : project
          ))))
        },
        onDeleteProject: (projectId) => {
          calls.delete += 1
          return outcome('delete', () => setProjects((current) => current.filter((project) => project.projectId !== projectId)))
        },
        onOpenExport: () => {},
        onOpenDashboard: () => {},
        onSignIn: () => {},
        onLogout: () => {},
        onAbout: () => {},
        onExportArchive: () => {},
        onImportArchive: () => {},
      },
    }
    const host = document.createElement('div')
    document.body.append(host)
    rootDispose = render(() => DashboardProjectsView({ model }), host)
    return true
  },
  resolve: (key, status) => {
    const operation = pending.get(key)
    if (status === 'rejected') operation?.reject(new Error('Injected project mutation failure.'))
    else operation?.resolve({ status })
  },
  mountLocal: () => {
    rootDispose?.()
    document.body.replaceChildren()
    localPending.length = 0
    const host = document.createElement('div')
    document.body.append(host)
    rootDispose = render(() => DashboardProjectsView({ onOpenProject: () => {} }), host)
  },
  listLocalProjects: () => new Promise((resolve, reject) => localPending.push({ resolve, reject })),
  resolveLocal: (index, result) => localPending[index]?.resolve(result),
  rejectLocal: (index) => localPending[index]?.reject(new Error('IndexedDB unavailable')),
  localListCount: () => localPending.length,
  counts: () => ({ ...calls }),
  state: () => ({
    renameDialog: Boolean(document.querySelector('[role=dialog]')?.textContent?.includes('Rename project')),
    deleteDialog: Boolean(document.querySelector('[role=dialog]')?.textContent?.includes('Delete project?')),
    busy: [...document.querySelectorAll('button')].some((button) => button.disabled),
    errorInDialog: Boolean(document.querySelector('[role=dialog] [role=alert]')),
    errorText: document.querySelector('[role=dialog] [role=alert]')?.textContent ?? '',
  }),
}
`
  const result = await build({
    root: repositoryRoot,
    configFile: false,
    logLevel: 'silent',
    plugins: [
      solidPlugin(),
      tailwindcss(),
      {
        name: 'project-dashboard-fixture',
        enforce: 'pre',
        resolveId: (id) => {
          if (id.endsWith(fixtureId)) return `\0${fixtureId}.ts`
          if (id.endsWith('hooks/useShareMenuController')) return '\0stub:share.ts'
          if (id.endsWith('hooks/useProjectSaveStatus')) return '\0stub:status.ts'
          if (id.endsWith('lib/shared-outbox')) return '\0stub:outbox.ts'
          if (id.endsWith('lib/local-project-changes')) return '\0stub:changes.ts'
          if (id.endsWith('lib/local-project-db')) return '\0stub:local-db.ts'
          if (id.endsWith('lib/local-project-pending-writes')) return '\0stub:pending-writes.ts'
          return undefined
        },
        load: (id) => {
          if (id === `\0${fixtureId}.ts`) return source
          if (id === '\0stub:share.ts') return `export const useShareMenuController = () => ({
            members: () => [], membersLoading: () => false, membersError: () => null,
            shareError: () => null, revokingMemberId: () => null, reset: () => {},
            loadMembers: async () => {}, createShareUrl: async () => {}, copy: async () => false,
            revokeMember: async () => false,
          })`
          if (id === '\0stub:status.ts') return `export const useProjectSaveStatus = (input) => () => ({
            label: 'Saved locally', shortLabel: 'Saved', compactLabel: 'Local', class: '',
          })`
          if (id === '\0stub:outbox.ts') return `export const readSharedOutboxRetryState = async () => ({})
            export const flushSharedOutbox = async () => ({})`
          if (id === '\0stub:changes.ts') return `export const notifyLocalProjectChanged = () => {}
            export const subscribeToLocalProjectChanges = () => () => {}`
          if (id === '\0stub:local-db.ts') return `export const createLocalProject = async () => ({ id: 'project:local' })
            export const deleteLocalProject = async () => {}
            export const isLocalProjectCatalogOpenError = () => false
            export const listLocalProjects = () => window.projectFixture.listLocalProjects()
            export const renameLocalProject = async () => {}`
          if (id === '\0stub:pending-writes.ts') return `export const flushLocalProjectPendingWrites = async () => {}`
          return undefined
        },
      },
    ],
    resolve: { alias: { '~': `${repositoryRoot}src` } },
    build: { write: false, minify: false, lib: { entry: fixtureId, formats: ['iife'], name: 'projectDashboardFixture' } },
  })
  const output = Array.isArray(result) ? result[0] : result
  if (!output || !('output' in output)) throw new Error('Expected one project dashboard bundle.')
  const styles = output.output.flatMap((chunk) => (
    chunk.type === 'asset' && chunk.fileName.endsWith('.css') ? [String(chunk.source)] : []
  ))
  return `<!doctype html><head><style>${styles.join('\n')}</style></head><body style="margin:0"><script>${output.output[0].code}</script>`
}

const stateSchema = z.object({
  renameDialog: z.boolean(),
  deleteDialog: z.boolean(),
  busy: z.boolean(),
  errorInDialog: z.boolean(),
  errorText: z.string(),
})
const localListStateSchema = z.object({
  text: z.string(),
  retryCount: z.number(),
  errorVisible: z.boolean(),
  loadingVisible: z.boolean(),
  projectVisible: z.boolean(),
  emptyVisible: z.boolean(),
})

test('dashboard project mutations stay busy and only close on success', async () => {
  const directory = `${evidenceDirectory}/dashboard`
  await mkdir(directory, { recursive: true })
  await Bun.write(`${directory}/index.html`, await buildFixture())
  const session = `project-dashboard-${crypto.randomUUID()}`
  const env = { ...process.env }
  delete env.AGENT_BROWSER_CDP
  delete env.AGENT_BROWSER_SESSION
  const run = async (...args: string[]) => {
    const child = Bun.spawn(['agent-browser', '--session', session, ...args], { env, stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
    if (await child.exited !== 0) throw new Error(stderr || stdout)
    return stdout.trim()
  }
  const read = async <Schema extends z.ZodType>(schema: Schema, script: string) => (
    schema.parse(JSON.parse(await run('eval', `(async () => JSON.stringify(await ${script}))()`).then((text) => JSON.parse(text))))
  )
  await run('open', `file://${directory}/index.html`)
  try {
    await run('eval', 'projectFixture.mount()')
    await run('eval', `Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.trim() === 'New project')?.click()`)
    await run('eval', `Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.trim() === 'New project')?.click()`)
    expect(await read(z.object({ create: z.number() }), 'projectFixture.counts()')).toEqual({ create: 1 })
    await run('eval', `projectFixture.resolve('create', 'error')`)
    const createError = await run('eval', `document.body.innerText.includes('could not be created')`)
    expect(createError).toContain('true')
    await run('eval', `Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.trim() === 'New project')?.click()`)
    await run('eval', `projectFixture.resolve('create', 'success')`)
    expect(await run('eval', `document.body.innerText.includes('Created project')`)).toContain('true')

    await run('eval', `Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.trim() === 'Rename')?.click()`)
    await run('eval', `document.querySelector('input')?.focus(); document.querySelector('input').value = 'Renamed'; document.querySelector('input').dispatchEvent(new InputEvent('input', { bubbles: true }))`)
    await run('eval', `document.querySelector('[role=dialog] input')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`)
    await run('eval', `document.querySelector('[role=dialog] button[type=submit]')?.click()`)
    expect(await read(z.object({ rename: z.number() }), 'projectFixture.counts()')).toEqual({ rename: 1 })
    expect(await read(stateSchema, 'projectFixture.state()')).toMatchObject({ renameDialog: true, busy: true })
    await run('eval', `projectFixture.resolve('rename', 'error')`)
    expect(await read(stateSchema, 'projectFixture.state()')).toMatchObject({
      renameDialog: true,
      errorInDialog: true,
      errorText: 'This project could not be renamed.',
    })

    await run('eval', `document.querySelector('[role=dialog] input')?.focus(); document.querySelector('[role=dialog] input').value = 'Renamed'; document.querySelector('[role=dialog] input').dispatchEvent(new InputEvent('input', { bubbles: true }))`)
    await run('eval', `document.querySelector('[role=dialog] button[type=submit]')?.click()`)
    await run('eval', `projectFixture.resolve('rename', 'success')`)
    expect(await read(stateSchema, 'projectFixture.state()')).toMatchObject({ renameDialog: false })
    expect(await run('eval', `document.body.innerText.includes('Renamed')`)).toContain('true')

    await run('eval', `Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.trim() === 'Delete')?.click()`)
    await run('eval', `document.querySelector('[role=dialog] input')?.focus(); document.querySelector('[role=dialog] input').value = 'Renamed'; document.querySelector('[role=dialog] input').dispatchEvent(new InputEvent('input', { bubbles: true }))`)
    await run('eval', `document.querySelector('[role=dialog] button[type=submit]')?.click()`)
    await run('eval', `document.querySelector('[role=dialog] button[type=submit]')?.click()`)
    expect(await read(z.object({ delete: z.number() }), 'projectFixture.counts()')).toEqual({ delete: 1 })
    await run('eval', `projectFixture.resolve('delete', 'error')`)
    expect(await read(stateSchema, 'projectFixture.state()')).toMatchObject({
      deleteDialog: true,
      errorInDialog: true,
      errorText: 'This project could not be deleted.',
    })
    await run('eval', `document.querySelector('[role=dialog] button[type=submit]')?.click()`)
    await run('eval', `projectFixture.resolve('delete', 'success')`)
    expect(await read(stateSchema, 'projectFixture.state()')).toMatchObject({ deleteDialog: false })
    expect(await run('eval', `document.body.innerText.includes('Other project')`)).toContain('false')
    await Bun.write(`${directory}/result.json`, JSON.stringify({ callbacks: 'resolved status:error and status:success', create: 'passed', rename: 'passed', delete: 'passed' }))
    console.log(`Dashboard mutations Chromium evidence: ${directory}`)
  } finally {
    await run('close').catch(() => '')
  }
})

test('local project listing exposes loading, retry, populated, and empty states', async () => {
  const directory = `${evidenceDirectory}/local-list`
  await mkdir(directory, { recursive: true })
  await Bun.write(`${directory}/index.html`, await buildFixture())
  const session = `project-local-list-${crypto.randomUUID()}`
  const env = { ...process.env }
  delete env.AGENT_BROWSER_CDP
  delete env.AGENT_BROWSER_SESSION
  const run = async (...args: string[]) => {
    const child = Bun.spawn(['agent-browser', '--session', session, ...args], { env, stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
    if (await child.exited !== 0) throw new Error(stderr || stdout)
    return stdout.trim()
  }
  const read = async (script: string) => localListStateSchema.parse(
    JSON.parse(await run('eval', `(async () => JSON.stringify(await ${script}))()`).then((text) => JSON.parse(text))),
  )
  await run('open', `file://${directory}/index.html`)
  try {
    await run('eval', 'projectFixture.mountLocal()')
    await run('eval', `projectFixture.rejectLocal(0)`)
    const failed = await read(`({
      text: document.body.innerText,
      retryCount: Array.from(document.querySelectorAll('button')).filter((button) => button.textContent?.trim() === 'Retry').length,
      errorVisible: document.body.innerText.includes('Local projects could not be loaded.'),
      loadingVisible: document.body.innerText.includes('Loading local projects...'),
      projectVisible: document.body.innerText.includes('Recovered project'),
      emptyVisible: document.body.innerText.includes('No local projects yet.'),
    })`)
    expect(failed).toMatchObject({ retryCount: 1, errorVisible: true, loadingVisible: false, projectVisible: false })
    await run('eval', `Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.trim() === 'Retry')?.click()`)
    await run('eval', `projectFixture.resolveLocal(1, [{ id: 'project:recovered', name: 'Recovered project', lastOpenedAt: 1 }])`)
    const populated = await read(`({
      text: document.body.innerText,
      retryCount: Array.from(document.querySelectorAll('button')).filter((button) => button.textContent?.trim() === 'Retry').length,
      errorVisible: document.body.innerText.includes('Local projects could not be loaded.'),
      loadingVisible: document.body.innerText.includes('Loading local projects...'),
      projectVisible: document.body.innerText.includes('Recovered project'),
      emptyVisible: document.body.innerText.includes('No local projects yet.'),
    })`)
    expect(populated).toMatchObject({ projectVisible: true, errorVisible: false, loadingVisible: false })
    await run('eval', `projectFixture.mountLocal()`)
    await run('eval', `projectFixture.resolveLocal(0, [])`)
    const empty = await read(`({
      text: document.body.innerText,
      retryCount: Array.from(document.querySelectorAll('button')).filter((button) => button.textContent?.trim() === 'Retry').length,
      errorVisible: document.body.innerText.includes('Local projects could not be loaded.'),
      loadingVisible: document.body.innerText.includes('Loading local projects...'),
      projectVisible: document.body.innerText.includes('Recovered project'),
      emptyVisible: document.body.innerText.includes('No local projects yet.'),
    })`)
    expect(empty).toMatchObject({ emptyVisible: true, projectVisible: false, errorVisible: false, loadingVisible: false })
  } finally {
    await run('close').catch(() => '')
  }
})
