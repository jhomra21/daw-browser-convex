import tailwindcss from '@tailwindcss/vite'
import { expect, test } from 'bun:test'
import { mkdir } from 'node:fs/promises'
import { build } from 'vite'
import solidPlugin from 'vite-plugin-solid'
import { z } from 'zod'

// Chromium drives the real MIDI editor component. Projects, clips, and writes
// use the production IndexedDB repository and local-control persistence path.
const repositoryRoot = new URL('../../../', import.meta.url).pathname
const evidenceDirectory = `/tmp/daw-midi-editor-persistence-${crypto.randomUUID()}`
const retainedEvidenceDirectory = `${repositoryRoot}acceptance-reports/daw-experience-midi-persistence-2026-10-13`
const fixtureId = 'virtual:midi-persistence-fixture'
const localControlService = `${repositoryRoot}src/lib/local-control/local-control-service.ts`

const fixture = `
import { createComponent, createEffect, createRoot, createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import MidiClipEditor from '~/components/midi/MidiClipEditor'
import TimelineBottomPanelFooter from '~/components/timeline/TimelineBottomPanelFooter'
import TimelineBottomPanelShell from '~/components/timeline/TimelineBottomPanelShell'
import { createLocalProject } from '~/lib/local-project-db'
import { createLocalTimelineRepository } from '~/lib/timeline-repository/local-timeline-repository'
import { createMidiEditorPersistence, flushMidiProjectWrites } from '~/lib/midi/editor-persistence'
import { createTimelineKeyboardHandler } from '~/hooks/useTimelineKeyboard'
import { useTimelineHistory } from '~/hooks/useTimelineHistory'
import { buildClipMidiNotesHistoryEntry } from '~/lib/undo/builders'
import { createTimelineTrackIndex } from '@daw-browser/timeline-core/track-index'
import { useTimelineSampleDetailController } from '~/hooks/useTimelineSampleDetailController'
import '~/index.css'

window.midiKeyboardCalls = { delete: 0, space: 0 }
window.midiNotesEditCount = 0
window.addEventListener('keydown', createTimelineKeyboardHandler({
  enabled: () => true,
  onSpace: () => { window.midiKeyboardCalls.space += 1 },
  onDelete: () => { window.midiKeyboardCalls.delete += 1 },
  onDuplicate: () => {},
  onCopy: () => false,
  onPaste: () => false,
  onAddAudioTrack: () => {},
  onAddReturnTrack: () => {},
  onAddGroupTrack: () => {},
  onGroupSelectedTracks: () => {},
  onUngroupSelectedTrack: () => {},
  onAddInstrumentTrack: () => {},
  onOpenExport: () => {},
  executeExtensionShortcut: () => false,
  onUndo: () => history.handleUndo(),
  onRedo: () => history.handleRedo(),
}), true)

let dispose
let project
let clip
let currentClip
let setCurrentClip
let trackId
let repository
let view
let history
const [currentMidi, setCurrentMidi] = createSignal(undefined)
// Mirrors Timeline's store update: the card and history both read the clip's MIDI from here.
const actions = { commitClipMidi: (_clipId, midi) => setCurrentMidi(midi) }
// Resolves once the settle predicate accepts the clip MIDI that the history replay commits.
const settled = (change, settle) => new Promise((resolve) => {
  createRoot((disposeRoot) => {
    createEffect(() => {
      if (!settle(currentMidi())) return
      disposeRoot()
      resolve()
    })
  })
  change()
})
const mount = async () => {
  view?.dispose()
  document.body.replaceChildren()
  const snapshot = await repository.loadSnapshot()
  const midi = snapshot.clips.find((entry) => entry.id === clip.id)?.midi
  if (!midi) throw new Error('Expected the persisted MIDI clip.')
  setCurrentMidi(midi)
  setCurrentClip({ ...clip })
  // A focusable control outside the editor, so a test can start with focus elsewhere.
  const outside = document.createElement('button')
  outside.dataset.acceptanceOutside = '1'
  outside.textContent = 'Outside focus'
  const host = document.createElement('div')
  // The transform makes the shell's fixed positioning relative to this host, so the panel stays inside the viewport.
  host.style.cssText = 'position:relative;width:800px;height:640px;transform:translateZ(0)'
  document.body.append(outside, host)
  // Mounted the way the bottom panel's Clip tab mounts it: shell, footer, then the editor body.
  dispose = render(() => createComponent(TimelineBottomPanelShell, {
    // Tall enough that the velocity lane still leaves grid row 18 inside the scrolled-to-top body.
    controls: { heightPx: 600, onHeightPreview: () => {}, onHeightCommit: () => {} },
    resizeLabel: 'Resize MIDI clip panel',
    footer: createComponent(TimelineBottomPanelFooter, {
      activeTab: 'clip',
      toggleLabel: 'Hide',
      onEffectsTabClick: () => {},
      onToggle: () => {},
    }),
    get children() {
      return createComponent(MidiClipEditor, {
        get clipId() { return currentClip().id },
        get clipName() { return currentClip().name },
        bpm: 120,
        gridDenominator: 4,
        clipDurationSec: 4,
        get midi() { return currentMidi() },
        canWrite: true,
        projectId: project.id,
        midiKeyboard: { isActive: () => false },
        onLocalMidiSaved: (_clipId, saved) => setCurrentMidi(saved),
        onNotesEdited: (clipId, from, to) => {
          window.midiNotesEditCount += 1
          const entry = buildClipMidiNotesHistoryEntry({ projectId: project.id, clip: { id: clipId }, from, to })
          if (entry) history.pushHistory(entry)
        },
      })
    },
  }), host)
  view = { dispose }
}
window.midiFixture = {
  setup: async () => {
    project = await createLocalProject('Disposable MIDI persistence acceptance')
    repository = createLocalTimelineRepository(project.id)
    const track = await repository.createTrack({ kind: 'instrument', name: 'MIDI acceptance' })
    trackId = track.id
    clip = await repository.createClip({
      trackId: track.id,
      name: 'Persistence check',
      startSec: 0,
      duration: 4,
      midi: { wave: 'sine', notes: [] },
    })
    const [clipValue, setClipValue] = createSignal(clip)
    currentClip = clipValue
    setCurrentClip = setClipValue
    createRoot(() => {
      history = useTimelineHistory({
        projectId: () => project.id,
        userId: () => 'local',
        getTracks: () => [{ id: trackId, clips: [{ id: clip.id, midi: currentMidi() }] }],
        convexClient: {},
        convexApi: {},
        grantTrackWrite: () => {},
        grantClipWrite: () => {},
        persistLocalMix: () => {},
        getActions: () => actions,
      })
    })
    await mount()
    return { projectId: project.id, clipId: clip.id, trackId: track.id }
  },
  undo: (settle) => settled(() => history.handleUndo(), settle),
  redo: (settle) => settled(() => history.handleRedo(), settle),
  gridPoint: (column, row) => {
    const grid = document.querySelector('.absolute.inset-0.grid > .relative')
    if (!(grid instanceof HTMLElement)) throw new Error('MIDI note grid was not mounted.')
    const rect = grid.getBoundingClientRect()
    return {
      x: rect.left + rect.width * (column + 0.5) / 8,
      y: rect.top + row * 20 + 10,
    }
  },
  flush: async () => {
    await flushMidiProjectWrites(project.id)
    return (await repository.loadSnapshot()).clips.find((entry) => entry.id === clip.id)?.midi
  },
  keyboardCalls: () => window.midiKeyboardCalls,
  // Top of a velocity marker, 3px below its stem top, which is inside the marker's hit box.
  velocityPoint: (index) => {
    const marker = document.querySelectorAll('[data-midi-velocity="1"]')[index]
    if (!(marker instanceof HTMLElement)) throw new Error('Velocity marker was not mounted.')
    const rect = marker.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + 3 }
  },
  // A marker's head is centered on the marker's top edge, so a hit means elementFromPoint lands on that marker.
  velocityHeadsHit: () => [...document.querySelectorAll('[data-midi-velocity="1"]')].map((marker) => {
    const rect = marker.getBoundingClientRect()
    return document.elementFromPoint(rect.left + rect.width / 2, rect.top)?.closest('[data-midi-velocity="1"]') === marker
  }),
  velocityHeadsInsideLane: () => [...document.querySelectorAll('[data-midi-velocity="1"]')].every((marker) => {
    const head = marker.getBoundingClientRect()
    const lane = marker.parentElement?.parentElement?.getBoundingClientRect()
    return lane !== undefined && head.top - 5 >= lane.top && head.top + 5 <= lane.bottom
  }),
  writeCounts: () => ({ commits: window.midiCommitAttempts ?? 0, edits: window.midiNotesEditCount }),
  noteOpacities: () => [...document.querySelectorAll('[data-midi-note="1"]')].map((note) => Number(getComputedStyle(note).opacity)),
  clipLabel: () => [...document.querySelectorAll('span')].find((span) => span.textContent?.startsWith('Clip:'))?.textContent ?? null,
  // Drives the real bottom-panel controller over one MIDI clip and one audio clip. Effects are created when the root
  // returns, so the steps run after createRoot.
  routing: () => {
    const midiClip = { id: clip.id, trackId, name: 'Persistence check', startSec: 0, duration: 4, midi: { wave: 'sine', notes: [] } }
    const audioClip = { id: 'routing-audio', trackId, name: 'Audio check', startSec: 0, duration: 1, sampleUrl: 'routing.wav' }
    const trackLookup = createTimelineTrackIndex([{ id: trackId, clips: [midiClip, audioClip] }])
    const [selected, setSelected] = createSignal(undefined)
    const [mode, setMode] = createSignal('effects')
    const [open, setOpen] = createSignal(false)
    let controller
    let disposeRouting
    createRoot((dispose) => {
      disposeRouting = dispose
      controller = useTimelineSampleDetailController({
        projectId: () => project.id,
        userId: () => 'local',
        mode,
        setMode,
        open,
        setOpen,
        trackLookup: () => trackLookup,
        selection: {
          selectedClip: selected,
          selectPrimaryClip: ({ trackId: nextTrackId, clipId }) => setSelected({ trackId: nextTrackId, clipId }),
        },
        canWriteClip: () => true,
        projection: { commitClipGain: () => {} },
        audioWarpController: { changeAudioWarp: () => {} },
        rescheduleChangedClips: () => {},
        pushHistory: () => {},
      })
    })
    const escape = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    const snapshot = () => ({
      mode: mode(),
      open: open(),
      audio: controller.selectedAudioClip()?.id ?? null,
      midi: controller.selectedMidiClip()?.id ?? null,
    })
    controller.openClipDetail(audioClip.id)
    const audioRouted = snapshot()
    controller.openClipDetail(midiClip.id)
    const midiRouted = snapshot()
    controller.openClipDetail('missing-clip')
    const unknownIgnored = snapshot()
    controller.setMarkerDragging(true)
    escape()
    const escapeWhileNoteDragging = snapshot()
    controller.setMarkerDragging(false)
    escape()
    const escapeWhenIdle = snapshot()
    controller.openClipDetail(midiClip.id)
    setSelected(undefined)
    const clearedSelection = snapshot()
    disposeRouting()
    return { audioRouted, midiRouted, unknownIgnored, escapeWhileNoteDragging, escapeWhenIdle, clearedSelection }
  },
  failNextCommit: () => { window.midiCommitFailures = 2 },
  // A collaborator's note, written through its own adapter. The open editor's MIDI never sees it, so undo must keep it.
  collaboratorInsert: async () => {
    const adapter = createMidiEditorPersistence({ projectId: project.id, clipId: clip.id })
    try {
      adapter.enqueue({ kind: 'insert', note: { id: 'collaborator-note', beat: 3, length: 1, pitch: 70, velocity: 0.5, channel: 1 } })
      await adapter.flush()
    } finally {
      adapter.dispose()
    }
    return { ok: true }
  },
  // Redo with two injected write failures. The second wait is the window where a background retry would show up.
  failedRedo: async () => {
    window.midiCommitFailures = 2
    const before = window.midiCommitAttempts ?? 0
    history.handleRedo()
    await new Promise((resolve) => setTimeout(resolve, 300))
    const attempts = (window.midiCommitAttempts ?? 0) - before
    await new Promise((resolve) => setTimeout(resolve, 300))
    return { attempts, attemptsLater: (window.midiCommitAttempts ?? 0) - before }
  },
  editorState: () => ({
    noteCount: document.querySelectorAll('[data-midi-note="1"]').length,
    selectedNoteCount: document.querySelectorAll('[data-midi-note="1"][aria-selected="true"]').length,
    retryVisible: [...document.querySelectorAll('button')].some((button) => button.textContent?.includes('MIDI save failed — Retry')),
  }),
  pointerSelectNote: (index, modifiers = {}) => {
    const note = document.querySelectorAll('[data-midi-note="1"]')[index]
    if (!(note instanceof HTMLElement)) throw new Error('MIDI note was not mounted.')
    const rect = note.getBoundingClientRect()
    const options = {
      bubbles: true, button: 0, clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2, pointerId: 1, ...modifiers,
    }
    note.dispatchEvent(new PointerEvent('pointerdown', options))
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }))
  },
  requestLocalDuplicate: () => {
    document.querySelector('[data-timeline-keyboard-local="true"]')?.dispatchEvent(new Event('timeline-local-duplicate'))
  },
  pressDuplicateKey: () => {
    const root = document.querySelector('[data-timeline-keyboard-local="true"]')
    if (!(root instanceof HTMLElement)) throw new Error('MIDI editor root was not mounted.')
    const event = new KeyboardEvent('keydown', { key: 'd', ctrlKey: true, bubbles: true, cancelable: true })
    root.dispatchEvent(event)
    return { prevented: event.defaultPrevented }
  },
  selectedNoteIds: () => [...document.querySelectorAll('[data-midi-note-id][aria-selected="true"]')]
    .map((element) => element.getAttribute('data-midi-note-id')).filter(Boolean),
  replaceClipObject: () => setCurrentClip({ ...currentClip(), midi: currentMidi() }),
  duplicateEnabled: () => document.querySelector('[data-timeline-keyboard-local="true"]')
    ?.getAttribute('data-timeline-keyboard-duplicate-enabled') ?? null,
  reload: mount,
  read: async () => {
    const midi = (await repository.loadSnapshot()).clips.find((entry) => entry.id === clip.id)?.midi
    if (!midi) throw new Error('The MIDI clip disappeared from IndexedDB.')
    return midi
  },
  close: () => { view?.dispose(); view = undefined },
}
`

const buildFixture = async () => {
  const output = await build({
    root: repositoryRoot,
    configFile: false,
    logLevel: 'silent',
    plugins: [solidPlugin(), tailwindcss(), {
      name: 'midi-persistence-fixture',
      enforce: 'pre',
      resolveId: (id) => id.endsWith(fixtureId) ? `\0${fixtureId}.tsx`
        : id.includes('/lib/convex') || id === '~/lib/convex' ? '\0stub:convex.ts'
          : id.includes('/lib/local-control/local-control-service') && !id.endsWith('?real') ? '\0stub:local-control-service.ts'
          : undefined,
      load: (id) => {
        if (id === `\0${fixtureId}.tsx`) return fixture
        if (id === '\0stub:convex.ts') return 'export const convexApi = {}; export const convexClient = {}'
        if (id === '\0stub:local-control-service.ts') return `
          import { createLocalControlService as createActual } from '${localControlService}?real'
          export { LocalControlServiceError } from '${localControlService}?real'
          export const createLocalControlService = (input) => {
            const service = createActual(input)
            return {
              ...service,
              commit: async (...args) => {
                window.midiCommitAttempts = (window.midiCommitAttempts ?? 0) + 1
                if (window.midiCommitFailures > 0) {
                  window.midiCommitFailures -= 1
                  throw new Error('Acceptance-injected local MIDI write failure.')
                }
                return service.commit(...args)
              },
            }
          }
        `
        return undefined
      },
    }],
    resolve: { alias: { '~': `${repositoryRoot}src` } },
    build: { write: false, minify: false, lib: { entry: fixtureId, formats: ['iife'], name: 'midiPersistenceFixture' } },
  })
  const bundle = Array.isArray(output) ? output[0] : output
  if (!bundle || !('output' in bundle)) throw new Error('Expected a single MIDI fixture bundle.')
  const styles = bundle.output.flatMap((chunk) => (
    chunk.type === 'asset' && chunk.fileName.endsWith('.css') ? [String(chunk.source)] : []
  ))
  return `<!doctype html><head><meta charset="utf-8"><style>${styles.join('\n')}</style></head><body style="margin:0"><script>${bundle.output[0].code}</script>`
}

const pointSchema = z.object({ x: z.number(), y: z.number() })
const midiSchema = z.object({
  notes: z.array(z.object({
    id: z.string(),
    beat: z.number(),
    length: z.number(),
    pitch: z.number(),
    velocity: z.number().optional(),
    channel: z.number().optional(),
  })),
})
const editorStateSchema = z.object({ noteCount: z.number(), selectedNoteCount: z.number(), retryVisible: z.boolean() })
const panelSchema = z.object({ mode: z.string(), open: z.boolean(), audio: z.string().nullable(), midi: z.string().nullable() })
const routingSchema = z.object({
  audioRouted: panelSchema,
  midiRouted: panelSchema,
  unknownIgnored: panelSchema,
  escapeWhileNoteDragging: panelSchema,
  escapeWhenIdle: panelSchema,
  clearedSelection: panelSchema,
})
const failedReplaySchema = z.object({ attempts: z.number(), attemptsLater: z.number() })
const keyboardCallsSchema = z.object({ delete: z.number(), space: z.number() })
const writeCountsSchema = z.object({ commits: z.number(), edits: z.number() })
const headsSchema = z.array(z.boolean())
const boolSchema = z.boolean()
const nullableStringSchema = z.string().nullable()
const opacitySchema = z.array(z.number())
const labelSchema = z.string().nullable()
const okSchema = z.object({ ok: z.literal(true) })

test('MIDI editor pointer-created notes persist in local IndexedDB and survive remount', async () => {
  const directory = `${evidenceDirectory}/midi-persistence`
  await mkdir(directory, { recursive: true })
  await mkdir(retainedEvidenceDirectory, { recursive: true })
  await Bun.write(`${directory}/index.html`, await buildFixture())
  const session = `midi-persistence-${crypto.randomUUID()}`
  const env = { ...process.env }
  delete env.AGENT_BROWSER_CDP
  delete env.AGENT_BROWSER_SESSION
  const run = async (...args: string[]) => {
    const child = Bun.spawn(['agent-browser', '--session', session, ...args], { env, stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
    if (await child.exited !== 0) throw new Error(stderr || stdout)
    return stdout.trim()
  }
  const read = async <Schema extends z.ZodType>(schema: Schema, expression: string): Promise<z.infer<Schema>> => (
    schema.parse(JSON.parse(await run('eval', `(async () => JSON.stringify(await ${expression}))()`).then(JSON.parse)))
  )
  await run('open', `file://${directory}/index.html`)
  // Tall enough for the host, the bottom panel, and the full velocity lane including a 127 head.
  await run('set', 'viewport', '1000', '760')
  let identity: { projectId: string; clipId: string; trackId: string } | undefined
  let persisted: z.infer<typeof midiSchema> | undefined
  let reloaded: z.infer<typeof midiSchema> | undefined
  let beforeRetry: z.infer<typeof editorStateSchema> | undefined
  let retrySucceeded: z.infer<typeof midiSchema> | undefined
  let created: z.infer<typeof midiSchema> | undefined
  let undone: z.infer<typeof midiSchema> | undefined
  let undoneVisible: z.infer<typeof editorStateSchema> | undefined
  let redone: z.infer<typeof midiSchema> | undefined
  let redoneVisible: z.infer<typeof editorStateSchema> | undefined
  let moved: z.infer<typeof midiSchema> | undefined
  let movedBack: z.infer<typeof midiSchema> | undefined
  let noteClickKeys: z.infer<typeof keyboardCallsSchema> | undefined
  let gutterBefore: z.infer<typeof keyboardCallsSchema> | undefined
  let gutterAfter: z.infer<typeof keyboardCallsSchema> | undefined
  let gutterNotes: z.infer<typeof midiSchema> | undefined
  let spaceKeys: z.infer<typeof keyboardCallsSchema> | undefined
  let headerBefore: z.infer<typeof keyboardCallsSchema> | undefined
  let headerAfter: z.infer<typeof keyboardCallsSchema> | undefined
  let routing: z.infer<typeof routingSchema> | undefined
  let clipLabel: string | null | undefined
  let velocityBefore: z.infer<typeof midiSchema> | undefined
  let velocityDragged: z.infer<typeof midiSchema> | undefined
  let velocityOpacities: number[] | undefined
  let velocityUndone: z.infer<typeof midiSchema> | undefined
  let velocityEscaped: z.infer<typeof midiSchema> | undefined
  let noOpBefore: z.infer<typeof writeCountsSchema> | undefined
  let noOpAfter: z.infer<typeof writeCountsSchema> | undefined
  let chordEdited: z.infer<typeof midiSchema> | undefined
  let chordHeads: boolean[] | undefined
  let chordInside: boolean | undefined
  let selectedBeforeDelete: z.infer<typeof editorStateSchema> | undefined
  let deletedSelection: z.infer<typeof midiSchema> | undefined
  let restoredSelection: z.infer<typeof midiSchema> | undefined
  let deletedAgain: z.infer<typeof midiSchema> | undefined
  let duplicated: z.infer<typeof midiSchema> | undefined
  let duplicateSelectedIds: string[] | undefined
  let duplicateUndo: z.infer<typeof midiSchema> | undefined
  let duplicateRedo: z.infer<typeof midiSchema> | undefined
  let duplicateKey: { prevented: boolean } | undefined
  let failedRedo: z.infer<typeof failedReplaySchema> | undefined
  let afterFailedRedo: z.infer<typeof midiSchema> | undefined
  let redoAfterFailure: z.infer<typeof midiSchema> | undefined
  const trace: { step: string; detail: string }[] = []
  try {
    identity = await read(z.object({ projectId: z.string(), clipId: z.string(), trackId: z.string() }), 'midiFixture.setup()')
    trace.push({ step: 'fixture-created', detail: 'Production local project, instrument track, and empty MIDI clip created.' })
    routing = await read(routingSchema, 'midiFixture.routing()')
    trace.push({ step: 'clip-routing', detail: `Real bottom-panel controller routing: ${JSON.stringify(routing)}.` })
    const first = await read(pointSchema, 'midiFixture.gridPoint(1, 18)')
    await run('mouse', 'move', String(Math.round(first.x)), String(Math.round(first.y)))
    await run('mouse', 'down')
    await run('mouse', 'up')
    trace.push({ step: 'pointer-insert', detail: 'Chromium mouse click inserted the first MIDI note.' })

    await read(z.object({ ok: z.literal(true) }), '(async () => { midiFixture.failNextCommit(); return { ok: true } })()')
    trace.push({ step: 'failure-armed', detail: 'Next local-control write and its automatic retry were set to reject by the test-only wrapper.' })
    const second = await read(pointSchema, 'midiFixture.gridPoint(5, 14)')
    await run('mouse', 'move', String(Math.round(second.x)), String(Math.round(second.y)))
    await run('mouse', 'down')
    await run('mouse', 'up')
    trace.push({ step: 'pointer-insert-with-failure', detail: 'Chromium mouse click inserted second MIDI note while persistence was armed to fail.' })

    beforeRetry = await read(editorStateSchema, '(async () => { try { await midiFixture.flush() } catch {} return midiFixture.editorState() })()')
    if (!beforeRetry.retryVisible) throw new Error('Expected the production MIDI retry affordance after the injected write failure.')
    trace.push({ step: 'failure-visible', detail: 'Real editor retained both projected notes and displayed its retry affordance.' })
    await run('click', 'button[title*="Acceptance-injected local MIDI write failure"]')
    retrySucceeded = await read(midiSchema, 'midiFixture.flush()')
    persisted = retrySucceeded
    trace.push({ step: 'retry-succeeded', detail: 'Real retry button clicked; subsequent production local-control flush persisted both notes.' })
    await read(z.object({ ok: z.literal(true) }), '(async () => { await midiFixture.reload(); return { ok: true } })()')
    reloaded = await read(midiSchema, 'midiFixture.read()')
    trace.push({ step: 'editor-remounted', detail: 'Real editor remounted from newly loaded production IndexedDB repository snapshot.' })
    const moveTo = async (column: number, row: number) => {
      const point = await read(pointSchema, `midiFixture.gridPoint(${column}, ${row})`)
      await run('mouse', 'move', String(Math.round(point.x)), String(Math.round(point.y)))
    }
    await moveTo(3, 2)
    await run('mouse', 'down')
    await run('mouse', 'up')
    created = await read(midiSchema, 'midiFixture.flush()')
    trace.push({ step: 'history-create', detail: 'Pointer insert of a third note committed and pushed one clip-midi-notes history entry.' })

    await read(okSchema, 'midiFixture.undo((midi) => midi.notes.length === 2).then(() => ({ ok: true }))')
    undone = await read(midiSchema, 'midiFixture.read()')
    undoneVisible = await read(editorStateSchema, 'midiFixture.editorState()')
    trace.push({ step: 'undo-create', detail: 'Undo ran through useTimelineHistory; the replayed notes reached IndexedDB and the open card.' })

    await read(okSchema, 'midiFixture.redo((midi) => midi.notes.length === 3).then(() => ({ ok: true }))')
    redone = await read(midiSchema, 'midiFixture.read()')
    redoneVisible = await read(editorStateSchema, 'midiFixture.editorState()')
    trace.push({ step: 'redo-create', detail: 'Redo re-applied the third note to IndexedDB and the open card.' })

    await moveTo(1, 18)
    await run('mouse', 'down')
    await moveTo(2, 18)
    await run('mouse', 'up')
    moved = await read(midiSchema, 'midiFixture.flush()')
    await read(okSchema, 'midiFixture.undo((midi) => midi.notes.some((note) => note.pitch === 90 && note.beat === 1)).then(() => ({ ok: true }))')
    movedBack = await read(midiSchema, 'midiFixture.read()')
    trace.push({ step: 'move-undo', detail: 'Pointer move committed beat 2, then undo restored beat 1 in IndexedDB.' })

    // Dragging a note out and back to its start is a no-op: no local-control write and no history entry.
    await read(midiSchema, 'midiFixture.flush()')
    noOpBefore = await read(writeCountsSchema, 'midiFixture.writeCounts()')
    await moveTo(1, 18)
    await run('mouse', 'down')
    await moveTo(3, 18)
    await moveTo(1, 18)
    await run('mouse', 'up')
    noOpAfter = await read(writeCountsSchema, '(async () => { await midiFixture.flush(); return midiFixture.writeCounts() })()')
    trace.push({ step: 'no-op-drag', detail: `Drag out and back to the start: write counts ${JSON.stringify(noOpBefore)} -> ${JSON.stringify(noOpAfter)}.` })

    // Focus starts on an outside button, so only a note click can move focus into the editor before Delete.
    // A note click focuses the editor root, so Delete stays inside the editor and never reaches clip delete.
    await run('click', 'button[data-acceptance-outside="1"]')
    await moveTo(1, 18)
    await run('mouse', 'down')
    await run('mouse', 'up')
    await run('press', 'Delete')
    noteClickKeys = await read(keyboardCallsSchema, 'midiFixture.keyboardCalls()')

    gutterBefore = await read(keyboardCallsSchema, 'midiFixture.keyboardCalls()')
    await run('click', 'button[aria-label^="Audition"]')
    await run('press', 'Delete')
    gutterAfter = await read(keyboardCallsSchema, 'midiFixture.keyboardCalls()')
    gutterNotes = await read(midiSchema, 'midiFixture.read()')
    await run('eval', 'document.activeElement?.blur()')
    await run('press', 'Space')
    spaceKeys = await read(keyboardCallsSchema, 'midiFixture.keyboardCalls()')
    trace.push({ step: 'delete-keys', detail: `Note click + Delete counters: ${JSON.stringify(noteClickKeys)}. Gutter focus + Delete: before ${JSON.stringify(gutterBefore)}, after ${JSON.stringify(gutterAfter)}. Body-focused Space after: ${JSON.stringify(spaceKeys)}.` })

    // A header click focuses the editor root, so Delete after it stays in the editor and never reaches clip delete.
    const header = await read(pointSchema, '(() => { const root = document.querySelector(\'[data-timeline-keyboard-local="true"]\'); const rect = root?.firstElementChild?.getBoundingClientRect(); if (!rect) throw new Error("MIDI editor header missing"); return { x: rect.right - 24, y: rect.top + rect.height / 2 } })()')
    await run('mouse', 'move', String(Math.round(header.x)), String(Math.round(header.y)))
    await run('mouse', 'down')
    await run('mouse', 'up')
    headerBefore = await read(keyboardCallsSchema, 'midiFixture.keyboardCalls()')
    await run('press', 'Delete')
    headerAfter = await read(keyboardCallsSchema, 'midiFixture.keyboardCalls()')
    trace.push({ step: 'header-delete', detail: `Header click + Delete counters: before ${JSON.stringify(headerBefore)}, after ${JSON.stringify(headerAfter)}.` })

    clipLabel = await read(labelSchema, 'midiFixture.clipLabel()')
    velocityBefore = await read(midiSchema, 'midiFixture.flush()')
    // Drag the first marker 36px down, which is about 0.63 of the 57px marker area. 0.9 - 0.63 is about 27%.
    const firstLane = await read(pointSchema, 'midiFixture.velocityPoint(0)')
    await run('mouse', 'move', String(Math.round(firstLane.x)), String(Math.round(firstLane.y)))
    await run('mouse', 'down')
    await run('mouse', 'move', String(Math.round(firstLane.x)), String(Math.round(firstLane.y + 36)))
    await run('mouse', 'up')
    velocityDragged = await read(midiSchema, 'midiFixture.flush()')
    velocityOpacities = await read(opacitySchema, 'midiFixture.noteOpacities()')
    trace.push({ step: 'velocity-drag', detail: `Marker 0 dragged 36px down. Persisted velocities: ${JSON.stringify(velocityDragged.notes.map((note) => note.velocity))}. Note opacities: ${JSON.stringify(velocityOpacities)}. Header: ${clipLabel}.` })

    // A collaborator adds a note after the edit. Undoing the velocity must leave it untouched.
    await read(okSchema, 'midiFixture.collaboratorInsert()')
    await read(okSchema, 'midiFixture.undo((midi) => midi.notes.every((note) => note.id === "collaborator-note" || note.velocity === 0.9)).then(() => ({ ok: true }))')
    velocityUndone = await read(midiSchema, 'midiFixture.read()')
    trace.push({ step: 'velocity-undo', detail: `Undo restored velocities: ${JSON.stringify(velocityUndone.notes.map((note) => note.velocity))}.` })

    // Escape during a marker drag abandons the draft, so nothing persists.
    const escapeLane = await read(pointSchema, 'midiFixture.velocityPoint(1)')
    await run('mouse', 'move', String(Math.round(escapeLane.x)), String(Math.round(escapeLane.y)))
    await run('mouse', 'down')
    await run('mouse', 'move', String(Math.round(escapeLane.x)), String(Math.round(escapeLane.y + 40)))
    await run('press', 'Escape')
    await run('mouse', 'up')
    velocityEscaped = await read(midiSchema, 'midiFixture.flush()')
    trace.push({ step: 'velocity-escape', detail: `Escape during a second marker drag left velocities at ${JSON.stringify(velocityEscaped.notes.map((note) => note.velocity))}.` })

    // Redo with injected write failures: no background retry lands, the redo entry survives, and a later redo applies it.
    failedRedo = await read(failedReplaySchema, 'midiFixture.failedRedo()')
    afterFailedRedo = await read(midiSchema, 'midiFixture.read()')
    trace.push({ step: 'failed-redo', detail: `Redo with two injected write failures made ${failedRedo.attempts} commit attempts, ${failedRedo.attemptsLater} after the wait. Velocities after: ${JSON.stringify(afterFailedRedo.notes.map((note) => note.velocity))}.` })
    await read(okSchema, 'midiFixture.redo((midi) => midi.notes.some((note) => note.velocity !== undefined && note.velocity < 0.5)).then(() => ({ ok: true }))')
    redoAfterFailure = await read(midiSchema, 'midiFixture.read()')
    trace.push({ step: 'redo-after-failure', detail: `Next redo applied the velocity edit: ${JSON.stringify(redoAfterFailure.notes.map((note) => note.velocity))}.` })

    // Chord: two notes at one start. Raising the later note to 127 puts its tall stem over the earlier head in DOM order,
    // so the earlier head must still be grabbable. Both heads land about 40px apart, so each center is clearly hittable.
    const chordStart = (await read(midiSchema, 'midiFixture.flush()')).notes.length
    for (const row of [8, 12]) {
      await moveTo(6, row)
      await run('mouse', 'down')
      await run('mouse', 'up')
    }
    const laterLane = await read(pointSchema, `midiFixture.velocityPoint(${chordStart + 1})`)
    await run('mouse', 'move', String(Math.round(laterLane.x)), String(Math.round(laterLane.y)))
    await run('mouse', 'down')
    await run('mouse', 'move', String(Math.round(laterLane.x)), String(Math.round(laterLane.y - 60)))
    await run('mouse', 'up')
    const earlierLane = await read(pointSchema, `midiFixture.velocityPoint(${chordStart})`)
    await run('mouse', 'move', String(Math.round(earlierLane.x)), String(Math.round(earlierLane.y)))
    await run('mouse', 'down')
    await run('mouse', 'move', String(Math.round(earlierLane.x)), String(Math.round(earlierLane.y + 36)))
    await run('mouse', 'up')
    chordEdited = await read(midiSchema, 'midiFixture.flush()')
    chordHeads = await read(headsSchema, 'midiFixture.velocityHeadsHit()')
    chordInside = await read(boolSchema, 'midiFixture.velocityHeadsInsideLane()')
    trace.push({ step: 'chord-heads', detail: `Chord velocities ${JSON.stringify(chordEdited.notes.slice(-2).map((note) => note.velocity))}. Head hits: ${JSON.stringify(chordHeads)}. Heads inside lane: ${chordInside}.` })
    const noSelectionCount = (await read(midiSchema, 'midiFixture.flush()')).notes.length
    const duplicateDisabled = await read(nullableStringSchema, 'midiFixture.duplicateEnabled()')
    expect(duplicateDisabled).toBe('false')
    await read(okSchema, '(async () => { midiFixture.requestLocalDuplicate(); return { ok: true } })()')
    expect((await read(midiSchema, 'midiFixture.flush()')).notes).toHaveLength(noSelectionCount)
    await read(okSchema, '(async () => { midiFixture.pointerSelectNote(2); midiFixture.pointerSelectNote(3, { metaKey: true }); return { ok: true } })()')
    expect(await read(nullableStringSchema, 'midiFixture.duplicateEnabled()')).toBe('true')
    await read(okSchema, '(async () => { midiFixture.requestLocalDuplicate(); return { ok: true } })()')
    const menuDuplicate = await read(midiSchema, 'midiFixture.flush()')
    expect(menuDuplicate.notes).toHaveLength(6)
    await read(okSchema, 'midiFixture.undo((midi) => midi.notes.length === 5).then(() => ({ ok: true }))')
    const menuDuplicateUndo = await read(midiSchema, 'midiFixture.read()')
    expect(menuDuplicateUndo.notes).toHaveLength(5)
    await read(okSchema, '(async () => { midiFixture.pointerSelectNote(2); midiFixture.pointerSelectNote(3, { metaKey: true }); return { ok: true } })()')
    const selectionBeforeKey = await read(z.array(z.string()), 'midiFixture.selectedNoteIds()')
    duplicateKey = await read(z.object({ prevented: z.boolean() }), 'midiFixture.pressDuplicateKey()')
    duplicated = await read(midiSchema, 'midiFixture.flush()')
    duplicateSelectedIds = await read(z.array(z.string()), 'midiFixture.selectedNoteIds()')
    await read(okSchema, '(async () => { midiFixture.replaceClipObject(); return { ok: true } })()')
    const selectedAfterClipReplacement = await read(z.array(z.string()), 'midiFixture.selectedNoteIds()')
    expect(selectedAfterClipReplacement).toEqual(duplicateSelectedIds)
    await read(okSchema, '(async () => { await midiFixture.reload(); return { ok: true } })()')
    trace.push({ step: 'duplicate-selected-notes', detail: `Ctrl+D duplicated ${selectionBeforeKey.length} selected notes; ${duplicated.notes.length} persisted notes, ${duplicateSelectedIds.length} selected copies, key prevented ${duplicateKey.prevented}.` })
    await read(okSchema, 'midiFixture.undo((midi) => midi.notes.length === 5).then(() => ({ ok: true }))')
    duplicateUndo = await read(midiSchema, 'midiFixture.read()')
    await read(okSchema, 'midiFixture.redo((midi) => midi.notes.length === 6).then(() => ({ ok: true }))')
    duplicateRedo = await read(midiSchema, 'midiFixture.read()')
    await read(okSchema, '(async () => { midiFixture.pointerSelectNote(3); midiFixture.pointerSelectNote(4, { metaKey: true }); return { ok: true } })()')
    selectedBeforeDelete = await read(editorStateSchema, 'midiFixture.editorState()')
    await run('press', 'Delete')
    deletedSelection = await read(midiSchema, 'midiFixture.flush()')
    await read(okSchema, 'midiFixture.undo((midi) => midi.notes.length === 6).then(() => ({ ok: true }))')
    restoredSelection = await read(midiSchema, 'midiFixture.read()')
    await read(okSchema, 'midiFixture.redo((midi) => midi.notes.length === 4).then(() => ({ ok: true }))')
    deletedAgain = await read(midiSchema, 'midiFixture.read()')
    trace.push({ step: 'multi-note-delete', detail: `Selected ${selectedBeforeDelete.selectedNoteCount} notes; Delete left ${deletedSelection.notes.length}; undo restored ${restoredSelection.notes.length}; redo left ${deletedAgain.notes.length}.` })
    await run('screenshot', `${repositoryRoot}acceptance-reports/daw-experience-midi-velocity-2026-10-15.png`)

    await run('screenshot', `${retainedEvidenceDirectory}/midi-editor.png`)
    await run('screenshot', `${repositoryRoot}acceptance-reports/daw-experience-midi-docked-2026-10-15.png`)
  } finally {
    const result = {
      identity,
      beforeRetry,
      retrySucceeded,
      persisted,
      reloaded,
      history: { created, undone, undoneVisible, redone, redoneVisible, moved, movedBack },
      keyboard: { noteClickKeys, gutterBefore, gutterAfter, spaceKeys },
      velocity: { clipLabel, before: velocityBefore, dragged: velocityDragged, opacities: velocityOpacities, undone: velocityUndone, escaped: velocityEscaped },
      noOpDrag: { before: noOpBefore, after: noOpAfter },
      chord: { edited: chordEdited, heads: chordHeads, inside: chordInside },
      noteSelection: { selectedBeforeDelete, deletedSelection, restoredSelection, deletedAgain },
      duplicate: { duplicated, selectedIds: duplicateSelectedIds, undo: duplicateUndo, redo: duplicateRedo, key: duplicateKey },
      routing,
      failedReplay: { failedRedo, afterFailedRedo, redoAfterFailure },
      trace,
    }
    await Bun.write(`${directory}/journey.json`, JSON.stringify(result, null, 2))
    await Bun.write(`${retainedEvidenceDirectory}/journey.json`, JSON.stringify(result, null, 2))
    await run('eval', 'midiFixture.close()').catch(() => '')
    await run('close').catch(() => '')
  }
  expect(persisted?.notes).toHaveLength(2)
  expect(beforeRetry).toEqual({ noteCount: 2, selectedNoteCount: 0, retryVisible: true })
  expect(reloaded?.notes).toEqual(persisted?.notes)
  expect(persisted?.notes.map(({ beat, pitch, length, velocity, channel }) => ({ beat, pitch, length, velocity, channel })))
    .toEqual([
      { beat: 1, pitch: 90, length: 1, velocity: 0.9, channel: 1 },
      { beat: 5, pitch: 94, length: 1, velocity: 0.9, channel: 1 },
    ])
  expect(created?.notes).toHaveLength(3)
  expect(undone?.notes).toHaveLength(2)
  expect(undone?.notes.some((note) => note.beat === 3)).toBe(false)
  expect(undoneVisible?.noteCount).toBe(2)
  expect(redone?.notes).toHaveLength(3)
  expect(redoneVisible?.noteCount).toBe(3)
  expect(moved?.notes).toHaveLength(3)
  expect(moved?.notes.find((note) => note.pitch === 90)?.beat).toBe(2)
  expect(movedBack?.notes).toHaveLength(3)
  expect(movedBack?.notes.find((note) => note.pitch === 90)?.beat).toBe(1)
  expect(noteClickKeys?.delete).toBe(0)
  expect(gutterAfter?.delete).toBe(gutterBefore?.delete)
  expect(gutterNotes?.notes).toHaveLength(3)
  expect(spaceKeys?.space).toBe((gutterAfter?.space ?? 0) + 1)
  expect(headerAfter?.delete).toBe(headerBefore?.delete)
  expect(clipLabel).toBe('Clip: Persistence check')
  expect(velocityBefore?.notes.every((note) => note.velocity === 0.9)).toBe(true)
  const draggedVelocities = velocityDragged?.notes.map((note) => note.velocity) ?? []
  const changedIndexes = draggedVelocities.flatMap((velocity, index) => velocity === 0.9 ? [] : [index])
  expect(changedIndexes).toEqual([0])
  expect(draggedVelocities[0]).toBeGreaterThan(0.25)
  expect(draggedVelocities[0]).toBeLessThan(0.35)
  expect(velocityOpacities?.[0]).toBeLessThan(velocityOpacities?.[1] ?? 0)
  expect(velocityUndone?.notes.filter((note) => note.id !== 'collaborator-note').every((note) => note.velocity === 0.9)).toBe(true)
  expect(velocityUndone?.notes.find((note) => note.id === 'collaborator-note')).toEqual({ id: 'collaborator-note', beat: 3, length: 1, pitch: 70, velocity: 0.5, channel: 1 })
  expect(velocityEscaped?.notes.map((note) => note.velocity)).toEqual(velocityUndone?.notes.map((note) => note.velocity))
  // A failed replay leaves the notes as they were, makes exactly the two injected attempts, and never retries later.
  expect(failedRedo).toEqual({ attempts: 2, attemptsLater: 2 })
  expect(afterFailedRedo?.notes).toEqual(velocityUndone?.notes)
  expect(redoAfterFailure?.notes.find((note) => note.id === velocityDragged?.notes[0]?.id)?.velocity).toBe(draggedVelocities[0])
  expect(noOpAfter).toEqual(noOpBefore)
  const [earlierChord, laterChord] = chordEdited?.notes.slice(-2) ?? []
  expect(earlierChord?.beat).toBe(laterChord?.beat)
  expect(earlierChord?.pitch).not.toBe(laterChord?.pitch)
  expect([earlierChord?.velocity, laterChord?.velocity]).toContain(1)
  expect([earlierChord?.velocity, laterChord?.velocity].some((velocity) => (velocity ?? 0) > 0.25 && (velocity ?? 1) < 0.35)).toBe(true)
  expect(chordHeads).toHaveLength(chordEdited?.notes.length ?? -1)
  expect(chordHeads?.every(Boolean)).toBe(true)
  expect(chordInside).toBe(true)
  expect(duplicateKey?.prevented).toBe(true)
  expect(duplicated?.notes).toHaveLength(6)
  expect(duplicateSelectedIds).toHaveLength(1)
  const duplicateSources = [chordEdited?.notes[2], chordEdited?.notes[3]].filter((note) => note !== undefined)
  const duplicateCopies = duplicated?.notes.filter((note) => duplicateSelectedIds?.includes(note.id)) ?? []
  expect(duplicateCopies).toHaveLength(1)
  expect(new Set(duplicateCopies.map((note) => note.id)).size).toBe(1)
  expect(duplicateCopies.map(({ beat, length, pitch, velocity, channel }) => ({ beat, length, pitch, velocity, channel })))
    .toEqual(duplicateSources.filter((note) => note.beat + 2 < 8).map(({ beat, length, pitch, velocity, channel }) => ({ beat: beat + 2, length, pitch, velocity, channel })))
  expect(duplicateUndo?.notes).toHaveLength(5)
  expect(duplicateRedo?.notes).toHaveLength(6)
  expect(selectedBeforeDelete?.selectedNoteCount).toBe(2)
  expect(deletedSelection?.notes).toHaveLength(4)
  expect(restoredSelection?.notes).toHaveLength(6)
  expect(deletedAgain?.notes).toHaveLength(4)
  const clipDetail = { mode: 'clip-detail', open: true }
  expect(routing?.audioRouted).toEqual({ ...clipDetail, audio: 'routing-audio', midi: null })
  expect(routing?.midiRouted).toEqual({ ...clipDetail, audio: null, midi: identity?.clipId })
  expect(routing?.unknownIgnored).toEqual(routing?.midiRouted)
  expect(routing?.escapeWhileNoteDragging).toEqual(routing?.midiRouted)
  expect(routing?.escapeWhenIdle).toEqual({ mode: 'effects', open: true, audio: null, midi: identity?.clipId ?? null })
  expect(routing?.clearedSelection).toEqual({ mode: 'effects', open: true, audio: null, midi: null })
}, 120_000)
