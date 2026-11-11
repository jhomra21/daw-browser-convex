import tailwindcss from '@tailwindcss/vite'
import { expect, test } from 'bun:test'
import { mkdir } from 'node:fs/promises'
import { build } from 'vite'
import solidPlugin from 'vite-plugin-solid'
import { z } from 'zod'

const repositoryRoot = new URL('../../../', import.meta.url).pathname
const evidenceDirectory = `/tmp/daw-export-dashboard-${crypto.randomUUID()}`
const fixtureId = 'virtual:export-dashboard-fixture'

const buildFixture = async () => {
  const source = `
import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { DashboardExportView } from '~/components/dashboard/export-view'
import { openLocalProjectDb } from '~/lib/local-project-db'
import { saveLocalExportMetadataBatch } from '~/lib/local-export-metadata'

let dispose
let setProjectId
let setQueryState
let getQueryState
const retries = { count: 0 }
let localDb
let originalGet
let pendingRead
window.exportFixture = {
  mount: () => {
    dispose?.()
    document.body.replaceChildren()
    retries.count = 0
    const [projectId, updateProjectId] = createSignal('shared-a')
    const [queryState, updateQueryState] = createSignal({ loading: true, error: null, exports: [] })
    setProjectId = updateProjectId
    setQueryState = updateQueryState
    getQueryState = queryState
    const host = document.createElement('div')
    document.body.append(host)
    const model = { get projectMenu() { return { currentProjectId: projectId(), currentUserId: 'user' } } }
    dispose = render(() => DashboardExportView({ model }), host)
  },
  setQuery: (state) => setQueryState(state),
  switchProject: (projectId) => { setProjectId(projectId) },
  query: () => getQueryState(),
  retry: () => { retries.count += 1 },
  retries: () => retries.count,
  prepareLocal: async () => {
    localDb = await openLocalProjectDb('project:export-history')
    await saveLocalExportMetadataBatch('project:export-history', [{
      name: 'Final mix', format: 'wav', durationSec: 1, sampleRate: 48000, sizeBytes: 100,
    }])
    originalGet = localDb.getAll.bind(localDb)
    Object.defineProperty(localDb, 'getAll', {
      configurable: true,
      value: (...args) => new Promise((resolve, reject) => {
        pendingRead = { reject, resolve: () => originalGet(...args).then(resolve, reject) }
      }),
    })
    setProjectId('project:export-history')
  },
  rejectLocal: () => pendingRead.reject(new Error('Injected local export read failure')),
  restoreLocal: () => Object.defineProperty(localDb, 'getAll', { configurable: true, value: originalGet }),
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
        name: 'export-dashboard-fixture',
        enforce: 'pre',
        resolveId: (id) => {
          if (id.endsWith(fixtureId)) return `\0${fixtureId}.ts`
          if (id.endsWith('lib/convex')) return '\0stub:convex.ts'
          if (id.endsWith('lib/clipboard')) return '\0stub:clipboard.ts'
          return undefined
        },
        load: (id) => {
          if (id === `\0${fixtureId}.ts`) return source
          if (id === '\0stub:convex.ts') return `export const convexApi = { exports: { listByRoom: {} } }
            export const useConvexQuery = () => ({
              get data() { return window.exportFixture.query().exports },
              get isLoading() { return window.exportFixture.query().loading },
              get error() { return window.exportFixture.query().error },
              refetch: () => window.exportFixture.retry(),
            })`
          if (id === '\0stub:clipboard.ts') return `export const copyText = async () => {}`
          return undefined
        },
      },
    ],
    resolve: { alias: { '~': `${repositoryRoot}src` } },
    build: { write: false, minify: false, lib: { entry: fixtureId, formats: ['iife'], name: 'exportDashboardFixture' } },
  })
  const output = Array.isArray(result) ? result[0] : result
  if (!output || !('output' in output)) throw new Error('Expected one export dashboard bundle.')
  const styles = output.output.flatMap((chunk) => (
    chunk.type === 'asset' && chunk.fileName.endsWith('.css') ? [String(chunk.source)] : []
  ))
  return `<!doctype html><head><style>${styles.join('\n')}</style></head><body style="margin:0"><script>${output.output[0].code}</script>`
}

const stateSchema = z.object({
  loading: z.boolean(),
  error: z.boolean(),
  empty: z.boolean(),
  exportVisible: z.boolean(),
  project: z.string(),
})

test('export history separates loading, error, empty, populated, and project switching', async () => {
  const directory = `${evidenceDirectory}/dashboard`
  await mkdir(directory, { recursive: true })
  await Bun.write(`${directory}/index.html`, await buildFixture())
  const session = `export-dashboard-${crypto.randomUUID()}`
  const env = { ...process.env }
  delete env.AGENT_BROWSER_CDP
  delete env.AGENT_BROWSER_SESSION
  const run = async (...args: string[]) => {
    const child = Bun.spawn(['agent-browser', '--session', session, ...args], { env, stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
    if (await child.exited !== 0) throw new Error(stderr || stdout)
    return stdout.trim()
  }
  const read = async () => stateSchema.parse(JSON.parse(JSON.parse(await run('eval', `(async () => JSON.stringify({
    loading: document.body.innerText.includes('Loading export history...'),
    error: document.body.innerText.includes('Export history could not be loaded.'),
    empty: document.body.innerText.includes('No exports yet.'),
    exportVisible: document.body.innerText.includes('Final mix'),
    project: document.body.innerText.includes('shared-b') ? 'shared-b' : 'shared-a',
  }))()`))))
  await run('open', `file://${directory}/index.html`)
  try {
    await run('eval', 'exportFixture.mount()')
    expect(await read()).toMatchObject({ loading: true, error: false, empty: false, exportVisible: false })
    await run('eval', `exportFixture.setQuery({ loading: false, error: new Error('Query failed'), exports: [] })`)
    expect(await read()).toMatchObject({ loading: false, error: true, empty: false })
    await run('eval', `Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.trim() === 'Retry')?.click()`)
    await run('eval', `exportFixture.setQuery({ loading: false, error: null, exports: [] })`)
    expect(await read()).toMatchObject({ loading: false, error: false, empty: true })
    await run('eval', `exportFixture.setQuery({ loading: false, error: null, exports: [{ _id: 'export-1', projectId: 'shared-a', name: 'Final mix', url: '', r2Key: '', format: 'wav', createdAt: 1, createdBy: 'user' }] })`)
    expect(await read()).toMatchObject({ empty: false, exportVisible: true })
    await run('eval', `exportFixture.switchProject('shared-b'); exportFixture.setQuery({ loading: true, error: null, exports: [] })`)
    expect(await read()).toMatchObject({ project: 'shared-b', loading: true, exportVisible: false })
    await run('eval', 'exportFixture.prepareLocal()')
    expect(await read()).toMatchObject({ loading: true, error: false, empty: false, exportVisible: false })
    await run('eval', 'exportFixture.rejectLocal()')
    expect(await read()).toMatchObject({ loading: false, error: true, empty: false, exportVisible: false })
    await run('eval', 'exportFixture.restoreLocal()')
    await run('eval', `Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.trim() === 'Retry')?.click()`)
    expect(await read()).toMatchObject({ loading: false, error: false, empty: false, exportVisible: true })
    await Bun.write(`${directory}/result.json`, JSON.stringify({ cloudStates: 'passed', localIndexedDbReadFailure: 'error', localRetry: 'populated' }))
    console.log(`Export history Chromium evidence: ${directory}`)
  } finally {
    await run('close').catch(() => '')
  }
})
