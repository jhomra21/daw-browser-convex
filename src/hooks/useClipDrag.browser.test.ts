import { expect, test } from 'bun:test'
import { mkdir } from 'node:fs/promises'
import { z } from 'zod'

// Gate the persistence and duplicate-creation boundaries, not pointer handlers:
// actual window events, Solid cleanup, placement, draft teardown, and move
// history run in Chromium.
const fixture = `
import { createRoot, createSignal } from 'solid-js'
import { useClipDrag } from './useClipDrag'
import { useTimelineSelectionState } from './useTimelineSelectionState'
window.clipDragResults = async () => {
  const results = {}
  const errors = []
  window.addEventListener('unhandledrejection', event => { errors.push(String(event.reason)); event.preventDefault() })
  const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
  for (const scenario of ['cancel', 'release', 'new-gesture', 'project', 'unmount', 'reject-move', 'reject-drop', 'reject-commit', 'success', 'duplicate-cancel', 'duplicate-release', 'cancel-after-create', 'populated-after-create', 'project-after-create']) {
    let dispose
    let tracks = [{ id: 'track:source', name: 'Source', volume: 0.8, kind: 'audio', clips: [{ id: 'clip:source', name: 'Clip', startSec: 0, duration: 2, offsetSec: 0, color: '#ffffff' }] }]
    let drafts = []
    let previews = new Map()
    const history = []
    const requests = []
    const deleted = []
    const notifications = []
    window.dragPersistence = {
      isLocalProject: () => true,
      // Mirrors createTrackForDrag: an obsolete result is deleted, not projected.
      createTrackForDrag: (kind, isCurrent) => new Promise((resolve, reject) => {
        const id = 'track:auto-' + requests.length
        requests.push({
          reject,
          resolve: () => {
            if (!isCurrent()) { deleted.push(id); resolve(null); return }
            tracks = [...tracks, { id, name: id, volume: 0.8, kind, clips: [] }]
            resolve(id)
          }
        })
      }),
      deleteEmptyTrack: async id => { deleted.push(id); tracks = tracks.filter(track => track.id !== id) },
      moveLocalClips: async () => {
        if (scenario === 'reject-commit') throw new Error('private persistence detail')
      },
      moveCloudClip: async () => true,
    }
    window.commitDuplicate = async input => {
      if (!input.canProject()) return []
      const created = input.items.map((item, index) => ({ trackId: item.trackId, clipId: 'clip:duplicate-' + index, clip: item.clip }))
      tracks = tracks.map(track => ({ ...track, clips: [...track.clips, ...created.filter(item => item.trackId === track.id).map(item => ({ ...item.clip, id: item.clipId, offsetSec: 0 }))] }))
      history.push({ type: 'clip-duplicate', addedTrackId: input.addedTrackId })
      return created
    }
    const [projectId, setProjectId] = createSignal('project:first')
    const scroll = document.createElement('div')
    scroll.style.cssText = 'position:fixed;left:0;top:0;width:800px;height:400px'
    document.body.append(scroll)
    const hook = createRoot(cleanup => {
      dispose = cleanup
      return useClipDrag({
        placementTracks: () => tracks,
        resolvedTracks: () => tracks,
        trackLayout: () => tracks.map((track, index) => ({ trackId: track.id, topPx: index * 80, heightPx: 80, clipLaneHeightPx: 80, automationHeightPx: 0, depth: 0 })),
        insertLocalTrack: track => { tracks = [...tracks, track] },
        removeLocalTrack: id => { tracks = tracks.filter(track => track.id !== id) },
        insertLocalClip: () => {}, removeLocalClips: () => {},
        replaceDraftClipMoves: moves => { drafts = moves },
        clearDraftClipMoves: () => { drafts = [] },
        setPreviewClipsByTrack: value => { previews = value },
        commitClipMoves: moves => {
          for (const move of moves) {
            const clip = tracks.flatMap(track => track.clips).find(clip => clip.id === move.clipId)
            tracks = tracks.map(track => ({ ...track, clips: [...track.clips.filter(clip => clip.id !== move.clipId), ...(track.id === move.trackId ? [{ ...clip, startSec: move.startSec }] : [])] }))
          }
        },
        canWriteClip: () => true,
        selection: useTimelineSelectionState({ projectId, tracks: () => tracks }),
        projectId, userId: () => '', convexClient: {}, convexApi: {},
        getScrollElement: () => scroll, bpm: () => 120, gridEnabled: () => false,
        gridDenominator: () => 4, pixelsPerSecond: () => 100,
        audioBufferCache: { writer: {}, getBuffer: () => null }, historyPush: entry => history.push(entry),
        notify: (title, message) => notifications.push({ title, message }),
      })
    })
    const ctrlKey = scenario.startsWith('duplicate')
    const pointer = (type, y = 300) => new PointerEvent(type, { pointerId: 1, button: 0, clientX: 100, clientY: y, ctrlKey })
    const start = () => hook.onClipPointerDown('track:source', 'clip:source', pointer('pointerdown', 30))
    const movedToCreatedTrack = () => history.filter(entry => entry.type === 'clips-move').length === 1 && tracks[1]?.clips.length === 1 && tracks.length === 2
    const afterCreate = scenario.endsWith('after-create')
    start()
    window.dispatchEvent(pointer(scenario === 'reject-drop' ? 'pointerup' : 'pointermove'))
    if (scenario === 'success') window.dispatchEvent(pointer('pointermove', 320))
    results[scenario + ':single-request'] = requests.length === 1
    if (scenario === 'cancel' || scenario === 'duplicate-cancel') window.dispatchEvent(pointer('pointercancel'))
    const releasedWhilePending = scenario === 'release' || scenario === 'duplicate-release'
    if (releasedWhilePending) window.dispatchEvent(pointer('pointerup'))
    if (scenario === 'new-gesture') {
      start()
      window.dispatchEvent(pointer('pointermove'))
    }
    if (scenario === 'project') setProjectId('project:second')
    if (scenario === 'unmount') dispose()
    if (scenario.startsWith('reject') && scenario !== 'reject-commit') requests[0].reject(new Error('Creation failed'))
    else requests[0].resolve()
    await settle()
    if (scenario === 'reject-commit') {
      window.dispatchEvent(pointer('pointerup', 180))
      await settle()
      results['reject-commit:rollback'] = history.length === 0 && tracks[0].clips[0].startSec === 0
      results['reject-commit:notification'] = notifications.some(message =>
        message.title === 'Clip move failed' && message.message === 'Clip move could not be saved.'
      )
      dispose()
      scroll.remove()
      continue
    }
    if (scenario === 'populated-after-create') {
      tracks = tracks.map(track => track.id === 'track:auto-0' ? { ...track, clips: [{ id: 'clip:remote', name: 'Remote', startSec: 4, duration: 1, offsetSec: 0, color: '#ffffff' }] } : track)
    }
    if (scenario === 'cancel-after-create' || scenario === 'populated-after-create') window.dispatchEvent(pointer('pointercancel'))
    if (scenario === 'project-after-create') setProjectId('project:second')
    await settle()
    if (scenario !== 'success') results[scenario + ':no-draft'] = drafts.length === 0 && previews.size === 0
    if (scenario === 'success') {
      window.dispatchEvent(pointer('pointerup', 180))
      await settle()
      results['success:commit'] = movedToCreatedTrack()
    } else if (releasedWhilePending) {
      // The drop waits for its track, then commits like a drop onto an existing lane.
      results[scenario + ':commit'] = scenario === 'release'
        ? movedToCreatedTrack()
        : history.length === 1 && history[0].addedTrackId === 'track:auto-0' && tracks.length === 2 && tracks[0].clips.length === 1 && tracks[1].clips.length === 1
      results[scenario + ':inactive'] = !hook.isDragging() && deleted.length === 0
    } else if (scenario === 'new-gesture') {
      results['new-gesture:still-active'] = hook.isDragging() && requests.length === 2 && deleted.join() === 'track:auto-0'
      requests[1].resolve()
      await settle()
      window.dispatchEvent(pointer('pointerup', 180))
      await settle()
      results['new-gesture:commit'] = movedToCreatedTrack()
    } else if (afterCreate) {
      const removesEmptyOwnedTrack = scenario === 'cancel-after-create'
      results[scenario + ':cleanup'] = removesEmptyOwnedTrack
        ? deleted.join() === 'track:auto-0' && tracks.length === 1
        : deleted.length === 0 && tracks.length === 2
      results[scenario + ':inactive'] = !hook.isDragging() && history.length === 0 && tracks[0].clips[0].startSec === 0
    } else {
      results[scenario + ':unchanged'] = history.length === 0 && tracks.length === 1 && tracks[0].clips[0].startSec === 0
      results[scenario + ':inactive'] = !hook.isDragging()
      if (scenario.startsWith('reject')) {
        start()
        window.dispatchEvent(pointer('pointermove'))
        requests[1].resolve()
        await settle()
        window.dispatchEvent(pointer('pointerup', 180))
        await settle()
        results[scenario + ':recovers'] = movedToCreatedTrack()
      } else {
        results[scenario + ':obsolete-discarded'] = deleted.join() === 'track:auto-0'
      }
    }
    dispose()
    scroll.remove()
  }
  // Chromium queues unhandledrejection on a task source that can trail timer
  // and message tasks; an idle callback runs only after pending tasks drain.
  await new Promise(resolve => requestIdleCallback(resolve))
  results['no-unhandled-rejections'] = errors.length === 0
  return { results, errors }
}
`

test('clip creation continuations belong to one gesture and project', async () => {
  const directory = `/tmp/daw-clip-drag-${crypto.randomUUID()}`
  const session = `clip-drag-${crypto.randomUUID()}`
  const browser = async (...args: string[]) => {
    const env = { ...process.env }
    delete env.AGENT_BROWSER_CDP
    delete env.AGENT_BROWSER_SESSION
    const child = Bun.spawn(['agent-browser', '--session', session, ...args], { env, stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
    if (await child.exited !== 0) throw new Error(stderr || stdout)
    return stdout.trim()
  }
  await mkdir(directory, { recursive: true })
  try {
    const solidPath = new URL('../../node_modules/solid-js/dist/solid.js', import.meta.url).pathname
    await Bun.write(`${directory}/fixture.js`, fixture.replaceAll("'./use", `'${import.meta.dir}/use`))
    const build = await Bun.build({
      entrypoints: [`${directory}/fixture.js`],
      target: 'browser',
      format: 'iife',
      plugins: [{
        name: 'clip-drag-boundary',
        setup(builder) {
          builder.onResolve({ filter: /^solid-js$/ }, () => ({ path: solidPath }))
          builder.onResolve({ filter: /clip-drag-persistence$/ }, () => ({ path: 'persistence', namespace: 'boundary' }))
          builder.onResolve({ filter: /clip-drag-commit$/ }, () => ({ path: 'commit', namespace: 'boundary' }))
          builder.onLoad({ filter: /^persistence$/, namespace: 'boundary' }, () => ({
            contents: 'export const createClipDragPersistence = () => window.dragPersistence', loader: 'js',
          }))
          // Duplicate creation writes IndexedDB clip rows; move commits stay real.
          builder.onLoad({ filter: /^commit$/, namespace: 'boundary' }, () => ({
            contents: `export { commitMovedClipDrag } from '${new URL('../lib/clip-drag-commit.ts', import.meta.url).pathname}'
export const commitDuplicatedClipDrag = input => window.commitDuplicate(input)`,
            loader: 'js',
          }))
        },
      }],
    })
    expect(build.success).toBe(true)
    await Bun.write(`${directory}/index.html`, `<!doctype html><body><script>${await build.outputs[0]!.text()}</script>`)
    await browser('open', `file://${directory}/index.html`)
    const output = z.object({ results: z.record(z.string(), z.boolean()), errors: z.array(z.string()) })
      .parse(JSON.parse(await browser('eval', 'window.clipDragResults()')))
    await Bun.write(`${directory}/results.json`, JSON.stringify(output, null, 2))
    console.log(`Clip drag evidence: ${directory}/results.json`)
    expect(output.errors).toEqual([])
    expect(Object.entries(output.results).filter(([, passed]) => !passed)).toEqual([])
  } finally {
    await browser('close').catch(() => undefined)
  }
}, 60_000)
