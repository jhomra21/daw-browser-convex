import tailwindcss from '@tailwindcss/vite'
import { expect, test } from 'bun:test'
import { mkdir } from 'node:fs/promises'
import { build } from 'vite'
import solidPlugin from 'vite-plugin-solid'
import { z } from 'zod'

const repositoryRoot = new URL('../../', import.meta.url).pathname
const evidenceDirectory = `/tmp/daw-shared-retry-${crypto.randomUUID()}`
const fixtureId = 'virtual:shared-retry-fixture'

const buildFixture = async () => {
  const source = `
import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { useTimelinePersistenceController } from '~/hooks/useTimelinePersistenceController'
import { flushSharedOutbox } from '~/lib/shared-outbox'
import { openLocalProjectDb } from '~/lib/local-project-db'

let dispose
let setProjectId
const timers = new Map()
let timerSequence = 0
const listeners = new Set()
const calls = []
const state = { nextAttemptAt: undefined, failure: undefined }
let realMode = false
let database
let originalTransaction
let publishGate
let published
let manualFlush
let timerReady
const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
let pendingFlushes = []
window.syncProbe = {
  mount: () => {
    dispose?.()
    timers.clear()
    listeners.clear()
    calls.length = 0
    pendingFlushes = []
    state.nextAttemptAt = undefined
    state.failure = undefined
    timerReady = deferred()
    window.setTimeout = (callback, delay) => {
      const id = ++timerSequence
      timers.set(id, { callback, delay })
      timerReady.resolve()
      return id
    }
    window.clearTimeout = (id) => timers.delete(id)
    const [projectId, updateProjectId] = createSignal('shared-a')
    setProjectId = updateProjectId
    const host = document.createElement('div')
    document.body.replaceChildren(host)
    const localProject = {
      localTimelineReloadVersion: () => 0,
      setLocalSaveFailure: () => {},
      backUpNow: async () => {},
    }
    dispose = render(() => {
      useTimelinePersistenceController({
        projectId,
        mountedProjectGeneration: () => 0,
        remoteTimelineAvailable: () => true,
        localProjectMode: () => undefined,
        userId: () => 'user',
        renderTracks: () => [],
        audioEngine: {},
        audioBufferCache: {},
        preloadClipBuffer: async () => {},
        getClipBuffer: () => undefined,
        localProject,
        projection: { insertLocalClip: () => {}, removeLocalClips: () => {} },
        selection: {
          selectedClip: () => null,
          setSelectedClip: () => {},
          setSelectedClipIds: () => {},
          selectTrackTarget: () => {},
        },
        notify: () => {},
      })
      return document.createElement('span')
    }, host)
  },
  state: (value) => { state.nextAttemptAt = value },
  resolveFlush: (index) => pendingFlushes[index]?.resolve(),
  timerCount: () => timers.size,
  timerDelays: () => Array.from(timers.values()).map((timer) => timer.delay),
  fireTimer: () => {
    const timer = Array.from(timers.entries())[0]
    if (!timer) return false
    timers.delete(timer[0])
    timerReady = deferred()
    timer[1].callback()
    return true
  },
  switchProject: (projectId) => setProjectId(projectId),
  unmount: () => dispose?.(),
  publishCalls: () => calls.length,
  emitChange: () => { for (const listener of listeners) listener() },
  flushStates: () => pendingFlushes.length,
  waitTimer: () => timerReady.promise,
  useReal: async () => {
    realMode = true
    database = await openLocalProjectDb('shared-a')
    originalTransaction = database.transaction.bind(database)
    const timestamp = Date.now() - 1000
    await database.put('syncState', {
      key: 'shared-outbox:real-entry',
      value: {
        id: 'real-entry', projectId: 'shared-a', userId: 'user', kind: 'tracks.setVolume',
        payload: { trackId: 'track-1', volume: 0.5 }, status: 'pending', attempts: 0,
        nextAttemptAt: timestamp, sequence: 1, createdAt: timestamp, updatedAt: timestamp,
      },
      updatedAt: timestamp,
    })
  },
  failStorage: () => Object.defineProperty(database, 'transaction', {
    configurable: true,
    value: (...args) => {
      if (args[1] === 'readwrite') throw new Error('Injected outbox IndexedDB write failure')
      return originalTransaction(...args)
    },
  }),
  restoreStorage: () => Object.defineProperty(database, 'transaction', { configurable: true, value: originalTransaction }),
  preparePublication: () => {
    published = deferred()
    publishGate = deferred()
    window.fetch = async () => {
      calls.push(Date.now())
      published.resolve()
      await publishGate.promise
      return new Response(JSON.stringify({ status: 'applied' }), { status: 200 })
    }
  },
  waitPublished: () => published.promise,
  manualFlush: () => { manualFlush = flushSharedOutbox('shared-a', 'user', { retryFailed: true }) },
  releasePublication: async () => {
    publishGate.resolve()
    await manualFlush
  },
  unmountReal: () => { dispose?.(); realMode = false },
}
window.sharedOutboxFixture = {
  real: () => realMode,
  read: async () => ({ nextAttemptAt: state.nextAttemptAt, failure: state.failure }),
  flush: () => {
    calls.push(Date.now())
    const operation = deferred()
    pendingFlushes.push(operation)
    return operation.promise
  },
  subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
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
        name: 'shared-retry-fixture',
        enforce: 'pre',
        resolveId: (id) => {
          if (id.endsWith(fixtureId)) return `\0${fixtureId}.ts`
          if (id.endsWith('lib/shared-outbox')) return '\0stub:outbox.ts'
          if (id.endsWith('lib/local-project-changes')) return '\0stub:changes.ts'
          if (id.endsWith('hooks/useCloudSyncTick') || id.endsWith('hooks/useCloudSyncTick.ts')) return '\0stub:cloud-tick.ts'
          if (id.endsWith('lib/timeline-clip-write-adapter')) return '\0stub:clip-adapter.ts'
          if (id.endsWith('hooks/useLocalTimelineMediaRecovery')) return '\0stub:recovery.ts'
          return undefined
        },
        load: (id) => {
          if (id === `\0${fixtureId}.ts`) return source
          if (id === '\0stub:outbox.ts') return `export * from '${repositoryRoot}src/lib/shared-outbox.ts'
            import * as real from '${repositoryRoot}src/lib/shared-outbox.ts'
            export const readSharedOutboxRetryState = (...args) => window.sharedOutboxFixture.real() ? real.readSharedOutboxRetryState(...args) : window.sharedOutboxFixture.read()
            export const flushSharedOutbox = (...args) => window.sharedOutboxFixture.real() ? real.flushSharedOutbox(...args) : window.sharedOutboxFixture.flush()`
          if (id === '\0stub:changes.ts') return `export * from '${repositoryRoot}src/lib/local-project-changes.ts'
            import * as real from '${repositoryRoot}src/lib/local-project-changes.ts'
            export const subscribeToLocalProjectChanges = (projectId, listener) => window.sharedOutboxFixture.real() ? real.subscribeToLocalProjectChanges(projectId, listener) : window.sharedOutboxFixture.subscribe(listener)`
          if (id === '\0stub:cloud-tick.ts') return `export const useCloudSyncTick = () => {}`
          if (id === '\0stub:clip-adapter.ts') return `export const createTimelineClipWriteAdapter = () => ({ deleteClips: async () => ({ removedIds: new Set() }) })`
          if (id === '\0stub:recovery.ts') return `export const useMissingMediaRecovery = () => ({ reloadLocalTimeline: async () => {}, ensureMountedLocalMedia: async () => {} })`
          return undefined
        },
      },
    ],
    resolve: { alias: { '~': `${repositoryRoot}src` } },
    build: { write: false, minify: false, lib: { entry: fixtureId, formats: ['iife'], name: 'sharedRetryFixture' } },
  })
  const output = Array.isArray(result) ? result[0] : result
  if (!output || !('output' in output)) throw new Error('Expected one persistence controller bundle.')
  const styles = output.output.flatMap((chunk) => (
    chunk.type === 'asset' && chunk.fileName.endsWith('.css') ? [String(chunk.source)] : []
  ))
  return `<!doctype html><head><style>${styles.join('\n')}</style></head><body style="margin:0"><script>${output.output[0].code}</script>`
}

const retryStateSchema = z.object({
  calls: z.number(),
  timers: z.number(),
  delays: z.array(z.number()),
  subscriptions: z.number(),
})

test('shared outbox schedules pending deadlines and clears project timers', async () => {
  const directory = `${evidenceDirectory}/browser`
  await mkdir(directory, { recursive: true })
  await Bun.write(`${directory}/index.html`, await buildFixture())
  const session = `shared-retry-${crypto.randomUUID()}`
  const env = { ...process.env }
  delete env.AGENT_BROWSER_CDP
  delete env.AGENT_BROWSER_SESSION
  const run = async (...args: string[]) => {
    const child = Bun.spawn(['agent-browser', '--session', session, ...args], { env, stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
    if (await child.exited !== 0) throw new Error(stderr || stdout)
    return stdout.trim()
  }
  const read = async () => retryStateSchema.parse(JSON.parse(JSON.parse(
    await run('eval', `(async () => JSON.stringify({
      calls: syncProbe.publishCalls(),
      timers: syncProbe.timerCount(),
      delays: syncProbe.timerDelays(),
      subscriptions: syncProbe.flushStates(),
    }))()`),
  )))
  await run('open', `file://${directory}/index.html`)
  try {
    await run('eval', 'syncProbe.mount()')
    expect(await read()).toMatchObject({ calls: 1 })
    await run('eval', 'syncProbe.state(Date.now()); syncProbe.emitChange()')
    expect(await read()).toMatchObject({ calls: 1, timers: 1 })
    await run('eval', 'syncProbe.fireTimer()')
    expect(await read()).toMatchObject({ calls: 1, timers: 0 })
    await run('eval', 'syncProbe.resolveFlush(0)')
    expect(await read()).toMatchObject({ calls: 2 })
    await run('eval', 'syncProbe.state(undefined); syncProbe.resolveFlush(1)')
    await run('eval', 'syncProbe.switchProject("shared-b")')
    expect(await read()).toMatchObject({ calls: 3, timers: 0 })
    await run('eval', 'syncProbe.unmount()')
    expect(await read()).toMatchObject({ timers: 0 })
    await run('eval', 'syncProbe.useReal()')
    await run('eval', 'syncProbe.failStorage(); syncProbe.mount(); syncProbe.waitTimer()')
    const firstFailure = await read()
    expect(firstFailure).toMatchObject({ calls: 0, timers: 1 })
    expect(firstFailure.delays[0]).toBeGreaterThan(0)
    await run('eval', 'syncProbe.fireTimer(); syncProbe.waitTimer()')
    const secondFailure = await read()
    expect(secondFailure.delays[0]).toBeGreaterThan(firstFailure.delays[0] ?? 0)
    await run('eval', 'syncProbe.fireTimer(); syncProbe.waitTimer()')
    const thirdFailure = await read()
    expect(thirdFailure.delays[0]).toBeGreaterThan(secondFailure.delays[0] ?? 0)
    expect(thirdFailure.calls).toBe(0)
    const backoffDelays = [firstFailure.delays[0], secondFailure.delays[0], thirdFailure.delays[0]]
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await run('eval', 'syncProbe.fireTimer(); syncProbe.waitTimer()')
      const failure = await read()
      expect(failure.delays[0]).toBeGreaterThan(0)
      expect(failure.delays[0]).toBeLessThanOrEqual(60_000)
      backoffDelays.push(failure.delays[0])
    }
    expect(backoffDelays[5]).toBeGreaterThan(59_000)
    expect(backoffDelays[6]).toBeGreaterThan(59_000)
    await run('eval', 'syncProbe.restoreStorage(); syncProbe.preparePublication(); window.dispatchEvent(new Event("online")); syncProbe.waitPublished()')
    await run('eval', 'syncProbe.manualFlush(); window.dispatchEvent(new Event("online"))')
    expect(await read()).toMatchObject({ calls: 1 })
    await run('eval', 'syncProbe.releasePublication()')
    expect(await read()).toMatchObject({ calls: 1, timers: 0 })
    await run('eval', 'syncProbe.unmountReal()')
    await Bun.write(`${directory}/result.json`, JSON.stringify({ realStorageBackoff: backoffDelays, overlappingPublications: 1 }))
    console.log(`Shared outbox Chromium evidence: ${directory}`)
  } finally {
    await run('close').catch(() => '')
  }
})
