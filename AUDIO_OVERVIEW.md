# Audio Architecture and Workflow

This document explains how audio is handled end‑to‑end in this project: data model, realtime engine, effects, synths, timeline/transport, recording, exporting, and UI integration. Code excerpts reference files under `src/` so you can cross‑check implementations.

## Stack at a glance

- Web Audio API for realtime playback, synthesis, effects, metering, and analysis.
- No heavy audio runtime frameworks; the engine is hand‑rolled (`src/lib/audio-engine.ts`).
- Offline rendering via `OfflineAudioContext` mirroring the live graph (`src/lib/export-mixdown.ts`).
- Encoding to WAV using the `mediabunny` library (only for export packaging).

## Core data model

Source: `src/types/timeline.ts`

```ts
export type Clip = {
  id: string
  name: string
  buffer?: AudioBuffer | null
  startSec: number
  duration: number
  leftPadSec?: number
  bufferOffsetSec?: number
  color: string
  sampleUrl?: string
  midi?: { wave: 'sine'|'square'|'sawtooth'|'triangle'; gain?: number; notes: { beat:number; length:number; pitch:number; velocity?:number }[] }
  midiOffsetBeats?: number
}

export type Track = {
  id: string
  name: string
  volume: number
  clips: Clip[]
  muted?: boolean
  soloed?: boolean
  lockedBy?: string | null
  lockedAt?: number | null
  kind?: 'audio' | 'instrument'
}
```

Key points

- A clip is either an audio sample (`buffer`/`sampleUrl`) or MIDI (`midi`). Instrument tracks only accept MIDI; audio tracks only accept audio.
- `leftPadSec` and `bufferOffsetSec` trim an audio clip without touching the source buffer. `midiOffsetBeats` shifts MIDI content when trimming.
- `startSec + duration` defines the clip window on the timeline; actual playable range is the window intersected with the source’s available audio/MIDI.

## Realtime audio engine

Source: `src/lib/audio-engine.ts` (class `AudioEngine`)

### Graph topology

- Master: `AudioContext` → `masterGain` → [optional Master Reverb/EQ] → destination.
- Per track:
  - `trackInputs[trackId]` (pre‑FX) → [optional Track Reverb (parallel dry/wet) → optional Track EQ chain] → `trackGains[trackId]` → `masterGain`.
  - Track analysers tap the post‑gain signal for meters/spectrum.
  - Synth output for MIDI is routed into the track input so downstream FX apply equally to audio and instrument content.

Notes

- The AudioContext is created lazily via `ensureAudio()` to satisfy autoplay policies (requires user gesture).
- EQ is built from `BiquadFilterNode` bands. Reverb uses a `ConvolverNode` with a generated impulse response (seeded noise tail) and optional pre‑delay.
- Meters use `AnalyserNode` with smoothing. Both mono RMS (quick) and stereo analysers exist.

### Transport, time and scheduling

- The engine keeps a mapping between timeline seconds and `currentTime` via a transport epoch:
  - `onTransportStart(playheadSec)` pins `transportEpochCtxTime` and `transportEpochTimelineSec`.
  - `onTransportSeek(playheadSec, offsetSec = 0, opts?: { resetMetronome?: boolean })` shifts the epoch; we often pass a small positive `offsetSec` so new events are scheduled slightly in the future and land exactly on-grid. `resetMetronome: false` preserves tick continuity when wrapping loops.
  - `timelineToCtxTime()`/`ctxTimeToTimeline()` convert times in both directions.
  - `scheduleAllClipsFromPlayhead(tracks, playheadSec, opts?: { atCtxTime?: number; preserveExisting?: boolean; endLimitSec?: number })` schedules all audible clips from the playhead forward, aligned to transport time (not “now”).
  - `rescheduleClipsAtPlayhead(tracks, playheadSec, clipIds, opts?: { endLimitSec?: number })` reschedules only specific clips (used by editing during playback).

Looping and metronome

- The UI (`useTimelinePlayback`) wraps playhead behavior around a loop region. At loop end we stop only the prior cycle’s sources, seek a few milliseconds into the future (small ahead offset), and schedule the next cycle exactly to that future transport timestamp. This prevents “past‑time” starts and audible lag while keeping FX intact.
- When initially starting playback (or after scrubs), scheduling may pass `endLimitSec` to cap events to the loop end; this avoids over‑scheduling beyond the region.
- The metronome is synthesized from a tiny click buffer and scheduled with a short lookahead; it follows `bpm` and transport state and shares the same transport epoch as clips.

### Audio clips: windowing and offsets

Scheduling code: `scheduleAudioClip()`

- Computes effective playable range as:
  - `audioStart = clip.startSec + leftPadSec`,
  - `bufferOffset = min(buffer.duration, bufferOffsetSec)`,
  - Play length limited by both the clip window and the remaining buffer duration from `bufferOffset`.
- Starts an `AudioBufferSourceNode` at `now + when`, with `(offset, duration)` derived from the playhead relative to `audioStart`.

### MIDI clips: synth, envelopes, arpeggiator

Scheduling code: `scheduleMidiClip()`

- Track synth defaults are stored in `trackSynths`: `{ wave, gain, attackMs, releaseMs }`.
- For each MIDI note (after `midiOffsetBeats` and optional arpeggiator expansion):
  - Create `OscillatorNode` and `GainNode`.
  - Envelope: linear attack to velocity×gains, hold, linear release; end is clipped to note/clip window.
  - Connect to per‑track synth gain node → track input (so EQ/Reverb apply).
  - Active oscillator and active note structures are tracked for clean stop and live parameter retargeting.

Arpeggiator

- Per‑track arpeggiator (`setTrackArpeggiator`) can transform chordal notes into a pattern (up/down/updown/random), with `rate`, `octaves`, `gate`, and `hold` settings.
- The offline exporter applies the same logic so renders match live playback.

Live param updates without clicks

- The engine tracks `ActiveNote` entries and can recompute envelopes mid‑flight when synth `attackMs`/`releaseMs` are changed, anchoring at the current amplitude to avoid pops.
- Waveform changes update `OscillatorNode.type` for oscillators already scheduled.

### Meters and analysis

- `getTrackLevel(trackId)` returns a 0..1 RMS for quick meters; `getTrackLevelsStereo()` returns L/R RMS.
- `getTrackSpectrum(trackId)`/`getMasterSpectrum()` return normalized FFT magnitude frames for visualizers and the EQ spectrum overlay. Sampling is opportunistic and leaves last non‑empty frame available after pause.

### Decoding and lifecycle

- `decodeAudioData(arrayBuffer)` uses the live `AudioContext` if available; otherwise an `OfflineAudioContext` to avoid creating a real context prematurely.
- `stopAllSources()` halts buffer sources and active MIDI oscillators; transport handlers coordinate metronome and scheduling.
- Clickless wrap/stop: the engine snapshots currently active sources, applies a very short master‑gain fade (a few milliseconds) to remove pops, and calls `source.stop(when)` at a common timestamp. Newly scheduled sources for the next cycle are not affected.
- `close()` clears caches, analysers, and attempts to close the context.

### Minimal usage example (live)

```ts
import { getAudioEngine } from '~/lib/audio-engine-singleton'
import type { Track } from '~/types/timeline'

const audio = getAudioEngine()
audio.ensureAudio()
audio.setBpm(120)

// Build a small session in memory
const tracks: Track[] = [
  { id: 't1', name: 'Instrument', volume: 0.9, clips: [
    { id: 'c1', name: 'MIDI Clip', startSec: 0, duration: 4, color: '#88f', midi: {
      wave: 'sawtooth', gain: 0.9,
      notes: [ { beat: 0, length: 1, pitch: 60 }, { beat: 1, length: 1, pitch: 64 }, { beat: 2, length: 1, pitch: 67 } ]
    } }
  ], kind: 'instrument' },
]

// Set per‑track synth/effects if needed
audio.setTrackSynth('t1', { wave: 'sawtooth', gain: 0.8, attackMs: 5, releaseMs: 30 })
audio.updateTrackGains(tracks)

// Start transport and schedule slightly in the future to avoid past‑time starts
audio.onTransportStart(0)
audio.onTransportSeek(0, 0.02) // small ahead offset (20ms)
audio.scheduleAllClipsFromPlayhead(tracks, 0)

// Advanced: limit schedule to loop end and/or use explicit ctx time
// const loopStart = 0, loopEnd = 8
// const at = audio.timelineToCtxTime(loopStart)
// audio.scheduleAllClipsFromPlayhead(tracks, loopStart, { atCtxTime: at, endLimitSec: loopEnd })
```

## Effects: EQ and Reverb

Sources: live engine (`audio-engine.ts`), exporter (`export-mixdown.ts`), UI (`components/effects/*`, `timeline/EffectsPanel.tsx`).

### EQ

- A lightweight param model is used by both live and offline paths: `{ enabled, bands[{ type, frequency, q, gainDb, enabled }] }`.
- Bands map to `BiquadFilterNode`s. Gain is applied only for `peaking|lowshelf|highshelf` types. Channel properties are pinned to avoid mode changes.

Apply examples

```ts
// Master EQ: two shelves + one mid peak
audio.setMasterEq({
  enabled: true,
  bands: [
    { id: 'lo', type: 'lowshelf',  frequency: 120,  q: 0.7, gainDb: +2, enabled: true },
    { id: 'mid', type: 'peaking',   frequency: 2000, q: 1.2, gainDb: -1, enabled: true },
    { id: 'hi', type: 'highshelf',  frequency: 8000, q: 0.7, gainDb: +1, enabled: true },
  ],
})

// Track EQ
audio.setTrackEq('t1', {
  enabled: true,
  bands: [ { id: 'cut', type: 'highpass', frequency: 40, q: 0.7, gainDb: 0, enabled: true } ]
})
```

### Reverb

- Parallel dry/wet routing around EQ for both track and master. Params: `{ enabled, wet (0..1), decaySec, preDelayMs }`.
- IR is synthesized deterministically and cached by decay/time bucket.

Apply examples

```ts
// Master light room
audio.setMasterReverb({ enabled: true, wet: 0.2, decaySec: 1.8, preDelayMs: 20 })

// Track roomy verb
audio.setTrackReverb('t1', { enabled: true, wet: 0.35, decaySec: 2.2, preDelayMs: 15 })
```

## Synths and MIDI

- Track synth params: `{ wave, gain, attackMs, releaseMs }`. These affect both scheduled notes and live audition/keyboard input.
- Live envelope retargeting updates active notes smoothly when params change.
- Arpeggiator is a pre‑synth MIDI effect applied per track; offline export applies the same transform.

Apply examples

```ts
audio.setTrackSynth('t1', { wave: 'triangle', gain: 0.7, attackMs: 10, releaseMs: 50 })
audio.setTrackArpeggiator('t1', { enabled: true, pattern: 'updown', rate: '1/16', octaves: 2, gate: 0.8, hold: true })
```

## Timeline, grid and transport

Sources: `src/hooks/useTimelinePlayback.ts`, `src/lib/timeline-utils.ts`, `src/components/timeline/*`.

- Grid helpers compute beat durations from BPM and denominator and provide quantization (`quantizeSecToGrid`).
- Non‑overlap helpers compute safe insertion points respecting existing clips, with grid‑aligned variants.
- Playback hook manages play/pause/stop, loop wrapping, and scrubbing; it delegates scheduling to the engine and keeps a reactive playhead signal.

Scrubbing snippet

```ts
// Convert mouse x to seconds using the scroll container; then reschedule
const sec = clientXToSec(event.clientX, scrollEl)
playback.setPlayhead(sec, tracks())
```

## Recording audio

Source: `src/hooks/useTrackRecording.ts`

Flow

1) Acquire microphone via `navigator.mediaDevices.getUserMedia({ audio: true })`.

2) Create `MediaRecorder` with the best supported MIME type (WebM/Opus preferred), capture chunks, and start.

3) Live preview: a separate `AudioContext` runs an analyser + `ScriptProcessorNode` for low‑overhead amplitude samples drawn on the timeline.

4) On stop, blobs are combined, decoded to `AudioBuffer` via `audioEngine.decodeAudioData`, and a new clip is created on the selected/armed track at a non‑overlapping position. The decoded buffer is cached and uploaded to R2; the server responds with a `sampleUrl` recorded on the clip.

The recorder keeps transport running so you can record against the metronome and playback.

## Importing audio

Source: `src/hooks/useTimelineClipImport.ts`

- Supports file picker, drag‑drop of local files, and dropping URLs or custom sample payloads.
- Decodes with `audioEngine.decodeAudioData`, computes grid‑aligned, non‑overlapping start, creates the clip, caches the buffer, and uploads the blob to R2 for persistence.
- Instrument tracks are gated from accepting audio (and vice‑versa) to maintain type consistency.

## Exporting/mixdown

Source: `src/lib/export-mixdown.ts`

- `renderMixdown({ tracks, bpm, range, fx, sampleRate, numberOfChannels })` builds an `OfflineAudioContext` mirroring the live graph: per‑track EQ/reverb, synth envelopes, arpeggiator, and audio buffer scheduling using the same timing rules (leftPad, buffer offsets, MIDI offsets). Returns an `AudioBuffer`.
- `encodeAudioBuffer(buffer)` packages the buffer to WAV via `mediabunny`.

Example

```ts
import { renderMixdown, encodeAudioBuffer } from '~/lib/export-mixdown'

const audioBuffer = await renderMixdown({ tracks, bpm: 120, range: { mode: 'whole' } })
const { blob } = await encodeAudioBuffer(audioBuffer)
// Save or upload the blob (type: audio/wav)
```

## Visuals: waveforms, meters, spectrum

- Waveform peaks are computed client‑side (`src/lib/waveform.ts`) as interleaved min/max arrays with caching by buffer and resolution.
- Meters and spectrum frames are sampled via `AnalyserNode` taps; EQ UI overlays live spectrum data.

## Design choices and reasoning

- Autoplay compliance: avoid creating `AudioContext` or connecting to destination until a user gesture; decoding uses an offline context when needed.
- Minimal graph churn: track inputs, gains, and chains are created once and rewired when FX change; clip scheduling only creates temporary sources.
- Live param retargeting: active MIDI notes can adjust envelopes and oscillator types mid‑play without zipper noise.
- Parallel reverb: classic dry/wet split around EQ yields predictable tonal behavior and makes on/off routing straightforward.
- Deterministic IRs: seeded noise tails allow caching across sample rates and decay “buckets”, matching live and offline paths.
- Edit‑while‑playing: targeted rescheduling (`rescheduleClipsAtPlayhead`) avoids restarting unrelated sources.

## Extending the system

- New FX: follow the EQ/Reverb patterns—introduce a lightweight param shape, build nodes in both live and offline paths, and add UI + persistence.
- New instruments: add a per‑track instrument output node feeding `trackInputs` so downstream FX remain consistent, and mirror in the exporter.
- More media types: add new clip kinds and scheduling logic in both engine and exporter; keep timeline math centralized in `timeline-utils`.

## Pointers

- Realtime engine: `src/lib/audio-engine.ts`
- Exporter: `src/lib/export-mixdown.ts`
- Timeline UI and transport: `src/components/Timeline.tsx`, `src/hooks/useTimelinePlayback.ts`
- Effects UI and persistence: `src/components/timeline/EffectsPanel.tsx`
- Recording: `src/hooks/useTrackRecording.ts`
- Importing: `src/hooks/useTimelineClipImport.ts`
- Waveforms: `src/lib/waveform.ts`
