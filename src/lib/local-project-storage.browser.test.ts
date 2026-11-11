import { expect, test } from 'bun:test'
import { mkdir } from 'node:fs/promises'
import { build } from 'vite'
import solidPlugin from 'vite-plugin-solid'
import { z } from 'zod'

const repositoryRoot = new URL('../../', import.meta.url).pathname
const fixtureId = 'virtual:local-project-storage'

// The Vite fixture build plus the Chromium scenario run measured 4.2–4.6s
// standalone, so allow headroom when this broad browser check runs under suite load.
test('catalog upgrades and fair cross-tab cleanup preserve concurrent publications in Chromium', async () => {
  const source = `
import { openDB, deleteDB } from 'idb'
import { render } from 'solid-js/web'
import { DashboardProjectsView } from '~/components/dashboard/projects-view'
import {
  createLocalProject, listLocalProjects, getLocalProject, openLocalProjectDb,
  getProjectOpfsRoot, getProjectDirectoryHandle,
  importLocalProject, replaceLocalProject, localProjectCatalogOpenError,
} from '~/lib/local-project-db'
import { createLocalAsset, deleteLocalAsset, readLocalAssetBytes, setLocalProjectAssetDirectory } from '~/lib/local-assets'
import { withLocalStorageRootLock } from '~/lib/local-project-asset-lock'
import { createLocalControlService } from '~/lib/local-control/local-control-service'
import { runLocalControlAssetGc } from '~/lib/local-control/local-control-asset-gc'

const deferred = () => {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}
const waitForText = (text) => new Promise((resolve) => {
  const observer = new MutationObserver(() => {
    if (!document.body.innerText.includes(text)) return
    observer.disconnect()
    resolve()
  })
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })
  if (document.body.innerText.includes(text)) { observer.disconnect(); resolve() }
}, 20_000)
const row = (id, name) => ({
  id, name, schemaVersion: 2, mode: 'local-only', storageKind: 'opfs',
  createdAt: 1, updatedAt: 1, lastOpenedAt: 1,
})
const asset = (path) => ({
  id: 'asset:fixture', name: path, mimeType: 'audio/wav',
  sizeBytes: 10, storagePath: path, createdAt: 1, updatedAt: 1,
  sourceKind: 'upload', contentHash: 'a'.repeat(64), durationSec: 1, sampleRate: 48000, channelCount: 2,
})
const write = async (root, path, bytes) => {
  const assets = await root.getDirectoryHandle('assets', { create: true })
  const writer = await (await assets.getFileHandle(path, { create: true })).createWritable()
  await writer.write(bytes)
  await writer.close()
}
const cleanupCompletion = (id) => {
  const done = deferred()
  const original = IDBObjectStore.prototype.delete
  IDBObjectStore.prototype.delete = function(key) {
    const request = original.call(this, key)
    if (this.name === 'projectDeletions' && key === id) {
      this.transaction.addEventListener('complete', () => done.resolve(), { once: true })
    }
    return request
  }
  return { promise: done.promise, restore: () => { IDBObjectStore.prototype.delete = original } }
}
const seedJob = async (catalog, project, directory, paths) => {
  const tx = catalog.transaction(['projects', 'directoryHandles', 'projectDeletions'], 'readwrite')
  await Promise.all([
    tx.objectStore('projects').delete(project.id),
    tx.objectStore('directoryHandles').delete(project.id),
    tx.objectStore('projectDeletions').put({
      projectId: project.id, assetPaths: paths, directoryHandle: directory,
    }),
    tx.done,
  ])
}
const drainCleanup = () => navigator.locks.request('daw-browser-project-cleanup-runner', async () => {})
window.storageFixture = {
  downgrade: async () => {
    try { await openDB('daw-browser-projects', 1); throw new Error('Expected VersionError') }
    catch (error) {
      const mapped = localProjectCatalogOpenError(error)
      return { original: error.name, name: mapped.name, message: mapped.message }
    }
  },
  versionGuidance: async () => {
    await drainCleanup()
    const newer = await openDB('daw-browser-projects', 3)
    newer.close()
    const dispose = render(() => DashboardProjectsView({ onOpenProject: () => {} }), document.body)
    try {
      await waitForText('Local projects')
      // Observe resource rejection through the existing Retry button, not a timer.
      if (!document.body.innerText.includes('Retry')) await waitForText('Retry')
      return document.body.innerText
    } finally {
      dispose()
      document.body.replaceChildren()
      await deleteDB('daw-browser-projects')
      await listLocalProjects()
      await drainCleanup()
    }
  },
  upgrade: async () => {
    const catalog = await openDB('daw-browser-projects', 1, {
      upgrade(db) {
        const projects = db.createObjectStore('projects', { keyPath: 'id' })
        projects.createIndex('by-last-opened', 'lastOpenedAt')
        projects.createIndex('by-updated-at', 'updatedAt')
        db.createObjectStore('directoryHandles', { keyPath: 'projectId' })
      },
    })
    const root = await navigator.storage.getDirectory()
    const folder = await root.getDirectoryHandle('v1-folder', { create: true })
    for (const project of [row('project:v1-a', 'V1 A'), row('project:v1-b', 'V1 B')]) {
      await catalog.put('projects', project)
      const db = await openLocalProjectDb(project.id)
      await db.put('assets', asset('v1.wav'))
      await write(await getProjectOpfsRoot(project.id), 'v1.wav', project.name)
    }
    await catalog.put('directoryHandles', { projectId: 'project:v1-a', handle: folder, updatedAt: 1 })
    catalog.close()
    const listed = await listLocalProjects()
    const upgraded = await openDB('daw-browser-projects')
    const result = {
      version: upgraded.version,
      names: listed.map((project) => project.name).sort(),
      jobs: await upgraded.count('projectDeletions'),
      directoryPreserved: await folder.isSameEntry(await getProjectDirectoryHandle('project:v1-a')),
      assets: await Promise.all(listed.map(async (project) => (
        (await openLocalProjectDb(project.id)).getAll('assets')
      ))),
      bytes: await Promise.all(listed.map(async (project) => {
        const assets = await (await getProjectOpfsRoot(project.id)).getDirectoryHandle('assets')
        return (await (await assets.getFileHandle('v1.wav')).getFile()).text()
      })),
    }
    upgraded.close()
    return result
  },
  versionchange: async () => {
    // The production cache must close on this real versionchange event.
    const newer = await openDB('daw-browser-projects', 3)
    const version = newer.version
    const projects = await newer.count('projects')
    newer.close()
    await deleteDB('daw-browser-projects')
    return { version, projects, reopened: (await listLocalProjects()).length }
  },
  blocked: async () => {
    await deleteDB('daw-browser-projects')
    const held = await openDB('daw-browser-projects', 1, {
      upgrade(db) {
        const projects = db.createObjectStore('projects', { keyPath: 'id' })
        projects.createIndex('by-last-opened', 'lastOpenedAt')
        projects.createIndex('by-updated-at', 'updatedAt')
        db.createObjectStore('directoryHandles', { keyPath: 'projectId' })
      },
    })
    await held.put('projects', row('project:retry', 'Recovered project'))
    const dispose = render(() => DashboardProjectsView({ onOpenProject: () => {} }), document.body)
    try {
      await waitForText('Close or reload other tabs')
      const error = document.body.innerText
      const retry = Array.from(document.querySelectorAll('button')).find((button) => button.textContent.trim() === 'Retry')
      held.close()
      retry.click()
      await waitForText('Recovered project')
      return { error, recovered: document.body.innerText.includes('Recovered project'), retry: Boolean(retry) }
    } finally { held.close(); dispose(); document.body.replaceChildren() }
  },
  slowCleanup: async () => {
    const project = await createLocalProject('Slow cleanup')
    const survivor = await createLocalProject('Visible while cleanup waits')
    const catalog = await openDB('daw-browser-projects')
    await seedJob(catalog, project, undefined, [])
    const held = deferred()
    const release = deferred()
    const lock = withLocalStorageRootLock(async () => { held.resolve(); await release.promise })
    await held.promise
    let scans = 0
    const original = IDBObjectStore.prototype.getAll
    const started = deferred()
    IDBObjectStore.prototype.getAll = function(...args) {
      if (this.name === 'projectDeletions') { scans += 1; started.resolve() }
      return original.apply(this, args)
    }
    const completion = cleanupCompletion(project.id)
    try {
      const first = await listLocalProjects()
      await started.promise
      const second = await listLocalProjects()
      // Materialization is per-project; only its final publication waits for root.
      const saving = createLocalAsset({ projectId: survivor.id, file: new File(['saved'], 'normal.wav') })
      const pending = await catalog.count('projectDeletions')
      const result = { firstVisible: first.some((entry) => entry.id === survivor.id),
        secondVisible: second.some((entry) => entry.id === survivor.id), scans, pending }
      release.resolve()
      await lock
      const saved = await saving
      await completion.promise
      await drainCleanup()
      return { ...result, remaining: await catalog.count('projectDeletions'), normalSave: Boolean(saved.id) }
    } finally {
      release.resolve()
      IDBObjectStore.prototype.getAll = original
      completion.restore()
      catalog.close()
    }
  },
  failedCleanup: async () => {
    const project = await createLocalProject('Failed cleanup')
    const catalog = await openDB('daw-browser-projects')
    await seedJob(catalog, project, undefined, [])
    const failed = deferred()
    const logged = deferred()
    const originalRemove = FileSystemDirectoryHandle.prototype.removeEntry
    const originalWarn = console.warn
    FileSystemDirectoryHandle.prototype.removeEntry = function(...args) {
      if (args[0] === project.id) { failed.resolve(); return Promise.reject(new Error('Injected storage failure')) }
      return originalRemove.apply(this, args)
    }
    console.warn = (...args) => { originalWarn(...args); logged.resolve() }
    try {
      const listed = await listLocalProjects()
      await failed.promise
      await logged.promise
      await drainCleanup()
      const retained = await catalog.count('projectDeletions')
      return { listed: listed.some((entry) => entry.id === 'project:retry'), retained }
    } finally {
      FileSystemDirectoryHandle.prototype.removeEntry = originalRemove
      console.warn = originalWarn
      const completion = cleanupCompletion(project.id)
      await getLocalProject('project:retry')
      await completion.promise
      await drainCleanup()
      completion.restore()
      catalog.close()
    }
  },
  boundedCleanup: async () => {
    const catalog = await openDB('daw-browser-projects')
    const ids = []
    for (let index = 0; index < 10; index += 1) {
      const project = await createLocalProject('Bounded cleanup ' + index)
      ids.push(project.id)
      await seedJob(catalog, project, undefined, [])
    }
    ids.sort()
    const firstPass = deferred()
    const allDone = deferred()
    let completed = 0
    const original = IDBObjectStore.prototype.delete
    IDBObjectStore.prototype.delete = function(key) {
      const request = original.call(this, key)
      if (this.name === 'projectDeletions' && ids.includes(key)) {
        this.transaction.addEventListener('complete', () => {
          completed += 1
          if (completed === 8) firstPass.resolve()
          if (completed === 10) allDone.resolve()
        }, { once: true })
      }
      return request
    }
    try {
      await listLocalProjects()
      await firstPass.promise
      // Wait for the eighth job to release its real lock before the next pass.
      await drainCleanup()
      const remaining = await catalog.count('projectDeletions')
      await listLocalProjects()
      await allDone.promise
      await drainCleanup()
      return { remaining, final: await catalog.count('projectDeletions') }
    } finally { IDBObjectStore.prototype.delete = original; catalog.close() }
  },
  sharedRace: async () => {
    const deleted = await createLocalProject('Deleted folder owner')
    const survivor = await createLocalProject('Switching survivor')
    const root = await navigator.storage.getDirectory()
    const folder = await root.getDirectoryHandle('switch-target', { create: true })
    await write(folder, 'collision.wav', 'old bytes')
    await setLocalProjectAssetDirectory(deleted.id, folder)
    await (await openLocalProjectDb(deleted.id)).put('assets', asset('collision.wav'))
    await (await openLocalProjectDb(survivor.id)).put('assets', asset('collision.wav'))
    await write(await getProjectOpfsRoot(survivor.id), 'collision.wav', 'surviving bytes')
    const catalog = await openDB('daw-browser-projects')
    await seedJob(catalog, deleted, folder, ['collision.wav'])
    const copied = deferred()
    const publish = deferred()
    const cleanupWaiting = deferred()
    const originalRequest = navigator.locks.request
    let copying = false
    navigator.locks.request = function(...args) {
      if (args[0] === 'daw-browser-storage-roots' && copying) cleanupWaiting.resolve()
      return originalRequest.apply(this, args)
    }
    const originalClose = FileSystemWritableFileStream.prototype.close
    FileSystemWritableFileStream.prototype.close = async function() {
      await originalClose.call(this)
      if (copying) return
      copying = true
      copied.resolve()
      await publish.promise
    }
    const completion = cleanupCompletion(deleted.id)
    try {
      const switching = setLocalProjectAssetDirectory(survivor.id, folder)
      await copied.promise
      const unrelated = await createLocalProject('Writable while folder copy is paused')
      await createLocalAsset({ projectId: unrelated.id, file: new File(['normal'], 'normal.wav') })
      const listed = await listLocalProjects()
      // Observe the real lock request, not elapsed time, while publication is paused.
      await cleanupWaiting.promise
      publish.resolve()
      await switching
      await completion.promise
      await drainCleanup()
      const assets = await folder.getDirectoryHandle('assets')
      return {
        survivor: listed.some((entry) => entry.id === survivor.id),
        published: await folder.isSameEntry(await getProjectDirectoryHandle(survivor.id)),
        bytes: await (await (await assets.getFileHandle('collision.wav')).getFile()).text(),
      }
    } finally {
      publish.resolve()
      FileSystemWritableFileStream.prototype.close = originalClose
      navigator.locks.request = originalRequest
      completion.restore()
      catalog.close()
    }
  },
  folderRollback: async () => {
    await drainCleanup()
    const project = await createLocalProject('Failed folder switch')
    const saved = await createLocalAsset({ projectId: project.id, file: new File(['original audio'], 'original.wav') })
    const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle('failed-copy', { create: true })
    const original = FileSystemWritableFileStream.prototype.close
    FileSystemWritableFileStream.prototype.close = () => Promise.reject(new DOMException('Injected copy failure', 'QuotaExceededError'))
    let kind
    try { await setLocalProjectAssetDirectory(project.id, folder) }
    catch (error) { kind = error.kind }
    finally { FileSystemWritableFileStream.prototype.close = original }
    const bytes = await readLocalAssetBytes(project.id, saved.id)
    const catalog = await openDB('daw-browser-projects')
    try {
      return { kind, originalOpfs: !await getProjectDirectoryHandle(project.id),
        reservationRemoved: !await catalog.get('directoryHandles', project.id),
        bytes: bytes.status === 'ready' ? await bytes.file.text() : bytes.status }
    } finally { catalog.close() }
  },
  sharedAssetRemoval: async (kind, retention) => {
    await drainCleanup()
    const owner = await createLocalProject('Removal owner ' + kind + retention)
    const survivor = await createLocalProject('Removal survivor ' + kind + retention)
    const catalog = await openDB('daw-browser-projects')
    const folder = retention === 'implicit' ? await getProjectOpfsRoot(survivor.id)
      : await (await navigator.storage.getDirectory()).getDirectoryHandle(
        'asset-removal-' + kind + retention, { create: true })
    await write(folder, 'shared.wav', 'shared audio')
    await setLocalProjectAssetDirectory(owner.id, folder)
    const ownerDb = await openLocalProjectDb(owner.id)
    const survivorDb = await openLocalProjectDb(survivor.id)
    await ownerDb.put('assets', asset('shared.wav'))
    let frame
    if (retention === 'live' || retention === 'implicit') {
      if (retention === 'live') await setLocalProjectAssetDirectory(survivor.id, folder)
      await survivorDb.put('assets', asset('shared.wav'))
    } else if (retention === 'gc') {
      await setLocalProjectAssetDirectory(survivor.id, folder)
      await survivorDb.put('controlAssetGc', {
        id: 'retained-gc', projectId: survivor.id, storagePath: 'shared.wav',
        assetId: 'retained', eligibleAt: Date.now() + 100000, version: 1, recoveryId: 'retained',
      })
    } else if (retention === 'copy') {
      await survivorDb.put('assets', asset('shared.wav'))
      await write(await getProjectOpfsRoot(survivor.id), 'shared.wav', 'shared audio')
      frame = document.createElement('iframe')
      const loaded = new Promise((resolve) => { frame.onload = resolve })
      frame.src = location.href
      document.body.append(frame)
      await loaded
      await frame.contentWindow.storageFixture.holdReservation(survivor.id, folder)
    }
    try {
      if (kind === 'dashboard') await deleteLocalAsset(owner.id, 'asset:fixture')
      else {
        const service = createLocalControlService({
          actor: { subject: 'local:00000000-0000-4000-8000-000000000000' }, excludePendingWriteKinds: [],
        })
        const request = { version: 'v1', projectId: owner.id,
          actions: [{ kind: 'asset.delete', asset: { source: 'persisted', id: 'asset:fixture' } }] }
        const approval = await service.requestApproval(request)
        const result = await service.commit({ ...request, approvalToken: approval.approvalToken, idempotencyKey: 'delete-shared-fixture' })
        const recovery = await ownerDb.get('controlRecoveries', result.recoveries[0].id)
        const job = (await ownerDb.getAll('controlAssetGc'))[0]
        const expiredAt = Date.now() - 1
        await ownerDb.put('controlRecoveries', { ...recovery, expiresAt: expiredAt })
        await ownerDb.put('controlAssetGc', { ...job, eligibleAt: expiredAt })
        await runLocalControlAssetGc(owner.id)
      }
      let bytes = null
      try { bytes = await (await (await (await folder.getDirectoryHandle('assets')).getFileHandle('shared.wav')).getFile()).text() }
      catch (error) { if (error.name !== 'NotFoundError') throw error }
      return { bytes, live: await ownerDb.count('assets'), gc: await ownerDb.count('controlAssetGc') }
    } finally {
      frame?.remove()
      await drainCleanup()
      if (frame) {
        await getLocalProject(survivor.id)
        await drainCleanup()
      }
      catalog.close()
    }
  },
  reservationRecovery: async (mode) => {
    await drainCleanup()
    const deleted = await createLocalProject('Reserved deletion')
    const owner = await createLocalProject('Reservation owner')
    const catalog = await openDB('daw-browser-projects')
    const chosen = mode === 'chosen'
      ? await (await navigator.storage.getDirectory()).getDirectoryHandle('reservation-previous-root', { create: true })
      : undefined
    if (chosen) await setLocalProjectAssetDirectory(owner.id, chosen)
    const destination = await getProjectOpfsRoot(deleted.id)
    const frame = document.createElement('iframe')
    const loaded = new Promise((resolve) => { frame.onload = resolve })
    frame.src = location.href
    document.body.append(frame)
    await loaded
    await frame.contentWindow.storageFixture.holdReservation(owner.id, destination)
    await seedJob(catalog, deleted, undefined, [])
    if (mode === 'closed') frame.remove() // Real realm teardown releases its Web Lock, without finally.
    try {
      await listLocalProjects()
      await drainCleanup()
      const first = {
        reservation: Boolean((await catalog.get('directoryHandles', owner.id))?.copyingTo),
        pending: Boolean(await catalog.get('projectDeletions', deleted.id)),
      }
      if (mode !== 'closed') {
        frame.remove()
        await getLocalProject(owner.id)
        await drainCleanup()
      }
      const finalHandle = await getProjectDirectoryHandle(owner.id)
      return {
        ...first,
        finalReservation: Boolean((await catalog.get('directoryHandles', owner.id))?.copyingTo),
        finalPending: Boolean(await catalog.get('projectDeletions', deleted.id)),
        expectedRoot: chosen ? 'chosen' : 'implicit-opfs',
        retainedChosenRoot: chosen && finalHandle ? await chosen.isSameEntry(finalHandle) : false,
        restoredImplicitRoot: !chosen && !finalHandle,
      }
    } finally { frame.remove(); catalog.close() }
  },
  sameTabReservation: async () => {
    await drainCleanup()
    const project = await createLocalProject('Same-tab copy')
    const saved = await createLocalAsset({ projectId: project.id, file: new File(['same-tab bytes'], 'same-tab.wav') })
    const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle('same-tab-copy', { create: true })
    const catalog = await openDB('daw-browser-projects')
    await seedJob(catalog, project, undefined, [])
    const started = deferred()
    const release = deferred()
    const original = FileSystemFileHandle.prototype.createWritable
    FileSystemFileHandle.prototype.createWritable = async function(...args) {
      if (this.name === saved.storagePath) {
        started.resolve()
        await release.promise
      }
      return original.apply(this, args)
    }
    const completion = cleanupCompletion(project.id)
    try {
      const copying = setLocalProjectAssetDirectory(project.id, folder)
      await started.promise
      await listLocalProjects()
      await drainCleanup()
      const duringCopy = {
        reservation: Boolean((await catalog.get('directoryHandles', project.id))?.copyingTo),
        pending: Boolean(await catalog.get('projectDeletions', project.id)),
      }
      release.resolve()
      await copying
      await getLocalProject(project.id)
      await completion.promise
      await drainCleanup()
      const bytes = await (await (await folder.getDirectoryHandle('assets')).getFileHandle(saved.storagePath)).getFile()
      return {
        ...duringCopy,
        finalReservation: Boolean((await catalog.get('directoryHandles', project.id))?.copyingTo),
        finalPending: Boolean(await catalog.get('projectDeletions', project.id)),
        bytes: await bytes.text(),
      }
    } finally {
      release.resolve()
      FileSystemFileHandle.prototype.createWritable = original
      completion.restore()
      catalog.close()
    }
  },
  duplicateGcPath: async () => {
    await drainCleanup()
    const project = await createLocalProject('Duplicate GC paths')
    const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle('duplicate-gc-path', { create: true })
    await setLocalProjectAssetDirectory(project.id, folder)
    await write(folder, 'duplicate.wav', 'duplicate bytes')
    const db = await openLocalProjectDb(project.id)
    await db.put('assets', { ...asset('duplicate.wav'), id: 'asset:first' })
    await db.put('assets', { ...asset('duplicate.wav'), id: 'asset:second' })
    const service = createLocalControlService({
      actor: { subject: 'local:00000000-0000-4000-8000-000000000000' }, excludePendingWriteKinds: [],
    })
    const request = { version: 'v1', projectId: project.id, actions: [
      { kind: 'asset.delete', asset: { source: 'persisted', id: 'asset:first' } },
      { kind: 'asset.delete', asset: { source: 'persisted', id: 'asset:second' } },
    ] }
    const approval = await service.requestApproval(request)
    const removed = await service.commit({ ...request, approvalToken: approval.approvalToken, idempotencyKey: 'delete-duplicate-paths' })
    const expiredAt = Date.now() - 1
    for (const recovery of removed.recoveries) {
      const row = await db.get('controlRecoveries', recovery.id)
      if (!row) throw new Error('Expected duplicate-path recovery.')
      await db.put('controlRecoveries', { ...row, expiresAt: expiredAt })
    }
    for (const job of await db.getAll('controlAssetGc')) await db.put('controlAssetGc', { ...job, eligibleAt: expiredAt })
    let firstRemoval
    const originalRemove = FileSystemDirectoryHandle.prototype.removeEntry
    FileSystemDirectoryHandle.prototype.removeEntry = async function(...args) {
      if (args[0] === 'duplicate.wav') {
        const assets = await folder.getDirectoryHandle('assets')
        firstRemoval = {
          pendingGc: await db.count('controlAssetGc'),
          bytes: await (await (await assets.getFileHandle('duplicate.wav')).getFile()).text(),
        }
      }
      return originalRemove.apply(this, args)
    }
    let result
    try { result = await runLocalControlAssetGc(project.id) }
    finally { FileSystemDirectoryHandle.prototype.removeEntry = originalRemove }
    let bytes = null
    try {
      bytes = await (await (await folder.getDirectoryHandle('assets')).getFileHandle('duplicate.wav')).getFile().then((file) => file.text())
    } catch (error) { if (error.name !== 'NotFoundError') throw error }
    return { finalized: result.finalized, firstRemoval, gc: await db.count('controlAssetGc'), bytes }
  },
  gcPublicationRace: async () => {
    await drainCleanup()
    const owner = await createLocalProject('Paused GC owner')
    const importer = await createLocalProject('Concurrent importer')
    const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle('paused-gc-publication', { create: true })
    await setLocalProjectAssetDirectory(owner.id, folder)
    await setLocalProjectAssetDirectory(importer.id, folder)
    const ownerDb = await openLocalProjectDb(owner.id)
    await write(folder, 'race.wav', 'race bytes')
    await ownerDb.put('assets', asset('race.wav'))
    const service = createLocalControlService({
      actor: { subject: 'local:00000000-0000-4000-8000-000000000000' }, excludePendingWriteKinds: [],
    })
    const request = { version: 'v1', projectId: owner.id,
      actions: [{ kind: 'asset.delete', asset: { source: 'persisted', id: 'asset:fixture' } }] }
    const approval = await service.requestApproval(request)
    const removed = await service.commit({ ...request, approvalToken: approval.approvalToken, idempotencyKey: 'paused-gc-delete' })
    const recovery = await ownerDb.get('controlRecoveries', removed.recoveries[0].id)
    const job = (await ownerDb.getAll('controlAssetGc'))[0]
    if (!recovery || !job) throw new Error('Expected the paused GC fixture.')
    const expiredAt = Date.now() - 1
    await ownerDb.put('controlRecoveries', { ...recovery, expiresAt: expiredAt })
    await ownerDb.put('controlAssetGc', { ...job, eligibleAt: expiredAt })
    const checked = deferred()
    const release = deferred()
    const queued = deferred()
    const originalRequest = navigator.locks.request
    navigator.locks.request = function(...args) {
      if (args[0] === 'daw-browser-storage-roots') queued.resolve()
      return originalRequest.apply(this, args)
    }
    try {
      const collecting = runLocalControlAssetGc(owner.id, {
        removeAssetFile: async () => {
          checked.resolve()
          await release.promise
          return { status: 'retryable-failure' }
        },
      })
      await checked.promise
      const publishing = importLocalProject(importer, {
        entities: [], assets: [asset('race.wav')], projectState: [], syncState: [],
      })
      await queued.promise
      const beforePublication = await (await openLocalProjectDb(importer.id)).count('assets')
      const duringPause = await (await folder.getDirectoryHandle('assets')).getFileHandle('race.wav')
      const bytesDuringPause = await (await duringPause.getFile()).text()
      release.resolve()
      const collection = await collecting
      await publishing
      return {
        collection: collection.finalized,
        beforePublication,
        published: (await (await openLocalProjectDb(importer.id)).get('assets', 'asset:fixture'))?.storagePath,
        bytesDuringPause,
        bytesAfter: await (await duringPause.getFile()).text(),
        gcRetained: await ownerDb.count('controlAssetGc'),
      }
    } finally {
      release.resolve()
      navigator.locks.request = originalRequest
    }
  },
  holdReservation: async (projectId, destination) => {
    const saved = await createLocalAsset({ projectId, file: new File(['copy source'], 'reserved.wav') })
    const ready = deferred()
    const original = FileSystemFileHandle.prototype.createWritable
    FileSystemFileHandle.prototype.createWritable = async function(...args) {
      if (this.name === saved.storagePath) {
        ready.resolve()
        // Closing this realm abandons a real copy mid-write, without its finally.
        await new Promise(() => {})
      }
      return original.apply(this, args)
    }
    // Recreate the transferred handle in this realm so its native methods use
    // this context's instrumented prototypes, just like postMessage transfer.
    void setLocalProjectAssetDirectory(projectId, structuredClone(destination))
    await ready.promise
  },
  settledCopyFailure: async () => {
    await drainCleanup()
    const project = await createLocalProject('Settled copy failure')
    const first = await createLocalAsset({ projectId: project.id, file: new File(['first bytes'], 'first.wav') })
    const second = await createLocalAsset({ projectId: project.id, file: new File(['second bytes'], 'second.wav') })
    const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle('settled-copy', { create: true })
    const catalog = await openDB('daw-browser-projects')
    const slow = deferred()
    const failed = deferred()
    const release = deferred()
    const original = FileSystemFileHandle.prototype.createWritable
    FileSystemFileHandle.prototype.createWritable = async function(...args) {
      if (this.name === first.storagePath) {
        await slow.promise
        failed.resolve()
        throw new DOMException('Injected first-file failure', 'QuotaExceededError')
      }
      if (this.name === second.storagePath) {
        slow.resolve()
        await release.promise
      }
      return original.apply(this, args)
    }
    let rejected = false
    let kind
    try {
      const copying = setLocalProjectAssetDirectory(project.id, folder).catch((error) => { rejected = true; kind = error.kind })
      await failed.promise
      // A root round trip drains the failure continuation before inspecting locks.
      await withLocalStorageRootLock(async () => {})
      const locks = await navigator.locks.query()
      const before = {
        rejected, held: locks.held.some((lock) => lock.name === 'daw-browser-project-assets:' + project.id),
        reserved: Boolean((await catalog.get('directoryHandles', project.id))?.copyingTo),
      }
      release.resolve()
      await copying
      const bytes = await readLocalAssetBytes(project.id, first.id)
      return { ...before, kind, rolledBack: !await catalog.get('directoryHandles', project.id),
        bytes: bytes.status === 'ready' ? await bytes.file.text() : bytes.status }
    } finally { release.resolve(); FileSystemFileHandle.prototype.createWritable = original; catalog.close() }
  },
  publicationRace: async (kind) => {
    await drainCleanup()
    const deleted = await createLocalProject('Deleted ' + kind)
    const survivor = await createLocalProject('Survivor ' + kind)
    const catalog = await openDB('daw-browser-projects')
    const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle('race-' + kind, { create: true })
    await write(folder, 'retained.wav', kind + ' bytes')
    await setLocalProjectAssetDirectory(survivor.id, folder)
    const survivorDb = await openLocalProjectDb(survivor.id)
    let staleOwner
    if (kind === 'replacement') {
      staleOwner = await createLocalProject('Shared replacement stale-path owner')
      await setLocalProjectAssetDirectory(staleOwner.id, folder)
      await (await openLocalProjectDb(staleOwner.id)).put('assets', asset('stale-shared.wav'))
      await survivorDb.put('assets', { ...asset('stale-shared.wav'), id: 'asset:stale' })
      await write(folder, 'stale-shared.wav', 'still live elsewhere')
    }
    let restore
    if (kind === 'recovery') {
      await survivorDb.put('assets', asset('retained.wav'))
      const service = createLocalControlService({
        actor: { subject: 'local:00000000-0000-4000-8000-000000000000' },
        excludePendingWriteKinds: [],
      })
      const request = { version: 'v1', projectId: survivor.id,
        actions: [{ kind: 'asset.delete', asset: { source: 'persisted', id: 'asset:fixture' } }] }
      const approval = await service.requestApproval(request)
      const removed = await service.commit({ ...request, approvalToken: approval.approvalToken, idempotencyKey: 'remove-fixture' })
      restore = () => service.commit({ version: 'v1', projectId: survivor.id, idempotencyKey: 'restore-fixture',
        actions: [{ kind: 'recovery.restore', recovery: { id: removed.recoveries[0].id } }] })
    } else {
      restore = () => (kind === 'replacement' ? replaceLocalProject : importLocalProject)(survivor, {
        entities: [], assets: [asset('retained.wav')], projectState: [], syncState: [],
      })
    }
    await drainCleanup()
    await seedJob(catalog, deleted, folder, ['retained.wav'])
    const queued = deferred()
    const release = deferred()
    const held = deferred()
    const root = withLocalStorageRootLock(async () => { held.resolve(); await release.promise })
    await held.promise
    const originalRequest = navigator.locks.request
    navigator.locks.request = function(...args) {
      if (args[0] === 'daw-browser-storage-roots') queued.resolve()
      return originalRequest.apply(this, args)
    }
    const completion = cleanupCompletion(deleted.id)
    try {
      const publishing = restore()
      await queued.promise
      const before = await survivorDb.count('assets')
      await listLocalProjects()
      release.resolve()
      await root
      await publishing
      await completion.promise
      await drainCleanup()
      const assets = await folder.getDirectoryHandle('assets')
      if (staleOwner) {
        const stale = await (await (await assets.getFileHandle('stale-shared.wav')).getFile()).text()
        if (stale !== 'still live elsewhere') throw new Error('Replacement removed shared live bytes')
      }
      return { before, live: await survivorDb.count('assets'), gc: await survivorDb.count('controlAssetGc'),
        bytes: await (await (await assets.getFileHandle('retained.wav')).getFile()).text() }
    } finally {
      release.resolve()
      navigator.locks.request = originalRequest
      completion.restore()
      catalog.close()
    }
  },
  atomicRecoveryRace: async () => {
    await drainCleanup()
    const deleted = await createLocalProject('Atomic deleted')
    const survivor = await createLocalProject('Atomic survivor')
    const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle('atomic-recovery', { create: true })
    await write(folder, 'atomic.wav', 'atomic bytes')
    await setLocalProjectAssetDirectory(survivor.id, folder)
    const db = await openLocalProjectDb(survivor.id)
    await db.put('assets', asset('atomic.wav'))
    const service = createLocalControlService({ actor: { subject: 'local:00000000-0000-4000-8000-000000000000' },
      excludePendingWriteKinds: [] })
    const request = { version: 'v1', projectId: survivor.id,
      actions: [{ kind: 'asset.delete', asset: { source: 'persisted', id: 'asset:fixture' } }] }
    const approval = await service.requestApproval(request)
    const removed = await service.commit({ ...request, approvalToken: approval.approvalToken, idempotencyKey: 'delete-fixture' })
    await drainCleanup()
    const catalog = await openDB('daw-browser-projects')
    await seedJob(catalog, deleted, folder, ['atomic.wav'])
    const original = IDBObjectStore.prototype.getAll
    const read = deferred()
    let atomic = false
    let observed = false
    let restoring
    IDBObjectStore.prototype.getAll = function(...args) {
      const result = original.apply(this, args)
      if (!observed && this.name === 'assets' && this.transaction.db.name.endsWith(survivor.id)) {
        observed = true
        atomic = this.transaction.objectStoreNames.contains('controlAssetGc')
        // Start the real restore after the live-assets read, while cleanup's root
        // lock still protects the atomic live/retained snapshot.
        result.addEventListener('success', () => {
          if (restoring) return
          restoring = service.commit({ version: 'v1', projectId: survivor.id, idempotencyKey: 'restore-fixture',
            actions: [{ kind: 'recovery.restore', recovery: { id: removed.recoveries[0].id } }] })
          read.resolve()
        }, { once: true })
      }
      return result
    }
    const completion = cleanupCompletion(deleted.id)
    try {
      await listLocalProjects()
      await read.promise
      await completion.promise
      await restoring
      await drainCleanup()
      return { atomic, live: await db.count('assets'),
        bytes: await (await (await (await folder.getDirectoryHandle('assets')).getFileHandle('atomic.wav')).getFile()).text() }
    } finally { IDBObjectStore.prototype.getAll = original; completion.restore(); catalog.close() }
  },
  recreated: async () => {
    await drainCleanup()
    const project = await createLocalProject('Recreated')
    const catalog = await openDB('daw-browser-projects')
    await seedJob(catalog, project, undefined, ['old.wav'])
    await write(await getProjectOpfsRoot(project.id), 'new.wav', 'new incarnation')
    await importLocalProject(project, { entities: [], assets: [asset('new.wav')], projectState: [], syncState: [] })
    const completion = cleanupCompletion(project.id)
    try {
      await listLocalProjects()
      await completion.promise
      await drainCleanup()
      return { jobs: await catalog.count('projectDeletions'),
        live: await (await openLocalProjectDb(project.id)).count('assets'),
        bytes: await (await (await (await getProjectOpfsRoot(project.id)).getDirectoryHandle('assets')).getFileHandle('new.wav')).getFile().then((file) => file.text()) }
    } finally { completion.restore(); catalog.close() }
  },
  starvation: async () => {
    await drainCleanup()
    const catalog = await openDB('daw-browser-projects')
    const ids = []
    for (let index = 0; index < 9; index += 1) {
      const project = await createLocalProject('Starvation ' + index)
      ids.push(project.id)
      await seedJob(catalog, project, undefined, [])
    }
    ids.sort()
    const original = FileSystemDirectoryHandle.prototype.removeEntry
    FileSystemDirectoryHandle.prototype.removeEntry = function(...args) {
      if (ids.slice(0, 8).includes(args[0])) return Promise.reject(new DOMException('No permission', 'NotAllowedError'))
      return original.apply(this, args)
    }
    try {
      await listLocalProjects()
      await drainCleanup()
      const first = await catalog.getAll('projectDeletions')
      await listLocalProjects()
      await drainCleanup()
      return { first: first.length, attempted: first.filter((job) => job.attemptCount > 0).length,
        laterProcessed: !await catalog.get('projectDeletions', ids[8]) }
    } finally {
      FileSystemDirectoryHandle.prototype.removeEntry = original
      await listLocalProjects()
      await drainCleanup()
      catalog.close()
    }
  },
  crossTab: async () => {
    await drainCleanup()
    const frame = document.createElement('iframe')
    const loaded = new Promise((resolve) => { frame.onload = resolve })
    frame.src = location.href
    document.body.append(frame)
    await loaded
    const project = await createLocalProject('Cross tab')
    const catalog = await openDB('daw-browser-projects')
    await seedJob(catalog, project, undefined, [])
    const held = deferred()
    const release = deferred()
    const root = withLocalStorageRootLock(async () => { held.resolve(); await release.promise })
    await held.promise
    const started = deferred()
    const original = IDBObjectStore.prototype.getAll
    IDBObjectStore.prototype.getAll = function(...args) {
      if (this.name === 'projectDeletions') started.resolve()
      return original.apply(this, args)
    }
    const other = frame.contentWindow
    let otherScans = 0
    const handled = deferred()
    const otherRequest = other.navigator.locks.request
    other.navigator.locks.request = function(name, options, callback) {
      if (name !== 'daw-browser-project-cleanup-runner') return otherRequest.apply(this, arguments)
      return otherRequest.call(this, name, options, async (lock) => {
        try { return await callback(lock) }
        finally { handled.resolve() }
      })
    }
    const otherOriginal = other.IDBObjectStore.prototype.getAll
    other.IDBObjectStore.prototype.getAll = function(...args) {
      if (this.name === 'projectDeletions') otherScans += 1
      return otherOriginal.apply(this, args)
    }
    const completion = cleanupCompletion(project.id)
    try {
      await listLocalProjects()
      await started.promise
      await other.storageFixture.list()
      await handled.promise
      const locks = await navigator.locks.query()
      const active = locks.held.filter((lock) => lock.name === 'daw-browser-project-cleanup-runner').length
      const queued = locks.pending.filter((lock) => lock.name === 'daw-browser-project-cleanup-runner').length
      release.resolve()
      await root
      await completion.promise
      await drainCleanup()
      return { otherScans, active, queued }
    } finally {
      release.resolve(); IDBObjectStore.prototype.getAll = original
      other.IDBObjectStore.prototype.getAll = otherOriginal
      other.navigator.locks.request = otherRequest
      completion.restore(); catalog.close(); frame.remove()
    }
  },
  list: () => listLocalProjects(),
}
`
  const result = await build({
    root: repositoryRoot,
    configFile: false,
    logLevel: 'silent',
    plugins: [solidPlugin(), {
      name: 'local-project-storage-fixture',
      enforce: 'pre',
      resolveId: (id) => {
        if (id.endsWith(fixtureId)) return `\0${fixtureId}.ts`
        if (id.endsWith('hooks/useShareMenuController')) return '\0stub:share.ts'
        if (id.endsWith('hooks/useProjectSaveStatus')) return '\0stub:status.ts'
        if (id.endsWith('lib/shared-outbox')) return '\0stub:outbox.ts'
        if (id.endsWith('lib/local-project-pending-writes')) return '\0stub:pending.ts'
        return undefined
      },
      load: (id) => {
        if (id === `\0${fixtureId}.ts`) return source
        if (id === '\0stub:share.ts') return 'export const useShareMenuController = () => ({})'
        if (id === '\0stub:status.ts') return 'export const useProjectSaveStatus = () => () => ({})'
        if (id === '\0stub:outbox.ts') return 'export const readSharedOutboxRetryState = async () => ({})'
        if (id === '\0stub:pending.ts') return 'export const flushLocalProjectPendingWrites = async () => {}'
        return undefined
      },
    }],
    resolve: { alias: { '~': `${repositoryRoot}src` } },
    build: { write: false, minify: false, lib: { entry: fixtureId, formats: ['iife'], name: 'storageFixture' } },
  })
  const output = Array.isArray(result) ? result[0] : result
  if (!output || !('output' in output)) throw new Error('Expected storage fixture bundle')
  const directory = `/tmp/daw-storage-round6-${crypto.randomUUID()}`
  await mkdir(directory, { recursive: true })
  const html = `<!doctype html><body><script>${output.output[0].code}</script>`
  await Bun.write(`${directory}/index.html`, html)
  // Only serve the built Chromium fixture; this is not the application dev server.
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(html, { headers: { 'Content-Type': 'text/html' } }) })
  const session = `storage-round6-${crypto.randomUUID()}`
  const env = { ...process.env }
  delete env.AGENT_BROWSER_CDP
  delete env.AGENT_BROWSER_SESSION
  const run = async (...args: string[]) => {
    const child = Bun.spawn(['agent-browser', '--session', session, ...args], { env, stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
    if (await child.exited !== 0) throw new Error(stderr || stdout)
    return stdout.trim()
  }
  const results: [string, unknown][] = []
  const read = async (method: string) => {
    const value = z.json().parse(JSON.parse(JSON.parse(
      await run('eval', `storageFixture.${method}().then(JSON.stringify)`),
    )))
    // toMatchObject rewrites matched fields in place, so the evidence keeps an untouched copy.
    results.push([method, structuredClone(value)])
    return value
  }
  await run('open', server.url.href)
  try {
    const upgrade = await read('upgrade')
    expect(upgrade).toMatchObject({ version: 2, names: ['V1 A', 'V1 B'], jobs: 0, directoryPreserved: true })
    expect(upgrade).toMatchObject({ assets: [[{ storagePath: 'v1.wav' }], [{ storagePath: 'v1.wav' }]] })
    expect(upgrade).toMatchObject({ bytes: ['V1 B', 'V1 A'] })
    expect(await read('downgrade')).toMatchObject({
      original: 'VersionError', name: 'LocalProjectCatalogVersionError',
      message: expect.stringContaining('newer version'),
    })
    expect(await read('versionchange')).toEqual({ version: 3, projects: 2, reopened: 0 })
    expect(await read('blocked')).toMatchObject({
      error: expect.stringContaining('Close or reload other tabs'), recovered: true, retry: true,
    })
    expect(await read('slowCleanup')).toEqual({
      firstVisible: true, secondVisible: true, scans: 1, pending: 1, remaining: 0, normalSave: true,
    })
    expect(await read('failedCleanup')).toEqual({ listed: true, retained: 1 })
    expect(await read('boundedCleanup')).toEqual({ remaining: 2, final: 0 })
    expect(await read('sharedRace')).toEqual({ survivor: true, published: true, bytes: 'surviving bytes' })
    expect(await read('folderRollback')).toEqual({
      kind: 'quota-exceeded', originalOpfs: true, reservationRemoved: true, bytes: 'original audio',
    })
    expect(await read("publicationRace.bind(null, 'recovery')")).toEqual({
      before: 0, live: 1, gc: 0, bytes: 'recovery bytes',
    })
    expect(await read("publicationRace.bind(null, 'import')")).toEqual({
      before: 0, live: 1, gc: 0, bytes: 'import bytes',
    })
    expect(await read("publicationRace.bind(null, 'replacement')")).toEqual({
      before: 1, live: 1, gc: 0, bytes: 'replacement bytes',
    })
    expect(await read('atomicRecoveryRace')).toEqual({ atomic: true, live: 1, bytes: 'atomic bytes' })
    expect(await read('recreated')).toEqual({ jobs: 0, live: 1, bytes: 'new incarnation' })
    expect(await read('starvation')).toEqual({ first: 9, attempted: 8, laterProcessed: true })
    expect(await read('crossTab')).toEqual({ otherScans: 0, active: 1, queued: 0 })
    for (const kind of ['dashboard', 'gc']) {
      for (const retention of ['live', 'implicit', 'gc', 'copy', 'none']) {
        expect(await read("sharedAssetRemoval.bind(null, '" + kind + "', '" + retention + "')")).toEqual({
          bytes: retention === 'none' ? null : 'shared audio', live: 0, gc: 0,
        })
      }
    }
    expect(await read("reservationRecovery.bind(null, 'closed')")).toEqual({
      reservation: false, pending: false, finalReservation: false, finalPending: false,
      expectedRoot: 'implicit-opfs', retainedChosenRoot: false, restoredImplicitRoot: true,
    })
    expect(await read("reservationRecovery.bind(null, 'live')")).toEqual({
      reservation: true, pending: true, finalReservation: false, finalPending: false,
      expectedRoot: 'implicit-opfs', retainedChosenRoot: false, restoredImplicitRoot: true,
    })
    expect(await read("reservationRecovery.bind(null, 'chosen')")).toEqual({
      reservation: true, pending: true, finalReservation: false, finalPending: false,
      expectedRoot: 'chosen', retainedChosenRoot: true, restoredImplicitRoot: false,
    })
    expect(await read('sameTabReservation')).toEqual({
      reservation: true, pending: true, finalReservation: false, finalPending: false, bytes: 'same-tab bytes',
    })
    expect(await read('duplicateGcPath')).toEqual({
      finalized: true, firstRemoval: { pendingGc: 1, bytes: 'duplicate bytes' }, gc: 0, bytes: null,
    })
    expect(await read('gcPublicationRace')).toEqual({
      collection: false, beforePublication: 0, published: 'race.wav', bytesDuringPause: 'race bytes',
      bytesAfter: 'race bytes', gcRetained: 1,
    })
    expect(await read('settledCopyFailure')).toEqual({
      rejected: false, held: true, reserved: true, kind: 'quota-exceeded', rolledBack: true, bytes: 'first bytes',
    })
    expect(await read('versionGuidance')).toContain('Update or reload the app, then retry.')
    await Bun.write(`${directory}/result.json`, JSON.stringify(Object.fromEntries(results)))
    console.log(`Storage Chromium evidence: ${directory}`)
  } finally {
    await run('close').catch(() => '')
    await server.stop(true)
  }
}, 20_000)
