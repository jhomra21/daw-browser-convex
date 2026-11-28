// Page side of the live-notes E2E (driver: live-notes.browser.test.ts). The real useTimelinePlayback and useTimelineMidiOverlay run over
// the real portable controller, WasmAudioWorkletBackend, worklet and WASM core on a real AudioContext. The stand-ins are the project's
// snapshot (one instrument track per case), a context built ahead of the engine so a pass-through tap can sit on its destination, and
// that tap, which records the peak of every output block.
import { createSignal, flush } from 'solid-js'
import { render } from '@solidjs/web'
import { ColorModeProvider } from '@kobalte/core/color-mode'

import { AudioEngine } from '@daw-browser/audio-engine/audio-engine'
import type { ExportFx } from '@daw-browser/audio-engine/export-mixdown'
import { resolveSampledInstrumentRegion } from '@daw-browser/audio-engine/sampled-instrument-region'
import {
  assignSampleToDrumRackPad, createDefaultDrumRackParams, createDefaultGranularParams, createDefaultSamplerParams, createDefaultSynthParams,
  type DrumRackPadSample, type SamplerZone, type TrackInstrumentParams,
} from '@daw-browser/shared'
import { AppPreferencesProvider } from '~/context/app-preferences'
import { MidiAccessProvider } from '~/context/midi-access'
import { compileLivePlaybackSnapshot } from '~/lib/live-playback-snapshot'
import { defaultAppPreferences } from '~/lib/preferences/app-preferences'
import type { RuntimeTrack } from '~/lib/timeline-runtime-types'
import { useTimelinePlayback } from './useTimelinePlayback'
import { useTimelineMidiOverlay } from './useTimelineMidiOverlay'
import { useTimelineSelectionState } from './useTimelineSelectionState'

const trackId = 'live'
const auditionSec = 0.6
const soundThreshold = 1e-4
const silenceThreshold = 1e-6
const tailStartSec = 1.2

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

// ---- rig: a running context with a tap on its destination ----
type Block = { frame: number; peak: number; arrival: number }

const tapModule = `
class Tap extends AudioWorkletProcessor {
  constructor() { super(); this.frames = []; this.peaks = [] }
  process(inputs, outputs) {
    const input = inputs[0], output = outputs[0]
    let peak = 0
    for (let channel = 0; channel < input.length; channel++) {
      const samples = input[channel]
      for (let index = 0; index < samples.length; index++) peak = Math.max(peak, Math.abs(samples[index]))
      if (output[channel]) output[channel].set(samples)
    }
    this.frames.push(currentFrame); this.peaks.push(peak)
    if (peak > 0 || this.frames.length >= 8) { this.port.postMessage({ frames: this.frames, peaks: this.peaks }); this.frames = []; this.peaks = [] }
    return true
  }
}
registerProcessor('live-notes-tap', Tap)`

const createRig = async () => {
  const context = new AudioContext({ latencyHint: 'interactive' })
  const blocks: Block[] = []
  const waiters: { frame: number; resolve: () => void }[] = []
  await context.resume()
  const url = URL.createObjectURL(new Blob([tapModule], { type: 'text/javascript' }))

  try { await context.audioWorklet.addModule(url) } finally { URL.revokeObjectURL(url) }

  const node = new AudioWorkletNode(context, 'live-notes-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] })

  node.port.onmessage = (event: MessageEvent<{ frames: number[]; peaks: number[] }>) => {
    const arrival = performance.now()
    event.data.frames.forEach((frame, index) => blocks.push({ frame, peak: event.data.peaks[index] ?? 0, arrival }))
    const last = event.data.frames[event.data.frames.length - 1] ?? 0

    for (const waiter of waiters.splice(0)) {
      if (last >= waiter.frame) waiter.resolve()
      else waiters.push(waiter)
    }
  }

  node.connect(context.destination)
  // Every session the product creates connects to context.destination: it now reaches the tap first.
  Object.defineProperty(context, 'destination', { value: node })

  return {
    context,
    blocks,
    rate: context.sampleRate,
    untilFrame: (frame: number) => new Promise<void>((resolve) => { waiters.push({ frame, resolve }) }),
    // The engine builds its context when the first audio is needed, as the app does: that construction hands it this one.
    lend: () => {
      const original = Object.getOwnPropertyDescriptor(window, 'AudioContext')
      Object.defineProperty(window, 'AudioContext', { configurable: true, writable: true, value: function lent() { return context } })

      return () => { if (original) Object.defineProperty(window, 'AudioContext', original) }
    },
  }
}

type Rig = Awaited<ReturnType<typeof createRig>>

// ---- the project: one instrument track per case, its samples decoded as the product holds them ----
const toneBuffer = (rig: Rig, seconds: number, hz: number, decay: boolean) => {
  const buffer = rig.context.createBuffer(1, Math.round(seconds * rig.rate), rig.rate)
  const samples = buffer.getChannelData(0)

  for (let index = 0; index < samples.length; index++) samples[index] = 0.5 * Math.sin(2 * Math.PI * hz * index / rig.rate) * (decay ? 1 - index / samples.length : 1)

  return buffer
}

const sampleRef = (assetKey: string, buffer: AudioBuffer): DrumRackPadSample => ({
  assetKey, url: `blob:live-notes/${assetKey}`, sourceKind: 'upload', source: { durationSec: buffer.duration, sampleRate: buffer.sampleRate, channelCount: 1 },
})

const zone = (sample: DrumRackPadSample): SamplerZone => ({
  id: 'zone', sample, keyLow: 0, keyHigh: 127, velocityLow: 1, velocityHigh: 127, rootNote: 60, tuneCents: 0, gain: 1, pan: 0,
  roundRobinGroup: 0, roundRobinIndex: 0, playbackMode: 'forward-loop', startSec: 0, crossfadeSec: 0, chokeGroup: 0,
})

// `sustains`: the sound lasts while the note is held. A Drum Rack pad plays its one-shot sample and ends on its own.
type Case = { name: string; pitches: [number, number]; sustains: boolean; instrument: TrackInstrumentParams; buffers: Pick<NonNullable<ExportFx['trackFx']>[string], 'samplerBuffers' | 'drumRackBuffers' | 'granularBuffer'> }

const buildCase = (rig: Rig, name: string): Case => {
  const held = toneBuffer(rig, 1, 220, false)
  const hit = toneBuffer(rig, 0.15, 100, true)
  const heldRef = sampleRef('live:held', held)
  const hitRef = sampleRef('live:hit', hit)
  const synth = createDefaultSynthParams()
  const sampler = createDefaultSamplerParams()
  const drums = ['pad-36', 'pad-37'].reduce((params, padId) => assignSampleToDrumRackPad(params, padId, hitRef), createDefaultDrumRackParams())
  const heldZone = zone(heldRef)

  switch (name) {
    case 'synth':
      return { name, pitches: [60, 64], sustains: true, buffers: {},
        instrument: { kind: 'synth', instanceId: 'live:synth', params: { ...synth, ampEnvelope: { ...synth.ampEnvelope, releaseSec: 0.05 } } } }
    case 'sampler':
      return { name, pitches: [60, 64], sustains: true, buffers: { samplerBuffers: new Map([['zone', { buffer: held, sourceStartFrame: 0 }]]) },
        instrument: { kind: 'sampler', instanceId: 'live:sampler', params: { ...sampler, zones: [heldZone], ampEnvelope: { ...sampler.ampEnvelope, releaseSec: 0.05 } } } }
    case 'drum-rack':
      return { name, pitches: [36, 37], sustains: false, buffers: { drumRackBuffers: new Map(['pad-36', 'pad-37'].map((id) => [id, { buffer: hit, sourceStartFrame: 0 }])) },
        instrument: { kind: 'drum-rack', instanceId: 'live:drums', params: drums } }
    case 'granular':
      return { name, pitches: [60, 64], sustains: true,
        buffers: { granularBuffer: { assetKey: resolveSampledInstrumentRegion(heldZone.sample, heldZone.startSec, heldZone.endSec).key, buffer: held, sourceStartFrame: 0 } },
        instrument: { kind: 'granular', instanceId: 'live:granular', params: { ...createDefaultGranularParams(), zone: heldZone } } }
    default:
      throw new Error(`Unknown instrument case ${name}`)
  }
}

const track: RuntimeTrack = { id: trackId, name: 'Live', kind: 'instrument', volume: 1, clips: [] }

// ---- the real hooks, mounted as the timeline mounts them ----
const mount = (engine: AudioEngine, instrumentCase: Case) => {
  const faults: string[] = []
  const projectId = `project:${crypto.randomUUID()}`
  const [panelOpen, setPanelOpen] = createSignal(false)
  const host = document.createElement('div')
  document.body.append(host)
  let hooks: { playback: ReturnType<typeof useTimelinePlayback>; overlay: ReturnType<typeof useTimelineMidiOverlay>; selection: ReturnType<typeof useTimelineSelectionState> } | undefined

  const dispose = render(() => (
    <ColorModeProvider>
      <AppPreferencesProvider initialPreferences={defaultAppPreferences}>
        <MidiAccessProvider>
          {(() => {
            const selection = useTimelineSelectionState({ projectId: () => projectId, tracks: () => [track] })

            const playback = useTimelinePlayback(engine, undefined, undefined, {
              reportFault: (message) => faults.push(message),
              compileSnapshot: async (transport) => {
                try {
                  const compilation = compileLivePlaybackSnapshot({
                    revision: 1, bpm: 120, transport, tracks: [track], sidechainRoutes: [],
                    renderState: { fx: { masterVolume: 1, masterFxInstances: [], trackFx: { [trackId]: { instances: [], instrument: instrumentCase.instrument, ...instrumentCase.buffers } } }, automationEnvelopes: [] },
                  })

                  if (!compilation.supported) faults.push(`compile unsupported: ${compilation.reasons.join('; ')}`)

                  return compilation
                } catch (error) {
                  faults.push(`compile threw: ${String(error)}`)
                  throw error
                }
              },
            })

            const overlay = useTimelineMidiOverlay({
              audioEngine: engine, tracks: () => [track], projectId: () => projectId, bpm: () => 120, isPlaying: playback.isPlaying,
              playheadSec: playback.playheadSec, selection, dockedMidiClipId: () => null, effectsPanelOpen: panelOpen,
              portableLiveMidi: playback.portableLiveMidi,
            })

            hooks = { playback, overlay, selection }

            return null
          })()}
        </MidiAccessProvider>
      </AppPreferencesProvider>
    </ColorModeProvider>
  ), host)

  if (!hooks) throw new Error('The hooks did not mount.')
  const mounted = hooks
  flush()

  return {
    ...mounted,
    faults,
    openPanel: () => { mounted.selection.selectTrackTarget(trackId); setPanelOpen(true); flush() },
    unmount: async () => { await mounted.playback.disposePreparedBackends(); dispose(); host.remove() },
  }
}

// ---- one note: when its sound starts, that it holds, and that it is gone after release ----
type NoteResult = {
  idleSilent: boolean; heard: boolean; holds: boolean; endsOnItsOwn: boolean; silentAfterRelease: boolean
  renderMs: number | null; wallMs: number | null; preparedAfterMs: number | null; lastSoundMs: number | null; peak: number
}

// Waits for the output to be quiet before the note unless `immediately`: a cold first note must follow the mount at once.
const playNote = async (rig: Rig, mounted: ReturnType<typeof mount>, pitch: number, sustains: boolean, immediately: boolean): Promise<NoteResult> => {
  if (!immediately) await rig.untilFrame(Math.round(rig.context.currentTime * rig.rate) + Math.round(0.2 * rig.rate))
  const noteFrame = Math.round(rig.context.currentTime * rig.rate)
  const idleBlocks = rig.blocks.filter((block) => block.frame >= noteFrame - Math.round(0.1 * rig.rate) && block.frame < noteFrame)
  const started = performance.now()
  mounted.overlay.auditionNote(trackId, pitch, 1, auditionSec)
  // How long the paused session took to exist after the call (null when it already did).
  let preparedAfterMs: number | null = null

  if (!mounted.playback.isPortableBrowserPlaybackPrepared()) {
    while (!mounted.playback.isPortableBrowserPlaybackPrepared() && performance.now() - started < 5_000) await sleep(0)
    preparedAfterMs = performance.now() - started
  }

  await rig.untilFrame(noteFrame + Math.round((auditionSec + tailStartSec + 0.4) * rig.rate) + Math.round(((preparedAfterMs ?? 0) / 1000) * rig.rate))
  const played = rig.blocks.filter((block) => block.frame >= noteFrame)
  const first = played.find((block) => block.peak > soundThreshold)
  const holdEnd = noteFrame + Math.round(auditionSec * 0.9 * rig.rate)
  const tail = played.filter((block) => block.frame >= noteFrame + Math.round((auditionSec + tailStartSec) * rig.rate))
  const lastSound = played.findLast((block) => block.peak > silenceThreshold)

  return {
    idleSilent: idleBlocks.length > 0 && idleBlocks.every((block) => block.peak <= silenceThreshold),
    heard: first !== undefined,
    holds: sustains && first !== undefined && played.some((block) => block.frame >= first.frame + Math.round(0.2 * rig.rate) && block.frame < holdEnd && block.peak > soundThreshold),
    endsOnItsOwn: !sustains && first !== undefined && lastSound !== undefined && lastSound.frame < noteFrame + Math.round(auditionSec * rig.rate),
    silentAfterRelease: tail.length > 50 && tail.every((block) => block.peak <= silenceThreshold),
    renderMs: first ? (first.frame - noteFrame) / rig.rate * 1000 : null,
    wallMs: first ? first.arrival - started : null,
    preparedAfterMs,
    lastSoundMs: lastSound ? (lastSound.frame - noteFrame) / rig.rate * 1000 : null,
    peak: Math.max(0, ...played.map((block) => block.peak)),
  }
}

type Mode = 'cold' | 'prepared'

// Each case gets a fresh engine without a context, so its first audio builds one as the app's first gesture does. 'cold' plays the first
// note straight after mounting, with no session; 'prepared' opens the instrument panel first, waits for the paused session and then
// plays. Both then play a second note on the session the first one used.
const measureCase = async (name: string, mode: Mode) => {
  const rig = await createRig()
  const restore = rig.lend()
  const engine = new AudioEngine()
  const instrumentCase = buildCase(rig, name)
  const mounted = mount(engine, instrumentCase)

  try {
    // Output is silent while nothing plays; the first note starts from that.
    await rig.untilFrame(Math.round(rig.context.currentTime * rig.rate) + Math.round(0.3 * rig.rate))

    if (mode === 'prepared') {
      mounted.openPanel()
      const deadline = performance.now() + 8_000

      while (!mounted.playback.isPortableBrowserPlaybackPrepared() && performance.now() < deadline) await sleep(20)
    }

    const contextBuiltBeforeNote = Boolean(engine.getAudioContext())
    const preparedBeforeFirstNote = mounted.playback.isPortableBrowserPlaybackPrepared()
    const first = await playNote(rig, mounted, instrumentCase.pitches[0], instrumentCase.sustains, true)
    const second = await playNote(rig, mounted, instrumentCase.pitches[1], instrumentCase.sustains, false)

    return { instrument: name, mode, contextBuiltBeforeNote, preparedBeforeFirstNote, first, second, faults: mounted.faults }
  } finally {
    await mounted.unmount()
    restore()
    await rig.context.close()
  }
}

const run = async () => {
  try {
    const measurements: Awaited<ReturnType<typeof measureCase>>[] = []

    for (const name of ['synth', 'sampler', 'drum-rack', 'granular']) {
      measurements.push(await measureCase(name, 'cold'))
      measurements.push(await measureCase(name, 'prepared'))
    }

    const results: Record<string, boolean> = {}

    for (const { instrument, mode, contextBuiltBeforeNote, preparedBeforeFirstNote, first, second, faults } of measurements) {
      const key = `${instrument}-${mode}`
      const ok = (note: NoteResult) => note.idleSilent && note.heard && (note.holds || note.endsOnItsOwn) && note.silentAfterRelease
      results[`${key}-first-note-sounds-and-releases`] = ok(first)
      results[`${key}-second-note-sounds-and-releases`] = ok(second)
      results[`${key}-no-faults`] = faults.length === 0
      results[`${key}-session-state-before-first-note`] = preparedBeforeFirstNote === (mode === 'prepared')
      results[`${key}-context-state-before-first-note`] = contextBuiltBeforeNote === (mode === 'prepared')
    }

    Object.defineProperty(window, '__browserFixtureData', { value: { auditionSec, soundThreshold, silenceThreshold, measurements } })
    Object.defineProperty(window, '__browserFixtureResults', { value: results })
  } catch (error) {
    Object.assign(window, { __browserFixtureError: String(error instanceof Error ? error.stack : error) })
  }
}

void run()
