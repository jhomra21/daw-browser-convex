import { expect, test } from 'bun:test'
import { mkdir } from 'node:fs/promises'
import { build } from 'vite'
import { z } from 'zod'

const repositoryRoot = new URL('../../', import.meta.url).pathname
const fixtureId = 'virtual:local-project-deletion'

test('catalog abort preserves assets and committed deletion retries orphan cleanup', async () => {
  const source = `
import { openDB } from 'idb'
import {
  createLocalProject, deleteLocalProject, listLocalProjects, openLocalProjectDb,
  getProjectOpfsRoot,
} from '~/lib/local-project-db'
import { setLocalProjectAssetDirectory } from '~/lib/local-assets'
let project
let catalog
let directory
let originalRemove
let other
window.deletionFixture = {
  prepare: async () => {
    project = await createLocalProject('Deletion fixture')
    const db = await openLocalProjectDb(project.id)
    const root = await getProjectOpfsRoot(project.id)
    const assets = await root.getDirectoryHandle('assets', { create: true })
    const file = await assets.getFileHandle('retained.wav', { create: true })
    const writer = await file.createWritable()
    await writer.write('fixture audio bytes')
    await writer.close()
    await db.put('assets', {
      id: 'asset:fixture', name: 'retained.wav', mimeType: 'audio/wav', sizeBytes: 19,
      storagePath: 'retained.wav', createdAt: 1, updatedAt: 1,
    })
    catalog = await openDB('daw-browser-projects')
  },
  abortDeletion: async () => {
    const originalDelete = IDBObjectStore.prototype.delete
    IDBObjectStore.prototype.delete = function(key) {
      const request = originalDelete.call(this, key)
      if (this.name === 'projects' && key === project.id) this.transaction.abort()
      return request
    }
    try {
      await deleteLocalProject(project.id)
      return false
    } catch { return true }
    finally { IDBObjectStore.prototype.delete = originalDelete }
  },
  state: async () => {
    let bytes
    try {
      const root = await navigator.storage.getDirectory()
      const projectRoot = await root.getDirectoryHandle(project.id)
      const assets = await projectRoot.getDirectoryHandle('assets')
      bytes = await (await (await assets.getFileHandle('retained.wav')).getFile()).text()
    } catch {}
    return {
      listed: (await listLocalProjects()).some((entry) => entry.id === project.id),
      bytes: bytes ?? null,
      jobs: await catalog.count('projectDeletions'),
    }
  },
  failCleanup: () => {
    originalRemove = FileSystemDirectoryHandle.prototype.removeEntry
    FileSystemDirectoryHandle.prototype.removeEntry = function(...args) {
      if (args[0] === project.id) return Promise.reject(new Error('Injected cleanup failure'))
      return originalRemove.apply(this, args)
    }
  },
  delete: () => deleteLocalProject(project.id),
  restoreCleanup: () => { FileSystemDirectoryHandle.prototype.removeEntry = originalRemove },
  sweep: async () => {
    // Listing no longer awaits cleanup. Observe the durable job's transaction,
    // rather than relying on CLI timing before checking the cleaned-up state.
    const originalDelete = IDBObjectStore.prototype.delete
    let completed
    const completion = new Promise((resolve) => { completed = resolve })
    IDBObjectStore.prototype.delete = function(key) {
      const request = originalDelete.call(this, key)
      if (this.name === 'projectDeletions' && key === project.id) {
        this.transaction.addEventListener('complete', () => completed(), { once: true })
      }
      return request
    }
    try {
      await listLocalProjects()
      await completion
    } finally { IDBObjectStore.prototype.delete = originalDelete }
  },
  sharedDirectory: async () => {
    project = await createLocalProject('Shared directory owner')
    other = await createLocalProject('Shared directory survivor')
    const root = await navigator.storage.getDirectory()
    directory = await root.getDirectoryHandle('shared-test-directory', { create: true })
    const assets = await directory.getDirectoryHandle('assets', { create: true })
    const file = await assets.getFileHandle('shared.wav', { create: true })
    const writer = await file.createWritable()
    await writer.write('shared bytes')
    await writer.close()
    for (const entry of [project, other]) {
      await setLocalProjectAssetDirectory(entry.id, directory)
      const db = await openLocalProjectDb(entry.id)
      await db.put('assets', {
        id: 'asset:shared', name: 'shared.wav', storagePath: 'shared.wav',
        mimeType: 'audio/wav', sizeBytes: 12, createdAt: 1, updatedAt: 1,
      })
    }
    await deleteLocalProject(project.id)
    return {
      survivor: Boolean(await catalog.get('projects', other.id)),
      bytes: await (await (await assets.getFileHandle('shared.wav')).getFile()).text(),
    }
  },
}
`
  const result = await build({
    root: repositoryRoot,
    configFile: false,
    logLevel: 'silent',
    plugins: [{
      name: 'local-project-deletion-fixture',
      enforce: 'pre',
      resolveId: (id) => id.endsWith(fixtureId) ? `\0${fixtureId}.ts` : undefined,
      load: (id) => id === `\0${fixtureId}.ts` ? source : undefined,
    }],
    resolve: { alias: { '~': `${repositoryRoot}src` } },
    build: { write: false, minify: false, lib: { entry: fixtureId, formats: ['iife'], name: 'deletionFixture' } },
  })
  const output = Array.isArray(result) ? result[0] : result
  if (!output || !('output' in output)) throw new Error('Expected deletion fixture bundle')
  const directory = `/tmp/daw-deletion-round2-${crypto.randomUUID()}`
  await mkdir(directory, { recursive: true })
  const html = `<!doctype html><body><script>${output.output[0].code}</script>`
  await Bun.write(`${directory}/index.html`, html)
  // OPFS requires an HTTP secure context; serve only the built test artifact.
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(html, { headers: { 'Content-Type': 'text/html' } }) })
  const session = `deletion-round2-${crypto.randomUUID()}`
  const env = { ...process.env }
  delete env.AGENT_BROWSER_CDP
  delete env.AGENT_BROWSER_SESSION
  const run = async (...args: string[]) => {
    const child = Bun.spawn(['agent-browser', '--session', session, ...args], { env, stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
    if (await child.exited !== 0) throw new Error(stderr || stdout)
    return stdout.trim()
  }
  const read = async () => z.object({
    listed: z.boolean(), bytes: z.string().nullable(), jobs: z.number(),
  }).parse(JSON.parse(JSON.parse(await run('eval', 'deletionFixture.state().then(JSON.stringify)'))))
  await run('open', server.url.href)
  try {
    await run('eval', 'deletionFixture.prepare()')
    expect(await run('eval', 'deletionFixture.abortDeletion()')).toBe('true')
    expect(await read()).toEqual({ listed: true, bytes: 'fixture audio bytes', jobs: 0 })
    await run('eval', 'deletionFixture.failCleanup()')
    await run('eval', 'deletionFixture.delete()')
    expect(await read()).toEqual({ listed: false, bytes: 'fixture audio bytes', jobs: 1 })
    await run('eval', 'deletionFixture.restoreCleanup()')
    await run('eval', 'deletionFixture.sweep()')
    expect(await read()).toEqual({ listed: false, bytes: null, jobs: 0 })
    expect(JSON.parse(JSON.parse(await run('eval', 'deletionFixture.sharedDirectory().then(JSON.stringify)'))))
      .toEqual({ survivor: true, bytes: 'shared bytes' })
    await Bun.write(`${directory}/result.json`, JSON.stringify({ catalogAbort: 'preserved', cleanupRetry: 'passed', sharedAsset: 'preserved' }))
    console.log(`Deletion Chromium evidence: ${directory}`)
  } finally {
    await run('close').catch(() => '')
    await server.stop(true)
  }
})
