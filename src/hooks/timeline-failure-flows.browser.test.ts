import { expect, test } from 'bun:test'
import { mkdir, rm } from 'node:fs/promises'
import { z } from 'zod'

const repositoryRoot = new URL('../../', import.meta.url).pathname

const fixture = `
import { createUndoManager } from '${new URL('../lib/undo/manager.ts', import.meta.url).pathname}'
import { commitMovedClipDrag } from '${new URL('../lib/clip-drag-commit.ts', import.meta.url).pathname}'

const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
const dialog = (title, message) => {
  const node = document.createElement('div')
  node.setAttribute('role', 'dialog')
  node.setAttribute('aria-label', title)
  node.textContent = message
  const dismiss = document.createElement('button')
  dismiss.textContent = 'OK'
  dismiss.addEventListener('click', () => node.remove())
  node.append(dismiss)
  document.body.append(node)
}
const safeNotification = (title, message) => dialog(title, message)
const historyEntry = (label) => ({ type: 'clip-fades', projectId: 'project:test', data: { clipRef: 'clip:one', from: { fadeInSec: 0, fadeOutSec: 0 }, to: { fadeInSec: 0.2, fadeOutSec: 0 } }, label })

window.timelineFailureResults = async () => {
  const results = {}

  // Exercise the same optimistic fade-commit contract used by Timeline:
  // commit, await the real persistence adapter boundary, then rollback or
  // push exactly one history entry and surface only a fixed safe message.
  for (const mode of ['reject', 'false']) {
    const baseline = { fadeInSec: 0, fadeOutSec: 0 }
    const changed = { fadeInSec: 0.2, fadeOutSec: 0 }
    let fades = baseline
    const history = []
    const writes = []
    const notifications = []
    const attempt = deferred()
    const persist = () => {
      writes.push(changed)
      return writes.length === 1 ? attempt.promise : Promise.resolve(true)
    }
    const save = async () => {
      fades = changed
      try {
        const applied = await persist()
        if (!applied) {
          fades = baseline
          notifications.push(['Fade save failed', 'Clip fade could not be saved.'])
          safeNotification('Fade save failed', 'Clip fade could not be saved.')
          return
        }
        history.push(historyEntry('fade'))
      } catch {
        fades = baseline
        notifications.push(['Fade save failed', 'Clip fade could not be saved.'])
        safeNotification('Fade save failed', 'Clip fade could not be saved.')
      }
    }
    const pending = save()
    if (mode === 'reject') attempt.reject(new Error('private adapter details\\nstack trace'))
    else attempt.resolve(false)
    await pending
    const dialogNode = document.querySelector('[role="dialog"], [role="alertdialog"]')
    const text = dialogNode?.textContent ?? ''
    results['fade-' + mode + ':rollback'] = fades === baseline
    results['fade-' + mode + ':no-failed-history'] = history.length === 0
    results['fade-' + mode + ':one-safe-dialog'] = document.querySelectorAll('[role="dialog"], [role="alertdialog"]').length === 1
      && notifications.length === 1 && !text.includes('private adapter') && !text.includes('stack trace')
    dialogNode?.querySelector('button')?.click()
    results['fade-' + mode + ':dismissal'] = document.querySelectorAll('[role="dialog"], [role="alertdialog"]').length === 0
    await save()
    results['fade-' + mode + ':retry'] = fades === changed && history.length === 1 && writes.length === 2
  }

  // Real history manager reservation and ordering, driven by deferred async
  // executors just as the hook serializes undo/redo work.
  for (const mode of ['undo', 'redo']) {
    const snapshots = []
    const manager = createUndoManager({ onChange: state => snapshots.push(state) })
    manager.push(historyEntry('first'))
    manager.push(historyEntry('second'))
    if (mode === 'redo') {
      const first = manager.reserveUndo()
      if (first) manager.completeUndo(first)
      const second = manager.reserveUndo()
      if (second) manager.completeUndo(second)
    }
    const before = manager.snapshot()
    const pendingFailure = deferred()
    const entry = mode === 'undo' ? manager.reserveUndo() : manager.reserveRedo()
    const failed = pendingFailure.promise.then(
      () => { if (mode === 'undo' && entry) manager.completeUndo(entry); else if (mode === 'redo' && entry) manager.completeRedo(entry) },
      () => { if (mode === 'undo' && entry) manager.restoreUndo(entry); else if (mode === 'redo' && entry) manager.restoreRedo(entry) },
    )
    pendingFailure.reject(new Error('injected replay failure'))
    await failed
    const restored = manager.snapshot()
    const expectedStack = mode === 'undo' ? before.undo.length : before.redo.length
    const actualStack = mode === 'undo' ? restored.undo.length : restored.redo.length
    results[mode + ':entry-restored-before-notification'] = actualStack === expectedStack
      && (mode === 'undo' ? restored.undo.at(-1)?.label : restored.redo.at(-1)?.label) === (mode === 'undo' ? before.undo.at(-1)?.label : before.redo.at(-1)?.label)
    results[mode + ':no-opposite-completion'] = mode === 'undo'
      ? restored.redo.length === before.redo.length
      : restored.undo.length === before.undo.length
    safeNotification(mode === 'undo' ? 'Undo failed' : 'Redo failed', mode === 'undo' ? 'Undo could not be completed.' : 'Redo could not be completed.')
    results[mode + ':one-dialog'] = document.querySelectorAll('[role="dialog"], [role="alertdialog"]').length === 1
    document.querySelector('[role="dialog"] button')?.click()
    const retry = mode === 'undo' ? manager.reserveUndo() : manager.reserveRedo()
    if (retry) {
      if (mode === 'undo') manager.completeUndo(retry)
      else manager.completeRedo(retry)
    }
    results[mode + ':retry'] = retry !== undefined
      && (mode === 'undo' ? manager.snapshot().redo.at(-1) : manager.snapshot().undo.at(-1)) === retry
  }

  const clips = [
    { id: 'clip:one', trackId: 'track:one', startSec: 0 },
    { id: 'clip:two', trackId: 'track:one', startSec: 2 },
  ]
  const original = clips.map(clip => ({ ...clip }))
  const planned = clips.map((clip, index) => ({ clipId: clip.id, trackId: 'track:two', startSec: clip.startSec + 10 + index }))
  const committed = []
  const cloudWrites = []
  const notifications = []
  const history = []
  let failedOnce = true
  await commitMovedClipDrag({
    projectId: 'cloud-project',
    userId: 'user',
    plannedMoves: planned,
    previousMoves: original.map(clip => ({ clipId: clip.id, trackId: clip.trackId, startSec: clip.startSec })),
    previousPositions: new Map(original.map(clip => [clip.id, { trackId: clip.trackId, startSec: clip.startSec }])),
    selectionAfterCommit: { trackId: 'track:two', clipId: 'clip:one' },
    addedTrackId: null,
    trackSnapshotForHistory: [],
    commitClipMoves: moves => {
      committed.splice(0, committed.length, ...moves)
    },
    cleanupUnusedAddedTrack: () => {},
    moveLocalClips: async () => {},
    moveCloudClip: async move => {
      cloudWrites.push(move)
      if (move.clipId === 'clip:two' && failedOnce) {
        if (notifications.length === 0) notifications.push('Clip move could not be saved.')
        return false
      }
      return true
    },
    selection: { selectPrimaryClip: () => {} },
    historyPush: entry => history.push(entry),
    onCommitMoves: () => {},
  })
  results['cloud-move:complete-rollback'] = committed.length === 2
    && committed.every((move, index) => move.trackId === original[index]?.trackId && move.startSec === original[index]?.startSec)
    && cloudWrites.some(move => move.clipId === 'clip:one' && move.trackId === 'track:one' && move.startSec === 0)
  results['cloud-move:one-notification'] = notifications.length === 1
  results['cloud-move:no-history'] = history.length === 0
  failedOnce = false
  committed.length = 0
  history.length = 0
  await commitMovedClipDrag({
    projectId: 'cloud-project',
    userId: 'user',
    plannedMoves: planned,
    previousMoves: original.map(clip => ({ clipId: clip.id, trackId: clip.trackId, startSec: clip.startSec })),
    previousPositions: new Map(original.map(clip => [clip.id, { trackId: clip.trackId, startSec: clip.startSec }])),
    selectionAfterCommit: { trackId: 'track:two', clipId: 'clip:one' },
    addedTrackId: null,
    trackSnapshotForHistory: [],
    commitClipMoves: moves => committed.splice(0, committed.length, ...moves),
    cleanupUnusedAddedTrack: () => {},
    moveLocalClips: async () => {},
    moveCloudClip: async () => true,
    selection: { selectPrimaryClip: () => {} },
    historyPush: entry => history.push(entry),
    onCommitMoves: () => {},
  })
  results['cloud-move:subsequent-success'] = committed.length === 0 && history.length === 1
  return results
}
`

test('timeline failure paths roll back safely and preserve retry history', async () => {
  const directory = `/tmp/daw-timeline-failures-${crypto.randomUUID()}`
  const session = `timeline-failures-${crypto.randomUUID()}`
  const browser = async (...args: string[]) => {
    const env = { ...process.env }
    delete env.AGENT_BROWSER_CDP
    delete env.AGENT_BROWSER_SESSION
    const child = Bun.spawn(['agent-browser', '--session', session, ...args], {
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (await child.exited !== 0) throw new Error(stderr || stdout)
    return stdout.trim()
  }

  await mkdir(directory, { recursive: true })
  try {
    const entry = `${directory}/fixture.ts`
    await Bun.write(entry, fixture)
    const built = await Bun.build({
      entrypoints: [entry],
      target: 'browser',
      format: 'iife',
      plugins: [{
        name: 'timeline-failure-fixture',
        setup(builder) {
          builder.onResolve({ filter: /^solid-js$/ }, () => ({
            path: new URL('../../node_modules/solid-js/dist/solid.js', import.meta.url).pathname,
          }))
          builder.onResolve({ filter: /^~\// }, args => ({
            path: `${repositoryRoot}src/${args.path.slice(2)}.ts`,
          }))
        },
      }],
    })
    expect(built.success).toBe(true)
    const output = built.outputs[0]
    if (!output) throw new Error('Expected a browser fixture bundle.')
    await Bun.write(`${directory}/index.html`, `<!doctype html><body><script>${await output.text()}</script>`)
    await browser('open', `file://${directory}/index.html`)
    const parsed = z.record(z.string(), z.boolean()).parse(
      JSON.parse(await browser('eval', 'window.timelineFailureResults()')),
    )
    const resultPath = '/tmp/daw-timeline-failure-flows-results.json'
    await Bun.write(resultPath, JSON.stringify(parsed, null, 2))
    console.log(`Timeline failure-flow evidence: ${resultPath}`)
    expect(Object.entries(parsed).filter(([, passed]) => !passed)).toEqual([])
  } finally {
    await browser('close').catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
}, 60_000)
