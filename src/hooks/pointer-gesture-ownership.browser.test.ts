import tailwindcss from '@tailwindcss/vite'
import { expect, test } from 'bun:test'
import { mkdir } from 'node:fs/promises'
import { build } from 'vite'
import solidPlugin from 'vite-plugin-solid'
import { z } from 'zod'

// Each gesture is owned by real Chromium mouse input (pointer 1 with real
// pointer capture). Synthetic pointer 2 events stand in for a second finger or
// pen, and synthetic pointer 1 events model input the mouse cannot produce
// (pointercancel, Shift-modified moves).
const repositoryRoot = new URL('../../', import.meta.url).pathname
const evidenceDirectory = `/tmp/daw-pointer-gesture-ownership-${crypto.randomUUID()}`
const fixtureId = 'virtual:pointer-gesture-fixture'
// These fixtures use local projects. A durable call is a wiring error, not an invented admission or completion.
const localOnlyOutboxStub = `
export const publishDurableSharedTimelineOperation = async () => { throw new Error('Unexpected cloud operation in local fixture') }
export const publishDurableEffectsOperation = async () => { throw new Error('Unexpected cloud operation in local fixture') }
export const readSharedOutboxOperation = async () => { throw new Error('Unexpected admitted write in local fixture') }
export const consumeSharedOutboxCompletion = async () => { throw new Error('Unexpected completion in local fixture') }
export const subscribeToSharedOutboxSettlements = () => { throw new Error('Unexpected durable subscription in local fixture') }
`

const buildFixture = async (source: string, stubs: Record<string, string>) => {
  const stubFor = (id: string) => Object.keys(stubs).find((suffix) => id.endsWith(suffix))
  const result = await build({
    root: repositoryRoot,
    configFile: false,
    logLevel: 'silent',
    plugins: [solidPlugin(), tailwindcss(), {
      name: 'pointer-gesture-fixture',
      enforce: 'pre',
      resolveId: (id) => {
        if (id.endsWith(fixtureId)) return `\0${fixtureId}.ts`
        const stub = stubFor(id)
        return stub ? `\0stub:${stub}.ts` : undefined
      },
      load: (id) => {
        if (id === `\0${fixtureId}.ts`) return source
        return id.startsWith('\0stub:') ? stubs[id.slice('\0stub:'.length, -'.ts'.length)] : undefined
      },
    }],
    resolve: { alias: { '~': `${repositoryRoot}src` } },
    build: { write: false, minify: false, lib: { entry: fixtureId, formats: ['iife'], name: 'pointerGestureFixture' } },
  })
  const output = Array.isArray(result) ? result[0] : result
  if (!output || !('output' in output)) throw new Error('Expected a single fixture bundle.')
  // Fixtures that import the app stylesheet get real Tailwind layout, which pointer geometry depends on.
  const styles = output.output.flatMap((chunk) => (
    chunk.type === 'asset' && chunk.fileName.endsWith('.css') ? [String(chunk.source)] : []
  ))
  return `<!doctype html><head><style>${styles.join('\n')}</style></head><body style="margin:0"><script>${output.output[0].code}</script>`
}

const openFixture = async (name: string, source: string, stubs: Record<string, string> = {}) => {
  const directory = `${evidenceDirectory}/${name}`
  await mkdir(directory, { recursive: true })
  await Bun.write(`${directory}/index.html`, await buildFixture(source, stubs))
  const session = `pointer-gesture-${name}-${crypto.randomUUID()}`
  const run = async (...args: string[]) => {
    const env = { ...process.env }
    delete env.AGENT_BROWSER_CDP
    delete env.AGENT_BROWSER_SESSION
    const child = Bun.spawn(['agent-browser', '--session', session, ...args], { env, stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
    if (await child.exited !== 0) throw new Error(stderr || stdout)
    return stdout.trim()
  }
  await run('open', `file://${directory}/index.html`)
  return {
    directory,
    mouse: (action: 'move' | 'down' | 'up', x?: number, y?: number) => (
      run('mouse', action, ...(x === undefined || y === undefined ? [] : [String(Math.round(x)), String(Math.round(y))]))
    ),
    press: (key: string) => run('press', key),
    evaluate: (script: string) => run('eval', script),
    read: async <Schema extends z.ZodType>(schema: Schema, script: string): Promise<z.infer<Schema>> => (
      schema.parse(JSON.parse(await run('eval', `(async () => JSON.stringify(await ${script}))()`).then((text) => JSON.parse(text))))
    ),
    close: () => run('close').catch(() => ''),
  }
}

const pointSchema = z.object({ x: z.number(), y: z.number() })

const resizeFixture = `
import { createRoot } from 'solid-js'
import { useClipResize } from '~/hooks/useClipResize'
import { useTimelineSelectionState } from '~/hooks/useTimelineSelectionState'

const box = (left, top, width, height) => {
  const element = document.createElement('div')
  element.style.cssText = 'position:absolute;left:' + left + 'px;top:' + top + 'px;width:' + width + 'px;height:' + height + 'px'
  document.body.append(element)
  return element
}
let state
window.persisted = []
window.resizeFixture = {
  mount: () => {
    state?.dispose()
    document.body.replaceChildren()
    window.persisted.length = 0
    const scroll = box(0, 0, 1000, 100)
    // A two-second clip at 100 px/s ends at x = 200.
    const handle = box(195, 0, 10, 100)
    const thief = box(0, 300, 100, 100)
    const abort = new AbortController()
    const log = { commits: [], history: [], escapeReachedBubble: false }
    window.addEventListener('keydown', (event) => { if (event.key === 'Escape') log.escapeReachedBubble = true }, { signal: abort.signal })
    let base = { id: 'clip:a', name: 'A', startSec: 0, duration: 2, leftPadSec: 0, bufferOffsetSec: 0, color: '#ffffff' }
    let draft = null
    const tracks = () => [{ id: 'track:a', name: 'A', volume: 1, clips: [draft ? { ...base, ...draft } : base] }]
    createRoot((dispose) => {
      const projectId = () => 'project:local-resize'
      const hook = useClipResize({
        tracks,
        setDraftClipTiming: (_clipId, patch) => { draft = patch },
        commitClipTiming: (_clipId, patch) => { log.commits.push(patch.duration); base = { ...base, ...patch } },
        canWriteClip: () => true,
        selection: useTimelineSelectionState({ projectId, tracks }),
        convexClient: {}, convexApi: {}, userId: () => '',
        getScrollElement: () => scroll,
        bpm: () => 120, gridEnabled: () => false, gridDenominator: () => 4, pixelsPerSecond: () => 100,
        rescheduleChangedClips: () => {},
        projectId,
        historyPush: (entry) => { log.history.push(entry.type) },
      })
      handle.addEventListener('pointerdown', (event) => hook.onClipResizeStart('track:a', 'clip:a', 'right', event))
      state = { dispose: () => { abort.abort(); dispose() }, hook, log, handle, thief, tracks }
    })
    const rect = handle.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  },
  live: () => ({ duration: state.tracks()[0].clips[0].duration, resizing: state.hook.isResizing() }),
  pointer: (type, pointerId, clientX) => { window.dispatchEvent(new PointerEvent(type, { pointerId, clientX, clientY: 50 })) },
  stealCapture: () => { state.thief.setPointerCapture(1) },
  detachHandle: () => { state.handle.remove() },
  blur: () => { window.dispatchEvent(new Event('blur')) },
  result: async () => {
    for (let index = 0; index < 20; index += 1) await Promise.resolve()
    return { ...state.log, persisted: window.persisted.map((write) => write.duration), ...window.resizeFixture.live() }
  },
}
`

const resizeResultSchema = z.object({
  commits: z.array(z.number()),
  history: z.array(z.string()),
  persisted: z.array(z.number()),
  escapeReachedBubble: z.boolean(),
  duration: z.number(),
  resizing: z.boolean(),
})
const resizeLiveSchema = z.object({ duration: z.number(), resizing: z.boolean() })

test('clip resize commits only on owner release and reverts on every cancel path', async () => {
  const page = await openFixture('clip-resize', resizeFixture, {
    'lib/timeline-repository/local-timeline-repository': `export const createLocalTimelineRepository = (projectId) => ({
      updateClip: async (input) => { window.persisted.push({ projectId, duration: input.duration }) },
    })`,
    'lib/clip-mutations': `export const persistClipTimingAndAudioWarp = async () => { throw new Error('Cloud clip persistence is outside this fixture.') }`,
  })
  const results: Record<string, z.infer<typeof resizeResultSchema>> = {}
  let foreignPointerLive: z.infer<typeof resizeLiveSchema> | undefined
  try {
    for (const scenario of ['release', 'pointercancel', 'escape', 'lost-capture', 'blur', 'foreign-pointer', 'detached-handle']) {
      const start = await page.read(pointSchema, 'resizeFixture.mount()')
      await page.mouse('move', start.x, start.y)
      await page.mouse('down')
      await page.mouse('move', start.x + 100, start.y)
      if (scenario === 'pointercancel') await page.evaluate('resizeFixture.pointer("pointercancel", 1, 300)')
      if (scenario === 'escape') await page.press('Escape')
      if (scenario === 'blur') await page.evaluate('resizeFixture.blur()')
      if (scenario === 'lost-capture') {
        await page.evaluate('resizeFixture.stealCapture()')
        await page.mouse('move', start.x + 110, start.y)
      }
      if (scenario === 'foreign-pointer') {
        await page.evaluate('resizeFixture.pointer("pointermove", 2, 700)')
        await page.evaluate('resizeFixture.pointer("pointercancel", 2, 700)')
        await page.evaluate('resizeFixture.pointer("pointerup", 2, 700)')
        foreignPointerLive = await page.read(resizeLiveSchema, 'resizeFixture.live()')
      }
      if (scenario === 'detached-handle') {
        await page.evaluate('resizeFixture.detachHandle()')
        await page.mouse('move', start.x + 150, start.y)
      }
      await page.mouse('up')
      // A stray move after the gesture would change the clip if a listener leaked.
      await page.mouse('move', start.x + 250, start.y)
      results[scenario] = await page.read(resizeResultSchema, 'resizeFixture.result()')
    }
  } finally {
    await Bun.write(`${page.directory}/results.json`, JSON.stringify({ ...results, foreignPointerLive }, null, 2))
    console.log(`Clip resize evidence: ${page.directory}/results.json`)
    await page.close()
  }
  const committed = (duration: number) => ({ commits: [duration], history: ['clip-timing'], persisted: [duration], duration, resizing: false })
  const reverted = { commits: [], history: [], persisted: [], duration: 2, resizing: false }
  expect(results.release).toMatchObject(committed(3))
  expect(results.pointercancel).toMatchObject(reverted)
  expect(results.escape).toMatchObject({ ...reverted, escapeReachedBubble: false })
  expect(results['lost-capture']).toMatchObject(reverted)
  expect(results.blur).toMatchObject(reverted)
  expect(foreignPointerLive).toEqual({ duration: 3, resizing: true })
  expect(results['foreign-pointer']).toMatchObject(committed(3))
  expect(results['detached-handle']).toMatchObject(committed(3.5))
}, 120_000)

const effectLifecycleFixture = `
import { createProcessorEditRegistry } from '~/components/timeline/create-processor-edit-registry'
import { createComponent, createEffect, createSignal, onCleanup, Show } from 'solid-js'
import { render } from 'solid-js/web'
import { AUDIO_EFFECT_CONTRACTS } from '@daw-browser/shared'
import { createUndoManager } from '~/lib/undo/manager'
import { buildEffectParamsHistoryEntry } from '~/lib/undo/builders'
import Delay from '~/components/effects/Delay'
import { ParameterGestureProvider } from '~/components/effects/effect-parameter-interaction'
import { createEffectsPanelAudioDevice } from '~/components/timeline/create-effects-panel-audio-effects-state'
let fixture
window.effectLifecycleFixture = {
  mount: () => {
    fixture?.dispose()
    document.body.replaceChildren()
    const root = document.createElement('div')
    document.body.append(root)
    const [target, setTarget] = createSignal('track:one')
    const [project, setProject] = createSignal('project:lifecycle-one')
    const [generation, setGeneration] = createSignal(1)
    const [collapsed, setCollapsed] = createSignal(false)
    const params = AUDIO_EFFECT_CONTRACTS.delay.createDefaultParams()
    window.effectStore = { rows: [
      { type: 'delay', effect: 'delay', targetType: 'track', targetId: 'track:one', trackId: 'track:one', instanceId: 'delay-1', index: 0, params },
      { type: 'delay', effect: 'delay', targetType: 'track', targetId: 'track:one', trackId: 'track:one', instanceId: 'delay-2', index: 1, params },
      { type: 'master-delay', effect: 'master-delay', targetType: 'master', targetId: 'master', instanceId: 'delay-1', index: 0, params },
    ], writes: [] }
    const previews = []
    const flushes = []
    const errors = []
    const begins = []
    const processorEdits = createProcessorEditRegistry(() => 120)
    let receiptSerial = 0
    const acknowledgeNative = (edit, gesture) => {
      // Model-only native sink for pointer ownership, not a controller promotion.
      const log = gesture?.holds ? previews : flushes
      if (gesture) log.push({ projectId: project(), targetId: edit.target.nodeId, instanceId: edit.target.instanceId, value: edit.content.params.feedback })
      return { receipt: { key: edit.target.instanceId, serial: ++receiptSerial }, settled: Promise.resolve({ state: 'applied' }) }
    }
    const nativeRequestFrame = window.requestAnimationFrame.bind(window)
    const nativeCancelFrame = window.cancelAnimationFrame.bind(window)
    let queuedPreviewFrames = []
    const engine = { getBpm: () => 120, setTrackFxInstance: async () => 'not-held', setMasterFxInstance: async () => 'not-held', setTrackFxInstances: async () => {}, setMasterFxInstances: async () => {} }
    const undo = createUndoManager({})
    let device
    const Card = () => {
      createEffect(() => {
        const targetId = target()
        onCleanup(() => device.interruptGesture('delay-1', targetId))
      })
      const base = device.gestureOwner('delay-1', 'delay', target())
      return createComponent(ParameterGestureProvider, {
        owner: { ...base, open: holder => { if (!base.isOpen(holder)) begins.push(target()); base.open(holder) } },
        get children() {
          return createComponent(Delay, {
            get params() { return device.paramsForInstance({ id: 'delay-1', kind: 'delay' }) ?? params },
            onChange: updates => device.delay.changeInstance('delay-1', current => ({ ...current, ...updates })),
            onToggleEnabled: enabled => device.delay.changeInstance('delay-1', current => ({ ...current, enabled })),
            onReset: () => device.delay.changeInstance('delay-1', () => params),
          })
        },
      })
    }
    const dispose = render(() => {
      device = createEffectsPanelAudioDevice({
        audioEngine: () => engine,
        projectId: project,
        projectGeneration: generation,
        userId: () => 'user',
        roomEffects: () => [],
        canWriteCurrentTargetEffects: () => true,
        usesLegacyAudioEngine: () => false,
        allocateProcessorEdit: processorEdits.allocate,
        deliverProcessor: acknowledgeNative,
        onEffectParamsCommitted: (payload, projectId, options) => undo.push(
          buildEffectParamsHistoryEntry({ projectId: projectId ?? project(), tracks: [], payload }),
          options?.mergeHistory === false ? undefined : 'delay:gesture',
          600,
        ),
        onEffectError: (title, message) => errors.push({ title, message }),
      }, target, () => undefined)
      return createComponent(Show, { get when() { return !collapsed() }, get children() { return createComponent(Card, {}) } })
    }, root)
    fixture = { dispose, root, device, undo, previews, flushes, errors, begins, setTarget, setProject, setGeneration, setCollapsed, params, nativeRequestFrame, nativeCancelFrame, queuedPreviewFrames }
    const knob = root.querySelector('[role="slider"][aria-label="Feedback"]')
    knob.scrollIntoView({ block: 'center' })
    const rect = knob.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  },
  setTarget: id => fixture.setTarget(id),
  holdPreviewFrame: () => {
    fixture.queuedPreviewFrames = []
    window.requestAnimationFrame = callback => { fixture.queuedPreviewFrames.push(callback); return 9001 }
    window.cancelAnimationFrame = () => {}
  },
  restoreAnimationFrames: () => {
    window.requestAnimationFrame = fixture.nativeRequestFrame
    window.cancelAnimationFrame = fixture.nativeCancelFrame
  },
  queuedPreviewCount: () => fixture.queuedPreviewFrames.length,
  point: () => {
    const rect = fixture.root.querySelector('[role="slider"][aria-label="Feedback"]').getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  },
  collapse: () => fixture.setCollapsed(true),
  switchProject: () => { fixture.setProject('project:lifecycle-two'); fixture.setGeneration(2) },
  remove: () => fixture.device.removeByInstanceFromTarget('track:one', { id: 'delay-1', kind: 'delay' }),
  keyboardEdit: () => {
    const knob = document.querySelector('[aria-label="Feedback"]')
    knob.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }))
    knob.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowUp', bubbles: true, cancelable: true }))
  },
  // Reading is not flushing: flushPending commits every open gesture, so a held gesture is read without it.
  settle: async () => {
    await new Promise(resolve => requestAnimationFrame(resolve))
    for (let index = 0; index < 20; index++) await Promise.resolve()
  },
  flushPending: async () => {
    await fixture.device.flushPending()
    await window.effectLifecycleFixture.settle()
  },
  result: async () => {
    await window.effectLifecycleFixture.settle()
    return {
      writes: window.effectStore.writes,
      history: fixture.undo.snapshot().undo.length,
      previews: fixture.previews,
      flushes: fixture.flushes,
      errors: fixture.errors,
      begins: fixture.begins,
      params: fixture.device.paramsForInstance({ id: 'delay-1', kind: 'delay' }),
      otherParams: fixture.device.paramsForInstance({ id: 'delay-2', kind: 'delay' }),
      order: fixture.device.orderedEffects().map(effect => effect.id),
      targetFeedback: fixture.device.snapshotExportRows(['track:one']).find(row => row.instanceId === 'delay-1')?.params.feedback,
    }
  },
  dispose: () => fixture.dispose(),
}
`

const reorderScrollFixture = `
import { createRoot } from 'solid-js'
import { createEffectCardReorderDrag } from '~/components/timeline/create-effect-card-reorder-drag'
let dispose
let targetIndex
let events
window.reorderScrollFixture = {
  mount: () => {
    dispose?.()
    document.body.replaceChildren()
    targetIndex = undefined
    events = []
    const chain = document.createElement('div')
    chain.style.cssText = 'display:flex;overflow:auto;width:210px;height:100px;gap:0'
    document.body.append(chain)
    for (const key of ['a', 'b', 'c', 'd']) {
      const card = document.createElement('div')
      card.dataset.reorderKey = key
      card.style.cssText = 'flex:none;width:100px;height:80px'
      const header = document.createElement('div')
      header.dataset.effectShellHeader = 'true'
      header.style.cssText = 'width:100%;height:80px'
      card.append(header)
      chain.append(card)
      if (key === 'a') {
        createRoot((cleanup) => {
          dispose = cleanup
          const drag = createEffectCardReorderDrag({
            key,
            orderedKeys: () => ['a', 'b', 'c', 'd'],
            canWrite: () => true,
            onReorder: (_key, index) => { targetIndex = index },
            onPreviewChange: () => {},
          })
          card.addEventListener('pointerdown', event => { events.push('down:' + event.pointerId); drag.onPointerDown(event) })
          window.addEventListener('pointermove', event => events.push('move:' + event.pointerId))
          window.addEventListener('pointerup', event => events.push('up:' + event.pointerId))
        })
      }
    }
    const rect = chain.firstElementChild.getBoundingClientRect()
    return { x: rect.left + 50, y: rect.top + 40 }
  },
  scroll: () => { document.querySelector('body > div').scrollLeft = 100 },
  result: () => ({ targetIndex, scrollLeft: document.querySelector('body > div').scrollLeft, events, header: document.querySelector('[data-effect-shell-header="true"]') !== null }),
}
`

test('effect card reorder remeasures scrolled geometry on pointer release', async () => {
  const page = await openFixture('reorder', reorderScrollFixture)
  const reorderResultSchema = z.object({ targetIndex: z.number().optional(), scrollLeft: z.number(), events: z.array(z.string()), header: z.boolean() })
  let result = reorderResultSchema.parse({ scrollLeft: 0, events: [], header: false })
  try {
    const point = await page.read(pointSchema, 'reorderScrollFixture.mount()')
    await page.mouse('move', point.x, point.y)
    await page.mouse('down')
    await page.mouse('move', point.x + 130, point.y)
    await page.evaluate('reorderScrollFixture.scroll()')
    await page.mouse('up')
    result = await page.read(reorderResultSchema, 'reorderScrollFixture.result()')
  } finally {
    await Bun.write(`${page.directory}/results.json`, JSON.stringify({ releaseAfterScroll: result }, null, 2))
    console.log(`Effect reorder evidence: ${page.directory}/results.json`)
    await page.close()
  }
  expect(result.scrollLeft).toBe(100)
  expect(result.targetIndex).toBe(2)
}, 120_000)

test('effect gestures cancel on target, collapse, removal, and project changes', async () => {
  const page = await openFixture('effect-lifecycle', effectLifecycleFixture, {
    'lib/local-effects': `
export const listLocalEffects = async () => window.effectStore.rows
export const getLocalEffect = async (_projectId, targetId, effect) => window.effectStore.rows.find(row => row.targetId === targetId && row.effect === effect)
export const setLocalEffectInstance = async (projectId, targetId, effect, params, options) => {
  const index = window.effectStore.rows.findIndex(row => row.targetId === targetId && row.effect === effect && row.instanceId === options.instanceId)
  if (index < 0) throw new Error('Effect instance is missing')
  const row = { ...window.effectStore.rows[index], params }
  window.effectStore.rows[index] = row
  window.effectStore.writes.push({ projectId, targetId, instanceId: options.instanceId, feedback: params.feedback })
  return { row, sequence: 0 }
}
export const setLocalEffect = setLocalEffectInstance
export const deleteLocalEffect = async () => {}
export const deleteLocalEffectInstance = async (_projectId, targetId, effect, instanceId) => {
  window.effectStore.rows = window.effectStore.rows.filter(row => !(row.targetId === targetId && row.effect === effect && row.instanceId === instanceId))
}
export const reorderLocalAudioEffects = async () => {}
export const createAudioEffectInstanceId = () => 'fixture-instance'
`,
    'lib/local-project-changes': `export const subscribeToLocalProjectChanges = () => () => {}; export const notifyLocalProjectChanged = () => 0; export const localProjectChangeSequence = () => 0`,
    'lib/timeline-repository/local-timeline-repository': `export const createLocalTimelineRepository = () => ({}); export const flushLocalTimelineWrites = async () => {}`,
    'lib/shared-outbox': localOnlyOutboxStub,
    'context/app-preferences': `export const useAppPreferences = () => ({ appearance: { themeTokens: () => ({}) } })`,
  })
  const resultSchema = z.object({
    writes: z.array(z.object({ projectId: z.string(), targetId: z.string(), instanceId: z.string(), feedback: z.number() })),
    history: z.number(),
    previews: z.array(z.object({ projectId: z.string(), targetId: z.string(), instanceId: z.string().optional(), value: z.number() })),
    flushes: z.array(z.object({ projectId: z.string(), targetId: z.string(), instanceId: z.string().optional(), value: z.number() })),
    errors: z.array(z.object({ title: z.string(), message: z.string() })),
    begins: z.array(z.string()),
    params: z.object({ feedback: z.number() }).optional(),
    otherParams: z.object({ feedback: z.number() }).optional(),
    order: z.array(z.string()),
    targetFeedback: z.number().optional(),
  })
  const evidence = new Map<string, object>()
  const startGesture = async () => {
    await page.read(pointSchema, 'effectLifecycleFixture.mount()')
    const before = await page.read(resultSchema, 'effectLifecycleFixture.result()')
    await page.evaluate('new Promise(resolve => requestAnimationFrame(resolve))')
    const point = await page.read(pointSchema, 'effectLifecycleFixture.point()')
    await page.mouse('move', point.x, point.y)
    await page.mouse('down')
    await page.mouse('move', point.x, point.y - 45)
    return { before, held: await result() }
  }
  const startQueuedGesture = async () => {
    await page.read(pointSchema, 'effectLifecycleFixture.mount()')
    const before = await page.read(resultSchema, 'effectLifecycleFixture.result()')
    const point = await page.read(pointSchema, 'effectLifecycleFixture.point()')
    await page.evaluate('effectLifecycleFixture.holdPreviewFrame()')
    await page.mouse('move', point.x, point.y)
    await page.mouse('down')
    await page.mouse('move', point.x, point.y - 45)
    const queuedPreviewCount = await page.evaluate('effectLifecycleFixture.queuedPreviewCount()')
    expect(queuedPreviewCount).toBe('1')
    return { before, queuedPreviewCount }
  }
  const result = () => page.read(resultSchema, 'effectLifecycleFixture.result()')
  const delta = async (before: z.infer<typeof resultSchema>) => {
    const after = await result()
    return {
      writes: after.writes.slice(before.writes.length),
      history: after.history - before.history,
      previews: after.previews.slice(before.previews.length),
      flushes: after.flushes.slice(before.flushes.length),
      errors: after.errors.slice(before.errors.length),
      params: after.params,
      otherParams: after.otherParams,
      order: after.order,
      targetFeedback: after.targetFeedback,
    }
  }
  try {
    let gesture = await startGesture()
    let before = gesture.before
    evidence.set('targetSwitchHeld', gesture.held)
    await page.evaluate('effectLifecycleFixture.setTarget("master")')
    await page.mouse('up')
    const targetSwitch = await delta(before)
    evidence.set('targetSwitch', targetSwitch)
    expect(targetSwitch.writes).toEqual([])
    expect(targetSwitch.history).toBe(0)
    // The closing registration restores the baseline for the captured target.
    expect(targetSwitch.flushes).toEqual([{ projectId: 'project:lifecycle-one', targetId: 'track:one', instanceId: 'delay-1', value: 0.25 }])
    expect(targetSwitch.params?.feedback).toBe(0.25)
    expect(targetSwitch.targetFeedback).toBe(0.25)
    expect(targetSwitch.previews.every(preview => preview.targetId === 'track:one')).toBe(true)
    await page.evaluate('effectLifecycleFixture.setTarget("track:one")')
    await page.evaluate('effectLifecycleFixture.keyboardEdit()')
    await page.evaluate('effectLifecycleFixture.flushPending()')
    const targetKeyboard = await result()
    const keyboardAfterTargetSwitch = {
      writes: targetKeyboard.writes.slice(before.writes.length),
      history: targetKeyboard.history - before.history,
    }
    evidence.set('keyboardAfterTargetSwitch', keyboardAfterTargetSwitch)
    expect(keyboardAfterTargetSwitch).toMatchObject({ writes: [{ projectId: 'project:lifecycle-one', targetId: 'track:one', instanceId: 'delay-1' }], history: 1 })

    gesture = await startGesture()
    before = gesture.before
    evidence.set('collapseHeld', gesture.held)
    await page.evaluate('effectLifecycleFixture.collapse()')
    await page.mouse('up')
    const collapse = await delta(before)
    evidence.set('collapse', collapse)
    expect(collapse.writes).toEqual([])
    expect(collapse.history).toBe(0)
    expect(collapse.flushes).toEqual([{ projectId: 'project:lifecycle-one', targetId: 'track:one', instanceId: 'delay-1', value: 0.25 }])
    expect(collapse.params?.feedback).toBe(0.25)
    expect(collapse.targetFeedback).toBe(0.25)

    gesture = await startGesture()
    before = gesture.before
    evidence.set('removalHeld', gesture.held)
    await page.evaluate('effectLifecycleFixture.remove()')
    await page.mouse('up')
    const removal = await delta(before)
    evidence.set('removal', removal)
    expect(removal.writes).toEqual([])
    expect(removal.history).toBe(0)
    expect(removal.errors).toEqual([])
    expect(removal.order).not.toContain('delay-1')
    expect(removal.otherParams?.feedback).toBe(0.25)
    expect(removal.targetFeedback).toBeUndefined()
    // The instance no longer exists: nothing is restored to it and no preview follows the removal.
    expect(removal.previews.every(preview => preview.value !== 0.25)).toBe(true)
    expect(removal.flushes).toEqual([])

    const queuedGesture = await startQueuedGesture()
    before = queuedGesture.before
    evidence.set('projectSwitchQueued', { queuedPreviewCount: queuedGesture.queuedPreviewCount })
    await page.evaluate('effectLifecycleFixture.switchProject()')
    await page.evaluate('effectLifecycleFixture.restoreAnimationFrames()')
    await page.evaluate('effectLifecycleFixture.flushPending()')
    await page.mouse('up')
    const projectSwitch = await delta(before)
    evidence.set('projectSwitch', projectSwitch)
    expect(projectSwitch.writes).toEqual([])
    expect(projectSwitch.history).toBe(0)
    expect(projectSwitch.flushes).toEqual([])
    expect(projectSwitch.previews).toEqual([])
    expect(projectSwitch.params?.feedback).toBe(0.25)
    expect(projectSwitch.targetFeedback).toBe(0.25)
    await page.evaluate('effectLifecycleFixture.keyboardEdit()')
    await page.evaluate('effectLifecycleFixture.flushPending()')
    const newProjectEdit = await result()
    const newProjectKeyboardEdit = {
      writes: newProjectEdit.writes.slice(before.writes.length),
      history: newProjectEdit.history - before.history,
    }
    evidence.set('newProjectKeyboardEdit', newProjectKeyboardEdit)
    expect(newProjectKeyboardEdit).toMatchObject({ writes: [{ projectId: 'project:lifecycle-two', targetId: 'track:one', instanceId: 'delay-1' }], history: 1 })
  } finally {
    await Bun.write(`${page.directory}/results.json`, JSON.stringify(Object.fromEntries(evidence), null, 2))
    console.log(`Effect lifecycle evidence: ${page.directory}/results.json`)
    await page.close()
  }
}, 120_000)

const utilityFixture = `
import { createProcessorEditRegistry } from '~/components/timeline/create-processor-edit-registry'
import { createComponent, createEffect, createSignal, onCleanup } from 'solid-js'
import { render } from 'solid-js/web'
import { AUDIO_EFFECT_CONTRACTS, normalizeUtilityParamsEnvelope } from '@daw-browser/shared'
import Utility from '~/components/effects/Utility'
import { ParameterGestureProvider } from '~/components/effects/effect-parameter-interaction'
import { createEffectsPanelAudioDevice } from '~/components/timeline/create-effects-panel-audio-effects-state'
let state
window.utilityFixture = {
  mount: (legacy = true) => {
    state?.dispose()
    document.body.replaceChildren()
    const root = document.createElement('div')
    const thief = document.createElement('div')
    thief.style.cssText = 'position:absolute;left:600px;top:600px;width:50px;height:50px'
    document.body.append(root, thief)
    const baseline = AUDIO_EFFECT_CONTRACTS.utility.createDefaultParams()
    const row = { type: 'utility', effect: 'master-utility', targetType: 'master', targetId: 'master', instanceId: 'utility-1', index: 0, params: baseline }
    window.effectStore = { row, writes: [] }
    const changes = []
    const history = []
    const engineValues = []
    const nativeValues = []
    const processorEdits = createProcessorEditRegistry(() => 120)
    let receiptSerial = 0
    const applyNative = (edit) => {
      // Model-only native sink. Persistence does not depend on its receipt.
      nativeValues.push(edit.content.values['utility.gainDb'])
      return { receipt: { key: edit.target.instanceId, serial: ++receiptSerial }, settled: Promise.resolve({ state: 'applied' }) }
    }
    const errors = []
    const engineErrors = []
    const engine = {
      getBpm: () => 120,
      // No in-place path: the whole chain carries the value.
      setMasterFxInstance: async () => 'not-held',
      setTrackFxInstance: async () => 'not-held',
      setMasterFxInstances: async (instances) => {
        if (window.effectStore.failure === 'engine') throw new Error('Engine is unavailable')
        engineValues.push(instances.find((entry) => entry.kind === 'utility')?.params.state.gainDb ?? 0)
      },
      setTrackFxInstances: async () => {},
    }
    let device
    const params = () => normalizeUtilityParamsEnvelope(device.paramsForInstance({ id: 'utility-1', kind: 'utility' })).state
    const dispose = render(() => {
      device = createEffectsPanelAudioDevice({
        audioEngine: () => engine,
        projectId: () => 'project:utility-fixture',
        userId: () => 'user',
        roomEffects: () => [],
        canWriteCurrentTargetEffects: () => true,
        usesLegacyAudioEngine: () => legacy,
        onEffectParamsCommitted: (payload) => history.push({ from: payload.from.state.gainDb, to: payload.to.state.gainDb }),
        allocateProcessorEdit: processorEdits.allocate,
        deliverProcessor: applyNative,
        onLocalSaveFailed: (_projectId, message) => errors.push(message),
        onEffectError: (title, message) => engineErrors.push({ title, message }),
      }, () => 'master', () => undefined)
      return createComponent(ParameterGestureProvider, {
        owner: device.gestureOwner('utility-1', 'utility', 'master'),
        get children() {
          return createComponent(Utility, {
            get params() { return params() },
            onChange: (updates) => {
              changes.push(updates.gainDb)
              device.utility.changeInstance('utility-1', (current) => ({ ...current, state: { ...current.state, ...updates } }))
            },
            onToggleEnabled: () => {},
            onReset: () => {},
          })
        },
      })
    }, root)
    const knob = root.querySelector('[role="slider"][aria-label="Gain"]')
    state = { dispose, knob, thief, changes, params, device, history, engineValues, nativeValues, errors, engineErrors }
    const rect = knob.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  },
  pointer: (type, init) => { window.dispatchEvent(new PointerEvent(type, { pointerId: 1, ...init })) },
  stealCapture: () => { state.thief.setPointerCapture(1) },
  blur: () => { window.dispatchEvent(new Event('blur')) },
  fail: (failure) => { window.effectStore.failure = failure },
  // Reading is not flushing: flushPending commits an open gesture, so a held gesture is read without it.
  result: async () => {
    await new Promise(resolve => requestAnimationFrame(resolve))
    for (let index = 0; index < 20; index++) await Promise.resolve()
    return {
      changes: state.changes, gainDb: state.params().gainDb, ariaValueNow: Number(state.knob.getAttribute('aria-valuenow')),
      persistedGainDb: window.effectStore.row.params.state.gainDb,
      writes: window.effectStore.writes, history: state.history,
      engineGainDb: state.engineValues.at(-1) ?? 0, nativeGainDb: state.nativeValues.at(-1) ?? 0, errors: state.errors,
      engineErrors: state.engineErrors,
    }
  },
}
`

const utilityStubs = {
  'lib/local-effects': `
import { notifyLocalProjectChanged } from '~/lib/local-project-changes'
export const listLocalEffects = async () => [window.effectStore.row]
export const getLocalEffect = async (_projectId, _targetId, effect) => effect === 'master-utility' ? window.effectStore.row : undefined
export const setLocalEffectInstance = async (projectId, _targetId, _effect, params) => {
  if (window.effectStore.failure === 'persist') throw new Error('Disk is full')
  window.effectStore.writes.push(params.state.gainDb)
  window.effectStore.row = { ...window.effectStore.row, params }
  return { row: window.effectStore.row, sequence: notifyLocalProjectChanged(projectId) }
}
export const setLocalEffect = setLocalEffectInstance
export const deleteLocalEffect = async () => {}
export const deleteLocalEffectInstance = async () => {}
export const reorderLocalAudioEffects = async () => {}
export const createAudioEffectInstanceId = () => 'fixture-instance'
`,
  'lib/timeline-repository/local-timeline-repository': `export const createLocalTimelineRepository = () => ({}); export const flushLocalTimelineWrites = async () => {}`,
  'lib/shared-outbox': localOnlyOutboxStub,
}

const utilityResultSchema = z.object({
  changes: z.array(z.number()), gainDb: z.number(), ariaValueNow: z.number(),
  persistedGainDb: z.number(), writes: z.array(z.number()),
  history: z.array(z.object({ from: z.number(), to: z.number() })),
  engineGainDb: z.number(), nativeGainDb: z.number(), errors: z.array(z.string()),
  engineErrors: z.array(z.object({ title: z.string(), message: z.string() })),
})

test('Utility Gain restores the pre-gesture value on every cancel path', async () => {
  const page = await openFixture('utility-gain', utilityFixture, utilityStubs)
  const results: Record<string, z.infer<typeof utilityResultSchema>> = {}
  try {
    for (const legacy of [true, false]) {
      for (const scenario of ['release', 'pointercancel', 'escape', 'lost-capture', 'blur', 'shift-cancel', 'release-at-baseline']) {
        const start = await page.read(pointSchema, `utilityFixture.mount(${legacy})`)
        await page.mouse('move', start.x, start.y)
        await page.mouse('down')
        await page.mouse('move', start.x, start.y - 40)
        await page.mouse('move', start.x, start.y - 60)
        // Read while still held: a preview is not persisted.
        const held = await page.read(utilityResultSchema, 'utilityFixture.result()')
        results[`${legacy}:${scenario}:held`] = held
        if (scenario === 'pointercancel') await page.evaluate('utilityFixture.pointer("pointercancel", {})')
        if (scenario === 'escape') await page.press('Escape')
        if (scenario === 'blur') await page.evaluate('utilityFixture.blur()')
        if (scenario === 'lost-capture') {
          await page.evaluate('utilityFixture.stealCapture()')
          await page.mouse('move', start.x, start.y - 50)
        }
        if (scenario === 'shift-cancel') {
          // Shift rebases the precision drag; cancel must still restore the gesture start.
          await page.evaluate(`utilityFixture.pointer("pointermove", { clientX: ${start.x}, clientY: ${start.y - 80}, shiftKey: true })`)
          await page.evaluate('utilityFixture.pointer("pointercancel", {})')
        }
        if (scenario === 'release-at-baseline') await page.mouse('move', start.x, start.y)
        await page.mouse('up')
        await page.mouse('move', start.x, start.y - 120)
        results[`${legacy}:${scenario}`] = await page.read(utilityResultSchema, 'utilityFixture.result()')
      }
    }
  } finally {
    await Bun.write(`${page.directory}/results.json`, JSON.stringify(results, null, 2))
    console.log(`Utility Gain evidence: ${page.directory}/results.json`)
    await page.close()
  }
  for (const legacy of [true, false]) {
    const released = results[`${legacy}:release`]
    expect(released?.changes.length).toBeGreaterThan(0)
    expect(released?.gainDb).not.toBe(0)
    expect(released?.ariaValueNow).toBe(released?.gainDb ?? Number.NaN)
    expect(released?.history).toEqual([{ from: 0, to: released?.gainDb }])
    expect(released?.writes).toEqual([released?.gainDb])
    expect(released?.persistedGainDb).toBe(released?.gainDb ?? Number.NaN)
    for (const scenario of ['pointercancel', 'escape', 'lost-capture', 'blur', 'shift-cancel', 'release-at-baseline']) {
      const held = results[`${legacy}:${scenario}:held`]
      expect(held?.history).toEqual([])
      expect(held?.writes).toEqual([])
      const cancelled = results[`${legacy}:${scenario}`]
      expect(cancelled?.changes.length).toBeGreaterThan(1)
      expect(cancelled?.gainDb).toBe(0)
      expect(cancelled?.ariaValueNow).toBe(0)
      expect(cancelled?.history).toEqual([])
      expect(cancelled?.writes).toEqual([])
      expect(cancelled?.persistedGainDb).toBe(0)
      expect(legacy ? cancelled?.engineGainDb : cancelled?.nativeGainDb).toBe(0)
      expect(cancelled?.errors).toEqual([])
    }
  }
}, 120_000)

const deviceKnobFixture = `
import { createProcessorEditRegistry } from '~/components/timeline/create-processor-edit-registry'
import { createComponent, createEffect, createSignal, onCleanup } from 'solid-js'
import { render } from 'solid-js/web'
import { AUDIO_EFFECT_CONTRACTS } from '@daw-browser/shared'
import { createUndoManager } from '~/lib/undo/manager'
import { buildEffectParamsHistoryEntry } from '~/lib/undo/builders'
import Delay from '~/components/effects/Delay'
import { ParameterGestureProvider } from '~/components/effects/effect-parameter-interaction'
import { createEffectsPanelAudioDevice } from '~/components/timeline/create-effects-panel-audio-effects-state'
let fixture
window.deviceKnobFixture = {
  mount: (legacy = true, targetId = 'track:one') => {
    fixture?.dispose()
    document.body.replaceChildren()
    const requestFrame = window.requestAnimationFrame.bind(window)
    let frames = 0
    window.requestAnimationFrame = callback => requestFrame(time => { frames += 1; callback(time) })
    const root = document.createElement('div')
    document.body.append(root)
    const params = AUDIO_EFFECT_CONTRACTS.delay.createDefaultParams()
    const row = { type: targetId === 'master' ? 'master-delay' : 'delay', effect: targetId === 'master' ? 'master-delay' : 'delay', targetType: targetId === 'master' ? 'master' : 'track', targetId, trackId: targetId === 'master' ? undefined : targetId, instanceId: 'delay-1', index: 0, params }
    window.deviceStore = { row, writes: [] }
    const engine = { getBpm: () => 120, calls: [], setTrackFxInstance: async () => 'not-held', setMasterFxInstance: async () => 'not-held', setTrackFxInstances: async (_id, instances) => { engine.calls.push(instances.find(item => item.kind === 'delay')?.params.timeMs) }, setMasterFxInstances: async instances => { engine.calls.push(instances.find(item => item.kind === 'delay')?.params.timeMs) } }
    const previews = []
    const flushes = []
    const nativeValues = []
    const overrides = []
    const processorEdits = createProcessorEditRegistry(() => 120)
    let receiptSerial = 0
    let deferredPersistence = false
    let resolvePersistence
    const undo = createUndoManager({})
    const [ownerKey, setOwnerKey] = createSignal('project:delay-knob-fixture:track:one')
    window.deviceKnobFixturePersistenceDeferred = () => deferredPersistence
    window.deviceKnobFixtureResolvePersistence = () => resolvePersistence?.()
    let device
    const dispose = render(() => {
      createEffect(() => {
        ownerKey()
        onCleanup(() => device?.interruptGesture('delay-1', targetId))
      })
      device = createEffectsPanelAudioDevice({
        audioEngine: () => engine,
        projectId: () => 'project:delay-knob-fixture',
        userId: () => 'user',
        roomEffects: () => [],
        canWriteCurrentTargetEffects: () => true,
        usesLegacyAudioEngine: () => legacy,
        allocateProcessorEdit: processorEdits.allocate,
        deliverProcessor: (edit, gesture) => {
          // The simple sink installs the absolute value before answering. Held receipt tests use the controller suite.
          const log = gesture?.holds ? previews : flushes
          log.push(edit)
          nativeValues.push(edit.content.values['delay.feedback'])
          return { receipt: { key: edit.target.instanceId, serial: ++receiptSerial }, settled: Promise.resolve({ state: 'applied' }) }
        },
        onEffectParamsCommitted: (payload, projectId, options) => undo.push(buildEffectParamsHistoryEntry({ projectId: projectId ?? 'project:delay-knob-fixture', tracks: [], payload }), options?.mergeHistory === false ? undefined : 'delay:gesture', 600),
      }, () => targetId, () => undefined)
      return createComponent(ParameterGestureProvider, {
        owner: device.gestureOwner('delay-1', 'delay', targetId),
        get children() {
          return createComponent(Delay, {
            get params() { return device.paramsForInstance({ id: 'delay-1', kind: 'delay' }) ?? params },
            onChange: updates => device.delay.changeInstance('delay-1', current => ({ ...current, ...updates })),
            onToggleEnabled: enabled => device.delay.changeInstance('delay-1', current => ({ ...current, enabled })),
            onReset: () => device.delay.changeInstance('delay-1', () => AUDIO_EFFECT_CONTRACTS.delay.createDefaultParams()),
            automationRangesByParameterId: new Map([['delay.feedback', { min: 0, max: 0.95 }]]),
            onManualAutomationOverride: parameterId => overrides.push(parameterId),
          })
        },
      })
    }, root)
    let flushSettled = false
    let pendingFlush
    fixture = { dispose: () => { dispose(); window.requestAnimationFrame = requestFrame }, device, engine, undo, previews, flushes, nativeValues, overrides, frames: () => frames, switchOwner: owner => setOwnerKey(owner), deferPersistence: () => { deferredPersistence = true }, resolvePersistence: () => resolvePersistence?.(), beginFlush: () => { flushSettled = false; pendingFlush = device.flushPending().then(() => { flushSettled = true }) }, waitFlush: async () => await pendingFlush, flushSettled: () => flushSettled, reset: () => { window.deviceStore.writes.length = 0; undo.clear(); engine.calls.length = 0; previews.length = 0; flushes.length = 0; nativeValues.length = 0; overrides.length = 0; frames = 0 } }
    const knob = root.querySelector('[role="slider"][aria-label="Feedback"]')
    knob.scrollIntoView({ block: 'center' })
    const rect = knob.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  },
  // Reading is not flushing: flushPending commits an open gesture, so a held gesture is read without it.
  result: async () => {
    await new Promise(resolve => requestAnimationFrame(resolve))
    for (let index = 0; index < 20; index++) await Promise.resolve()
    return { writes: window.deviceStore.writes, history: fixture.undo.snapshot().undo.length, historyEntries: fixture.undo.snapshot().undo.map(entry => entry.data), historyEntry: fixture.undo.snapshot().undo.at(-1)?.data, calls: fixture.engine.calls, value: window.deviceStore.row.params.feedback, frames: fixture.frames(), previews: fixture.previews.length, flushes: fixture.flushes.length, nativeValues: fixture.nativeValues, overrides: fixture.overrides }
  },
  reset: () => fixture.reset(),
  switchOwner: owner => fixture.switchOwner(owner),
  deferPersistence: () => fixture.deferPersistence(),
  resolvePersistence: () => {
    fixture.resolvePersistence()
    window.deviceKnobFixtureResolvePersistence?.()
  },
  beginFlush: () => fixture.beginFlush(),
  waitFlush: () => fixture.waitFlush(),
  flushSettled: () => fixture.flushSettled(),
  cancel: () => window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1 })),
}
`

test('non-EQ device knob drag previews then persists once, cancellation stays transient', async () => {
  const page = await openFixture('device-knob', deviceKnobFixture, {
    'lib/local-effects': `
export const listLocalEffects = async () => [window.deviceStore.row]
export const getLocalEffect = async () => window.deviceStore.row
export const setLocalEffectInstance = async (_projectId, _targetId, _effect, params) => {
  window.deviceStore.writes.push(params.feedback)
  if (window.deviceKnobFixturePersistenceDeferred?.()) await new Promise(resolve => { window.deviceKnobFixtureResolvePersistence = resolve })
  window.deviceStore.row = { ...window.deviceStore.row, params }
  window.deviceStoreChanged?.()
  return { row: window.deviceStore.row, sequence: 0 }
}
export const setLocalEffect = setLocalEffectInstance
export const deleteLocalEffect = async () => {}
export const deleteLocalEffectInstance = async () => {}
export const reorderLocalAudioEffects = async () => {}
export const createAudioEffectInstanceId = () => 'fixture-instance'
`,
    // The panel reloads its stored rows on this notification, as the product does after a write.
    'lib/local-project-changes': `export const subscribeToLocalProjectChanges = (_projectId, listener) => { window.deviceStoreChanged = listener; return () => {} }; export const notifyLocalProjectChanged = () => 0; export const localProjectChangeSequence = () => 0`,
    'lib/timeline-repository/local-timeline-repository': `export const createLocalTimelineRepository = () => ({}); export const flushLocalTimelineWrites = async () => {}`,
    'lib/shared-outbox': localOnlyOutboxStub,
  })
const resultSchema = z.object({ writes: z.array(z.number()), history: z.number(), historyEntries: z.array(z.unknown()), historyEntry: z.unknown().optional(), calls: z.array(z.number().nullable()), value: z.number(), frames: z.number(), previews: z.number(), flushes: z.number(), nativeValues: z.array(z.number()), overrides: z.array(z.string()) })
  const evidence: Record<string, z.infer<typeof resultSchema>> = {}
  try {
    const start = await page.read(pointSchema, 'deviceKnobFixture.mount()')
    await page.evaluate('deviceKnobFixture.reset()')
    await page.mouse('move', start.x, start.y)
    await page.mouse('down')
    await page.mouse('move', start.x, start.y - 30)
    await page.mouse('move', start.x, start.y - 60)
    const held = await page.read(resultSchema, 'deviceKnobFixture.result()')
    evidence.legacyHeld = held
    expect(held.calls.length).toBeLessThanOrEqual(held.frames)
    await page.mouse('up')
    const released = await page.read(resultSchema, 'deviceKnobFixture.result()')
    evidence.legacyReleased = released
    expect(released.writes).toHaveLength(1)
    expect(released.history).toBe(1)
    expect(released.calls.length).toBeGreaterThan(0)
    expect(released.previews).toBe(0)
    expect(released.flushes).toBe(0)
    const cancelStart = await page.read(pointSchema, 'deviceKnobFixture.mount()')
    await page.evaluate('deviceKnobFixture.reset()')
    await page.mouse('move', cancelStart.x, cancelStart.y)
    await page.mouse('down')
    await page.mouse('move', cancelStart.x, cancelStart.y - 30)
    await page.evaluate('deviceKnobFixture.cancel()')
    const cancelled = await page.read(resultSchema, 'deviceKnobFixture.result()')
    evidence.legacyCancelled = cancelled
    expect(cancelled.writes).toEqual([])
    expect(cancelled.history).toBe(0)
    expect(cancelled.value).toBe(0.25)
    for (const legacy of [false]) {
      for (const targetId of ['track:one', 'master']) {
        const nativeStart = await page.read(pointSchema, `deviceKnobFixture.mount(${legacy}, ${JSON.stringify(targetId)})`)
        await page.evaluate('deviceKnobFixture.reset()')
        await page.mouse('move', nativeStart.x, nativeStart.y)
        await page.mouse('down')
        await page.mouse('move', nativeStart.x, nativeStart.y - 35)
        const heldNative = await page.read(resultSchema, 'deviceKnobFixture.result()')
        evidence[`${targetId}-native-held`] = heldNative
        expect(heldNative.previews).toBeGreaterThan(0)
        expect(heldNative.nativeValues.length).toBeGreaterThan(0)
        expect(heldNative.calls).toEqual([])
        expect(heldNative.writes).toEqual([])
        expect(heldNative.history).toBe(0)
        await page.mouse('up')
        const releasedNative = await page.read(resultSchema, 'deviceKnobFixture.result()')
        evidence[`${targetId}-native-released`] = releasedNative
        expect(releasedNative.flushes).toBe(1)
        expect(releasedNative.calls).toEqual([])
        expect(releasedNative.writes).toHaveLength(1)
        expect(releasedNative.history).toBe(1)

        for (const cancel of ['escape', 'pointercancel']) {
          const cancelStart = await page.read(pointSchema, `deviceKnobFixture.mount(${legacy}, ${JSON.stringify(targetId)})`)
          await page.evaluate('deviceKnobFixture.reset()')
          await page.mouse('move', cancelStart.x, cancelStart.y)
          await page.mouse('down')
          await page.mouse('move', cancelStart.x, cancelStart.y - 35)
          if (cancel === 'escape') await page.press('Escape')
          else await page.evaluate('deviceKnobFixture.cancel()')
          const rolledBack = await page.read(resultSchema, 'deviceKnobFixture.result()')
          evidence[`${targetId}-native-${cancel}`] = rolledBack
          expect(rolledBack.value).toBe(0.25)
          expect(rolledBack.writes).toEqual([])
          expect(rolledBack.history).toBe(0)
          expect(rolledBack.calls).toEqual([])
          expect(rolledBack.nativeValues.at(-1)).toBe(0.25)
          await page.mouse('up')
        }
      }
    }

    const rapidStart = await page.read(pointSchema, 'deviceKnobFixture.mount(false)')
    await page.evaluate('deviceKnobFixture.reset()')
    for (const offset of [30, 60]) {
      await page.mouse('move', rapidStart.x, rapidStart.y)
      await page.mouse('down')
      await page.mouse('move', rapidStart.x, rapidStart.y - offset)
      await page.mouse('up')
    }
    const rapidReleases = await page.read(resultSchema, 'deviceKnobFixture.result()')
    evidence.rapidReleases = rapidReleases
    expect(rapidReleases.history).toBe(2)
    expect(rapidReleases.writes).toHaveLength(2)

    for (const owner of ['project:delay-knob-fixture:track:two', 'project:other:track:one']) {
      const ownerStart = await page.read(pointSchema, 'deviceKnobFixture.mount(false)')
      await page.evaluate('deviceKnobFixture.reset()')
      await page.mouse('move', ownerStart.x, ownerStart.y)
      await page.mouse('down')
      await page.mouse('move', ownerStart.x, ownerStart.y - 35)
      await page.evaluate('deviceKnobFixture.reset()')
      await page.evaluate(`deviceKnobFixture.switchOwner(${JSON.stringify(owner)})`)
      const afterOwnerChange = await page.read(resultSchema, 'deviceKnobFixture.result()')
      await page.mouse('move', ownerStart.x, ownerStart.y - 70)
      await page.mouse('up')
      const switched = await page.read(resultSchema, 'deviceKnobFixture.result()')
      evidence[`owner-switch:${owner}`] = switched
      expect(switched.writes).toEqual([])
      expect(switched.history).toBe(0)
      expect(switched.previews).toBe(afterOwnerChange.previews)
      // The interrupted holder ends with one closing registration of its baseline.
      expect(switched.flushes).toBe(1)
      expect(switched.calls).toEqual([])
    }

    await page.read(pointSchema, 'deviceKnobFixture.mount(false)')
    const strip = await page.read(pointSchema, `(() => { const element = document.querySelector('[aria-label="Delay low cut frequency"]'); const rect = element.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } })()`)
    await page.mouse('move', strip.x, strip.y)
    await page.mouse('down')
    await page.mouse('move', strip.x, strip.y - 35)
    await page.evaluate('deviceKnobFixture.reset()')
    await page.evaluate(`deviceKnobFixture.switchOwner("project:delay-knob-fixture:master")`)
    await page.mouse('move', strip.x, strip.y - 70)
    await page.mouse('up')
    const switchedStrip = await page.read(resultSchema, 'deviceKnobFixture.result()')
    evidence.delayStripOwnerSwitch = switchedStrip
    expect(switchedStrip.writes).toEqual([])
    expect(switchedStrip.history).toBe(0)

    const discreteStart = await page.read(pointSchema, 'deviceKnobFixture.mount(false)')
    await page.evaluate('deviceKnobFixture.reset()')
    await page.evaluate(`[-1, -1].forEach(deltaY => document.elementFromPoint(${discreteStart.x}, ${discreteStart.y}).dispatchEvent(new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true })))`)
    // A wheel burst is one gesture: it commits once, when the wheel has been quiet for WHEEL_IDLE_MS.
    await page.evaluate('new Promise(resolve => setTimeout(resolve, 300))')
    const wheel = await page.read(resultSchema, 'deviceKnobFixture.result()')
    evidence.wheel = wheel
    expect(wheel.writes).toHaveLength(1)
    expect(wheel.history).toBe(1)
    expect(wheel.historyEntry).toMatchObject({ from: { feedback: 0.25 }, to: { feedback: 0.27 } })
    expect(wheel.overrides).toContain('delay.feedback')
    const pressKey = (key: string, type: 'keydown' | 'keyup', repeat = false) => page.evaluate(`document.querySelector('[aria-label="Feedback"]').dispatchEvent(new KeyboardEvent(${JSON.stringify(type)}, { key: ${JSON.stringify(key)}, repeat: ${repeat}, bubbles: true, cancelable: true }))`)
    const shownValue = () => page.read(z.string(), `document.querySelector('[aria-label="Feedback"]').getAttribute('aria-valuenow')`)
    await pressKey('ArrowUp', 'keydown')
    for (let index = 0; index < 5; index++) await pressKey('ArrowUp', 'keydown', true)
    expect(Number(await shownValue())).toBeCloseTo(0.33)
    const heldKeyboard = await page.read(resultSchema, 'deviceKnobFixture.result()')
    // A held key is one gesture: nothing is persisted until the key is released.
    expect(heldKeyboard.writes).toHaveLength(1)
    expect(heldKeyboard.history).toBe(1)
    expect(heldKeyboard.previews).toBeGreaterThan(0)
    await pressKey('ArrowUp', 'keyup')
    const keyboard = await page.read(resultSchema, 'deviceKnobFixture.result()')
    expect(keyboard.value).toBeCloseTo(0.33)
    expect(keyboard.writes).toHaveLength(2)
    expect(keyboard.history).toBe(2)
    await pressKey('ArrowDown', 'keydown')
    await pressKey('ArrowDown', 'keydown', true)
    await pressKey('Escape', 'keydown')
    await pressKey('ArrowDown', 'keydown', true)
    expect(Number(await shownValue())).toBeCloseTo(0.33)
    await pressKey('ArrowDown', 'keyup')
    const escaped = await page.read(resultSchema, 'deviceKnobFixture.result()')
    expect(escaped.value).toBeCloseTo(0.33)
    expect(escaped.nativeValues.at(-1)).toBeCloseTo(0.33)
    expect(escaped.writes).toHaveLength(2)
    expect(escaped.history).toBe(2)
    await page.evaluate(`document.querySelector('[aria-label="Feedback"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`)
    const reset = await page.read(resultSchema, 'deviceKnobFixture.result()')
    expect(reset.value).toBe(0.25)
    expect(reset.writes).toHaveLength(3)
    expect(reset.history).toBeGreaterThanOrEqual(1)
    await pressKey('End', 'keydown')
    await pressKey('End', 'keyup')
    const boundary = await page.read(resultSchema, 'deviceKnobFixture.result()')
    expect(boundary.value).toBe(0.95)
    expect(boundary.writes).toHaveLength(4)
    expect(boundary.history).toBeGreaterThanOrEqual(reset.history)
    await pressKey('End', 'keydown')
    await pressKey('End', 'keyup')
    const boundaryNoop = await page.read(resultSchema, 'deviceKnobFixture.result()')
    expect(boundaryNoop.writes).toHaveLength(4)
    expect(boundaryNoop.history).toBe(boundary.history)
    evidence.discrete = boundaryNoop

    const deferredStart = await page.read(pointSchema, 'deviceKnobFixture.mount(false)')
    await page.evaluate('deviceKnobFixture.reset()')
    await page.evaluate('deviceKnobFixture.deferPersistence()')
    await page.evaluate(`document.elementFromPoint(${deferredStart.x}, ${deferredStart.y}).dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true, cancelable: true }))`)
    await page.evaluate('deviceKnobFixture.beginFlush()')
    await page.evaluate('Promise.resolve()')
    expect(await page.read(z.boolean(), 'deviceKnobFixture.flushSettled()')).toBe(false)
    await page.evaluate('deviceKnobFixture.resolvePersistence()')
    expect(await page.read(z.boolean(), 'deviceKnobFixture.waitFlush().then(() => true)')).toBe(true)
    const flushedDiscrete = await page.read(resultSchema, 'deviceKnobFixture.result()')
    evidence.flushPendingDiscrete = flushedDiscrete
    expect(flushedDiscrete.writes).toHaveLength(1)
  } finally {
    await Bun.write(`${page.directory}/results.json`, JSON.stringify(evidence, null, 2))
    console.log(`Delay gesture evidence: ${page.directory}/results.json`)
    await page.close()
  }
}, 120_000)

test('Utility reports playback and storage failures through separate surfaces', async () => {
  const page = await openFixture('utility-failures', utilityFixture, utilityStubs)
  const results: Record<string, z.infer<typeof utilityResultSchema>> = {}
  try {
    for (const failure of ['engine', 'persist']) {
      const start = await page.read(pointSchema, 'utilityFixture.mount()')
      await page.evaluate(`utilityFixture.fail(${JSON.stringify(failure)})`)
      await page.mouse('move', start.x, start.y)
      await page.mouse('down')
      await page.mouse('move', start.x, start.y - 40)
      await page.mouse('up')
      results[failure] = await page.read(utilityResultSchema, 'utilityFixture.result()')
    }
  } finally {
    await Bun.write(`${page.directory}/results.json`, JSON.stringify(results, null, 2))
    console.log(`Utility failure evidence: ${page.directory}/results.json`)
    await page.close()
  }
  // A released edit whose engine apply failed is not saved: the knob returns to what the engine holds, and the failure is
  // reported as playback (the preview) and as an unsaved local edit (the release).
  expect(results.engine).toMatchObject({ errors: ['Engine is unavailable'], writes: [], history: [], gainDb: 0, persistedGainDb: 0 })
  expect(results.engine?.engineErrors.length).toBeGreaterThan(0)
  expect(results.engine?.engineErrors.every((error) => error.title === 'Effect playback update failed')).toBe(true)
  expect(results.persist).toMatchObject({ errors: ['Disk is full'], engineErrors: [], writes: [], history: [], persistedGainDb: 0 })
}, 120_000)

const effectFailureFixture = `
import { createRoot } from 'solid-js'
import { createPersistedEffectState } from '~/components/timeline/create-persisted-effect-state'
window.effectFailureFixture = {
  run: async (mode) => {
    const engineErrors = []
    const persistenceErrors = []
    const writes = []
    const cause = new Error(mode)
    let dispose
    let state
    createRoot((cleanup) => {
      dispose = cleanup
      state = createPersistedEffectState({
        targetId: () => undefined,
        row: () => undefined,
        readQueryParams: () => undefined,
        createInitialParams: () => undefined,
        serializeParams: String,
        createPersistContext: () => ({ projectId: 'project:failure-fixture' }),
        applyToEngine: () => {
          if (mode.endsWith('-sync')) throw cause
          if (mode.endsWith('-async')) return Promise.reject(cause)
        },
        persistParams: (_targetId, params) => { writes.push(params); if (mode === 'persist' && writes.length === 1) throw cause },
        onEngineApplyError: (error, context) => engineErrors.push({ message: error.message, projectId: context?.projectId }),
        // A released edit whose engine apply failed is not saved and is reported as an engine failure.
        onReleaseFailed: (error, context) => engineErrors.push({ message: error.message, projectId: context?.projectId }),
        onPersistError: (error, context) => persistenceErrors.push({ message: error.message, projectId: context?.projectId }),
      })
    })
    let escaped = null
    try {
      if (mode.startsWith('remote')) state.syncRemoteForTarget('track', 2)
      else state.setForTarget('track', 2)
    } catch (error) { escaped = error.message }
    for (let index = 0; index < 20; index++) await Promise.resolve()
    // Do not retry a failed draft during fixture cleanup.
    if (mode === 'persist') await state.flushPending().catch(() => {})
    dispose()
    for (let index = 0; index < 20; index++) await Promise.resolve()
    return { engineErrors, persistenceErrors, writes, escaped }
  },
}
`
const effectFailureSchema = z.object({
  engineErrors: z.array(z.object({ message: z.string(), projectId: z.string() })),
  persistenceErrors: z.array(z.object({ message: z.string(), projectId: z.string() })),
  writes: z.array(z.number()), escaped: z.string().nullable(),
})

test('effect engine failures are not reported as persistence failures', async () => {
  const page = await openFixture('effect-failures', effectFailureFixture)
  const results: Record<string, z.infer<typeof effectFailureSchema>> = {}
  try {
    for (const mode of ['local-sync', 'local-async', 'remote-sync', 'remote-async', 'persist']) {
      results[mode] = await page.read(effectFailureSchema, `effectFailureFixture.run(${JSON.stringify(mode)})`)
    }
  } finally {
    await Bun.write(`${page.directory}/results.json`, JSON.stringify(results, null, 2))
    console.log(`Effect failure evidence: ${page.directory}/results.json`)
    await page.close()
  }
  for (const mode of ['local-sync', 'local-async', 'remote-sync', 'remote-async']) {
    expect(results[mode]).toMatchObject({
      engineErrors: [{ message: mode, projectId: 'project:failure-fixture' }],
      persistenceErrors: [], escaped: null,
    })
  }
  expect(results.persist?.engineErrors).toEqual([])
  expect(results.persist?.persistenceErrors[0]).toEqual({ message: 'persist', projectId: 'project:failure-fixture' })
}, 120_000)

const eqFixture = `
import { createComponent, createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { createDefaultEqParams } from '@daw-browser/shared'
import Eq from '~/components/effects/Eq'
import { ParameterGestureProvider } from '~/components/effects/effect-parameter-interaction'
import '~/index.css'
let state
window.eqFixture = {
  mount: () => {
    state?.dispose()
    document.body.replaceChildren()
    const root = document.createElement('div')
    document.body.append(root)
    const baseline = createDefaultEqParams()
    // Gain is available on a peaking band.
    baseline.bands[0] = { ...baseline.bands[0], enabled: true, type: 'peaking', gainDb: 0 }
    const [params, setParams] = createSignal(baseline)
    const events = []
    const preview = (id, updates) => setParams((current) => ({ ...current, bands: current.bands.map((band) => band.id === id ? { ...band, ...updates } : band) }))
    const open = new Set()
    const owner = {
      open: holder => { if (open.size === 0) events.push('begin'); open.add(holder) },
      end: holder => { if (open.delete(holder) && open.size === 0) events.push('commit') },
      cancel: holder => { if (!open.has(holder)) return; open.clear(); events.push('cancel'); setParams(baseline) },
      tick: (holder, emit) => { if (!open.has(holder)) return false; emit(); return true },
      once: emit => emit(),
      isOpen: holder => open.has(holder),
      closed: () => 0,
    }
    const dispose = render(() => createComponent(ParameterGestureProvider, {
      owner,
      get children() {
        return createComponent(Eq, {
          get bands() { return params().bands },
          enabled: true, channelMode: 'stereo',
          onBandChange: preview, onChannelModeChange: () => {},
        })
      },
    }), root)
    const knob = root.querySelector('[role="slider"][aria-label="Gain"]')
    state = { dispose, events, params }
    const rect = knob.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  },
  result: () => ({ events: state.events, gainDb: state.params().bands[0].gainDb }),
}
`
test('EQ knob cancellation dispatches cancel rather than commit', async () => {
  const page = await openFixture('eq-gain', eqFixture, {
    'context/app-preferences': `export const useAppPreferences = () => ({ appearance: { themeTokens: () => ({}) } })`,
  })
  const schema = z.object({ events: z.array(z.string()), gainDb: z.number() })
  const results: Record<string, z.infer<typeof schema>> = {}
  try {
    for (const scenario of ['release', 'escape']) {
      const start = await page.read(pointSchema, 'eqFixture.mount()')
      await page.mouse('move', start.x, start.y)
      await page.mouse('down')
      await page.mouse('move', start.x, start.y - 30)
      if (scenario === 'escape') await page.press('Escape')
      await page.mouse('up')
      results[scenario] = await page.read(schema, 'eqFixture.result()')
    }
  } finally {
    await Bun.write(`${page.directory}/results.json`, JSON.stringify(results, null, 2))
    console.log(`EQ gesture evidence: ${page.directory}/results.json`)
    await page.close()
  }
  expect(results.release?.events).toEqual(['begin', 'commit'])
  expect(results.release?.gainDb).not.toBe(0)
  expect(results.escape).toEqual({ events: ['begin', 'cancel'], gainDb: 0 })
}, 120_000)

const builtInEffectGestureFixture = `
import { createProcessorEditRegistry } from '~/components/timeline/create-processor-edit-registry'
import { createAudioEffectParameterPayload } from '~/components/timeline/audio-effect-parameter-payload'
import { captureNativeBuiltInParameterValues } from '~/lib/desktop/native-built-in-parameter-mapper'
import { createComponent } from 'solid-js'
import { render } from 'solid-js/web'
import { AUDIO_EFFECT_CONTRACTS } from '@daw-browser/shared'
import Eq from '~/components/effects/Eq'
import Limiter from '~/components/effects/Limiter'
import { ParameterGestureProvider } from '~/components/effects/effect-parameter-interaction'
import { createEffectsPanelAudioDevice } from '~/components/timeline/create-effects-panel-audio-effects-state'
import { createUndoManager } from '~/lib/undo/manager'
import { buildEffectParamsHistoryEntry } from '~/lib/undo/builders'
import '~/index.css'

let fixture
window.builtInEffectGestureFixture = {
  mount: (kind, targetId = 'track:one', legacy = false) => {
    fixture?.dispose()
    document.body.replaceChildren()
    const root = document.createElement('div')
    root.style.cssText = 'width:900px;height:520px'
    document.body.append(root)
    const effect = kind === 'eq' ? 'eq' : targetId === 'master' ? 'master-limiter' : 'limiter'
    const instanceId = kind === 'eq' ? 'eq-1' : 'limiter-1'
    const baseline = kind === 'eq'
      ? { ...AUDIO_EFFECT_CONTRACTS.eq.createDefaultParams(), bands: AUDIO_EFFECT_CONTRACTS.eq.createDefaultParams().bands.map((band, index) => index === 0 ? { ...band, enabled: true, type: 'peaking', frequency: 1000, gainDb: -0.1 } : band) }
      : AUDIO_EFFECT_CONTRACTS.limiter.createDefaultParams()
    const row = { type: effect, effect, targetType: targetId === 'master' ? 'master' : 'track', targetId, trackId: targetId === 'master' ? undefined : targetId, instanceId, index: 0, params: baseline }
    window.builtInEffectStore = { row, writes: [] }
    const engine = {
      getBpm: () => 120,
      calls: [],
      subscribeTrackGateMeter: () => () => {},
      subscribeMasterGateMeter: () => () => {},
      setTrackFxInstance: async () => 'not-held',
      setMasterFxInstance: async () => 'not-held',
      setTrackFxInstances: async (_id, instances) => { engine.calls.push(instances.find(item => item.kind === kind)?.params) },
      setMasterFxInstances: async instances => { engine.calls.push(instances.find(item => item.kind === kind)?.params) },
    }
    const abort = new AbortController()
    let escapeReachedDocument = false
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') escapeReachedDocument = true
    }, { signal: abort.signal })
    const previews = []
    const flushes = []
    const nativeValues = []
    let pendingPreview
    let resolvePreview
    let rejectNextPreview = false
    let failNextFlush = false
    const errors = []
    let holdFlush = false
    let resolveFlush
    let pendingDrain
    let drainSettled = false
    const undo = createUndoManager({})
    const processorEdits = createProcessorEditRegistry(() => 120)
    const initialPayload = createAudioEffectParameterPayload({ targetId, instanceId, kind }, baseline, baseline)
    const installed = new Map(Object.entries(captureNativeBuiltInParameterValues(initialPayload, 120)))
    const touched = new Map()
    let nativeTail = Promise.resolve()
    let receiptSerial = 0
    let device
    const params = () => device.paramsForInstance({ id: instanceId, kind }) ?? baseline
    // Model sink only: controller carrier/count assertions belong to the real-controller witnesses.
    const applyNative = (edit, gesture) => {
      const fields = Object.entries(edit.content.values)
      const changed = fields.filter(([id, value]) => installed.get(id) !== value)
      const held = gesture ? touched.get(gesture.token) ?? new Set() : new Set()
      for (const [id] of changed) held.add(id)
      if (gesture?.holds) touched.set(gesture.token, held)
      for (const [parameterId, value] of fields) if (changed.some(([id]) => id === parameterId) || !gesture?.holds && held.has(parameterId)) {
        nativeValues.push({ parameterId, value })
        installed.set(parameterId, value)
      }
      if (gesture && !gesture.holds) touched.delete(gesture.token)
    }
    const dispose = render(() => {
      device = createEffectsPanelAudioDevice({
        audioEngine: () => engine,
        projectId: () => 'project:builtin-effect-fixture',
        userId: () => 'user',
        roomEffects: () => [],
        canWriteCurrentTargetEffects: () => true,
        usesLegacyAudioEngine: () => legacy,
        allocateProcessorEdit: processorEdits.allocate,
        // This gate is the independently awaited portable leg, not a native proof or ACK.
        applyPortableProcessor: legacy ? undefined : async () => {
          if (pendingPreview) await new Promise(resolve => { resolvePreview = resolve })
          return 'skipped'
        },
        deliverProcessor: (edit, gesture) => {
          if (gesture) (gesture.holds ? previews : flushes).push(edit)
          const settled = nativeTail.then(async () => {
            applyNative(edit, gesture)
            if (!gesture?.holds && holdFlush) await new Promise(resolve => { resolveFlush = resolve })
            if (gesture?.holds && rejectNextPreview || !gesture?.holds && failNextFlush) {
              rejectNextPreview = false; failNextFlush = false
              errors.push({ title: 'Device playback update unconfirmed', message: 'Reply lost after model application.' })
              return { state: 'unconfirmed' }
            }
            return { state: 'applied' }
          })
          nativeTail = settled.then(() => {})
          return { receipt: { key: instanceId, serial: ++receiptSerial }, settled }
        },
        onEffectParamsCommitted: async (payload, projectId, options) => {
          undo.push(
            buildEffectParamsHistoryEntry({ projectId: projectId ?? 'project:builtin-effect-fixture', tracks: [], payload }),
            options?.mergeHistory === false ? undefined : 'builtin:gesture',
            600,
          )
        },
        // A release that failed is not saved: a local project reports it as an unsaved edit.
        onLocalSaveFailed: (_projectId, message) => errors.push({ title: 'Local save failed', message }),
        onEffectError: (title, message) => errors.push({ title, message }),
      }, () => targetId, () => undefined)
      return createComponent(ParameterGestureProvider, {
        owner: device.gestureOwner(instanceId, kind, targetId),
        get children() {
          if (kind === 'eq') {
            return createComponent(Eq, {
              get bands() { return params().bands },
              get enabled() { return params().enabled },
              get channelMode() { return params().channelMode },
              onBandChange: (id, updates) => device.eq.changeInstance(instanceId, current => ({ ...current, bands: current.bands.map(band => band.id === id ? { ...band, ...updates } : band) })),
            })
          }
          return createComponent(Limiter, {
            get params() { return params().state },
            targetId,
            effectInstanceId: instanceId,
            audioEngine: engine,
            onChange: updates => device.limiter.changeInstance(instanceId, current => ({ ...current, state: { ...current.state, ...updates } })),
            onToggleEnabled: enabled => device.limiter.changeInstance(instanceId, current => ({ ...current, state: { ...current.state, enabled } })),
            onReset: () => device.limiter.changeInstance(instanceId, () => AUDIO_EFFECT_CONTRACTS.limiter.createDefaultParams()),
          })
        },
      })
    }, root)
    fixture = { dispose: () => { abort.abort(); dispose() }, beginDrain: () => { drainSettled = false; pendingDrain = device.flushPending().then(() => { drainSettled = true }) }, drainSettled: () => drainSettled, waitDrain: () => pendingDrain, escapeReachedDocument: () => escapeReachedDocument, root, device, engine, previews, flushes, errors, nativeValues, undo, params, targetId, instanceId, kind, baseline, holdPreview: () => { pendingPreview = true }, releasePreview: () => { pendingPreview = false; resolvePreview?.() }, rejectNextPreview: () => { rejectNextPreview = true }, failNextFlush: () => { failNextFlush = true }, holdFlush: () => { holdFlush = true }, releaseFlush: () => { holdFlush = false; resolveFlush?.() }, discreteEdit: () => device.eq.changeInstance(instanceId, current => ({ ...current, bands: current.bands.map((band, index) => index === 0 ? { ...band, gainDb: 3 } : band) })) }
    return { x: 0, y: 0 }
  },
  eqPoint: (frequency, gainDb) => {
    const canvas = fixture.root.querySelector('canvas')
    const rect = canvas.getBoundingClientRect()
    const width = Number(canvas.getAttribute('width'))
    const height = Number(canvas.getAttribute('height'))
    const x = 6 + ((Math.log10(frequency) - Math.log10(20)) / (Math.log10(20000) - Math.log10(20))) * (width - 12)
    const y = 18 + ((24 - gainDb) / 48) * (height - 36)
    return { x: rect.left + x * rect.width / width, y: rect.top + y * rect.height / height }
  },
  gainKnobPoint: () => {
    const rect = fixture.root.querySelector('[role="slider"][aria-label="Gain"]').getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  },
  // Waits for queued previews without ending a held gesture: flushPending commits it.
  settle: async () => {
    await new Promise(resolve => requestAnimationFrame(resolve))
    for (let index = 0; index < 20; index++) await Promise.resolve()
  },
  // A failed release rejects the flush; the fixture reads its outcome from the result instead.
  flushPending: async () => fixture.device.flushPending().catch(() => {}),
  beginDrain: () => fixture.beginDrain(),
  drainSettled: () => fixture.drainSettled(),
  waitDrain: () => fixture.waitDrain(),
  params: () => fixture.params(),
  result: () => ({
    params: fixture.params(),
    baseline: fixture.baseline,
    writes: window.builtInEffectStore.writes,
    history: fixture.undo.snapshot().undo.length,
    undo: fixture.undo.snapshot().undo,
    redo: fixture.undo.snapshot().redo,
    previews: fixture.previews,
    flushes: fixture.flushes,
    nativeValues: fixture.nativeValues,
    engineCalls: fixture.engine.calls,
    persistedParams: window.builtInEffectStore.row.params,
    dragging: document.body.classList.contains('select-none'),
    escapeReachedDocument: fixture.escapeReachedDocument(),
    errors: fixture.errors,
  }),
  reset: () => {
    window.builtInEffectStore.writes.length = 0
    fixture.undo.clear()
    fixture.previews.length = 0
    fixture.flushes.length = 0
    fixture.nativeValues.length = 0
    fixture.engine.calls.length = 0
  },
  replay: async direction => {
    const entry = direction === 'undo' ? fixture.undo.reserveUndo() : fixture.undo.reserveRedo()
    if (!entry) return false
    const replayed = fixture.device.replayInstanceParams({
      targetId: fixture.targetId,
      effect: fixture.kind === 'eq'
        ? fixture.targetId === 'master' ? 'master-eq' : 'eq'
        : fixture.targetId === 'master' ? 'master-limiter' : 'limiter',
      instanceId: fixture.instanceId,
      params: direction === 'undo' ? entry.data.from : entry.data.to,
    })
    if (replayed) {
      if (direction === 'undo') fixture.undo.completeUndo(entry)
      else fixture.undo.completeRedo(entry)
    }
    await fixture.device.flushPending()
    return replayed
  },
  cancel: () => fixture.root.querySelector('canvas')?.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 1 })),
  holdPreview: () => fixture.holdPreview(),
  releasePreview: () => fixture.releasePreview(),
  rejectNextPreview: () => fixture.rejectNextPreview(),
  failNextFlush: () => fixture.failNextFlush(),
  holdFlush: () => fixture.holdFlush(),
  releaseFlush: () => fixture.releaseFlush(),
  discreteEdit: () => fixture.discreteEdit(),
}
`

test('native EQ 2D gestures flush touched fields and cancel or replay atomically', async () => {
  const page = await openFixture('eq-native', builtInEffectGestureFixture, {
    'lib/local-effects': `
import { notifyLocalProjectChanged } from '~/lib/local-project-changes'
export const listLocalEffects = async () => [window.builtInEffectStore.row]
export const getLocalEffect = async () => window.builtInEffectStore.row
export const setLocalEffectInstance = async (projectId, _targetId, _effect, params) => {
  window.builtInEffectStore.writes.push(params)
  window.builtInEffectStore.row = { ...window.builtInEffectStore.row, params }
  return { row: window.builtInEffectStore.row, sequence: notifyLocalProjectChanged(projectId) }
}
export const setLocalEffect = setLocalEffectInstance
export const deleteLocalEffect = async () => {}
export const deleteLocalEffectInstance = async () => {}
export const reorderLocalAudioEffects = async () => {}
export const createAudioEffectInstanceId = () => 'fixture-instance'
`,
    'lib/timeline-repository/local-timeline-repository': `export const createLocalTimelineRepository = () => ({}); export const flushLocalTimelineWrites = async () => {}`,
    'lib/shared-outbox': localOnlyOutboxStub,
    'context/app-preferences': `export const useAppPreferences = () => ({ appearance: { themeTokens: () => ({}) } })`,
  })
  const resultSchema = z.object({
    params: z.object({ bands: z.array(z.object({ id: z.string(), frequency: z.number(), gainDb: z.number() })) }),
    persistedParams: z.object({ bands: z.array(z.object({ id: z.string(), frequency: z.number(), gainDb: z.number() })) }),
    baseline: z.object({ bands: z.array(z.object({ id: z.string(), frequency: z.number(), gainDb: z.number() })) }),
    writes: z.array(z.unknown()),
    history: z.number(),
    undo: z.array(z.unknown()),
    redo: z.array(z.unknown()),
    previews: z.array(z.unknown()),
    flushes: z.array(z.unknown()),
    nativeValues: z.array(z.object({ parameterId: z.string(), value: z.number() })),
    engineCalls: z.array(z.unknown()),
    dragging: z.boolean(),
    escapeReachedDocument: z.boolean(),
    errors: z.array(z.object({ title: z.string(), message: z.string() })),
  })
  const evidence: Record<string, z.infer<typeof resultSchema>> = {}
  try {
    // Repeat a sent value before release: the terminal send must still include gain.
    await page.read(pointSchema, 'builtInEffectGestureFixture.mount("eq")')
    const repeatStart = await page.read(pointSchema, 'builtInEffectGestureFixture.gainKnobPoint()')
    await page.mouse('move', repeatStart.x, repeatStart.y)
    await page.mouse('down')
    for (const pixels of [35, 45, 35]) {
      await page.mouse('move', repeatStart.x, repeatStart.y - pixels)
      await page.evaluate('builtInEffectGestureFixture.settle()')
    }
    await page.mouse('up')
    await page.evaluate('builtInEffectGestureFixture.flushPending()')
    const repeated = await page.read(resultSchema, 'builtInEffectGestureFixture.result()')
    evidence.repeatedFinalGain = repeated
    expect(repeated.params.bands[0]?.gainDb).toBe(6.9)
    expect(repeated.persistedParams.bands[0]?.gainDb).toBe(6.9)
    expect(repeated.flushes).toHaveLength(1)
    expect(repeated.writes).toHaveLength(1)
    expect(repeated.history).toBe(1)
    expect(repeated.nativeValues.filter(value => value.parameterId.endsWith('.gainDb')).map(value => value.value)).toEqual([6.9, 8.9, 6.9, 6.9])

    // Hold the rollback before apply. The next gesture must queue behind it.
    await page.read(pointSchema, 'builtInEffectGestureFixture.mount("eq")')
    const rollbackStart = await page.read(pointSchema, 'builtInEffectGestureFixture.gainKnobPoint()')
    await page.mouse('move', rollbackStart.x, rollbackStart.y)
    await page.mouse('down')
    await page.mouse('move', rollbackStart.x, rollbackStart.y - 35)
    await page.evaluate('builtInEffectGestureFixture.settle()')
    await page.evaluate('builtInEffectGestureFixture.holdPreview()')
    await page.press('Escape')
    await page.mouse('up')
    await page.mouse('move', rollbackStart.x, rollbackStart.y)
    await page.mouse('down')
    await page.mouse('move', rollbackStart.x, rollbackStart.y - 20)
    await page.mouse('up')
    const blocked = await page.read(resultSchema, 'builtInEffectGestureFixture.result()')
    evidence.rollbackHeldWithNewCommit = blocked
    expect(blocked.params.bands[0]?.gainDb).toBe(3.9)
    expect(blocked.writes).toEqual([])
    expect(blocked.history).toBe(0)
    expect(blocked.nativeValues.at(-1)?.value).toBe(6.9)
    await page.evaluate('builtInEffectGestureFixture.releasePreview()')
    await page.evaluate('builtInEffectGestureFixture.flushPending()')
    const ordered = await page.read(resultSchema, 'builtInEffectGestureFixture.result()')
    evidence.rollbackBeforeNewCommit = ordered
    expect(ordered.nativeValues.at(-1)).toEqual({ parameterId: 'eq.b1.gainDb', value: 3.9 })
    expect(ordered.params.bands[0]?.gainDb).toBe(3.9)
    expect(ordered.persistedParams.bands[0]?.gainDb).toBe(3.9)
    expect(ordered.writes).toHaveLength(1)
    expect(ordered.history).toBe(1)
    // Without a registry the cancel ends with an edit-less flush; the new commit's flush follows it.
    expect(ordered.flushes).toHaveLength(2)

    await page.read(pointSchema, 'builtInEffectGestureFixture.mount("eq")')
    const noOpStart = await page.read(pointSchema, 'builtInEffectGestureFixture.gainKnobPoint()')
    await page.mouse('move', noOpStart.x, noOpStart.y)
    await page.mouse('down')
    await page.mouse('move', noOpStart.x, noOpStart.y - 35)
    await page.evaluate('builtInEffectGestureFixture.settle()')
    await page.mouse('move', noOpStart.x, noOpStart.y)
    await page.mouse('up')
    await page.evaluate('builtInEffectGestureFixture.flushPending()')
    const noOp = await page.read(resultSchema, 'builtInEffectGestureFixture.result()')
    evidence.releaseAtBaseline = noOp
    expect(noOp.params.bands).toEqual(noOp.baseline.bands)
    expect(noOp.persistedParams.bands).toEqual(noOp.baseline.bands)
    // Previews reached playback, so a release back at the baseline still flushes once to end the gesture.
    expect(noOp.flushes).toHaveLength(1)
    expect(noOp.writes).toEqual([])
    expect(noOp.history).toBe(0)
    expect(noOp.nativeValues.at(-1)?.value).toBe(-0.1)

    for (const cancel of ['escape', 'pointercancel']) {
      await page.read(pointSchema, 'builtInEffectGestureFixture.mount("eq")')
      const start = await page.read(pointSchema, 'builtInEffectGestureFixture.eqPoint(1000, -0.1)')
      const changed = await page.read(pointSchema, 'builtInEffectGestureFixture.eqPoint(2200, 6)')
      const restoredGain = await page.read(pointSchema, 'builtInEffectGestureFixture.eqPoint(2200, -0.1)')
      await page.mouse('move', start.x, start.y)
      await page.mouse('down')
      await page.mouse('move', changed.x, changed.y)
      await page.evaluate('builtInEffectGestureFixture.settle()')
      await page.mouse('move', restoredGain.x, restoredGain.y)
      await page.evaluate('builtInEffectGestureFixture.settle()')
      const held = await page.read(resultSchema, 'builtInEffectGestureFixture.result()')
      evidence[`${cancel}:held`] = held
      expect(held.nativeValues.some(value => value.parameterId.endsWith('.gainDb') && value.value === -0.1)).toBe(true)
      if (cancel === 'escape') await page.press('Escape')
      else await page.evaluate('builtInEffectGestureFixture.cancel()')
      const cancelled = await page.read(resultSchema, 'builtInEffectGestureFixture.result()')
      evidence[cancel] = cancelled
      expect(cancelled.writes).toEqual([])
      expect(cancelled.history).toBe(0)
      expect(cancelled.params.bands).toEqual(cancelled.baseline.bands)
      expect(cancelled.nativeValues.slice(-2)).toEqual(expect.arrayContaining([
        expect.objectContaining({ parameterId: expect.stringMatching(/frequencyHz$/), value: 1000 }),
        expect.objectContaining({ parameterId: expect.stringMatching(/gainDb$/), value: -0.1 }),
      ]))
      await page.mouse('up')
    }

    await page.read(pointSchema, 'builtInEffectGestureFixture.mount("eq")')
    await page.evaluate('builtInEffectGestureFixture.rejectNextPreview()')
    const rejectedStart = await page.read(pointSchema, 'builtInEffectGestureFixture.eqPoint(1000, -0.1)')
    const rejectedChange = await page.read(pointSchema, 'builtInEffectGestureFixture.eqPoint(2213, 6)')
    await page.mouse('move', rejectedStart.x, rejectedStart.y)
    await page.mouse('down')
    await page.mouse('move', rejectedChange.x, rejectedChange.y)
    await page.evaluate('builtInEffectGestureFixture.settle()')
    await page.evaluate('builtInEffectGestureFixture.cancel()')
    const rejectedCancelled = await page.read(resultSchema, 'builtInEffectGestureFixture.result()')
    evidence.rejectedPreviewCancel = rejectedCancelled
    expect(rejectedCancelled.params.bands).toEqual(rejectedCancelled.baseline.bands)
    expect(rejectedCancelled.nativeValues.slice(-2)).toEqual(expect.arrayContaining([
      expect.objectContaining({ parameterId: expect.stringMatching(/frequencyHz$/), value: 1000 }),
      expect.objectContaining({ parameterId: expect.stringMatching(/gainDb$/), value: -0.1 }),
    ]))
    expect(rejectedCancelled.writes).toEqual([])
    expect(rejectedCancelled.history).toBe(0)
    await page.mouse('up')

    await page.read(pointSchema, 'builtInEffectGestureFixture.mount("eq")')
    const blurStart = await page.read(pointSchema, 'builtInEffectGestureFixture.eqPoint(1000, -0.1)')
    const blurChange = await page.read(pointSchema, 'builtInEffectGestureFixture.eqPoint(2213, 6)')
    await page.mouse('move', blurStart.x, blurStart.y)
    await page.mouse('down')
    await page.mouse('move', blurChange.x, blurChange.y)
    await page.evaluate('window.dispatchEvent(new Event("blur"))')
    const blurred = await page.read(resultSchema, 'builtInEffectGestureFixture.result()')
    evidence.windowBlurCancel = blurred
    expect(blurred.params.bands).toEqual(blurred.baseline.bands)
    expect(blurred.writes).toEqual([])
    expect(blurred.history).toBe(0)
    await page.mouse('up')

    await page.read(pointSchema, 'builtInEffectGestureFixture.mount("eq")')
    const pointerStart = await page.read(pointSchema, 'builtInEffectGestureFixture.eqPoint(1000, -0.1)')
    const pointerChange = await page.read(pointSchema, 'builtInEffectGestureFixture.eqPoint(2213, 6)')
    await page.mouse('move', pointerStart.x, pointerStart.y)
    await page.mouse('down')
    await page.mouse('move', pointerChange.x, pointerChange.y)
    await page.evaluate('window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 2 }))')
    const foreignRelease = await page.read(resultSchema, 'builtInEffectGestureFixture.result()')
    evidence.foreignPointerRelease = foreignRelease
    expect(foreignRelease.writes).toEqual([])
    expect(foreignRelease.history).toBe(0)
    expect(foreignRelease.params.bands).not.toEqual(foreignRelease.baseline.bands)
    await page.mouse('up')
    const ownerRelease = await page.read(resultSchema, 'builtInEffectGestureFixture.result()')
    evidence.ownerPointerRelease = ownerRelease
    expect(ownerRelease.writes).toHaveLength(1)
    expect(ownerRelease.history).toBe(1)

    await page.read(pointSchema, 'builtInEffectGestureFixture.mount("eq")')
    await page.evaluate('builtInEffectGestureFixture.holdPreview()')
    const pendingStart = await page.read(pointSchema, 'builtInEffectGestureFixture.eqPoint(1000, -0.1)')
    const pendingChange = await page.read(pointSchema, 'builtInEffectGestureFixture.eqPoint(2200, 6)')
    await page.mouse('move', pendingStart.x, pendingStart.y)
    await page.mouse('down')
    await page.mouse('move', pendingChange.x, pendingChange.y)
    await page.evaluate('builtInEffectGestureFixture.settle()')
    const pendingHeld = await page.read(resultSchema, 'builtInEffectGestureFixture.result()')
    expect(pendingHeld.nativeValues).toEqual([])
    await page.evaluate('builtInEffectGestureFixture.cancel()')
    await page.evaluate('builtInEffectGestureFixture.releasePreview()')
    // The owner lane runs the held preview, then the restore queued behind it; draining it is the completion signal.
    await page.evaluate('builtInEffectGestureFixture.flushPending()')
    const pendingRollback = await page.read(resultSchema, 'builtInEffectGestureFixture.result()')
    evidence.pendingPreviewCancel = pendingRollback
    expect(pendingRollback.writes).toEqual([])
    expect(pendingRollback.history).toBe(0)
    // The held preview carries whichever pointer move the frame had reached (the first, or the last), so the set of parameters the
    // engine was moved on varies. Every one of them ends on its baseline, and the frequency is always among them.
    const nativeFinal = new Map(pendingRollback.nativeValues.map(entry => [entry.parameterId.replace(/^.*\./, ''), entry.value]))
    expect(nativeFinal.get('frequencyHz')).toBe(1000)
    expect(nativeFinal.get('gainDb') ?? -0.1).toBe(-0.1)

    await page.read(pointSchema, 'builtInEffectGestureFixture.mount("eq")')
    await page.evaluate('builtInEffectGestureFixture.holdPreview()')
    const flushingStart = await page.read(pointSchema, 'builtInEffectGestureFixture.eqPoint(1000, -0.1)')
    const flushingChange = await page.read(pointSchema, 'builtInEffectGestureFixture.eqPoint(2213, 6)')
    await page.mouse('move', flushingStart.x, flushingStart.y)
    await page.mouse('down')
    await page.mouse('move', flushingChange.x, flushingChange.y)
    await page.evaluate('builtInEffectGestureFixture.beginDrain()')
    const previewFlushSettled = await page.read(z.boolean(), 'builtInEffectGestureFixture.drainSettled()')
    expect(previewFlushSettled).toBe(false)
    await page.evaluate('builtInEffectGestureFixture.releasePreview()')
    await page.evaluate('builtInEffectGestureFixture.waitDrain()')
    await page.evaluate('builtInEffectGestureFixture.flushPending()')
    evidence.flushPendingPreview = await page.read(resultSchema, 'builtInEffectGestureFixture.result()')
    await page.evaluate('builtInEffectGestureFixture.cancel()')
    await page.mouse('up')

    await page.read(pointSchema, 'builtInEffectGestureFixture.mount("eq")')
    await page.evaluate('builtInEffectGestureFixture.holdFlush()')
    await page.evaluate('builtInEffectGestureFixture.discreteEdit()')
    await page.evaluate('builtInEffectGestureFixture.beginDrain()')
    const discreteFlushSettled = await page.read(z.boolean(), 'builtInEffectGestureFixture.drainSettled()')
    expect(discreteFlushSettled).toBe(true)
    await page.evaluate('builtInEffectGestureFixture.releaseFlush()')
    await page.evaluate('builtInEffectGestureFixture.waitDrain()')
    await page.evaluate('builtInEffectGestureFixture.flushPending()')
    evidence.flushPendingDiscreteEdit = await page.read(resultSchema, 'builtInEffectGestureFixture.result()')
    expect(evidence.flushPendingDiscreteEdit?.writes).toHaveLength(1)
    expect(evidence.flushPendingDiscreteEdit?.history).toBe(1)

    await page.read(pointSchema, 'builtInEffectGestureFixture.mount("eq")')
    const start = await page.read(pointSchema, 'builtInEffectGestureFixture.eqPoint(1000, -0.1)')
    const changed = await page.read(pointSchema, 'builtInEffectGestureFixture.eqPoint(2200, 6)')
    const restoredGain = await page.read(pointSchema, 'builtInEffectGestureFixture.eqPoint(2200, -0.1)')
    await page.mouse('move', start.x, start.y)
    await page.mouse('down')
    await page.mouse('move', changed.x, changed.y)
    await page.evaluate('builtInEffectGestureFixture.settle()')
    await page.mouse('move', restoredGain.x, restoredGain.y)
    await page.mouse('up')
    let released = await page.read(resultSchema, 'builtInEffectGestureFixture.result()')
    evidence.release = released
    expect(released.writes).toHaveLength(1)
    expect(released.history).toBe(1)
    expect(released.undo[0]).toMatchObject({ type: 'effect-params' })
    expect(released.undo[0]).toMatchObject({ data: { from: { bands: released.baseline.bands }, to: { bands: released.params.bands } } })
    await page.evaluate('builtInEffectGestureFixture.replay("undo")')
    const undone = await page.read(resultSchema, 'builtInEffectGestureFixture.result()')
    evidence.undo = undone
    expect(undone.params.bands).toEqual(undone.baseline.bands)
    expect(undone.redo).toHaveLength(1)
    await page.evaluate('builtInEffectGestureFixture.replay("redo")')
    released = await page.read(resultSchema, 'builtInEffectGestureFixture.result()')
    evidence.redo = released
    expect(released.params.bands).toEqual(evidence.release?.params.bands)
    expect(released.undo).toHaveLength(1)

    // An unconfirmed native close never vetoes the save or rolls the knob back.
    await page.read(pointSchema, 'builtInEffectGestureFixture.mount("eq")')
    await page.evaluate('builtInEffectGestureFixture.failNextFlush()')
    const flushStart = await page.read(pointSchema, 'builtInEffectGestureFixture.eqPoint(1000, -0.1)')
    const flushChange = await page.read(pointSchema, 'builtInEffectGestureFixture.eqPoint(2213, 6)')
    await page.mouse('move', flushStart.x, flushStart.y)
    await page.mouse('down')
    await page.mouse('move', flushChange.x, flushChange.y)
    await page.mouse('up')
    await page.evaluate('builtInEffectGestureFixture.flushPending()')
    const flushFailed = await page.read(resultSchema, 'builtInEffectGestureFixture.result()')
    evidence.terminalFlushFailure = flushFailed
    expect(flushFailed.errors).toHaveLength(1)
    expect(flushFailed.params.bands).not.toEqual(flushFailed.baseline.bands)
    expect(flushFailed.params.bands).toEqual(flushFailed.persistedParams.bands)
    expect(flushFailed.writes).toHaveLength(1)
    expect(flushFailed.history).toBe(1)

    // The same native policy applies to a discrete edit.
    await page.read(pointSchema, 'builtInEffectGestureFixture.mount("eq")')
    await page.evaluate('builtInEffectGestureFixture.failNextFlush()')
    await page.evaluate('builtInEffectGestureFixture.discreteEdit()')
    await page.evaluate('builtInEffectGestureFixture.flushPending()')
    const discreteFailed = await page.read(resultSchema, 'builtInEffectGestureFixture.result()')
    evidence.discreteFlushFailure = discreteFailed
    expect(discreteFailed.errors).toHaveLength(1)
    expect(discreteFailed.params.bands[0]?.gainDb).toBe(3)
    expect(discreteFailed.params.bands).toEqual(discreteFailed.persistedParams.bands)
    expect(discreteFailed.writes).toHaveLength(1)
    expect(discreteFailed.history).toBe(1)

    // P2-1: a preview back to the baseline is rejected after the engine left the baseline; Escape must still restore.
    await page.read(pointSchema, 'builtInEffectGestureFixture.mount("eq")')
    const previewStart = await page.read(pointSchema, 'builtInEffectGestureFixture.eqPoint(1000, -0.1)')
    const previewChange = await page.read(pointSchema, 'builtInEffectGestureFixture.eqPoint(2213, 6)')
    await page.mouse('move', previewStart.x, previewStart.y)
    await page.mouse('down')
    await page.mouse('move', previewChange.x, previewChange.y)
    await page.evaluate('builtInEffectGestureFixture.settle()')
    await page.evaluate('builtInEffectGestureFixture.rejectNextPreview()')
    await page.mouse('move', previewStart.x, previewStart.y)
    await page.evaluate('builtInEffectGestureFixture.settle()')
    const beforeEscape = await page.read(resultSchema, 'builtInEffectGestureFixture.result()')
    await page.evaluate('builtInEffectGestureFixture.cancel()')
    const escaped = await page.read(resultSchema, 'builtInEffectGestureFixture.result()')
    evidence.failedBaselinePreviewEscape = escaped
    expect(escaped.previews).toHaveLength(beforeEscape.previews.length)
    expect(escaped.flushes).toHaveLength(1)
    expect(escaped.nativeValues.filter(value => value.parameterId.endsWith('gainDb')).at(-1)?.value).toBe(-0.1)
    expect(escaped.params.bands).toEqual(escaped.baseline.bands)
    expect(escaped.writes).toEqual([])
    expect(escaped.history).toBe(0)
    await page.mouse('up')

    // A newer gesture survives the old native receipt. Its Escape returns to the successfully saved older value.
    await page.read(pointSchema, 'builtInEffectGestureFixture.mount("eq")')
    await page.evaluate('builtInEffectGestureFixture.holdFlush()')
    await page.evaluate('builtInEffectGestureFixture.failNextFlush()')
    const olderStart = await page.read(pointSchema, 'builtInEffectGestureFixture.eqPoint(1000, -0.1)')
    const olderChange = await page.read(pointSchema, 'builtInEffectGestureFixture.eqPoint(2213, 6)')
    const newerChange = await page.read(pointSchema, 'builtInEffectGestureFixture.eqPoint(2000, 3)')
    await page.mouse('move', olderStart.x, olderStart.y)
    await page.mouse('down')
    await page.mouse('move', olderChange.x, olderChange.y)
    await page.mouse('up')
    await page.mouse('down')
    await page.mouse('move', newerChange.x, newerChange.y)
    await page.evaluate('builtInEffectGestureFixture.releaseFlush()')
    await page.evaluate('builtInEffectGestureFixture.settle()')
    const newerSurvived = await page.read(resultSchema, 'builtInEffectGestureFixture.result()')
    evidence.newerGestureSurvivesOlderFailure = newerSurvived
    expect(newerSurvived.errors).toHaveLength(1)
    expect(newerSurvived.params.bands).not.toEqual(newerSurvived.baseline.bands)
    expect(newerSurvived.writes).toHaveLength(1)
    await page.evaluate('builtInEffectGestureFixture.cancel()')
    const newerEscaped = await page.read(resultSchema, 'builtInEffectGestureFixture.result()')
    evidence.newerGestureEscape = newerEscaped
    expect(newerEscaped.params.bands).not.toEqual(newerEscaped.baseline.bands)
    expect(newerEscaped.params.bands).toEqual(newerEscaped.persistedParams.bands)
    expect(newerEscaped.nativeValues.filter(value => value.parameterId.endsWith('frequencyHz')).at(-1)?.value).toBe(newerEscaped.persistedParams.bands[0]?.frequency)
    expect(newerEscaped.nativeValues.filter(value => value.parameterId.endsWith('gainDb')).at(-1)?.value).toBe(newerEscaped.persistedParams.bands[0]?.gainDb)
    expect(newerEscaped.writes).toHaveLength(1)
    expect(newerEscaped.history).toBe(1)
    await page.mouse('up')

    // Keep this last: after an unconsumed Escape with the button held, agent-browser slows every later mouse move.
    await page.read(pointSchema, 'builtInEffectGestureFixture.mount("eq")')
    const miss = await page.read(pointSchema, 'builtInEffectGestureFixture.eqPoint(2500, 20)')
    await page.mouse('move', miss.x, miss.y)
    await page.mouse('down')
    await page.press('Escape')
    const missed = await page.read(resultSchema, 'builtInEffectGestureFixture.result()')
    evidence.missedCanvasPointerDown = missed
    expect(missed.escapeReachedDocument).toBe(true)
    expect(missed.dragging).toBe(false)
    expect(missed.params.bands).toEqual(missed.baseline.bands)
    expect(missed.previews).toEqual([])
    expect(missed.flushes).toEqual([])
    expect(missed.writes).toEqual([])
    expect(missed.history).toBe(0)
    await page.mouse('up')
  } finally {
    await Bun.write(`${page.directory}/results.json`, JSON.stringify(evidence, null, 2))
    console.log(`Native EQ gesture evidence: ${page.directory}/results.json`)
    await page.close()
  }
}, 120_000)

test('track and master Limiter gestures commit once, replay, and cancel cleanly', async () => {
  const page = await openFixture('limiter', builtInEffectGestureFixture, {
    'lib/local-effects': `
import { notifyLocalProjectChanged } from '~/lib/local-project-changes'
export const listLocalEffects = async () => [window.builtInEffectStore.row]
export const getLocalEffect = async () => window.builtInEffectStore.row
export const setLocalEffectInstance = async (projectId, _targetId, _effect, params) => {
  window.builtInEffectStore.writes.push(params)
  window.builtInEffectStore.row = { ...window.builtInEffectStore.row, params }
  return { row: window.builtInEffectStore.row, sequence: notifyLocalProjectChanged(projectId) }
}
export const setLocalEffect = setLocalEffectInstance
export const deleteLocalEffect = async () => {}
export const deleteLocalEffectInstance = async () => {}
export const reorderLocalAudioEffects = async () => {}
export const createAudioEffectInstanceId = () => 'fixture-instance'
`,
    'lib/timeline-repository/local-timeline-repository': `export const createLocalTimelineRepository = () => ({}); export const flushLocalTimelineWrites = async () => {}`,
    'lib/shared-outbox': localOnlyOutboxStub,
    'context/app-preferences': `export const useAppPreferences = () => ({ appearance: { themeTokens: () => ({}) } })`,
  })
  const schema = z.object({
    params: z.object({ state: z.object({ releaseMs: z.number() }) }),
    baseline: z.object({ state: z.object({ releaseMs: z.number() }) }),
    writes: z.array(z.unknown()),
    history: z.number(),
    undo: z.array(z.unknown()),
    redo: z.array(z.unknown()),
    previews: z.array(z.unknown()),
    flushes: z.array(z.unknown()),
    nativeValues: z.array(z.object({ parameterId: z.string(), value: z.number() })),
    engineCalls: z.array(z.unknown()),
  })
  const evidence: Record<string, z.infer<typeof schema>> = {}
  try {
    for (const targetId of ['track:one', 'master']) {
      for (const legacy of [true, false]) {
        const key = `${targetId}:${legacy ? 'legacy' : 'native'}`
        await page.read(pointSchema, `builtInEffectGestureFixture.mount("limiter", ${JSON.stringify(targetId)}, ${legacy})`)
        const release = await page.read(pointSchema, `(() => { const knob = document.querySelector('[role="slider"][aria-label="Release"]'); const rect = knob.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } })()`)
        await page.mouse('move', release.x, release.y)
        await page.mouse('down')
        await page.mouse('move', release.x, release.y - 45)
        await page.mouse('up')
        let committed = await page.read(schema, 'builtInEffectGestureFixture.result()')
        evidence[`${key}:release`] = committed
        expect(committed.writes).toHaveLength(1)
        expect(committed.history).toBe(1)
        expect(committed.params.state.releaseMs).not.toBe(committed.baseline.state.releaseMs)
        expect(committed.undo).toHaveLength(1)
        if (legacy) expect(committed.engineCalls.length).toBeGreaterThan(0)
        else expect(committed.flushes.length).toBe(1)

        await page.evaluate('builtInEffectGestureFixture.replay("undo")')
        const undone = await page.read(schema, 'builtInEffectGestureFixture.result()')
        evidence[`${key}:undo`] = undone
        expect(undone.params.state.releaseMs).toBe(undone.baseline.state.releaseMs)
        expect(undone.redo).toHaveLength(1)
        expect(undone.engineCalls.length).toBeGreaterThan(0)
        await page.evaluate('builtInEffectGestureFixture.replay("redo")')
        committed = await page.read(schema, 'builtInEffectGestureFixture.result()')
        evidence[`${key}:redo`] = committed
        expect(committed.params.state.releaseMs).toBe(evidence[`${key}:release`]?.params.state.releaseMs)
        expect(committed.undo).toHaveLength(1)

        await page.read(pointSchema, `builtInEffectGestureFixture.mount("limiter", ${JSON.stringify(targetId)}, ${legacy})`)
        const cancelPoint = await page.read(pointSchema, `(() => { const knob = document.querySelector('[role="slider"][aria-label="Release"]'); const rect = knob.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } })()`)
        await page.mouse('move', cancelPoint.x, cancelPoint.y)
        await page.mouse('down')
        await page.mouse('move', cancelPoint.x, cancelPoint.y - 45)
        await page.press('Escape')
        const cancelled = await page.read(schema, 'builtInEffectGestureFixture.result()')
        evidence[`${key}:cancel`] = cancelled
        expect(cancelled.writes).toEqual([])
        expect(cancelled.history).toBe(0)
        expect(cancelled.params.state.releaseMs).toBe(cancelled.baseline.state.releaseMs)
        expect(legacy ? cancelled.engineCalls.length : cancelled.nativeValues.length).toBeGreaterThan(0)
        await page.mouse('up')
      }
    }
  } finally {
    await Bun.write(`${page.directory}/results.json`, JSON.stringify(evidence, null, 2))
    console.log(`Limiter gesture evidence: ${page.directory}/results.json`)
    await page.close()
  }
}, 120_000)

// Two Delay instances on one track. Native deliveries can be held, and the commit callback mirrors
// handleEffectParamsCommitted's history-only behavior.
const effectCommitContractFixture = `
import { createProcessorEditRegistry } from '~/components/timeline/create-processor-edit-registry'
import { createAudioEffectParameterPayload } from '~/components/timeline/audio-effect-parameter-payload'
import { createComponent } from 'solid-js'
import { render } from 'solid-js/web'
import { AUDIO_EFFECT_CONTRACTS } from '@daw-browser/shared'
import { createUndoManager } from '~/lib/undo/manager'
import { buildEffectParamsHistoryEntry } from '~/lib/undo/builders'
import { mapNativeBuiltInParameterCommit } from '~/lib/desktop/native-built-in-parameter-mapper'
import Delay from '~/components/effects/Delay'
import { ParameterGestureProvider } from '~/components/effects/effect-parameter-interaction'
import { createEffectsPanelAudioDevice } from '~/components/timeline/create-effects-panel-audio-effects-state'

let fixture
const turns = async () => { for (let index = 0; index < 20; index++) await Promise.resolve() }
const snapshot = () => {
  const view = fixture.undo.snapshot()
  const feedback = id => fixture.device.paramsForInstance({ id, kind: 'delay' })?.feedback
  const pingPong = id => fixture.device.paramsForInstance({ id, kind: 'delay' })?.pingPong
  return {
    writes: window.commitStore.writes,
    orphanWrites: window.commitStore.orphanWrites,
    rows: window.commitStore.rows.map(row => row.instanceId),
    order: window.commitStore.order,
    history: view.undo.length,
    historyEntries: view.undo.map(entry => entry.data),
    flushes: fixture.flushes,
    handlerFlushes: fixture.handlerFlushes.length,
    rebuilds: fixture.rebuilds.length,
    previews: fixture.previews.length,
    engineCalls: fixture.engineCalls,
    errors: fixture.errors,
    feedback: { 'delay-1': feedback('delay-1'), 'delay-2': feedback('delay-2') },
    pingPong: { 'delay-1': pingPong('delay-1'), 'delay-2': pingPong('delay-2') },
    removalSettled: fixture.removalSettled,
  }
}
const manualHolder = {}
window.effectCommitContractFixture = {
  mount: legacy => {
    fixture?.dispose()
    fixture?.restoreFrames()
    document.body.replaceChildren()
    const root = document.createElement('div')
    document.body.append(root)
    const params = AUDIO_EFFECT_CONTRACTS.delay.createDefaultParams()
    const row = (instanceId, index) => ({ type: 'delay', effect: 'delay', targetType: 'track', targetId: 'track:one', trackId: 'track:one', instanceId, index, params })
    window.commitStore = { rows: [row('delay-1', 0), row('delay-2', 1)], writes: [], orphanWrites: [], order: [] }
    const undo = createUndoManager({})
    const state = { flushes: [], handlerFlushes: [], rebuilds: [], previews: [], engineCalls: [], errors: [], removalSettled: false, settledReceipts: 0 }
    const processorEdits = createProcessorEditRegistry(() => 120)
    const committed = new Map([['delay-1', params], ['delay-2', params]])
    const installedParams = new Map(committed)
    let receiptSerial = 0
    const nativeRequestFrame = window.requestAnimationFrame.bind(window)
    const nativeCancelFrame = window.cancelAnimationFrame.bind(window)
    let queuedFrames = []
    let holdFlush = false
    let resolveFlush
    let holdPortable = false
    let resolvePortable
    const engine = {
      getBpm: () => 120,
      setMasterFxInstance: async () => 'not-held',
      setTrackFxInstance: async () => 'not-held',
      setMasterFxInstances: async () => {},
      setTrackFxInstances: async (_id, instances) => {
        state.engineCalls.push(Object.fromEntries(instances.map(instance => [instance.id, instance.params.feedback])))
      },
    }
    let device
    const dispose = render(() => {
      device = createEffectsPanelAudioDevice({
        audioEngine: () => engine,
        projectId: () => 'project:commit-contract',
        userId: () => 'user',
        roomEffects: () => [],
        canWriteCurrentTargetEffects: () => true,
        usesLegacyAudioEngine: () => legacy,
        allocateProcessorEdit: processorEdits.allocate,
        applyPortableProcessor: legacy ? undefined : async () => {
          if (holdPortable) await new Promise(resolve => { resolvePortable = resolve })
          return 'skipped'
        },
        // Explicit model sink. These are logical registrations, not claims about real controller dispatch counts.
        deliverProcessor: (edit, gesture) => {
          const instanceId = edit.target.instanceId
          if (gesture?.holds) state.previews.push(instanceId)
          else if (gesture || JSON.stringify(installedParams.get(instanceId)) !== JSON.stringify(edit.content.params)) {
            const payload = createAudioEffectParameterPayload({ targetId: 'track:one', instanceId, kind: 'delay' },
              gesture ? committed.get(instanceId) : installedParams.get(instanceId), edit.content.params)
            const mapped = mapNativeBuiltInParameterCommit(payload, 120)
            if (mapped && mapped.values.length > 0) state.flushes.push({
              instanceId, from: payload.from.feedback, to: payload.to.feedback,
              parameterIds: mapped.values.map(value => value.parameterId),
            })
            else state.rebuilds.push(instanceId)
            window.commitStore.order.push('register:' + instanceId)
          }
          const settled = (async () => {
            if (gesture && !gesture.holds && holdFlush) await new Promise(resolve => { resolveFlush = resolve })
            installedParams.set(instanceId, edit.content.params)
            state.settledReceipts++
            return { state: 'applied' }
          })()
          return { receipt: { key: instanceId, serial: ++receiptSerial }, settled }
        },
        onEffectParamsCommitted: async (payload, projectId, options) => {
          undo.push(buildEffectParamsHistoryEntry({ projectId: projectId ?? 'project:commit-contract', tracks: [], payload }))
          window.commitStore.order.push('history')
          committed.set(payload.instanceId, payload.to)
        },
        onEffectError: (title, message) => state.errors.push({ title, message }),
      }, () => 'track:one', () => undefined)
      return createComponent(ParameterGestureProvider, {
        owner: device.gestureOwner('delay-1', 'delay', 'track:one'),
        get children() {
          return createComponent(Delay, {
            get params() { return device.paramsForInstance({ id: 'delay-1', kind: 'delay' }) ?? params },
            onChange: updates => device.delay.changeInstance('delay-1', current => ({ ...current, ...updates })),
            onToggleEnabled: enabled => device.delay.changeInstance('delay-1', current => ({ ...current, enabled })),
            onReset: () => device.delay.changeInstance('delay-1', () => AUDIO_EFFECT_CONTRACTS.delay.createDefaultParams()),
          })
        },
      })
    }, root)
    fixture = {
      ...state, device, undo,
      dispose,
      restoreFrames: () => { window.requestAnimationFrame = nativeRequestFrame; window.cancelAnimationFrame = nativeCancelFrame },
      holdFrames: () => { window.requestAnimationFrame = callback => { queuedFrames.push(callback); return 9001 }; window.cancelAnimationFrame = () => {} },
      runFrames: () => queuedFrames.splice(0).forEach(callback => callback(0)),
      holdFlush: () => { holdFlush = true },
      releaseFlush: () => { holdFlush = false; resolveFlush?.() },
      holdPortable: () => { holdPortable = true },
      releasePortable: () => { holdPortable = false; resolvePortable?.() },
    }
    const knob = root.querySelector('[role="slider"][aria-label="Feedback"]')
    knob.scrollIntoView({ block: 'center' })
    const rect = knob.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  },
  holdFlush: () => fixture.holdFlush(),
  releaseFlush: () => fixture.releaseFlush(),
  holdPortable: () => fixture.holdPortable(),
  releasePortable: () => fixture.releasePortable(),
  holdFrames: () => fixture.holdFrames(),
  runFrames: () => fixture.runFrames(),
  restoreFrames: () => fixture.restoreFrames(),
  begin: id => fixture.device.gestureOwner(id, 'delay', 'track:one').open(manualHolder),
  commit: id => fixture.device.gestureOwner(id, 'delay', 'track:one').end(manualHolder),
  // Inside an open gesture the edit is a tick; otherwise it is one released edit.
  change: (id, updates) => {
    const emit = () => fixture.device.delay.changeInstance(id, current => ({ ...current, ...updates }))
    if (!fixture.device.gestureOwner(id, 'delay', 'track:one').tick(manualHolder, emit)) emit()
  },
  // Waits for queued previews without ending a held gesture: flushPending commits it.
  settle: () => turns(),
  flushPending: () => fixture.device.flushPending(),
  removeAll: () => {
    fixture.removalSettled = false
    fixture.removal = fixture.device.removeAllFromTarget('track:one').then(() => { fixture.removalSettled = true })
  },
  awaitRemoval: async () => { await fixture.removal; return true },
  replay: async direction => {
    const entry = direction === 'undo' ? fixture.undo.reserveUndo() : fixture.undo.reserveRedo()
    const replayed = fixture.device.replayInstanceParams({
      targetId: 'track:one', effect: 'delay', instanceId: entry.data.instanceId,
      params: direction === 'undo' ? entry.data.from : entry.data.to,
    })
    if (direction === 'undo') fixture.undo.completeUndo(entry)
    else fixture.undo.completeRedo(entry)
    await fixture.device.flushPending()
    return replayed
  },
  peek: () => snapshot(),
  result: async () => {
    await fixture.device.flushPending()
    await turns()
    return snapshot()
  },
}
`

const effectCommitContractStubs = {
  'lib/local-effects': `
import { notifyLocalProjectChanged } from '~/lib/local-project-changes'
export const listLocalEffects = async () => window.commitStore.rows
export const getLocalEffect = async (_projectId, targetId, effect) => window.commitStore.rows.find(row => row.targetId === targetId && row.effect === effect)
export const setLocalEffectInstance = async (projectId, targetId, effect, params, options) => {
  const index = window.commitStore.rows.findIndex(row => row.targetId === targetId && row.effect === effect && row.instanceId === options.instanceId)
  if (index < 0) {
    window.commitStore.orphanWrites.push(options.instanceId)
    throw new Error('Effect instance is missing')
  }
  window.commitStore.rows[index] = { ...window.commitStore.rows[index], params }
  window.commitStore.writes.push({ instanceId: options.instanceId, feedback: params.feedback, pingPong: params.pingPong })
  window.commitStore.order.push('write:' + options.instanceId)
  return { row: window.commitStore.rows[index], sequence: notifyLocalProjectChanged(projectId) }
}
export const setLocalEffect = setLocalEffectInstance
export const deleteLocalEffect = async () => {}
export const deleteLocalEffectInstance = async (projectId, targetId, effect, instanceId) => {
  window.commitStore.rows = window.commitStore.rows.filter(row => !(row.targetId === targetId && row.effect === effect && row.instanceId === instanceId))
  window.commitStore.order.push('delete:' + instanceId)
  notifyLocalProjectChanged(projectId)
}
export const reorderLocalAudioEffects = async () => {}
export const createAudioEffectInstanceId = () => 'fixture-instance'
`,
  'lib/timeline-repository/local-timeline-repository': `export const createLocalTimelineRepository = () => ({}); export const flushLocalTimelineWrites = async () => {}`,
  'lib/shared-outbox': localOnlyOutboxStub,
}

const effectCommitResultSchema = z.object({
  writes: z.array(z.object({ instanceId: z.string(), feedback: z.number(), pingPong: z.boolean() })),
  orphanWrites: z.array(z.string()),
  rows: z.array(z.string()),
  order: z.array(z.string()),
  history: z.number(),
  historyEntries: z.array(z.object({ instanceId: z.string(), from: z.object({ feedback: z.number() }), to: z.object({ feedback: z.number() }) })),
  flushes: z.array(z.object({ instanceId: z.string(), from: z.number(), to: z.number(), parameterIds: z.array(z.string()) })),
  handlerFlushes: z.number(),
  rebuilds: z.number(),
  previews: z.number(),
  engineCalls: z.array(z.record(z.string(), z.number())),
  errors: z.array(z.object({ title: z.string(), message: z.string() })),
  feedback: z.record(z.string(), z.number()),
  pingPong: z.record(z.string(), z.boolean()),
  removalSettled: z.boolean(),
})

test('effect commits order flush, persist, and history without double flushes or stale chains', async () => {
  const page = await openFixture('commit-contract', effectCommitContractFixture, effectCommitContractStubs)
  const read = () => page.read(effectCommitResultSchema, 'effectCommitContractFixture.result()')
  const peek = () => page.read(effectCommitResultSchema, 'effectCommitContractFixture.peek()')
  const drag = async (legacy: boolean, pixels: number) => {
    const start = await page.read(pointSchema, `effectCommitContractFixture.mount(${legacy})`)
    await page.mouse('move', start.x, start.y)
    await page.mouse('down')
    await page.mouse('move', start.x, start.y - pixels)
    return start
  }
  const evidence: Record<string, z.infer<typeof effectCommitResultSchema>> = {}
  try {
    // (a) The awaited portable leg must settle before remove-all deletes rows.
    await drag(false, 35)
    await page.evaluate('effectCommitContractFixture.settle()')
    await page.evaluate('effectCommitContractFixture.holdPortable()')
    await page.mouse('up')
    await page.evaluate('effectCommitContractFixture.removeAll()')
    evidence.removeAllHeld = await peek()
    expect(evidence.removeAllHeld.removalSettled).toBe(false)
    expect(evidence.removeAllHeld.rows).toEqual(['delay-1', 'delay-2'])
    await page.evaluate('effectCommitContractFixture.releasePortable()')
    await page.evaluate('effectCommitContractFixture.awaitRemoval()')
    evidence.removeAllSettled = await read()
    const { order } = evidence.removeAllSettled
    expect(evidence.removeAllSettled.orphanWrites).toEqual([])
    expect(evidence.removeAllSettled.rows).toEqual([])
    expect(evidence.removeAllSettled.errors).toEqual([])
    expect(evidence.removeAllSettled.writes).toHaveLength(1)
    expect(evidence.removeAllSettled.history).toBe(1)
    expect(order.indexOf('write:delay-1')).toBeGreaterThan(order.indexOf('register:delay-1'))
    expect(order.indexOf('delete:delay-1')).toBeGreaterThan(order.indexOf('history'))

    // Native settlement is independent: holding only that receipt must not hold persistence or deletion.
    await drag(false, 35)
    await page.evaluate('effectCommitContractFixture.holdFlush()')
    await page.mouse('up')
    await page.evaluate('effectCommitContractFixture.removeAll()')
    await page.evaluate('effectCommitContractFixture.awaitRemoval()')
    evidence.removeAllNativeHeld = await peek()
    expect(evidence.removeAllNativeHeld.removalSettled).toBe(true)
    expect(evidence.removeAllNativeHeld.rows).toEqual([])
    expect(evidence.removeAllNativeHeld.writes).toHaveLength(1)
    expect(evidence.removeAllNativeHeld.history).toBe(1)
    expect(evidence.removeAllNativeHeld.orphanWrites).toEqual([])
    await page.evaluate('effectCommitContractFixture.releaseFlush()')

    // (b) A gesture that changes only a field the native mapper cannot express still persists once.
    for (const legacy of [false, true]) {
      await page.read(pointSchema, `effectCommitContractFixture.mount(${legacy})`)
      await page.evaluate('effectCommitContractFixture.begin("delay-1")')
      await page.evaluate('effectCommitContractFixture.change("delay-1", { pingPong: true })')
      await page.evaluate('effectCommitContractFixture.commit("delay-1")')
      const unmapped = await read()
      evidence[`unmappedField:${legacy ? 'legacy' : 'native'}`] = unmapped
      expect(unmapped.writes).toEqual([{ instanceId: 'delay-1', feedback: 0.25, pingPong: true }])
      expect(unmapped.history).toBe(1)
      expect(unmapped.flushes).toEqual([])
      expect(unmapped.handlerFlushes).toBe(0)
      expect(unmapped.rebuilds).toBe(legacy ? 0 : 1)
      expect(unmapped.errors).toEqual([])
      if (legacy) expect(unmapped.engineCalls.length).toBeGreaterThan(0)
    }

    // (c) A second begin on the same instance leaves the first gesture's baseline and touched fields alone.
    const start = await drag(false, 35)
    await page.evaluate('effectCommitContractFixture.settle()')
    await page.evaluate('effectCommitContractFixture.begin("delay-1")')
    await page.mouse('move', start.x, start.y - 55)
    await page.mouse('up')
    evidence.secondBegin = await read()
    expect(evidence.secondBegin.history).toBe(1)
    expect(evidence.secondBegin.writes).toHaveLength(1)
    expect(evidence.secondBegin.historyEntries[0]?.from.feedback).toBe(0.25)
    expect(evidence.secondBegin.flushes).toHaveLength(1)
    expect(evidence.secondBegin.flushes[0]).toMatchObject({ from: 0.25 })
    expect(evidence.secondBegin.flushes[0]?.parameterIds).toContain('delay.feedback')

    // (c) A direct change to the same instance during a gesture is its own released edit from the committed value:
    // Escape restores the gesture's field and leaves that edit committed.
    await drag(false, 35)
    await page.evaluate('effectCommitContractFixture.change("delay-1", { pingPong: true })')
    await page.press('Escape')
    await page.mouse('up')
    evidence.sameInstanceEditThenEscape = await read()
    expect(evidence.sameInstanceEditThenEscape.writes).toEqual([{ instanceId: 'delay-1', feedback: 0.25, pingPong: true }])
    expect(evidence.sameInstanceEditThenEscape.history).toBe(1)
    expect(evidence.sameInstanceEditThenEscape.feedback['delay-1']).toBe(0.25)
    expect(evidence.sameInstanceEditThenEscape.pingPong['delay-1']).toBe(true)

    // (c) A discrete edit on another instance is independent: Escape on the gesture leaves it committed.
    await drag(false, 35)
    await page.evaluate('effectCommitContractFixture.change("delay-2", { feedback: 0.6 })')
    await page.press('Escape')
    await page.mouse('up')
    evidence.otherInstanceEditThenEscape = await read()
    expect(evidence.otherInstanceEditThenEscape.writes).toEqual([{ instanceId: 'delay-2', feedback: 0.6, pingPong: false }])
    expect(evidence.otherInstanceEditThenEscape.history).toBe(1)
    expect(evidence.otherInstanceEditThenEscape.feedback).toEqual({ 'delay-1': 0.25, 'delay-2': 0.6 })

    // (d) One native registration per release and discrete edit. Replay adds a row delivery, not history.
    for (const legacy of [false, true]) {
      const key = legacy ? 'legacy' : 'native'
      await drag(legacy, 35)
      await page.mouse('up')
      const release = await read()
      evidence[`${key}:release`] = release
      expect(release.history).toBe(1)
      expect(release.flushes.length + release.handlerFlushes).toBe(legacy ? 0 : 1)
      await page.evaluate('effectCommitContractFixture.change("delay-1", { feedback: 0.9 })')
      const discrete = await read()
      evidence[`${key}:discrete`] = discrete
      expect(discrete.history).toBe(2)
      expect(discrete.flushes.length + discrete.handlerFlushes).toBe(legacy ? 0 : 2)
      expect(discrete.rebuilds).toBe(0)
      const enginePriorToReplay = discrete.engineCalls.length
      await page.evaluate('effectCommitContractFixture.replay("undo")')
      const undone = await read()
      evidence[`${key}:undo`] = undone
      expect(undone.engineCalls.length).toBeGreaterThan(enginePriorToReplay)
      expect(undone.engineCalls.at(-1)?.['delay-1']).toBe(release.feedback['delay-1'] ?? Number.NaN)
      expect(undone.flushes.length + undone.handlerFlushes).toBe(legacy ? 0 : 3)
      expect(undone.history).toBe(1)
      await page.evaluate('effectCommitContractFixture.replay("redo")')
      const redone = await read()
      evidence[`${key}:redo`] = redone
      expect(redone.engineCalls.at(-1)?.['delay-1']).toBe(0.9)
      expect(redone.flushes.length + redone.handlerFlushes).toBe(legacy ? 0 : 4)
      expect(redone.history).toBe(2)
    }

    // (e) Legacy chain: a delayed preview on A must carry B's newer value from a discrete edit.
    await page.read(pointSchema, 'effectCommitContractFixture.mount(true)')
    await page.evaluate('effectCommitContractFixture.holdFrames()')
    await page.evaluate('effectCommitContractFixture.begin("delay-1")')
    await page.evaluate('effectCommitContractFixture.change("delay-1", { feedback: 0.5 })')
    await page.evaluate('effectCommitContractFixture.change("delay-2", { feedback: 0.6 })')
    await page.evaluate('effectCommitContractFixture.runFrames()')
    await page.evaluate('effectCommitContractFixture.restoreFrames()')
    evidence.legacyDelayedPreview = await read()
    expect(evidence.legacyDelayedPreview.engineCalls.at(-1)).toEqual({ 'delay-1': 0.5, 'delay-2': 0.6 })
    await page.evaluate('effectCommitContractFixture.commit("delay-1")')
    evidence.legacyDelayedPreviewCommitted = await read()
    expect(evidence.legacyDelayedPreviewCommitted.engineCalls.at(-1)).toEqual({ 'delay-1': 0.5, 'delay-2': 0.6 })
    expect(evidence.legacyDelayedPreviewCommitted.writes.map(write => write.instanceId).sort()).toEqual(['delay-1', 'delay-2'])
    expect(evidence.legacyDelayedPreviewCommitted.history).toBe(2)
  } finally {
    await Bun.write(`${page.directory}/results.json`, JSON.stringify(evidence, null, 2))
    console.log(`Effect commit contract evidence: ${page.directory}/results.json`)
    await page.close()
  }
}, 120_000)

const midiFixture = `
import { createComponent } from 'solid-js'
import { render } from 'solid-js/web'
import MidiClipEditor from '~/components/midi/MidiClipEditor'
import '~/index.css'

const center = (element, xFraction = 0.5) => {
  const rect = element.getBoundingClientRect()
  return { x: rect.left + rect.width * xFraction, y: rect.top + rect.height / 2 }
}
const notes = () => Array.from(document.querySelectorAll('[data-midi-note]'))
let state
window.midiOperations = []
window.midiFixture = {
  mount: () => {
    state?.dispose()
    document.body.replaceChildren()
    window.midiOperations.length = 0
    const root = document.createElement('div')
    root.style.cssText = 'position:relative;width:844px;height:700px'
    const thief = document.createElement('div')
    thief.style.cssText = 'position:absolute;left:1000px;top:600px;width:50px;height:50px'
    document.body.append(root, thief)
    const dispose = render(() => createComponent(MidiClipEditor, {
      clipId: 'clip:midi',
      clipName: 'Clip',
      bpm: 120,
      gridDenominator: 16,
      clipDurationSec: 2,
      midi: { wave: 'sine', notes: [
        { id: 'note:a', beat: 0, length: 0.5, pitch: 100, velocity: 0.9 },
        { id: 'note:b', beat: 2, length: 0.5, pitch: 98, velocity: 0.9 },
      ] },
      canWrite: true,
      projectId: 'project:local-midi',
      midiKeyboard: { isActive: () => false },
      trackId: 'track:midi',
    }), root)
    const [a, b] = notes()
    const grid = a.parentElement.parentElement
    const gridRect = grid.getBoundingClientRect()
    state = { dispose, grid, thief }
    return {
      a: center(a),
      aRightEdge: center(a, 0.85),
      b: center(b),
      empty: { x: gridRect.left + gridRect.width * (13 / 16), y: center(a).y },
      column: gridRect.width / 16,
    }
  },
  pointer: (type, init, target = window) => {
    const element = target === 'b' ? notes()[1] : target === 'empty' ? state.grid : window
    element.dispatchEvent(new PointerEvent(type, { pointerId: 2, button: 0, bubbles: true, ...init }))
  },
  gridOwnsPointer: () => state.grid.hasPointerCapture(1),
  stealCapture: () => { state.thief.setPointerCapture(1) },
  snapshot: () => ({
    notes: notes().map((note) => note.getAttribute('style')),
    operations: window.midiOperations,
  }),
}
`

const midiSnapshotSchema = z.object({ notes: z.array(z.string()), operations: z.array(z.unknown()) })
const midiRunSchema = z.object({
  initial: midiSnapshotSchema,
  owned: midiSnapshotSchema,
  afterInterference: midiSnapshotSchema,
  continued: midiSnapshotSchema,
  released: midiSnapshotSchema,
  stray: midiSnapshotSchema,
})

test('MIDI note gestures belong to the pointer that started them', async () => {
  const page = await openFixture('midi-note', midiFixture, {
    'hooks/useMidiEditorPersistence': `export const useMidiEditorPersistence = () => ({
      canPersist: () => true,
      saveSoon: (operation) => { window.midiOperations.push(operation) },
      flush: async () => {},
      error: () => undefined,
      dismissError: () => {},
      project: (midi) => midi,
      reconcile: () => {},
    })`,
  })
  const layoutSchema = z.object({ a: pointSchema, aRightEdge: pointSchema, b: pointSchema, empty: pointSchema, column: z.number() })
  const results: Record<string, z.infer<typeof midiRunSchema>> = {}
  let gridOwnsPointer: boolean | undefined
  try {
    const scenarios = [
      'move-release', 'resize-release', 'foreign-move', 'foreign-up', 'foreign-cancel',
      'foreign-down', 'foreign-draw', 'capture-owned', 'lost-capture', 'escape',
    ]
    for (const scenario of scenarios) {
      const layout = await page.read(layoutSchema, 'midiFixture.mount()')
      const initial = await page.read(midiSnapshotSchema, 'midiFixture.snapshot()')
      const start = scenario === 'resize-release' ? layout.aRightEdge : layout.a
      await page.mouse('move', start.x, start.y)
      await page.mouse('down')
      await page.mouse('move', start.x + layout.column * 2, start.y)
      const owned = await page.read(midiSnapshotSchema, 'midiFixture.snapshot()')
      const away = `{ clientX: ${layout.empty.x}, clientY: ${layout.b.y + 60} }`
      if (scenario === 'foreign-move') await page.evaluate(`midiFixture.pointer("pointermove", ${away})`)
      if (scenario === 'foreign-up') await page.evaluate(`midiFixture.pointer("pointerup", ${away})`)
      if (scenario === 'foreign-cancel') await page.evaluate(`midiFixture.pointer("pointercancel", ${away})`)
      if (scenario === 'foreign-down') await page.evaluate(`midiFixture.pointer("pointerdown", { clientX: ${layout.b.x}, clientY: ${layout.b.y} }, "b")`)
      if (scenario === 'foreign-draw') await page.evaluate(`midiFixture.pointer("pointerdown", { clientX: ${layout.empty.x}, clientY: ${layout.empty.y} }, "empty")`)
      if (scenario === 'capture-owned') gridOwnsPointer = await page.read(z.boolean(), 'midiFixture.gridOwnsPointer()')
      if (scenario === 'lost-capture') await page.evaluate('midiFixture.stealCapture()')
      if (scenario === 'escape') await page.press('Escape')
      const afterInterference = await page.read(midiSnapshotSchema, 'midiFixture.snapshot()')
      const continues = scenario.startsWith('foreign-') || scenario === 'lost-capture'
      if (continues) await page.mouse('move', start.x + layout.column * 3, start.y)
      const continued = await page.read(midiSnapshotSchema, 'midiFixture.snapshot()')
      await page.mouse('up')
      const released = await page.read(midiSnapshotSchema, 'midiFixture.snapshot()')
      await page.mouse('move', start.x + layout.column * 6, start.y + 40)
      const stray = await page.read(midiSnapshotSchema, 'midiFixture.snapshot()')
      results[scenario] = { initial, owned, afterInterference, continued, released, stray }
    }
  } finally {
    await Bun.write(`${page.directory}/results.json`, JSON.stringify({ ...results, gridOwnsPointer }, null, 2))
    console.log(`MIDI note evidence: ${page.directory}/results.json`)
    await page.close()
  }
  const scenario = (name: string) => midiRunSchema.parse(results[name])
  for (const name of ['move-release', 'resize-release', 'capture-owned']) {
    const run = scenario(name)
    expect(run.owned.notes[0]).not.toBe(run.initial.notes[0])
    expect(run.released.operations).toHaveLength(1)
    expect(run.released.operations[0]).toMatchObject({ kind: 'update', id: 'note:a' })
    expect(run.stray).toEqual(run.released)
  }
  expect(scenario('move-release').released.operations[0]).toMatchObject({ changes: { beat: 0.5, pitch: 100 } })
  expect(scenario('resize-release').released.operations[0]).toMatchObject({ changes: { length: 1 } })
  expect(gridOwnsPointer).toBe(true)
  for (const name of ['foreign-move', 'foreign-up', 'foreign-cancel', 'foreign-down', 'foreign-draw']) {
    const run = scenario(name)
    expect(run.afterInterference.notes).toEqual(run.owned.notes)
    expect(run.continued.notes[0]).not.toBe(run.owned.notes[0])
    expect(run.continued.notes[1]).toBe(run.initial.notes[1])
    expect(run.released.operations).toEqual([{ kind: 'update', id: 'note:a', changes: { beat: 0.75, pitch: 100 } }])
    expect(run.stray).toEqual(run.released)
  }
  for (const name of ['lost-capture', 'escape']) {
    const run = scenario(name)
    expect(run.continued.notes).toEqual(run.initial.notes)
    expect(run.released.operations).toEqual([])
    expect(run.stray).toEqual(run.released)
  }
}, 180_000)
