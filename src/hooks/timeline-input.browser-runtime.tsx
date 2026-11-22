import { createRoot, createSignal, flush } from 'solid-js'
import { render } from '@solidjs/web'
import { ColorModeProvider } from '@kobalte/core/color-mode'

import { AudioEngine } from '@daw-browser/audio-engine/audio-engine'
import type { Track } from '@daw-browser/timeline-core/types'
import { AppPreferencesProvider } from '~/context/app-preferences'
import { MidiAccessProvider } from '~/context/midi-access'
import type { NativeLiveMidiNoteHandle } from '~/lib/desktop/native-live-midi'
import { defaultAppPreferences } from '~/lib/preferences/app-preferences'
import type { TimelineTrackLayoutRow } from '~/lib/timeline-track-layout'
import type { DesktopAudioLifecycle } from '~/types/desktop-bridge'
import { useTimelineMidiOverlay } from './useTimelineMidiOverlay'
import { useTimelineSelection } from './useTimelineSelection'
import { useTimelineSelectionState } from './useTimelineSelectionState'

const scenarios: Record<string, boolean> = {}
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }

const track = (id: string, midiClipId?: string): Track => ({
  id,
  name: `Track ${id}`,
  volume: 1,
  kind: 'instrument',
  clips: midiClipId
    ? [{ id: midiClipId, name: midiClipId, startSec: 0, duration: 4, color: '#ffffff', midi: { wave: 'sine', notes: [] } }]
    : [],
})

const press = (code: string) => window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true }))
const release = (code: string) => window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true, cancelable: true }))

type NativeCall = { kind: 'start' | 'stop'; trackId: string; pitch: number; force?: boolean }

const createNative = (state: { available: boolean }) => {
  const calls: NativeCall[] = []
  const resetListeners = new Set<() => void>()
  let nextNoteId = 1

  return {
    calls,
    reset: () => { for (const listener of resetListeners) listener() },
    port: {
      isActive: () => false,
      isAvailable: () => state.available,
      start: (note: { trackId: string; pitch: number }): NativeLiveMidiNoteHandle | undefined => {
        calls.push({ kind: 'start', trackId: note.trackId, pitch: note.pitch })

        return state.available ? { backend: 'native', trackId: note.trackId, pitch: note.pitch, noteId: nextNoteId++ } : undefined
      },
      stop: (handle: NativeLiveMidiNoteHandle, force?: boolean) => {
        calls.push({ kind: 'stop', trackId: handle.trackId, pitch: handle.pitch, force })
      },
      subscribeReset: (listener: () => void) => {
        resetListeners.add(listener)

        return () => resetListeners.delete(listener)
      },
    },
  }
}

const mountOverlay = (config: {
  tracks: Track[]
  requiresNativeAudio?: boolean
  native?: ReturnType<typeof createNative>
  dockedClipId?: string | null
}) => {
  const projectId = `project:${crypto.randomUUID()}`
  const engine = new AudioEngine()
  const browserStarts: number[] = []
  const startLiveMidiNote = engine.startLiveMidiNote.bind(engine)
  engine.startLiveMidiNote = (note) => { browserStarts.push(note.pitch);

 return startLiveMidiNote(note) }

  const [bpm, setBpm] = createSignal(120)
  const [docked, setDocked] = createSignal<string | null>(config.dockedClipId ?? null)
  const host = document.createElement('div')
  document.body.append(host)
  let overlay: ReturnType<typeof useTimelineMidiOverlay> | undefined
  let selection: ReturnType<typeof useTimelineSelectionState> | undefined

  const dispose = render(() => (
    <ColorModeProvider>
    <AppPreferencesProvider initialPreferences={defaultAppPreferences}>
      <MidiAccessProvider>
        {(() => {
          selection = useTimelineSelectionState({ projectId: () => projectId, tracks: () => config.tracks })
          overlay = useTimelineMidiOverlay({
            audioEngine: engine,
            requiresNativeAudio: config.requiresNativeAudio,
            tracks: () => config.tracks,
            projectId: () => projectId,
            bpm,
            isPlaying: () => false,
            playheadSec: () => 0,
            selection,
            dockedMidiClipId: docked,
            nativeLiveMidi: config.native?.port,
          })

          return null
        })()}
      </MidiAccessProvider>
    </AppPreferencesProvider>
    </ColorModeProvider>
  ), host)

  if (!overlay || !selection) throw new Error('The MIDI overlay did not mount.')
  // The stored preference loads while the hook mounts; enabling afterwards is the user turning the keyboard on.
  flush()
  overlay.midiKeyboard.toggle()
  flush()

  return {
    overlay,
    selection,
    browserStarts,
    setBpm,
    setDocked,
    unmount: () => { dispose(); host.remove() },
  }
}

const withLifecycleBridge = async <T,>(
  initial: DesktopAudioLifecycle,
  run: (emit: (lifecycle: DesktopAudioLifecycle) => void) => Promise<T>,
) => {
  const listeners = new Set<(lifecycle: DesktopAudioLifecycle) => void>()
  Object.assign(window, {
    dawDesktop: {
      audioHost: {
        getLifecycle: async () => initial,
        onLifecycle: (listener: (lifecycle: DesktopAudioLifecycle) => void) => {
          listeners.add(listener)

          return () => listeners.delete(listener)
        },
      },
    },
  })

  try {
    return await run((lifecycle) => { for (const listener of listeners) listener(lifecycle) })
  } finally {
    Reflect.deleteProperty(window, 'dawDesktop')
  }
}

const runMidiScenarios = async () => {
  const instrument = [track('a', 'clip:a'), track('b', 'clip:b'), track('audio-only')]

  {
    const native = createNative({ available: false })
    const mounted = mountOverlay({ tracks: instrument, requiresNativeAudio: true, native, dockedClipId: 'clip:a' })
    mounted.overlay.auditionNote('a', 64)
    press('KeyA')
    release('KeyA')
    scenarios['native-required-stays-off-the-browser-engine-while-native-is-pending'] =
      mounted.browserStarts.length === 0 && native.calls.every((call) => call.kind === 'start')
    mounted.unmount()
  }

  {
    const native = createNative({ available: true })
    const mounted = mountOverlay({ tracks: instrument, native, dockedClipId: 'clip:a' })
    press('KeyA')
    const started = native.calls.at(-1)
    release('KeyA')
    const stopped = native.calls.at(-1)
    scenarios['keyboard-note-routes-to-the-docked-clip-track-on-native'] =
      started?.kind === 'start' && started.trackId === 'a' && started.pitch === 60
      && stopped?.kind === 'stop' && stopped.pitch === 60 && mounted.browserStarts.length === 0
    mounted.unmount()
  }

  {
    const mounted = mountOverlay({ tracks: instrument, dockedClipId: 'clip:a' })
    press('KeyA')
    scenarios['browser-engine-plays-when-no-native-backend-exists'] = mounted.browserStarts.includes(60)
    release('KeyA')
    mounted.unmount()
  }

  {
    const native = createNative({ available: true })
    const mounted = mountOverlay({ tracks: instrument, native, dockedClipId: 'clip:a' })
    scenarios['docked-clip-names-the-target'] =
      mounted.overlay.midiEditorClipId() === 'clip:a' && mounted.overlay.midiKeyboard.targetLabel() === 'Track a'
    press('KeyA')
    mounted.setDocked('clip:b')
    flush()
    const cleaned = native.calls.at(-1)
    scenarios['docked-clip-change-force-releases-held-notes'] =
      cleaned?.kind === 'stop' && cleaned.trackId === 'a' && cleaned.force === true
      && mounted.overlay.midiKeyboard.targetLabel() === 'Track b'
    mounted.setDocked('clip:unknown')
    flush()
    scenarios['docked-clip-without-midi-yields-no-editor-clip'] = mounted.overlay.midiEditorClipId() === null
    mounted.unmount()
  }

  {
    const native = createNative({ available: true })
    const mounted = mountOverlay({ tracks: instrument, native, dockedClipId: 'clip:a' })
    press('KeyA')
    const callsBefore = native.calls.length
    mounted.setBpm(90)
    flush()
    scenarios['bpm-change-keeps-held-notes'] = native.calls.length === callsBefore
    mounted.selection.selectTrackTarget('b')
    flush()
    mounted.setDocked(null)
    flush()
    const cleaned = native.calls.slice(callsBefore).find((call) => call.kind === 'stop')
    scenarios['target-change-force-releases-held-notes'] =
      cleaned?.trackId === 'a' && cleaned.force === true
    mounted.unmount()
  }

  {
    const native = createNative({ available: true })
    const mounted = mountOverlay({ tracks: instrument, native, dockedClipId: 'clip:a' })
    press('KeyA')
    native.reset()
    const released = native.calls.at(-1)
    scenarios['native-preview-reset-force-releases-held-notes'] =
      released?.kind === 'stop' && released.force === true
    mounted.unmount()
    const notesAtUnmount = native.calls.length
    press('KeyS')
    scenarios['unmounted-overlay-ignores-keys'] = native.calls.length === notesAtUnmount
  }

  {
    const native = createNative({ available: true })
    const mounted = mountOverlay({ tracks: instrument, native, dockedClipId: 'clip:a' })
    press('KeyA')
    mounted.unmount()
    const released = native.calls.at(-1)
    scenarios['unmount-force-releases-held-notes'] = released?.kind === 'stop' && released.force === true
  }

  await withLifecycleBridge({ state: 'recovering', powerGeneration: 1 }, async (emit) => {
    const native = createNative({ available: true })
    const mounted = mountOverlay({ tracks: instrument, native, dockedClipId: 'clip:a' })
    await settle()
    press('KeyA')
    release('KeyA')
    scenarios['native-waits-for-ready-lifecycle'] =
      native.calls.length === 0 && mounted.browserStarts.includes(60)
    emit({ state: 'ready', powerGeneration: 2 })
    press('KeyS')
    scenarios['ready-lifecycle-routes-to-native'] =
      native.calls.some((call) => call.kind === 'start' && call.pitch === 62)
    emit({ state: 'suspended', powerGeneration: 3 })
    const suspended = native.calls.at(-1)
    scenarios['suspended-lifecycle-force-releases-held-notes'] =
      suspended?.kind === 'stop' && suspended.pitch === 62 && suspended.force === true
    const before = native.calls.length
    const browserBefore = mounted.browserStarts.length
    press('KeyD')
    scenarios['suspended-lifecycle-blocks-new-notes'] =
      native.calls.length === before && mounted.browserStarts.length === browserBefore
    mounted.unmount()
  })
}

const runSelectionScenarios = () => {
  const rows: TimelineTrackLayoutRow[] = ['one', 'two'].map((trackId, index) => ({
    trackId, topPx: index * 50, heightPx: 50, clipLaneHeightPx: 50, automationHeightPx: 0, depth: 0,
  }))

  for (const playing of [false, true]) {
    const label = playing ? 'playing' : 'stopped'
    const host = document.createElement('div')
    host.style.cssText = 'position:fixed;left:0;top:0;width:600px;height:100px'
    document.body.append(host)
    const starts: { clientX: number; listen: boolean | undefined }[] = []
    const moves: number[] = []

    const { state, dispose } = createRoot((dispose) => {
      const tracks = [track('one'), track('two')]
      const state = useTimelineSelectionState({ projectId: () => 'project:selection', tracks: () => tracks })

      const selection = useTimelineSelection({
        tracks: () => tracks,
        trackLayout: () => rows,
        displayTrackIds: () => ['one', 'two'],
        selection: state,
        bpm: () => 120,
        gridDenominator: () => 4,
        pixelsPerSecond: () => 100,
        isPlaying: () => playing,
        startScrub: (clientX, options) => { starts.push({ clientX, listen: options?.listen }) },
        moveScrub: (clientX) => { moves.push(clientX) },
        stopScrub: () => {},
      })

      host.addEventListener('pointerdown', (event) => {
        if (event instanceof PointerEvent) selection.onLanePointerDown(event, { kind: 'scrolling', element: host, rows, rulerOffsetPx: 0 })
      })

      return { state, dispose }
    })

    // Pointer events are handled outside any owner, as in the app, and the selection applies at the flush.
    flush()
    host.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: 120, clientY: 70, pointerId: 1 }))
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 122, clientY: 70, pointerId: 1 }))
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: 122, clientY: 70, pointerId: 1 }))
    flush()
    scenarios[`click-selects-the-clicked-track-while-${label}`] = state.selectedTrackId() === 'two'
    scenarios[`click-${playing ? 'does-not-seek' : 'seeks-without-listening'}-while-${label}`] = playing
      ? starts.length === 0 && moves.length === 0
      : starts.length === 1 && starts[0]?.clientX === 120 && starts[0].listen === false && moves.includes(122)
    dispose()
    host.remove()
  }
}

const run = async () => {
  try {
    await runMidiScenarios()
    runSelectionScenarios()
    Object.defineProperty(window, '__browserFixtureResults', { value: scenarios })
  } catch (error) {
    Object.assign(window, { __browserFixtureError: String(error) })
  }
}

void run()
