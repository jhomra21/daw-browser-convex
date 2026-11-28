import tailwindcss from '@tailwindcss/vite'
import { expect, test } from 'bun:test'
import { mkdir } from 'node:fs/promises'
import { build } from 'vite'
import solidPlugin from 'vite-plugin-solid'
import { z } from 'zod'

const repositoryRoot = new URL('../../', import.meta.url).pathname
const evidenceDirectory = `/tmp/daw-project-save-status-${crypto.randomUUID()}`
const fixtureId = 'virtual:project-save-status-fixture'

const buildFixture = async () => {
  const source = `
import { createComponent, createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import TransportControls from '~/components/timeline/TransportControls'
import { DashboardProjectsView } from '~/components/dashboard/projects-view'
import { getLocalEntityWriteQueue } from '~/lib/local-write-queue'
import { createLocalProjectEntityRow, openLocalProjectDb } from '~/lib/local-project-db'

let dispose
let queue
let db
let originalTransaction
let setProjectId
let setPlayheadSec
let projectId
window.saveFixture = {
  mount: async () => {
    dispose?.()
    document.body.replaceChildren()
    window.requestIdleCallback = () => 1
    window.cancelIdleCallback = () => {}
    const [currentProjectId, updateProjectId] = createSignal('project:save-status-e2e')
    projectId = currentProjectId
    setProjectId = updateProjectId
    const [playhead, updatePlayhead] = createSignal(0)
    setPlayheadSec = updatePlayhead
    db = await openLocalProjectDb(projectId())
    originalTransaction = db.transaction.bind(db)
    queue = getLocalEntityWriteQueue(projectId())
    const host = document.createElement('div')
    document.body.append(host)
    dispose = render(() => {
      const surfaces = document.createElement('div')
      const noop = () => {}
      const projectMenu = {
        get currentProjectId() { return projectId() },
        currentUserId: 'user', canManageSharing: false,
        projects: [
          { projectId: 'project:save-status-e2e', name: 'First project' },
          { projectId: 'project:save-status-other', name: 'Second project' },
        ],
        onOpenProject: setProjectId, onCreateProject: noop, onDeleteProject: noop,
        onRenameProject: noop, onOpenExport: noop, onOpenDashboard: noop, onSignIn: noop,
        onLogout: noop, onAbout: noop, onExportArchive: noop, onImportArchive: noop,
      }
      surfaces.append(
        createComponent(TransportControls, {
          projectMenu, isPlaying: false, isRecording: false, get playheadSec() { return playhead() },
          onPlay: noop, onPause: noop, onStop: noop, onToggleRecord: noop,
          onAddAudio: noop, tracksMenu: {}, bpm: 120, onChangeBpm: noop,
          metronomeEnabled: false, onToggleMetronome: noop, gridEnabled: true, onToggleGrid: noop,
          gridDenominator: 4, onChangeGridDenominator: noop, loopEnabled: false,
          onToggleLoop: noop, automationOverrideCount: 0,
          browser: { open: false, onToggle: noop },
          midiKeyboard: { enabled: () => false, canPlay: () => false, targetLabel: () => null, octave: () => 0, toggle: noop },
        }),
        createComponent(DashboardProjectsView, { model: { projectMenu } }),
      )
      return surfaces
    }, host)
  },
  scheduleWrite: () => queue.schedulePut(createLocalProjectEntityRow('track', 'e2e-track', { name: 'Track' })),
  failTransaction: () => Object.defineProperty(db, 'transaction', {
    configurable: true,
    value: () => { throw new Error('Injected IndexedDB transaction abort.') },
  }),
  restoreTransaction: () => Object.defineProperty(db, 'transaction', {
    configurable: true,
    value: originalTransaction,
  }),
  flush: async () => { try { await queue.flush() } catch {} },
  switchProject: (id) => setProjectId(id),
  setPlayhead: (sec) => setPlayheadSec(sec),
  playheadLabel: () => [...document.querySelectorAll('span')]
    .find((node) => node.previousElementSibling?.textContent === 'Playhead')?.textContent?.trim() ?? null,
  labels: () => Array.from(document.querySelectorAll('[aria-label], [title]'))
    .map((node) => node.getAttribute('aria-label') ?? node.getAttribute('title'))
    .filter((label) => ['Saved locally on this device', 'Saving locally', 'Some changes could not be saved', 'Shared change rejected: Project was archived'].includes(label)),
  dashboardLabel: () => document.body.innerText.includes('Some changes could not be saved'),
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
        name: 'project-save-status-fixture',
        enforce: 'pre',
        resolveId: (id) => {
          if (id.endsWith(fixtureId)) return `\0${fixtureId}.tsx`
          if (id.endsWith('hooks/useShareMenuController')) return '\0stub:share.ts'
          if (/menus\/(file|edit|view|settings|tracks)-menu$/.test(id)) return '\0stub:menus.ts'
          if (id.endsWith('lib/shared-outbox')) return '\0stub:outbox.ts'
          return undefined
        },
        load: (id) => {
          if (id === `\0${fixtureId}.tsx`) return source
          if (id === '\0stub:share.ts') return `export const useShareMenuController = () => ({
            members: () => [], membersLoading: () => false, membersError: () => null,
            shareError: () => null, revokingMemberId: () => null, reset: () => {},
            loadMembers: async () => {}, createShareUrl: async () => {}, copy: async () => false,
            revokeMember: async () => false,
          })`
          if (id === '\0stub:outbox.ts') return `export const readSharedOutboxRetryState = async () => ({
            failure: { reason: 'Project was archived', permanent: true },
          })`
          if (id === '\0stub:menus.ts') return `export const FileMenu = () => null
            export const EditMenu = () => null
            export const ViewMenu = () => null
            export const SettingsMenu = () => null
            export const TracksMenu = () => null`
          return undefined
        },
      },
    ],
    resolve: { alias: { '~': `${repositoryRoot}src` } },
    build: { write: false, minify: false, lib: { entry: fixtureId, formats: ['iife'], name: 'projectSaveStatusFixture' } },
  })
  const output = Array.isArray(result) ? result[0] : result
  if (!output || !('output' in output)) throw new Error('Expected one save status bundle.')
  const styles = output.output.flatMap((chunk) => (
    chunk.type === 'asset' && chunk.fileName.endsWith('.css') ? [String(chunk.source)] : []
  ))
  return `<!doctype html><head><style>${styles.join('\n')}</style></head><body style="margin:0"><script>${output.output[0].code}</script>`
}

const labelsSchema = z.array(z.string().nullable())
const sharedFailureLabel = 'Shared change rejected: Project was archived'

test('project save status surfaces share queued IndexedDB write state', async () => {
  const directory = `${evidenceDirectory}/browser`
  await mkdir(directory, { recursive: true })
  await Bun.write(`${directory}/index.html`, await buildFixture())
  const session = `project-save-status-${crypto.randomUUID()}`
  const env = { ...process.env }
  delete env.AGENT_BROWSER_CDP
  delete env.AGENT_BROWSER_SESSION
  const run = async (...args: string[]) => {
    const child = Bun.spawn(['agent-browser', '--session', session, ...args], { env, stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
    if (await child.exited !== 0) throw new Error(stderr || stdout)
    return stdout.trim()
  }
  const readLabels = async () => labelsSchema.parse(JSON.parse(JSON.parse(
    await run('eval', `(async () => JSON.stringify(saveFixture.labels()))()`),
  )))
  await run('open', `file://${directory}/index.html`)
  try {
    await run('eval', 'saveFixture.mount()')
    expect(await readLabels()).toEqual(['Saved locally on this device', 'Saved locally on this device'])
    expect(JSON.parse(await run('eval', 'saveFixture.playheadLabel()'))).toBe('1.1.1')
    await run('eval', 'saveFixture.setPlayhead(9.125)')
    expect(JSON.parse(await run('eval', 'saveFixture.playheadLabel()'))).toBe('5.3.2')
    await run('eval', 'saveFixture.scheduleWrite()')
    expect(await readLabels()).toEqual(['Saving locally', 'Saving locally'])
    await run('eval', 'saveFixture.failTransaction()')
    await run('eval', 'saveFixture.flush()')
    expect(await readLabels()).toEqual(['Some changes could not be saved', 'Some changes could not be saved'])
    expect(await run('eval', 'saveFixture.dashboardLabel()')).toBe('true')
    await run('eval', 'saveFixture.switchProject("project:save-status-other")')
    expect(await readLabels()).toEqual(['Saved locally on this device', 'Saved locally on this device'])
    expect(await run('eval', 'saveFixture.dashboardLabel()')).toBe('false')
    await run('eval', 'saveFixture.switchProject("project:save-status-e2e")')
    expect(await readLabels()).toEqual(['Some changes could not be saved', 'Some changes could not be saved'])
    await run('eval', 'saveFixture.restoreTransaction()')
    await run('eval', 'saveFixture.flush()')
    expect(await readLabels()).toEqual(['Saved locally on this device', 'Saved locally on this device'])
    await run('eval', 'saveFixture.switchProject("cloud-save-status-e2e")')
    expect(await readLabels()).toEqual([sharedFailureLabel, sharedFailureLabel])
    await run('eval', 'saveFixture.switchProject("project:save-status-e2e")')
    expect(await readLabels()).toEqual(['Saved locally on this device', 'Saved locally on this device'])
    await Bun.write(`${directory}/result.json`, JSON.stringify({ surfaces: ['TransportControls', 'DashboardProjectsView'], projectSwitch: 'passed', sharedOutboxFailure: 'passed', states: ['saved', 'saving', 'failed', 'saved'] }))
    console.log(`Save status Chromium evidence: ${directory}`)
  } finally {
    await run('close').catch(() => '')
  }
})
