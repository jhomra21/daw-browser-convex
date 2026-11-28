// Page side of the portable-unavailable E2E (driver: portable-unavailable.browser.test.ts). The real useTimelinePlayback and
// useTimelineMidiOverlay run over the real portable controller in a page whose AudioWorkletNode is removed, so the portable session
// cannot be selected. The only stand-in is the project's snapshot: one synth instrument track.
import { createSignal, flush } from 'solid-js'
import { render } from '@solidjs/web'
import { ColorModeProvider } from '@kobalte/core/color-mode'

import { AudioEngine } from '@daw-browser/audio-engine/audio-engine'
import { createDefaultSynthParams } from '@daw-browser/shared'
import { AppPreferencesProvider } from '~/context/app-preferences'
import { MidiAccessProvider } from '~/context/midi-access'
import { compileLivePlaybackSnapshot } from '~/lib/live-playback-snapshot'
import { defaultAppPreferences } from '~/lib/preferences/app-preferences'
import type { RuntimeTrack } from '~/lib/timeline-runtime-types'
import { useTimelinePlayback } from './useTimelinePlayback'
import { useTimelineMidiOverlay } from './useTimelineMidiOverlay'
import { useTimelineSelectionState } from './useTimelineSelectionState'

const trackId = 'synth'
const track: RuntimeTrack = { id: trackId, name: 'Synth', kind: 'instrument', volume: 1, clips: [] }
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const mount = (engine: AudioEngine) => {
  const messages: string[] = []
  const projectId = `project:${crypto.randomUUID()}`
  const [panelOpen] = createSignal(false)
  const host = document.createElement('div')
  document.body.append(host)
  let hooks: { playback: ReturnType<typeof useTimelinePlayback>; overlay: ReturnType<typeof useTimelineMidiOverlay> } | undefined

  const dispose = render(() => (
    <ColorModeProvider>
      <AppPreferencesProvider initialPreferences={defaultAppPreferences}>
        <MidiAccessProvider>
          {(() => {
            const selection = useTimelineSelectionState({ projectId: () => projectId, tracks: () => [track] })

            const playback = useTimelinePlayback(engine, undefined, undefined, {
              // The app shows this message in a blocking dialog (Timeline.tsx notify).
              reportFault: (message) => messages.push(message),
              compileSnapshot: async (transport) => compileLivePlaybackSnapshot({
                revision: 1, bpm: 120, transport, tracks: [track], sidechainRoutes: [],
                renderState: { fx: { masterVolume: 1, masterFxInstances: [], trackFx: { [trackId]: { instances: [], instrument: { kind: 'synth', instanceId: 'synth:1', params: createDefaultSynthParams() } } } }, automationEnvelopes: [] },
              }),
            })

            const overlay = useTimelineMidiOverlay({
              audioEngine: engine, tracks: () => [track], projectId: () => projectId, bpm: () => 120, isPlaying: playback.isPlaying,
              playheadSec: playback.playheadSec, selection, dockedMidiClipId: () => null, effectsPanelOpen: panelOpen,
              portableLiveMidi: playback.portableLiveMidi,
            })

            hooks = { playback, overlay }

            return null
          })()}
        </MidiAccessProvider>
      </AppPreferencesProvider>
    </ColorModeProvider>
  ), host)

  if (!hooks) throw new Error('The hooks did not mount.')
  flush()

  return { ...hooks, messages, unmount: async () => { await hooks?.playback.disposePreparedBackends(); dispose(); host.remove() } }
}

const waitFor = async (condition: () => boolean, timeoutMs = 5_000) => {
  const deadline = performance.now() + timeoutMs

  while (!condition() && performance.now() < deadline) await sleep(20)
}

const run = async () => {
  try {
    // Without AudioWorkletNode the page cannot host the portable session: this is the browser that used to fall back to Web Audio.
    Reflect.deleteProperty(window, 'AudioWorkletNode')
    const results: Record<string, boolean> = {}

    const play = mount(new AudioEngine())
    await play.playback.handlePlay([track])
    results['play-shows-the-reason'] = play.messages.some((message) => message.includes('Playback is unavailable') && message.includes('AudioWorklet is unavailable'))
    results['play-does-not-start-silently'] = !play.playback.isPlaying() && !play.playback.isPlayPending() && play.playback.backendDiagnostics().activeBackend === 'idle'
    results['play-shows-one-message'] = play.messages.length === 1
    await play.playback.handlePlay([track])
    results['a-second-play-shows-it-again'] = play.messages.length === 2
    await play.unmount()

    const note = mount(new AudioEngine())
    note.overlay.auditionNote(trackId, 60, 1, 0.3)
    await waitFor(() => note.messages.length > 0)
    results['note-shows-the-reason'] = note.messages.some((message) => message.includes('Playback is unavailable') && message.includes('AudioWorklet is unavailable'))
    results['note-starts-no-session'] = !note.playback.isPortableBrowserPlaybackPrepared() && !note.playback.isPlaying()
    await note.unmount()

    Object.defineProperty(window, '__browserFixtureResults', { value: results })
  } catch (error) {
    Object.assign(window, { __browserFixtureError: String(error instanceof Error ? error.stack : error) })
  }
}

void run()
