import { readFile } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { appliedLatencyMatches, attributePublications, compareLatency, judgeBurst as judgeStates } from "./analyze-ae-08-continuity"
import { readWav, type Pcm } from "./ae08-wav"
import { phase5AssetSample } from "./ae-08-phase-5-fixture"
import { judgeBurst, parseHostLines, type BurstVerdict, type Compare, type HostEvent } from "./ae-08-phase-9-matrix"
import type { Row, Step } from "./ae-08-phase-9-rows"

// The per-window checks of a phase 9 row, over the launch capture. "states" rows use the analyzer's judgeBurst with one offline
// export per state as the reference and each step's settling publication as a seam; "sustained" and "delete" rows judge the capture
// against itself (ruling item 3 for the delete row).
export const fadeFramesFor = (sampleRate: number) => Math.round(sampleRate * 0.006)

const captureBlock = z.object({ event: z.literal("capture-block"), pid: z.number(), captureId: z.number(), transportEpoch: z.number(), transportFrame: z.number(), offset: z.number(), frames: z.number(), wallMs: z.number() })
export type CaptureBlock = z.infer<typeof captureBlock>

// The capture indexed by transport frame, as checkPhase5 builds it. A frame no block covers stays NaN, so it fails every compare
// and is never mistaken for silence.
export const transportIndexed = (capture: Pcm, blocks: readonly CaptureBlock[], endFrame: number): Pcm => {
  const samples = new Float32Array(endFrame * capture.channels).fill(NaN)
  for (const block of blocks) for (let frame = 0; frame < block.frames && block.transportFrame + frame < endFrame; frame++)
    for (let channel = 0; channel < capture.channels; channel++)
      samples[(block.transportFrame + frame) * capture.channels + channel] = capture.samples[(block.offset + frame) * capture.channels + channel] ?? NaN
  return { ...capture, samples }
}

// One analyzer call per window (step k of the burst is publication k, window index k is 1-based). The analyzer crossfades the state
// left into the state entered over 6 ms; a step whose entry is not that crossfade says how it differs (Step.entry), and its window is
// judged against the state the product really leaves: a removed graph node also fades over 5 ms (the phase 3 ghost, phase 5's
// remove-readd-track model), and a restored track or a decoded asset starts at its publication, which is the entered state left
// and entered at once.
const ghostFrames = (sampleRate: number) => Math.round(sampleRate * 0.005)
const leftState = (before: Pcm, after: Pcm, seam: number, to: number, entry: Step["entry"]): Pcm => {
  if (entry === "cut") return after
  if (entry !== "ghost") return before
  const ghost = ghostFrames(before.sampleRate)
  const samples = before.samples.slice(0, to * before.channels)
  for (let frame = seam; frame < to; frame++) {
    const gain = Math.max(0, Math.fround(1 - Math.fround((frame - seam) / ghost)))
    for (let channel = 0; channel < before.channels; channel++) samples[frame * before.channels + channel] = Math.fround((samples[frame * before.channels + channel] ?? NaN) * gain)
  }
  return { ...before, samples }
}
export const compareStates = (input: { output: Pcm; states: readonly Pcm[]; seams: readonly number[]; entries: readonly Step["entry"][]; endFrame: number }): Compare => {
  const { output, states, seams, entries, endFrame } = input
  const verdicts = seams.map((seam, edit) => {
    const before = states[edit], after = states[edit + 1], to = seams[edit + 1] ?? endFrame
    return before && after ? judgeStates(output, [leftState(before, after, seam, to, entries[edit]), after], [seam], { fadeFrames: fadeFramesFor(output.sampleRate), endFrame: to }) : undefined
  })
  return (window) => {
    const verdict = verdicts[window.index - 1]
    if (verdict === undefined) return `no analyzer window for edit ${window.index}`
    if (!verdict.wellFormed) return "the capture, the state references and the seams do not line up (rate, channels, length or seam order)"
    const found = verdict.windows[0]
    return found && !verdict.passed
      ? `${found.mismatches} samples differ from the entered state in [${found.seamFrame}, ${found.endFrame}) (first at ${found.firstMismatch}, max ${found.maxAbsDifference}${found.covered ? "" : ", window shorter than the fade"})`
      : undefined
  }
}

// A raise row on the unmonitored Spectral fixture. The retained left channel is the phase 5 source, delayed by the Spectral's latency
// from the start (the master path latency) and by every raise the budget has not yet absorbed. The budget only rises while playing,
// so a lower, or a raise back to a level already reached, moves nothing. Two checks, both from the analyzer:
// the host's reported graph and pinned latencies against the declared edits (publishedLatencyMatchesMoves), and the left channel against
// the shifted source (compareLatency, with its fade and exact shift). A fixture whose declared moves never reach the master path
// reports 0 for both and fails the first check at its first publication.
// The retained track is created without a volume, so it plays at the default track volume (src/lib/tracks.ts), applied in float32.
const defaultTrackVolume = Math.fround(0.8)
const sourceThroughTrack = (frame: number) => Math.fround(Math.fround(phase5AssetSample(frame, false)) * defaultTrackVolume)
export type LatencyEdit = { name: string; fromLatencyFrames: number; toLatencyFrames: number; wallMs: number }
export type LatencyPublication = { wallMs: number; publicationFrame: number; graphLatencyFrames: number; pinnedLatencyFrames: number }
// Rows merged into one launch share the pinned budget, so a row starts at the budget the rows before it left (`startingPinned`) and is
// judged from half a second before its first publication to its own end: what an earlier row's raise or the next row's raise did to
// the capture outside that span is not this row's.
export const compareLatencyMoves = (input: { output: Pcm; edits: readonly LatencyEdit[]; publications: readonly LatencyPublication[]; startingPinned: number
  endFrame: number }): Compare => {
  const { output, edits, publications, startingPinned, endFrame } = input
  const attributed = attributePublications([...edits], publications)
  if (!attributed) return () => `${publications.length} publications do not match the ${edits.length} declared edits (a lost, extra or early revision)`
  const reported = attributed.findIndex((_, index) => !appliedLatencyMatches(attributed.slice(0, index + 1)))
  if (reported >= 0) return (window) => window.index === reported + 1
    ? `the published latency ${publications[reported]?.graphLatencyFrames}/${publications[reported]?.pinnedLatencyFrames} (graph/pinned) differs from the declared move of edit ${window.index}` : undefined
  let pinned = startingPinned
  const moves = attributed.map(({ publication, edits: group }) => {
    const graph = group.at(-1)?.toLatencyFrames ?? 0
    const raiseFrames = Math.max(0, graph - pinned)
    pinned = Math.max(pinned, graph)
    return { publicationFrame: publication.publicationFrame, raiseFrames }
  })
  const from = Math.max(0, (publications[0]?.publicationFrame ?? 0) - output.sampleRate / 2)
  const length = endFrame - from
  const source: Pcm = { sampleRate: output.sampleRate, channels: 1,
    samples: Float32Array.from({ length }, (_, frame) => from + frame < startingPinned ? 0 : sourceThroughTrack(from + frame - startingPinned)) }
  const left: Pcm = { ...output, channels: 1, samples: Float32Array.from({ length }, (_, frame) => output.samples[(from + frame) * output.channels] ?? NaN) }
  const verdict = compareLatency(left, source, moves.filter((move) => move.raiseFrames > 0).map((move) => ({ ...move, publicationFrame: move.publicationFrame - from })), 0, length,
    publications.map((publication) => publication.publicationFrame - from))
  return (window) => verdict.passed || window.index !== (verdict.failedPublication ?? 0) + 1 ? undefined
    : `${verdict.mismatches} retained-channel samples differ from the source shifted by the published moves (first at ${(verdict.firstMismatch ?? 0) + from}, max ${verdict.maxAbsDifference})`
}

// A held live note on the edited (right) channel never goes quiet: no run of 1 ms of near-silence (a sine's zero crossing is a frame
// or two) and no NaN anywhere in a window.
const SILENT_RUN_SECONDS = 0.001
const SILENT_LEVEL = 1e-4
export const compareSustained = (input: { output: Pcm; seams: readonly number[]; endFrame: number }): Compare => {
  const { output, seams, endFrame } = input
  const longest = Math.round(output.sampleRate * SILENT_RUN_SECONDS)
  return (window) => {
    const from = seams[window.index - 1], to = seams[window.index] ?? endFrame
    if (from === undefined) return `no publication for edit ${window.index}`
    let run = 0
    for (let frame = from; frame < to; frame++) {
      const value = Math.abs(output.samples[frame * output.channels + 1] ?? NaN)
      run = value < SILENT_LEVEL ? run + 1 : 0
      if (!(value >= 0) || run >= longest) return `the held note drops out at frame ${frame} (${Number.isNaN(value) ? "no captured sample" : `${run} silent frames`})`
    }
    return undefined
  }
}

// A held note on the edited (right) channel stays smooth. The second difference of content slower than a tenth of the sample rate (a 440 Hz sine
// is 0.3 % of its level, the fixture's sample under 0.2 %) is a small fraction of its level, and a gain ramp adds less; a retrigger, a gap's edge
// or a gain step is a jump, and its second difference is the jump itself.
const SMOOTH_FRACTION = 0.02
export const compareSmooth = (input: { output: Pcm; seams: readonly number[]; endFrame: number }): Compare => {
  const { output, seams, endFrame } = input
  const at = (frame: number) => output.samples[frame * output.channels + 1] ?? NaN
  return (window) => {
    const from = seams[window.index - 1], to = seams[window.index] ?? endFrame
    if (from === undefined) return `no publication for edit ${window.index}`
    let peak = 0
    for (let frame = from; frame < to; frame++) peak = Math.max(peak, Math.abs(at(frame)))
    for (let frame = from + 2; frame < to; frame++) {
      const jump = Math.abs(at(frame) - 2 * at(frame - 1) + at(frame - 2))
      if (!(jump <= SMOOTH_FRACTION * peak)) return `the held note jumps at frame ${frame} (second difference ${jump} against a peak of ${peak})`
    }
    return undefined
  }
}
// The held-instrument rows: never silent, never a jump.
export const compareHeld = (input: { output: Pcm; seams: readonly number[]; endFrame: number }): Compare => {
  const sustained = compareSustained(input), smooth = compareSmooth(input)
  return (window) => sustained(window) ?? smooth(window)
}

// Ruling item 3: the deleted clip is absent after its fade, measured on the capture itself against its own pre-delete window. The
// right channel is the deleted clip's; the left channel (the retained source) must keep sounding, which is the one session carrying on.
const PRESENT_LEVEL = 0.01
const peakOf = (pcm: Pcm, channel: number, from: number, to: number) => {
  let peak = 0
  for (let frame = from; frame < to; frame++) peak = Math.max(peak, Math.abs(pcm.samples[frame * pcm.channels + channel] ?? NaN))
  return peak
}
// `audibleUntil` ends the window that must hold the clip when the sound stops before the seam (a crash precedes its isolation).
export const compareDelete = (input: { output: Pcm; seam: number; endFrame: number; audibleUntil?: number }): Compare => {
  const { output, seam, endFrame } = input
  const fade = fadeFramesFor(output.sampleRate)
  const audibleUntil = input.audibleUntil ?? seam
  return () => {
    const beforeFrom = audibleUntil - output.sampleRate / 2, afterFrom = seam + fade
    if (beforeFrom < 0 || endFrame - afterFrom < fade) return "the capture does not hold a window before and after the delete"
    const present = peakOf(output, 1, beforeFrom, audibleUntil)
    if (!(present >= PRESENT_LEVEL)) return `the clip is not audible before the delete (peak ${present}), so its absence proves nothing`
    const after1 = peakOf(output, 1, afterFrom, endFrame)
    if (!(after1 === 0)) return `the deleted clip still sounds after its fade (peak ${after1} against ${present} before)`
    const retained = peakOf(output, 0, afterFrom, endFrame)
    return retained >= PRESENT_LEVEL ? undefined : `the retained source stops after the delete (peak ${retained})`
  }
}

// The recording rows: the launch compared the take with the tone (verifyTakeAgainstTone) and stored its answer beside the row's edits.
// The take is the row's one output, so every window of the burst holds or fails with it.
export const takeFile = "take.json"
export const takeResult = z.object({ passed: z.boolean(), offset: z.number(), mismatches: z.number() })
export const compareTake = (take: z.infer<typeof takeResult>): Compare => () => take.passed ? undefined
  : `the take differs from the tone in ${take.mismatches} samples (first non-silent frame ${take.offset})`

// The burst plays in one transport epoch. The pause that ends it opens the next epoch at the frame it stopped on, and the blocks
// it renders there (its fade-out, then repeats of that frame) are not the timeline: indexed by frame they would overwrite the
// last played block.
export const playedBlocks = (blocks: readonly CaptureBlock[], firstEditWallMs: number) => {
  const owner = blocks.find((block) => block.transportFrame > 0 && block.wallMs >= firstEditWallMs)
  return owner && { owner, mine: blocks.filter((block) => block.pid === owner.pid && block.captureId === owner.captureId && block.transportEpoch === owner.transportEpoch) }
}

// No cold lifecycle event between the edit and the end of the capture: a delete is one session, never a stop and start. A session
// is begun (begin) and configured (device-configure, capture-configure) only when it is built.
export const lifecycleBetween = (events: readonly HostEvent[], fromWallMs: number, toWallMs: number) =>
  events.filter((event) => event.wallMs >= fromWallMs && event.wallMs <= toWallMs && /stop|teardown|begin|rebuild|host-exit|host-spawn|configure/i.test(event.event))

// The VST rows that judge on host evidence. A restart is a worker spawned again or a host restart request after the edit.
const restartsBetween = (events: readonly HostEvent[], fromWallMs: number, toWallMs: number) =>
  [...lifecycleBetween(events, fromWallMs, toWallMs), ...events.filter((event) => /^(worker-spawn|host-restart-request)$/.test(event.event) && event.wallMs >= fromWallMs && event.wallMs <= toWallMs)]
const named = (events: readonly HostEvent[]) => events.map((event) => event.event).join(", ")

// The rows whose edits drive the transport (PackagedRun.transport) observe it themselves: after each edit the launch marks the transport
// state, its playhead, the host pid and when the edit's cancelling command was issued, and the judge reads those marks with the host evidence.
export const nativeUnavailableReported = "native-unavailable"
export const transportObservation = z.object({ event: z.literal("transport-observed"), wallMs: z.number(), edit: z.string(), pid: z.number(), cancelWallMs: z.number(),
  state: z.string(), playheadSec: z.number(), failure: z.string() })
export type TransportObservation = z.infer<typeof transportObservation>
const positionToleranceSec = 0.001

// The audio host dies under a pending Play: the host is reported exited, the transport stays stopped, the app reports native unavailable,
// and nothing starts a session afterwards (a restarted host is the supervisor's, a started device or published graph would be a session).
export const compareHostLoss = (events: readonly HostEvent[], observations: readonly TransportObservation[]): Compare => (window) => {
  const killed = observations.find((observation) => observation.edit === "play-kill-host")
  if (!killed) return "the host kill was never observed"
  if (!events.some((event) => event.event === "host-exit" && event.pid === killed.pid && event.wallMs >= killed.cancelWallMs))
    return `the audio host ${killed.pid} was never reported exited after the kill`
  if (killed.state !== "stopped") return `the transport is ${killed.state} after the host was lost, not stopped`
  if (killed.failure !== nativeUnavailableReported) return "the app reported no native-unavailable fault"
  const started = events.filter((event) => /^(device-start-request|graph-publish)$/.test(event.event) && event.wallMs >= killed.cancelWallMs && event.wallMs <= window.toWallMs)
  return started.length ? `a session was started after the host was lost: ${named(started)}` : undefined
}

// A Pause or a Stop over a Play that has not landed cancels it: nothing stops, tears down, begins or configures after the cancel, the transport
// is paused where the prepared session was (a Stop reads stopped at 0: the transport reports not-playing at 0 as stopped), and the next Play
// resumes without any of them. "session-pause" only prepares.
export const compareCancelledStart = (input: { events: readonly HostEvent[]; observations: readonly TransportObservation[]; editName: (index: number) => string
  editWallMs: (index: number) => number }): Compare => (window) => {
  const name = input.editName(window.index), from = input.editWallMs(window.index)
  const seen = input.observations.find((observation) => observation.edit === name && observation.wallMs >= from && observation.wallMs <= window.fromWallMs)
  if (!seen) return `${name} observed no transport state`
  const expected = name === "play-resume" ? "playing" : name === "play-then-stop" ? "stopped" : "paused"
  if (seen.state !== expected) return `the transport is ${seen.state}, not ${expected}, after ${name}`
  const prepared = input.observations.filter((observation) => observation.wallMs < from).at(-1)
  if (name === "play-then-stop" && seen.playheadSec !== 0) return `the transport stopped at ${seen.playheadSec} s, not 0`
  if (name === "play-then-pause" && prepared && Math.abs(seen.playheadSec - prepared.playheadSec) > positionToleranceSec)
    return `the cancelled Play moved the paused position from ${prepared.playheadSec} s to ${seen.playheadSec} s`
  if (name === "session-pause") return undefined
  const cold = lifecycleBetween(input.events, name === "play-resume" ? from : seen.cancelWallMs, window.toWallMs)
  return cold.length ? `${name} stopped, tore down, began or configured the session: ${named(cold)}` : undefined
}

// The output-device rows: a device change is a rebuild of the session, not an edit, so there is no audio to compare. Each step of the row
// (ae-08-phase-9-output-device.ts) marks the host's lifecycle line counts before and after it, the transport, the saved output and what
// BlackHole heard while playing, and the judge reads what the step must have caused from those marks.
const lifecycleCounts = z.string().transform((text) => z.record(z.string(), z.number()).parse(JSON.parse(text)))
export const deviceObservation = z.object({ event: z.literal("device-switch-observed"), wallMs: z.number(), step: z.string(), before: lifecycleCounts, after: lifecycleCounts,
  state: z.string(), playheadSec: z.number(), saved: z.string(), blackhole: z.string(), consoleErrors: z.string(), stateReadRefusals: z.string(),
  deviceId: z.string().optional(), moved: z.boolean().optional(), stopped: z.boolean().optional(), refused: z.boolean().optional(), noticeShown: z.boolean().optional(),
  takeKeptBlackholeInput: z.boolean().optional(), secondTake: z.string().optional() })
export type DeviceObservation = z.infer<typeof deviceObservation>
// BlackHole's input while the transport plays: signal there means the session sounds on it, and the silence of an empty input is far lower.
const BLACKHOLE_AUDIBLE_DB = -60
const BLACKHOLE_SILENT_DB = -80
const blackholeLevels = z.object({ blackholeMeanDb: z.string(), blackholeMaxDb: z.string() })
// A second Start recording over a playing transport is declined by the host with this line; it changes nothing.
const declinedSecondPlay = /^\[native-vst3\] native play skipped: Playback was already marked active/

export const compareOutputDevice = (input: { observations: readonly DeviceObservation[]; editName: (index: number) => string; editWallMs: (index: number) => number
  instruments: boolean }): Compare => (window) => {
  const name = input.editName(window.index), from = input.editWallMs(window.index)
  // The previous step settles in the millisecond this one starts, so its observation is not this step's.
  const marks = input.observations.filter((mark) => mark.wallMs > from && mark.wallMs <= window.fromWallMs)
  const previous = input.observations.findLast((mark) => mark.wallMs <= from)
  const delta = (mark: DeviceObservation, event: string) => (mark.after[event] ?? NaN) - (mark.before[event] ?? NaN)
  const sessions = (mark: DeviceObservation) => delta(mark, "device-session"), rebuilds = (mark: DeviceObservation) => delta(mark, "structural-rebuild")
  const untouched = (mark: DeviceObservation) => Object.keys(mark.after).every((event) => delta(mark, event) === 0)
  for (const mark of marks) {
    if (mark.stateReadRefusals !== "[]") return `${mark.step}: a plug-in state read was refused ${mark.stateReadRefusals}`
    const errors = z.array(z.string()).parse(JSON.parse(mark.consoleErrors)).filter((error) => !declinedSecondPlay.test(error))
    if (errors.length) return `${mark.step}: the app reported ${errors[0]}`
    if (delta(mark, "host-exit") !== 0) return `${mark.step}: the audio host exited`
    if (delta(mark, "host-spawn") > (window.index === 1 ? 1 : 0)) return `${mark.step}: another audio host was spawned`
    // The saved output is where the session sounds: a playing transport is heard on BlackHole exactly when BlackHole is the saved output.
    if (mark.state === "playing" && mark.saved !== "") {
      const levels = blackholeLevels.safeParse(mark.blackhole.startsWith("{") ? JSON.parse(mark.blackhole) : {})
      const mean = levels.success ? Number(levels.data.blackholeMeanDb) : NaN, max = levels.success ? Number(levels.data.blackholeMaxDb) : NaN
      if (!(mean <= 0)) return `${mark.step}: BlackHole's level was not measured while playing`
      if (mark.saved.includes("BlackHole") && !(mean > BLACKHOLE_AUDIBLE_DB)) return `${mark.step}: playing on BlackHole but it hears ${mean} dB`
      if (!mark.saved.includes("BlackHole") && !(max < BLACKHOLE_SILENT_DB)) return `${mark.step}: playing on ${mark.saved} but BlackHole still hears ${max} dB`
    }
    // A rebuilt session brings its plug-in worker (spawned and ready) and the sampler's assets back. The row's first Play also starts the editor
    // window's host and worker, which may still be starting when the step is observed, so only its ready worker is required there.
    const workersBack = delta(mark, "worker-ready") >= 1 && (window.index === 1 || delta(mark, "worker-ready") === delta(mark, "worker-spawn"))
    if (input.instruments && rebuilds(mark) >= 1 && !(workersBack && delta(mark, "worker-spawn") >= 1 && delta(mark, "asset-install") >= 1))
      return `${mark.step}: the rebuilt session has no plug-in worker ready (${delta(mark, "worker-spawn")} spawned, ${delta(mark, "worker-ready")} ready) or no sampler assets (${delta(mark, "asset-install")} installed)`
  }
  const [mark] = marks
  if (!mark) return `${name} observed no device state`
  const positionTolerance = 0.001
  const resumed = previous === undefined || mark.playheadSec > previous.playheadSec + 0.1
  const heldPosition = previous === undefined || Math.abs(mark.playheadSec - previous.playheadSec) <= positionTolerance
  const movedTo = mark.moved === true && mark.saved === mark.deviceId
  if (/^out-play(-|$)/.test(name) && name !== "out-play-with-missing") {
    if (mark.state !== "playing") return `the transport is ${mark.state} after Play`
    if (previous && (mark.playheadSec < previous.playheadSec - positionTolerance || mark.playheadSec > previous.playheadSec + 1)) return `Play moved the playhead from ${previous.playheadSec} s to ${mark.playheadSec} s`
    // The row's first Play builds the session (and starts the host); a later Play rebuilds it at most once.
    return previous === undefined || (sessions(mark) <= 1 && rebuilds(mark) <= 1) ? undefined : `Play rebuilt the session ${sessions(mark)} times`
  }
  if (name.startsWith("out-pause")) {
    if (mark.state !== "paused") return `the transport is ${mark.state} after Pause`
    return sessions(mark) === 0 && rebuilds(mark) === 0 ? undefined : "Pause rebuilt the session"
  }
  if (name === "out-to-blackhole-playing" || name === "out-to-speakers-playing") {
    if (!movedTo) return `the saved output ${mark.saved} is not the chosen ${mark.deviceId} or the host never moved`
    if (mark.state !== "playing") return `the transport is ${mark.state} after the output changed while playing`
    if (!resumed) return `playback did not resume on the new device (playhead ${mark.playheadSec} s after ${previous?.playheadSec} s)`
    return sessions(mark) === 1 && rebuilds(mark) === 1 && delta(mark, "device-start-request") === 1 ? undefined
      : `the switch rebuilt ${sessions(mark)} sessions and ${rebuilds(mark)} graphs, and started ${delta(mark, "device-start-request")} devices, not one each`
  }
  if (name === "out-reselect-speakers-playing") {
    if (mark.state !== "playing" || !resumed) return "the unchanged output interrupted playback"
    return untouched(mark) ? undefined : "choosing the output already in use rebuilt the session"
  }
  if (name === "out-to-blackhole-paused" || name === "out-to-speakers-paused") {
    if (!movedTo) return `the saved output ${mark.saved} is not the chosen ${mark.deviceId} or the host never moved`
    if (mark.state !== "paused" || !heldPosition) return `the output change while paused left the transport ${mark.state} at ${mark.playheadSec} s`
    return sessions(mark) <= 1 && rebuilds(mark) <= 1 ? undefined : "the output change while paused rebuilt the session more than once"
  }
  if (name === "out-to-missing-playing") {
    if (mark.stopped !== true || mark.noticeShown !== true) return "the missing output stopped no playback or reported no notice"
    return mark.state !== "playing" && sessions(mark) === 0 && delta(mark, "device-start-request") === 0 ? undefined : "the missing output left the transport playing or started a device"
  }
  if (name === "out-play-with-missing") {
    if (mark.refused !== true || mark.noticeShown !== true) return "Play over the missing output was not refused with a notice"
    return mark.state !== "playing" && sessions(mark) === 0 && delta(mark, "device-start-request") === 0 ? undefined : "Play over the missing output started a device"
  }
  if (name === "out-restore-speakers") {
    if (!movedTo || mark.state === "playing") return "restoring the output moved nothing or started the transport"
    return sessions(mark) === 0 ? undefined : "restoring the output while stopped rebuilt the session"
  }
  if (name === "out-recording-keeps-devices") {
    const stepNamed = (step: string) => marks.find((entry) => entry.step === step)
    const during = stepNamed("change-devices-during-take"), finished = stepNamed("recording-finished"), next = stepNamed("next-take")
    if (!during || !finished || !next) return "the take's three observations are not all there"
    if (!untouched(during) || during.noticeShown !== true) return "the take's devices changed, or no notice said they apply after it"
    if (finished.takeKeptBlackholeInput !== true) return "the take did not keep BlackHole's tone as its input"
    if (finished.moved !== true || sessions(finished) !== 1) return `the output did not move once after the take (${sessions(finished)} sessions)`
    return next.secondTake?.startsWith("tone heard: true") ? "the next take still heard BlackHole's tone, not the new saved input" : undefined
  }
  return `no expectation for ${name}`
}

// An edit of a plug-in row never restarts the playing host: nothing stops, tears down, begins or configures on it, and the only worker it
// starts is an insert's own (a removal or a parameter change starts none). The editor window's host is another process (another pid).
export const compareNoRestart = (input: { events: readonly HostEvent[]; hostPid: number; editWallMs: (index: number) => number; workerSpawns: (index: number) => number }): Compare => (window) => {
  const from = input.editWallMs(window.index)
  const mine = input.events.filter((event) => event.pid === input.hostPid)
  const cold = lifecycleBetween(mine, from, window.toWallMs)
  if (cold.length) return `the edit stopped, tore down or rebuilt the playing host: ${named(cold)}`
  const spawned = mine.filter((event) => /^(worker-spawn|host-restart-request)$/.test(event.event) && event.wallMs >= from && event.wallMs <= window.toWallMs)
  const expected = input.workerSpawns(window.index)
  return spawned.length === expected && spawned.every((event) => event.event === "worker-spawn") ? undefined
    : `the edit started ${spawned.length} workers or restarts (${named(spawned) || "none"}), expected ${expected} worker`
}

// An edit made while the editor is open publishes in place: after any step the editor is never reported closed and nothing restarts.
export const compareEditor = (events: readonly HostEvent[], playingPid: number, editWallMs: (index: number) => number): Compare => (window) => {
  const from = editWallMs(window.index)
  const closed = events.filter((event) => event.event === "vst-editor-state" && event.open === false && event.wallMs >= from && event.wallMs <= window.toWallMs)
  if (closed.length) return "the editor was reported closed after the edit"
  const restarted = restartsBetween(events.filter((event) => event.pid === playingPid), from, window.toWallMs)
  return restarted.length ? `the edit restarted something: ${named(restarted)}` : undefined
}

// The failed plug-in is muted on its own, nothing replaces or restarts it, and the unrelated source keeps sounding: the delete row's capture
// check (the plug-in's channel is silent after the fade, never a dry fallback), with nothing restarted.
// The worker dies on its next process call, long before the host reports the isolation (the seam), so the plug-in is audible only up to the edit.
export const compareFault = (input: { events: readonly HostEvent[]; output: Pcm; seam: number; editFrame: number; endFrame: number; editWallMs: number }): Compare => (window) => {
  const restarted = restartsBetween(input.events, input.editWallMs, window.toWallMs)
  return restarted.length ? `the fault restarted or replaced something: ${named(restarted)}` : compareDelete({ ...input, audibleUntil: input.editFrame })(window)
}

// A refused insert changes nothing: no graph is requested or published and nothing restarts.
export const compareTrust = (events: readonly HostEvent[], editWallMs: number): Compare => (window) => {
  const changed = [...restartsBetween(events, editWallMs, window.toWallMs), ...events.filter((event) => /^graph-publish(-request)?$/.test(event.event) && event.wallMs >= editWallMs && event.wallMs <= window.toWallMs)]
  return changed.length ? `the refused insert changed the session: ${named(changed)}` : undefined
}

// The override (odd steps) holds the built-in lane out of the native schedule: a publication follows the drag and none of the schedule
// windows sent until the re-enable carries a lane event, so the lane cannot move the value. The re-enable (even steps) publishes the
// windows with the lane again. The lane is judged on the schedule windows the main process sent (audio-host.ts schedule-window lines).
export const compareLane = (events: readonly HostEvent[], editWallMs: (index: number) => number): Compare => (window) => {
  const from = editWallMs(window.index)
  const laneEvents = events.filter((event) => event.event === "schedule-window" && event.wallMs >= from && event.wallMs < window.toWallMs)
    .reduce((total, event) => total + event.processorAutomationEvents, 0)
  const published = events.some((event) => event.event === "graph-publish" && event.cause === "block-boundary" && event.publicationFrame > 0 && event.wallMs >= from && event.wallMs < window.toWallMs)
  if (!published) return "no schedule publication followed the edit"
  if (window.index % 2 === 1) return laneEvents === 0 ? undefined : `${laneEvents} lane events were still scheduled after the manual override, so the lane would move the value`
  return laneEvents > 0 ? undefined : "the re-enabled lane's schedule windows carry no lane event"
}

// The live output holds every path back by the pinned latency budget, which only rises while playing: a state's offline export starts on
// the timeline (no budget), so it is compared delayed by it.
export const delayedBy = (pcm: Pcm, frames: number): Pcm => frames === 0 ? pcm
  : { ...pcm, samples: Float32Array.from({ length: pcm.samples.length }, (_, index) => index < frames * pcm.channels ? 0 : pcm.samples[index - frames * pcm.channels] ?? NaN) }
// A plug-in row's edited (right) channel is swapped between the plug-in's output and the path that replaces it for one transport block (the
// pinned budget) plus the 10 ms compensation crossfade after the publication. Those frames are not compared; the retained channel always is.
// A frame the capture never covered stays NaN and still fails.
export const withoutSwap = (output: Pcm, states: readonly Pcm[], seams: readonly number[], swapFrames: number): Pcm => {
  const samples = Float32Array.from(output.samples)
  seams.forEach((seam, edit) => {
    for (let frame = seam; frame < seam + swapFrames; frame++) {
      const index = frame * output.channels + 1
      if (Number.isFinite(samples[index])) samples[index] = states[edit + 1]?.samples[index] ?? NaN
    }
  })
  return { ...output, samples }
}
// An import lands at the playhead, which differs per cycle, while the reference export imports at 0 (the launch asserts it). The clip's
// sound is the same shifted in time, so the state an import enters is the reference with the edited (right) channel moved to the start
// the live clip actually took; the frames before it are the state that was left (the clip's absence).
export const placedAt = (present: Pcm, absent: Pcm, startSec: number): Pcm => {
  const start = Math.round(startSec * present.sampleRate)
  const samples = Float32Array.from(present.samples)
  for (let frame = 0; frame < samples.length / present.channels; frame++) {
    const index = frame * present.channels + 1
    samples[index] = (frame < start ? absent.samples[index] : present.samples[index - start * present.channels]) ?? NaN
  }
  return { ...present, samples }
}

const logged = z.object({ edits: z.array(z.object({ index: z.number(), name: z.string(), wallMs: z.number(), settledWallMs: z.number().optional(), publicationFrame: z.number(),
  fromLatencyFrames: z.number(), toLatencyFrames: z.number(), startSec: z.number().optional() })) })
const publicationLine = z.object({ event: z.literal("graph-publish"), cause: z.string(), pid: z.number(), wallMs: z.number(), transportEpoch: z.number(),
  publicationFrame: z.number(), graphLatencyFrames: z.number(), pinnedLatencyFrames: z.number() })
const nativeLines = (text: string) => text.slice(0, text.lastIndexOf("\n") + 1).split("\n").filter(Boolean).map((line) => JSON.parse(line))

// Judges one stored row of a launch: steps and seams from its phase9-edits.json, the capture from the launch folder.
// `stateFile` names the offline export of a state (only "states" rows read it).
export const judgeRowCapture = async (input: { launchOut: string; directory: string; row: Row; stateFile: (state: string) => string; captureEndWallMs: number
  natives: readonly string[] }): Promise<BurstVerdict> => {
  const { launchOut, directory, row } = input
  const { edits } = logged.parse(JSON.parse(await readFile(path.join(directory, "phase9-edits.json"), "utf8")))
  const steps = [...Map.groupBy(edits, (edit) => edit.index)].map(([index, group]) => ({ index, name: group[0]?.name ?? "", editWallMs: Math.min(...group.map((edit) => edit.wallMs)),
    settledWallMs: group[0]?.settledWallMs, publicationFrame: group[0]?.publicationFrame ?? 0, startSec: group.find((edit) => edit.startSec !== undefined)?.startSec }))
  if (row.judge === "take") return judgeBurst(steps, input.captureEndWallMs, compareTake(takeResult.parse(JSON.parse(await readFile(path.join(directory, takeFile), "utf8")))))
  const marksOf = async <Mark>(schema: z.ZodType<Mark>) => (await readFile(path.join(launchOut, "actions.jsonl"), "utf8")).split("\n").filter(Boolean)
    .flatMap((line) => { const observed = schema.safeParse(JSON.parse(line)); return observed.success ? [observed.data] : [] })
  const stepNamed = (index: number) => steps.find((step) => step.index === index)
  if (row.judge === "output-device") {
    const compare = compareOutputDevice({ observations: await marksOf(deviceObservation), editName: (index) => stepNamed(index)?.name ?? "", editWallMs: (index) => stepNamed(index)?.editWallMs ?? 0,
      instruments: row.prepare?.includes("vst-insert") === true })
    return judgeBurst(steps, input.captureEndWallMs, compare, 0)
  }
  if (row.judge === "host-loss" || row.judge === "cancelled-start") {
    const events = (await Promise.all(["host.jsonl", ...input.natives].map((name) => readFile(path.join(launchOut, name), "utf8")))).flatMap(parseHostLines)
    const observations = await marksOf(transportObservation)
    const compare = row.judge === "host-loss" ? compareHostLoss(events, observations)
      : compareCancelledStart({ events, observations, editName: (index) => stepNamed(index)?.name ?? "", editWallMs: (index) => stepNamed(index)?.editWallMs ?? 0 })
    return judgeBurst(steps, input.captureEndWallMs, compare, 0)
  }
  const texts = await Promise.all(input.natives.map((name) => readFile(path.join(launchOut, name), "utf8")))
  const blocks = texts.flatMap(nativeLines).flatMap((entry) => entry.event === "capture-block" ? [captureBlock.parse(entry)] : [])
  const played = playedBlocks(blocks, steps[0]?.editWallMs ?? 0)
  if (!played) return { outcome: "setup", detail: "no capture blocks after the first edit", judged: 0 }
  const { owner, mine } = played
  const hostEvents = texts.flatMap(parseHostLines)
  const editWallMs = (index: number) => steps.find((step) => step.index === index)?.editWallMs ?? 0
  // Opening an editor starts a second host process for the editor window; its own startup is not a restart of the playing host (owner.pid).
  if (row.judge === "editor") return judgeBurst(steps, input.captureEndWallMs, compareEditor(hostEvents, owner.pid, editWallMs))
  if (row.judge === "trust") return judgeBurst(steps, input.captureEndWallMs, compareTrust(hostEvents, editWallMs(1)))
  const capture = await readWav(path.join(launchOut, `output-${owner.pid}-${owner.captureId}.wav`))
  const seams = steps.map((step) => step.publicationFrame)
  const captured = Math.max(...mine.map((block) => block.transportFrame + block.frames))
  const firstEditWallMs = steps[0]?.editWallMs ?? 0
  const hostPublications = texts.flatMap(nativeLines).flatMap((entry) => {
    const line = publicationLine.safeParse(entry)
    return line.success && line.data.pid === owner.pid ? [line.data] : []
  })
  const launchPublications = hostPublications.filter((line) => line.cause === "block-boundary" && line.transportEpoch === owner.transportEpoch && line.publicationFrame > 0).sort((a, b) => a.publicationFrame - b.publicationFrame)
  // The budget the host pinned before the burst (in whatever epoch): every path is held back by it.
  const pinnedBefore = hostPublications.sort((a, b) => a.wallMs - b.wallMs).findLast((line) => line.wallMs < firstEditWallMs)?.pinnedLatencyFrames
  const stepEdits = (index: number) => row.cycle[(index - 1) % row.cycle.length]?.edits ?? []
  const restartFree = row.repeat === "vst-burst"
    ? compareNoRestart({ events: hostEvents, hostPid: owner.pid, editWallMs, workerSpawns: (index) => stepEdits(index).filter((edit) => edit === "vst-insert").length })
    : () => undefined
  const guarded = (compare: Compare): Compare => (window) => restartFree(window) ?? compare(window)
  if (row.judge === "states") {
    const [initial, ...entered] = await Promise.all([row.start, ...steps.map((step) => row.cycle[(step.index - 1) % row.cycle.length]?.state ?? "")]
      .map((state) => readWav(input.stateFile(row.reference ?? state))))
    const states = initial ? [initial, ...entered.map((state, position) => {
      const startSec = steps[position]?.startSec
      return startSec === undefined ? state : placedAt(state, initial, startSec)
    })].map((state) => delayedBy(state, pinnedBefore ?? 0)) : []
    const endFrame = Math.min(captured, ...states.map((state) => state.samples.length / state.channels))
    const entries = steps.map((step) => row.cycle[(step.index - 1) % row.cycle.length]?.entry)
    const live = transportIndexed(capture, mine, endFrame)
    const output = row.reference === undefined ? live : withoutSwap(live, states, seams, (pinnedBefore ?? 0) + Math.round(live.sampleRate * 0.01))
    return judgeBurst(steps, input.captureEndWallMs, guarded(compareStates({ output, states, seams, entries, endFrame })))
  }
  const output = transportIndexed(capture, mine, captured)
  if (row.judge === "lane") {
    // The schedule-window lines are the main process's, in the launch's host.jsonl.
    const events = parseHostLines(await readFile(path.join(launchOut, "host.jsonl"), "utf8"))
    return judgeBurst(steps, input.captureEndWallMs, compareLane(events, editWallMs))
  }
  if (row.judge === "latency") {
    const publications = launchPublications.filter((line) => line.wallMs >= firstEditWallMs && line.wallMs <= input.captureEndWallMs)
    const startingPinned = launchPublications.findLast((line) => line.wallMs < firstEditWallMs)?.pinnedLatencyFrames ?? edits[0]?.fromLatencyFrames ?? 0
    const rowEnd = Math.max(...mine.filter((block) => block.wallMs <= input.captureEndWallMs).map((block) => block.transportFrame + block.frames))
    return judgeBurst(steps, input.captureEndWallMs, guarded(compareLatencyMoves({ output, edits, publications, startingPinned, endFrame: Math.min(captured, rowEnd) })))
  }
  if (row.judge === "held") return judgeBurst(steps, input.captureEndWallMs, compareHeld({ output, seams, endFrame: captured }))
  if (row.judge === "sustained") return judgeBurst(steps, input.captureEndWallMs, compareSustained({ output, seams, endFrame: captured }))
  if (row.judge === "fault") return judgeBurst(steps, input.captureEndWallMs, compareFault({ events: hostEvents, output, seam: seams[0] ?? 0,
    editFrame: mine.find((block) => block.wallMs >= editWallMs(1))?.transportFrame ?? 0, endFrame: captured, editWallMs: editWallMs(1) }))
  if (row.judge === "delete") {
    const cold = lifecycleBetween(hostEvents, steps[0]?.editWallMs ?? 0, input.captureEndWallMs)
    if (cold.length) return { outcome: "fail", editIndex: 1, detail: `the delete stopped or restarted the session: ${cold.map((event) => event.event).join(", ")}`, judged: 1 }
    return judgeBurst(steps, input.captureEndWallMs, compareDelete({ output, seam: seams[0] ?? 0, endFrame: captured }))
  }
  return { outcome: "pass", judged: steps.length }
}

// ---- Self-test ----
const check = (condition: boolean, message: string) => { if (!condition) throw new Error(`phase 9 compare self-test: ${message}`) }

export const selfTest = () => {
  const sampleRate = 48000, channels = 2, fade = fadeFramesFor(sampleRate), window = 2 * sampleRate, edits = 6
  const seams = Array.from({ length: edits }, (_, edit) => sampleRate + edit * window), endFrame = sampleRate + edits * window
  const state = (index: number): Pcm => {
    const samples = new Float32Array(endFrame * channels)
    for (let frame = 0; frame < endFrame; frame++) {
      samples[frame * channels] = 0.1 * Math.sin(frame * 0.027)
      samples[frame * channels + 1] = 0.1 * Math.sin(frame * (index % 2 ? 0.061 : 0.043) + index)
    }
    return { sampleRate, channels, samples }
  }
  const states = Array.from({ length: edits + 1 }, (_, index) => state(index))
  // What the engine renders: each window enters its state over the fade on the edited channel and holds it exactly on the retained one.
  const render = (defect?: (output: Pcm) => void): Pcm => {
    const samples = Float32Array.from(states[0]?.samples ?? [])
    seams.forEach((from, edit) => {
      for (let frame = from; frame < (seams[edit + 1] ?? endFrame); frame++) {
        const fadeOut = Math.max(0, Math.fround(1 - Math.fround((frame - from) / fade)))
        const index = frame * channels
        samples[index] = states[edit + 1]?.samples[index] ?? NaN
        samples[index + 1] = Math.fround((states[edit]?.samples[index + 1] ?? NaN) * fadeOut + (states[edit + 1]?.samples[index + 1] ?? NaN) * (1 - fadeOut))
      }
    })
    const output = { sampleRate, channels, samples }
    defect?.(output)
    return output
  }
  const steps = seams.map((seam, position) => ({ index: position + 1, editWallMs: position * 4000, settledWallMs: position * 4000 + 1500, publicationFrame: seam }))
  const verdictOf = (compare: Compare) => judgeBurst(steps, edits * 4000 + 4000, compare)
  // A take that is not the tone fails the row at its first edit; the answer's file name is the one the launch writes.
  check(verdictOf(compareTake({ passed: true, offset: 1200, mismatches: 0 })).outcome === "pass", "a take equal to the tone passes")
  const badTake = verdictOf(compareTake({ passed: false, offset: 1200, mismatches: 7 }))
  check(badTake.outcome === "fail" && badTake.editIndex === 1 && /7 samples/.test(badTake.detail ?? ""), `a take that differs from the tone fails: ${JSON.stringify(badTake)}`)
  check(takeResult.safeParse({ passed: true }).success === false, "the stored answer names passed, offset and mismatches")
  const states9 = (output: Pcm, entries: Step["entry"][] = []) => verdictOf(compareStates({ output, states, seams, entries, endFrame }))
  check(states9(render()).outcome === "pass", "a clean burst passes")
  // A restored track or a decoded asset sounds from its publication; a removed track also fades over 5 ms (the ghost) inside the 6 ms.
  const entered = (entry: "cut" | "ghost") => render((output) => {
    const from = seams[2] ?? 0
    for (let frame = from; frame < (seams[3] ?? 0); frame++) {
      const index = frame * channels + 1, next = states[3]?.samples[index] ?? NaN
      const ghost = entry === "ghost" ? Math.max(0, Math.fround(1 - Math.fround((frame - from) / Math.round(sampleRate * 0.005)))) : 0
      const fadeOut = Math.max(0, Math.fround(1 - Math.fround((frame - from) / fade)))
      output.samples[index] = entry === "cut" ? next : Math.fround(Math.fround((states[2]?.samples[index] ?? NaN) * ghost) * fadeOut + next * (1 - fadeOut))
    }
  })
  const declared = (entry: "cut" | "ghost") => [undefined, undefined, entry]
  check(states9(entered("cut"), declared("cut")).outcome === "pass" && states9(entered("ghost"), declared("ghost")).outcome === "pass", "a cut and a ghost entry pass when the step declares them")
  const undeclaredCut = states9(entered("cut")), undeclaredGhost = states9(entered("ghost"))
  check(undeclaredCut.outcome === "fail" && undeclaredCut.editIndex === 3 && undeclaredGhost.outcome === "fail" && undeclaredGhost.editIndex === 3, "a cut or a ghost the step does not declare fails")
  check(states9(render(), declared("cut")).outcome === "fail" && states9(render(), declared("ghost")).outcome === "fail", "a plain crossfade fails a step that declares a cut or a ghost")
  const held = states9(render((output) => { for (let frame = seams[2] ?? 0; frame < (seams[3] ?? 0); frame++) output.samples[frame * channels + 1] = states[2]?.samples[frame * channels + 1] ?? NaN }))
  check(held.outcome === "fail" && held.editIndex === 3, `a publication that holds the old state fails at its own edit: ${JSON.stringify(held)}`)
  const click = states9(render((output) => { output.samples[((seams[4] ?? 0) + 5000) * channels] += 1e-3 }))
  check(click.outcome === "fail" && click.editIndex === 5, `a click on the retained channel fails at its edit: ${JSON.stringify(click)}`)
  const gap = states9(render((output) => { for (let frame = (seams[1] ?? 0) + 9000; frame < (seams[1] ?? 0) + 9100; frame++) output.samples[frame * channels] = NaN }))
  check(gap.outcome === "fail" && gap.editIndex === 2, `frames no capture block covered fail: ${JSON.stringify(gap)}`)
  const crowded = judgeBurst(steps.map((step, position) => position === 2 ? { ...step, publicationFrame: (seams[1] ?? 0) + fade - 1 } : step), 100_000,
    compareStates({ output: render(), states, seams: [seams[0] ?? 0, seams[1] ?? 0, (seams[1] ?? 0) + fade - 1, ...seams.slice(3)], entries: [], endFrame }))
  check(crowded.outcome === "fail", "a window shorter than the fade fails")
  check(states9({ ...render(), sampleRate: 44100 }).outcome === "fail", "a capture at another rate fails")
  // The capture is rebuilt by transport frame; an uncovered frame is NaN.
  const capture: Pcm = { sampleRate, channels, samples: Float32Array.from({ length: 8 }, (_, index) => index + 1) }
  const indexed = transportIndexed(capture, [{ event: "capture-block", pid: 1, captureId: 1, transportEpoch: 1, transportFrame: 10, offset: 0, frames: 2, wallMs: 0 },
    { event: "capture-block", pid: 1, captureId: 1, transportEpoch: 1, transportFrame: 13, offset: 2, frames: 2, wallMs: 0 }], 16)
  check(indexed.samples[20] === 1 && indexed.samples[23] === 4 && Number.isNaN(indexed.samples[24]) && indexed.samples[26] === 5 && Number.isNaN(indexed.samples[0]), "capture blocks land at their transport frames, the rest is NaN")
  // The pause that ends a burst repeats its stop frame in the next epoch; those blocks are not part of the played timeline.
  const block = (transportEpoch: number, transportFrame: number, offset: number): CaptureBlock => ({ event: "capture-block", pid: 1, captureId: 1, transportEpoch, transportFrame, offset, frames: 512, wallMs: 5 })
  const tail = playedBlocks([block(2, 0, 0), block(3, 512, 512), block(3, 1024, 1024), block(4, 1536, 1536), block(4, 1536, 2048)], 1)
  check(tail?.mine.map((entry) => entry.transportFrame).join() === "512,1024", `blocks after the pause are not the timeline: ${tail?.mine.map((entry) => entry.transportFrame).join()}`)
  // A held live note must sound in every 10 ms block of every window.
  const sine = (silence?: [number, number]): Pcm => {
    const samples = new Float32Array(endFrame * channels)
    for (let frame = 0; frame < endFrame; frame++) samples[frame * channels + 1] = silence && frame >= silence[0] && frame < silence[1] ? 0 : 0.2 * Math.sin(frame * 0.0576)
    return { sampleRate, channels, samples }
  }
  check(verdictOf(compareSustained({ output: sine(), seams, endFrame })).outcome === "pass", "a held note that never drops passes")
  const dropped = verdictOf(compareSustained({ output: sine([(seams[3] ?? 0) + 3000, (seams[3] ?? 0) + 3600]), seams, endFrame }))
  check(dropped.outcome === "fail" && dropped.editIndex === 4, `a 12 ms dropout fails at its window: ${JSON.stringify(dropped)}`)
  // A delete: the right channel (the deleted clip) is silent after the fade, audible before; the left (retained) keeps sounding.
  const seam = seams[0] ?? 0
  const deleted = (right: (frame: number) => number, left: (frame: number) => number): Pcm => {
    const samples = new Float32Array(endFrame * channels)
    for (let frame = 0; frame < endFrame; frame++) { samples[frame * channels] = left(frame); samples[frame * channels + 1] = right(frame) }
    return { sampleRate, channels, samples }
  }
  const tone = (frame: number) => 0.2 * Math.sin(frame * 0.0576)
  const once = (output: Pcm) => judgeBurst(steps.slice(0, 1), 10_000, compareDelete({ output, seam, endFrame }))
  check(once(deleted((frame) => frame < seam + fade ? tone(frame) : 0, tone)).outcome === "pass", "a clip that is gone after its fade passes")
  check(once(deleted(tone, tone)).outcome === "fail", "a clip that still sounds after the delete fails")
  check(once(deleted((frame) => frame < seam ? 0 : 0, tone)).outcome === "fail", "a clip that never sounded proves nothing")
  check(once(deleted((frame) => frame < seam + fade ? tone(frame) : 0, (frame) => frame < seam ? tone(frame) : 0)).outcome === "fail", "a retained source that stops with the delete fails")
  // An import places its clip at the playhead: the live output holds the present state shifted to that start. The reference built at 0
  // fails against it; the reference moved to the same start passes.
  const absent = deleted(() => 0, tone), present = deleted((frame) => tone(frame * 1.7 + 3), tone)
  const start = 1, importSeam = seams[0] ?? 0
  const live = deleted((frame) => frame < start * sampleRate ? 0 : tone((frame - start * sampleRate) * 1.7 + 3), tone)
  const importWindow = (reference: Pcm) => judgeBurst(steps.slice(0, 1), 10_000, compareStates({ output: live, states: [absent, reference], seams: [importSeam], entries: ["cut"], endFrame }))
  check(importWindow(placedAt(present, absent, start)).outcome === "pass", "a reference placed at the live clip's start passes")
  const unplaced = importWindow(present)
  check(unplaced.outcome === "fail" && unplaced.editIndex === 1, `a reference built at 0 against a clip placed later fails: ${JSON.stringify(unplaced)}`)
  // A raise row: the Spectral on the master path goes 700 to 4300 frames of latency and back, twice. Only the first raise moves the
  // pinned budget, so only it shifts the retained channel (by 3600 frames); the lowers and the second raise move nothing.
  const low = 700, high = 4300, latencyEnd = 800_000, publicationFrames = [100_000, 300_000, 500_000, 700_000]
  const latencyEdits: LatencyEdit[] = [low, high, low, high].map((from, edit) => ({ name: edit % 2 ? "fft-512" : "fft-4096", fromLatencyFrames: from,
    toLatencyFrames: from === low ? high : low, wallMs: 1000 + edit * 4000 }))
  const reportedBy = (reports: readonly { graph: number; pinned: number }[]): LatencyPublication[] => publicationFrames.map((publicationFrame, index) =>
    ({ wallMs: 2500 + index * 4000, publicationFrame, graphLatencyFrames: reports[index]?.graph ?? NaN, pinnedLatencyFrames: reports[index]?.pinned ?? NaN }))
  const honest = [{ graph: high, pinned: high }, { graph: low, pinned: high }, { graph: high, pinned: high }, { graph: low, pinned: high }]
  const retainedAfter = (shifts: readonly { publicationFrame: number; raiseFrames: number }[], initial = low): Pcm => {
    const samples = new Float32Array(latencyEnd * channels).fill(0.5)
    for (let frame = 0; frame < latencyEnd; frame++) {
      let shift = initial, gain = 1
      for (const move of shifts) {
        const seamAt = move.publicationFrame + 240
        if (frame >= seamAt) shift += move.raiseFrames
        if (frame >= move.publicationFrame && frame < seamAt + 240) gain *= frame < seamAt ? (seamAt - frame) / 240 : (frame - seamAt) / 240
      }
      samples[frame * channels] = frame < shift ? 0 : Math.fround(sourceThroughTrack(frame - shift) * Math.fround(gain))
    }
    return { sampleRate, channels, samples }
  }
  const raised = (frames: number) => [{ publicationFrame: publicationFrames[0] ?? 0, raiseFrames: frames }]
  const latencySteps = latencyEdits.map((edit, position) => ({ index: position + 1, editWallMs: edit.wallMs, settledWallMs: edit.wallMs + 1500 }))
  const raiseRow = (output: Pcm, reports = honest, publications = reportedBy(reports), startingPinned = low) =>
    judgeBurst(latencySteps, 20_000, compareLatencyMoves({ output, edits: latencyEdits, publications, startingPinned, endFrame: latencyEnd }))
  check(raiseRow(retainedAfter(raised(high - low))).outcome === "pass", "a raise row whose master path follows the declared moves passes")
  const monitored = raiseRow(retainedAfter([], 0), [0, 0, 0, 0].map(() => ({ graph: 0, pinned: 0 })))
  check(monitored.outcome === "fail" && monitored.editIndex === 1 && /published latency 0\/0/.test(monitored.detail ?? ""), `a fixture whose Spectral is monitored reports 0 and fails at the first publication: ${JSON.stringify(monitored)}`)
  const lostLower = raiseRow(retainedAfter(raised(high - low)), honest.map((report, index) => index === 1 ? { ...report, graph: high } : report))
  check(lostLower.outcome === "fail" && lostLower.editIndex === 2, `a lower that is reported as the pinned level fails at its own edit: ${JSON.stringify(lostLower)}`)
  const wrongShift = raiseRow(retainedAfter(raised(high - low + 1)))
  check(wrongShift.outcome === "fail" && wrongShift.editIndex === 1, `a raise that shifts by one frame too many fails at its edit: ${JSON.stringify(wrongShift)}`)
  const atUnity = retainedAfter(raised(high - low))
  const untouchedByTrackVolume = raiseRow({ ...atUnity, samples: atUnity.samples.map((sample) => Math.fround(sample / defaultTrackVolume)) })
  check(untouchedByTrackVolume.outcome === "fail" && untouchedByTrackVolume.editIndex === 1, `a retained channel that skipped the track volume fails: ${JSON.stringify(untouchedByTrackVolume)}`)
  // A row merged after another that already raised the budget starts at `high`: its own first raise moves nothing, and an earlier raise
  // in the capture is not its own.
  const absorbed = raiseRow(retainedAfter([], high), honest, reportedBy(honest), high)
  check(absorbed.outcome === "pass", `a row that starts at a budget already raised passes without a shift: ${JSON.stringify(absorbed)}`)
  const wrongStart = raiseRow(retainedAfter([], high), honest, reportedBy(honest), low)
  check(wrongStart.outcome === "fail" && wrongStart.editIndex === 1, `a row judged from the wrong starting budget fails at its first edit: ${JSON.stringify(wrongStart)}`)
  const earlierRaise = retainedAfter([{ publicationFrame: 20_000, raiseFrames: 900 }, { publicationFrame: publicationFrames[0] ?? 0, raiseFrames: high - low - 900 }], low)
  const foreign = judgeBurst(latencySteps, 20_000, compareLatencyMoves({ output: earlierRaise, edits: latencyEdits, publications: reportedBy(honest), startingPinned: low + 900, endFrame: latencyEnd }))
  check(foreign.outcome === "pass", `a raise made before the row started is not the row's: ${JSON.stringify(foreign)}`)
  const unpinned = raiseRow(retainedAfter([...raised(high - low), { publicationFrame: publicationFrames[2] ?? 0, raiseFrames: high - low }]))
  check(unpinned.outcome === "fail" && unpinned.editIndex === 3, `a second raise to a level already reached must not shift again: ${JSON.stringify(unpinned)}`)
  const extra = raiseRow(retainedAfter(raised(high - low)), honest, [...reportedBy(honest), { wallMs: 9000, publicationFrame: 150_000, graphLatencyFrames: high, pinnedLatencyFrames: high }]
    .sort((a, b) => a.publicationFrame - b.publicationFrame))
  check(extra.outcome === "fail", `a publication no edit made fails: ${JSON.stringify(extra)}`)
  const event = (name: string, wallMs: number) => parseHostLines(`${JSON.stringify({ event: name, wallMs })}\n`)
  check(lifecycleBetween([...event("host-spawn", 1500), ...event("graph-publish", 1600)], 1000, 2000).length === 1, "a host restart after the edit is a lifecycle event")
  check(lifecycleBetween(event("transport-stop", 500), 1000, 2000).length === 0, "an event before the edit is not")
  // The editor row: closed after the edit, or anything restarted, fails; an edit that publishes in place with the editor open passes.
  const lines = (...entries: object[]) => parseHostLines(entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n")
  const editedAt = (index: number) => index * 1000
  const one = (compare: Compare) => judgeBurst(steps.slice(0, 1), 10_000, compare)
  check(one(compareEditor(lines({ event: "vst-editor-state", open: true, wallMs: 1500 }, { event: "graph-publish", wallMs: 1800 }), 0, editedAt)).outcome === "pass", "an edit that publishes with the editor open passes")
  check(one(compareEditor(lines({ event: "vst-editor-state", open: false, wallMs: 1800 }), 0, editedAt)).outcome === "fail", "an editor reported closed after the edit fails")
  check(one(compareEditor(lines({ event: "worker-spawn", wallMs: 1800 }), 0, editedAt)).outcome === "fail", "a worker spawned again after the edit fails")
  check(one(compareEditor(lines({ event: "host-restart-request", wallMs: 1800 }), 0, editedAt)).outcome === "fail", "a host restart request after the edit fails")
  check(one(compareEditor(lines({ event: "host-spawn", pid: 7, wallMs: 1100 }, { event: "worker-spawn", pid: 7, wallMs: 1200 }), 1, editedAt)).outcome === "pass", "the editor window's own host starting is not a restart of the playing host")
  check(one(compareEditor(lines({ event: "worker-spawn", pid: 1, wallMs: 1200 }), 1, editedAt)).outcome === "fail", "the playing host starting a worker fails")
  check(one(compareEditor(lines({ event: "vst-editor-state", open: false, wallMs: 500 }), 0, editedAt)).outcome === "pass", "an editor closed before the edit is not the edit's")
  // The lane row: the override's publication carries no lane event and nor does any window until the re-enable, whose windows carry it.
  const published = { event: "graph-publish", cause: "block-boundary", publicationFrame: 100, wallMs: 1500 }
  const windowOf = (wallMs: number, processorAutomationEvents: number) => ({ event: "schedule-window", revision: 2, wallMs, processorAutomationEvents })
  const laneStep = (index: number, compare: Compare) => judgeBurst(steps.slice(index - 1, index), 10_000, compare)
  check(laneStep(1, compareLane(lines(published, windowOf(1400, 0)), editedAt)).outcome === "pass", "an override whose windows carry no lane passes")
  check(laneStep(1, compareLane(lines(published, windowOf(1400, 0), windowOf(3000, 1)), editedAt)).outcome === "fail", "a lane event scheduled after the override fails")
  check(laneStep(1, compareLane(lines(windowOf(1400, 0)), editedAt)).outcome === "fail", "an override with no publication fails")
  check(laneStep(2, compareLane(lines({ ...published, wallMs: 2500 }, windowOf(2400, 3)), editedAt)).outcome === "pass", "a re-enable whose windows carry the lane passes")
  check(laneStep(2, compareLane(lines({ ...published, wallMs: 2500 }, windowOf(2400, 0)), editedAt)).outcome === "fail", "a re-enable whose windows carry no lane fails")
  // The fault row: the delete row's capture check plus nothing restarted.
  const faultInput = (events: ReturnType<typeof lines>, right: (frame: number) => number) => ({ events, output: deleted(right, tone), seam, editFrame: seam - sampleRate / 2, endFrame, editWallMs: 1000 })
  const gone = (frame: number) => frame < seam + fade ? tone(frame) : 0
  const crashed = (frame: number) => frame < seam - sampleRate / 4 ? tone(frame) : 0
  check(one(compareFault(faultInput(lines({ event: "attachment-fault-isolated", cause: "plugin-fault", wallMs: 1200 }), gone))).outcome === "pass", "a muted plug-in beside a live source passes")
  check(one(compareFault(faultInput(lines(), crashed))).outcome === "pass", "a plug-in that went silent at its crash, before the host reported the isolation, passes")
  check(one(compareFault({ ...faultInput(lines(), crashed), output: deleted(() => 0, tone) })).outcome === "fail", "a plug-in that was never audible before the edit fails")
  check(one(compareFault(faultInput(lines({ event: "host-spawn", wallMs: 1300 }), gone))).outcome === "fail", "a fault that restarts the host fails")
  check(one(compareFault(faultInput(lines({ event: "device-stop", wallMs: 1300 }), gone))).outcome === "fail", "a fault that stops the session fails")
  check(one(compareFault(faultInput(lines(), tone))).outcome === "fail", "a plug-in that still sounds, or a dry fallback, fails")
  check(one(compareFault({ ...faultInput(lines(), gone), output: deleted(gone, (frame) => frame < seam ? tone(frame) : 0) })).outcome === "fail", "unrelated audio that stops fails")
  // The trust row: a refusal changes nothing, so any publication request or restart after it fails.
  check(one(compareTrust(lines({ event: "graph-publish", wallMs: 500 }), 1000)).outcome === "pass", "nothing after the refusal passes")
  check(one(compareTrust(lines({ event: "graph-publish-request", wallMs: 1500 }), 1000)).outcome === "fail", "a graph request after the refusal fails")
  check(one(compareTrust(lines({ event: "worker-spawn", wallMs: 1500 }), 1000)).outcome === "fail", "a worker spawned after the refusal fails")
  // The held-instrument rows judge the right channel: a 440 Hz sine and the fixture's sample (an offset, a sine and a chirp) are smooth, a gain
  // ramp over the 6 ms fade is smooth, and a gap, a retrigger or a gain step is a jump.
  const heldFrames = 12_000, heldSeam = 2000
  const heldOutput = (right: (frame: number) => number): Pcm => {
    const samples = new Float32Array(heldFrames * 2)
    for (let frame = 0; frame < heldFrames; frame++) samples[frame * 2 + 1] = right(frame)
    return { sampleRate, channels: 2, samples }
  }
  const heldVerdict = (right: (frame: number) => number) => compareHeld({ output: heldOutput(right), seams: [heldSeam], endFrame: heldFrames })({ index: 1, fromWallMs: 0, toWallMs: 0 })
  const heldTone = (frame: number) => 0.1 * Math.sin(2 * Math.PI * 440 * frame / sampleRate)
  const sample = (frame: number) => phase5AssetSample(frame, true)
  check(heldVerdict(heldTone) === undefined, "a held 440 Hz sine passes")
  check(heldVerdict(sample) === undefined, "the fixture's sample played straight passes")
  check(heldVerdict((frame) => heldTone(frame) * (frame < 5000 ? 1 : frame > 5288 ? 0.5 : 1 - 0.5 * (frame - 5000) / 288)) === undefined, "a gain ramp over 6 ms passes")
  check(/drops out/.test(heldVerdict((frame) => frame >= 5000 && frame < 5600 ? 0 : heldTone(frame)) ?? ""), "a gap fails as the note dropping out")
  check(/jumps at frame 5000/.test(heldVerdict((frame) => frame < 5000 ? heldTone(frame) : heldTone(frame + 123)) ?? ""), "a retrigger that restarts the phase fails as a jump")
  check(/jumps/.test(heldVerdict((frame) => sample(frame < 5000 ? frame : frame - 5000)) ?? ""), "a sample restarted from its start fails as a jump")
  check(/jumps at frame 5000/.test(heldVerdict((frame) => heldTone(frame) * (frame < 5000 ? 1 : 0.5)) ?? ""), "a hard gain step fails as a jump")
  check(/no publication for edit 2/.test(compareHeld({ output: heldOutput(heldTone), seams: [heldSeam], endFrame: heldFrames })({ index: 2, fromWallMs: 0, toWallMs: 0 }) ?? ""), "a window with no publication is refused")
  // The transport rows. Host loss: the host is reported exited, the transport stopped, native unavailable reported, and no session starts after.
  const observed = (edit: string, wallMs: number, fields: Partial<TransportObservation> = {}): TransportObservation =>
    ({ event: "transport-observed", wallMs, edit, pid: 7, cancelWallMs: wallMs - 100, state: "stopped", playheadSec: 0, failure: nativeUnavailableReported, ...fields })
  const lossSteps = [{ index: 1, editWallMs: 1000, settledWallMs: 1500 }]
  const loss = (events: ReturnType<typeof lines>, fields?: Partial<TransportObservation>) =>
    judgeBurst(lossSteps, 3000, compareHostLoss(events, [observed("play-kill-host", 1400, fields)]), 0)
  const exited = { event: "host-exit", pid: 7, wallMs: 1350 }
  check(loss(lines(exited, { event: "host-spawn", pid: 8, wallMs: 1800 })).outcome === "pass", "a lost host with the transport stopped and a restarted supervisor passes")
  check(loss(lines()).outcome === "fail", "a kill with no host-exit line fails")
  check(loss(lines({ ...exited, pid: 9 })).outcome === "fail", "another process's exit is not the killed host's")
  check(loss(lines(exited), { state: "playing" }).outcome === "fail", "a transport that plays after the host was lost fails")
  check(loss(lines(exited), { failure: "" }).outcome === "fail", "no native-unavailable report fails")
  check(loss(lines(exited, { event: "graph-publish", wallMs: 1700 })).outcome === "fail", "a graph published after the host was lost fails")
  check(loss(lines(exited, { event: "device-start-request", wallMs: 1700 })).outcome === "fail", "a device started after the host was lost fails")
  check(loss(lines(exited, { event: "device-start-request", wallMs: 1200 })).outcome === "pass", "a start request before the kill is the pending Play's own")
  // Cancelled start: edit k begins at k s, the cancel is issued 100 ms before its observation, which lands 300 ms in.
  const names = ["session-pause", "play-then-pause", "play-resume", "session-pause", "play-then-stop", "play-resume"]
  const cancelSteps = names.map((_, position) => ({ index: position + 1, editWallMs: (position + 1) * 1000, settledWallMs: (position + 1) * 1000 + 400 }))
  const resting = [{ state: "paused", playheadSec: 1.5 }, { state: "paused", playheadSec: 1.5 }, { state: "playing", playheadSec: 2 },
    { state: "paused", playheadSec: 2.5 }, { state: "stopped", playheadSec: 0 }, { state: "playing", playheadSec: 0.2 }]
  const honestSeen = names.map((name, position) => observed(name, (position + 1) * 1000 + 300, { failure: "", ...resting[position] }))
  const cancelled = (events: ReturnType<typeof lines>, observations = honestSeen) => judgeBurst(cancelSteps, 8000, compareCancelledStart({ events, observations,
    editName: (index) => names[index - 1] ?? "", editWallMs: (index) => index * 1000 }), 0)
  check(cancelled(lines({ event: "device-configure", wallMs: 1200 }, { event: "device-stop", wallMs: 2050 })).outcome === "pass",
    "the preparing play and a stop before the cancel are not the cancel's")
  check(cancelled(lines({ event: "device-stop", wallMs: 2250 })).editIndex === 2, "a device stop after a Pause's cancel fails that step")
  check(cancelled(lines({ event: "host-teardown-request", wallMs: 5250 })).editIndex === 5, "a teardown after a Stop's cancel fails that step")
  check(cancelled(lines({ event: "capture-configure", wallMs: 2250 })).editIndex === 2, "a capture configure after the cancel fails")
  check(cancelled(lines({ event: "begin-transaction", wallMs: 5250 })).editIndex === 5, "a begin after the cancel fails")
  check(cancelled(lines({ event: "structural-rebuild", wallMs: 3200 })).editIndex === 3, "a rebuild under the next Play fails")
  check(cancelled(lines({ event: "device-configure", wallMs: 6100 })).editIndex === 6, "a configure under the Play after the Stop fails")
  const replaced = (position: number, fields: Partial<TransportObservation>) => honestSeen.map((entry, at) => at === position ? { ...entry, ...fields } : entry)
  check(cancelled(lines(), replaced(1, { state: "playing" })).editIndex === 2, "a Pause that leaves the transport playing fails")
  check(cancelled(lines(), replaced(1, { playheadSec: 1.6 })).editIndex === 2, "a cancelled Play that moves the paused position fails")
  check(cancelled(lines(), replaced(4, { playheadSec: 0.5 })).editIndex === 5, "a Stop that leaves the position off 0 fails")
  check(cancelled(lines(), replaced(4, { state: "paused" })).editIndex === 5, "a Stop that reads paused fails")
  check(cancelled(lines({ event: "structural-rebuild", wallMs: 5250 })).editIndex === 5, "a rebuild after a Stop's cancel fails although the Stop reads stopped at 0")
  check(cancelled(lines(), replaced(2, { state: "paused" })).editIndex === 3, "a Play that does not play fails")
  check(cancelled(lines(), honestSeen.filter((_, position) => position !== 1)).editIndex === 2, "a step with no observation fails")
  // The output-device rows. Each edit k is entered at k * 10 s and its observations land 3 s in; the counts are those of the packaged evidence.
  const keys = ["device-session", "device-stop", "device-configure", "device-start-request", "structural-rebuild", "host-spawn", "host-exit", "worker-spawn", "worker-ready", "asset-install"]
  const zero = Object.fromEntries(keys.map((key) => [key, 0]))
  const blackholeId = "coreaudio:BlackHole2ch_UID", speakersId = "coreaudio:BuiltInSpeakerDevice", missingId = "coreaudio:ae08-missing-output"
  const heard = { silent: { blackholeMeanDb: "-91.0", blackholeMaxDb: "-91.0" }, tone: { blackholeMeanDb: "-23.6", blackholeMaxDb: "-20.4" } }
  type Seen = Partial<Omit<DeviceObservation, "before" | "after" | "blackhole">> & { step: string; delta?: Record<string, number>; levels?: keyof typeof heard }
  const seen = (edit: number, entry: Seen): DeviceObservation => {
    const { delta = {}, levels, ...fields } = entry
    return deviceObservation.parse({ event: "device-switch-observed", wallMs: edit * 10_000 + 3000, state: "paused", playheadSec: 0, saved: speakersId, consoleErrors: "[]", stateReadRefusals: "[]",
      ...fields, before: JSON.stringify(zero), after: JSON.stringify({ ...zero, ...delta }), blackhole: levels ? JSON.stringify(heard[levels]) : "not captured" })
  }
  const rebuild = { "device-session": 1, "device-stop": 3, "device-configure": 1, "device-start-request": 1, "structural-rebuild": 1, "asset-install": 2 }
  const switchOf = (edit: number, to: "blackhole" | "speakers", state: "playing" | "paused", playheadSec: number, extra: Partial<Seen> = {}) => seen(edit, { step: "switch-to-" + to, state, playheadSec,
    saved: to === "blackhole" ? blackholeId : speakersId, deviceId: to === "blackhole" ? blackholeId : speakersId, moved: true, delta: rebuild,
    levels: state === "playing" ? to === "blackhole" ? "tone" : "silent" : undefined, ...extra })
  const play = (edit: number, playheadSec: number, saved: string, extra: Partial<Seen> = {}) => seen(edit, { step: "play", state: "playing", playheadSec, saved, levels: saved === blackholeId ? "tone" : "silent", ...extra })
  const pause = (edit: number, playheadSec: number, saved: string) => seen(edit, { step: "pause", state: "paused", playheadSec, saved })
  const outputNames = ["out-play", "out-to-blackhole-playing", "out-to-speakers-playing", "out-reselect-speakers-playing", "out-pause", "out-to-blackhole-paused", "out-play-after-paused-switch",
    "out-pause-again", "out-to-speakers-paused", "out-play-back-on-speakers", "out-to-missing-playing", "out-play-with-missing", "out-restore-speakers", "out-play-after-restore", "out-recording-keeps-devices"]
  const takeMarks = (during: Partial<Seen> = {}, finished: Partial<Seen> = {}, next: Partial<Seen> = {}) => [
    seen(15, { step: "change-devices-during-take", state: "playing", playheadSec: 0.18, saved: blackholeId, levels: "tone", noticeShown: true, ...during }),
    seen(15, { step: "recording-finished", state: "playing", playheadSec: 6.1, saved: blackholeId, levels: "tone", moved: true, takeKeptBlackholeInput: true, delta: { "device-session": 1, "structural-rebuild": 1 }, ...finished }),
    seen(15, { step: "next-take", state: "playing", playheadSec: 13.3, saved: blackholeId, levels: "tone", secondTake: "tone heard: false", ...next })]
  const cleanMarks = {
      "out-play": [play(1, 0.04, "", { delta: { "device-session": 1, "device-stop": 1, "device-start-request": 1 } })],
      "out-to-blackhole-playing": [switchOf(2, "blackhole", "playing", 2.8)],
      "out-to-speakers-playing": [switchOf(3, "speakers", "playing", 5.1)],
      "out-reselect-speakers-playing": [seen(4, { step: "switch-to-speakers", state: "playing", playheadSec: 7.5, deviceId: speakersId, moved: true, levels: "silent" })],
      "out-pause": [pause(5, 9.8, speakersId)],
      "out-to-blackhole-paused": [switchOf(6, "blackhole", "paused", 9.8)],
      "out-play-after-paused-switch": [play(7, 9.85, blackholeId)],
      "out-pause-again": [pause(8, 12.1, blackholeId)],
      "out-to-speakers-paused": [switchOf(9, "speakers", "paused", 12.1)],
      "out-play-back-on-speakers": [play(10, 12.18, speakersId)],
      "out-to-missing-playing": [seen(11, { step: "switch-to-missing", playheadSec: 14.4, saved: missingId, stopped: true, noticeShown: true, delta: { "device-stop": 4 } })],
      "out-play-with-missing": [seen(12, { step: "play-with-missing-output", playheadSec: 14.4, saved: missingId, refused: true, noticeShown: true })],
      "out-restore-speakers": [seen(13, { step: "switch-to-speakers", playheadSec: 14.4, deviceId: speakersId, moved: true })],
      "out-play-after-restore": [play(14, 14.49, speakersId, { delta: rebuild })],
      "out-recording-keeps-devices": takeMarks(),
  } satisfies Record<string, DeviceObservation[]>
  const outputMarks = (override: Record<string, DeviceObservation[]> = {}) => ({ ...cleanMarks, ...override })
  const outputSteps = outputNames.map((name, position) => ({ index: position + 1, name, editWallMs: (position + 1) * 10_000, settledWallMs: (position + 1) * 10_000 + 9000 }))
  const device = (marks: Record<string, DeviceObservation[]>, instruments = false, names = outputNames) => judgeBurst(outputSteps.filter((step) => names.includes(step.name)), 200_000,
    compareOutputDevice({ observations: Object.values(marks).flat(), editName: (index) => outputNames[index - 1] ?? "", editWallMs: (index) => index * 10_000, instruments }), 0)
  const defective = (name: keyof typeof cleanMarks, mutate: (mark: DeviceObservation) => DeviceObservation, why: string) => {
    const verdict = device(outputMarks({ [name]: cleanMarks[name].map(mutate) }))
    check(verdict.outcome === "fail" && verdict.editIndex === outputNames.indexOf(name) + 1, `${why} fails at ${name}: ${JSON.stringify(verdict)}`)
  }
  const grown = (mark: DeviceObservation, add: Record<string, number>): DeviceObservation => ({ ...mark, after: Object.fromEntries(Object.entries(mark.after).map(([key, value]) => [key, value + (add[key] ?? 0)])) })
  check(device(outputMarks()).outcome === "pass", `a switch row that rebuilds once per change, resumes and sounds on the chosen device passes: ${JSON.stringify(device(outputMarks()))}`)
  defective("out-to-blackhole-playing", (mark) => grown(mark, { "host-spawn": 1 }), "a switch that spawns another host")
  defective("out-to-blackhole-playing", (mark) => grown(mark, { "host-exit": 1 }), "a switch that makes the host exit")
  defective("out-to-blackhole-playing", (mark) => ({ ...mark, state: "paused" }), "a switch that leaves the transport paused (no resume)")
  defective("out-to-blackhole-playing", (mark) => ({ ...mark, playheadSec: 0.04 }), "a switch that rewinds the playhead")
  defective("out-to-blackhole-playing", (mark) => ({ ...mark, blackhole: JSON.stringify(heard.silent) }), "a switch that stays silent on BlackHole")
  defective("out-to-speakers-playing", (mark) => ({ ...mark, blackhole: JSON.stringify(heard.tone) }), "a switch that still sounds on BlackHole")
  defective("out-to-speakers-playing", (mark) => ({ ...mark, saved: blackholeId }), "a switch that saved another device")
  defective("out-to-speakers-playing", (mark) => ({ ...mark, moved: false }), "a switch the host never saw")
  defective("out-to-speakers-playing", (mark) => grown(mark, { "device-session": 1, "structural-rebuild": 1 }), "a switch that rebuilds twice")
  defective("out-to-speakers-playing", (mark) => grown(mark, { "device-start-request": 1 }), "a switch that starts the device twice")
  defective("out-reselect-speakers-playing", (mark) => grown(mark, { "structural-rebuild": 1 }), "reselecting the output in use that rebuilds")
  defective("out-reselect-speakers-playing", (mark) => ({ ...mark, state: "paused" }), "reselecting the output in use that pauses")
  defective("out-pause", (mark) => ({ ...mark, state: "playing" }), "a Pause that leaves the transport playing")
  defective("out-pause", (mark) => grown(mark, { "device-session": 1 }), "a Pause that rebuilds")
  defective("out-to-blackhole-paused", (mark) => ({ ...mark, state: "playing" }), "a paused switch that starts the transport")
  defective("out-to-blackhole-paused", (mark) => ({ ...mark, playheadSec: 9.9 }), "a paused switch that moves the position")
  defective("out-to-blackhole-paused", (mark) => grown(mark, { "device-session": 1 }), "a paused switch that rebuilds twice")
  defective("out-play-after-paused-switch", (mark) => ({ ...mark, state: "paused" }), "a Play after the paused switch that does not play")
  defective("out-play-after-paused-switch", (mark) => ({ ...mark, blackhole: JSON.stringify(heard.silent) }), "a Play after the paused switch that does not sound on the new device")
  defective("out-play-after-paused-switch", (mark) => ({ ...mark, playheadSec: 0 }), "a Play that restarts from zero")
  defective("out-play-back-on-speakers", (mark) => ({ ...mark, blackhole: JSON.stringify(heard.tone) }), "a Play that sounds on the device that was left")
  defective("out-to-missing-playing", (mark) => ({ ...mark, noticeShown: false }), "a missing output that reports nothing")
  defective("out-to-missing-playing", (mark) => ({ ...mark, state: "playing" }), "a missing output that leaves the transport playing")
  defective("out-to-missing-playing", (mark) => grown(mark, { "host-exit": 1 }), "a missing output that crashes the host")
  defective("out-play-with-missing", (mark) => ({ ...mark, refused: false }), "a Play over the missing output that is not refused")
  defective("out-play-with-missing", (mark) => grown(mark, { "device-start-request": 1 }), "a Play over the missing output that starts a device")
  defective("out-restore-speakers", (mark) => ({ ...mark, moved: false }), "a restore the host never saw")
  defective("out-play-after-restore", (mark) => ({ ...mark, state: "paused" }), "a Play after the restore that does not play")
  defective("out-play-after-restore", (mark) => ({ ...mark, consoleErrors: JSON.stringify(["[native-playback] moving the session to the saved output device failed Error: x"]) }), "a rebuild the app reports as failed")
  defective("out-play-after-restore", (mark) => ({ ...mark, stateReadRefusals: JSON.stringify(["unsupported"]) }), "a plug-in state read that was refused")
  const takeCase = (during?: Partial<Seen>, finished?: Partial<Seen>, next?: Partial<Seen>) => device(outputMarks({ "out-recording-keeps-devices": takeMarks(during, finished, next) }))
  check(takeCase({}, {}, { consoleErrors: JSON.stringify(["[native-vst3] native play skipped: Playback was already marked active before the native graph start."]) }).outcome === "pass", "the host declining a second Play is not a failure")
  check(takeCase({ delta: { "device-session": 1 } }).outcome === "fail", "a take whose devices changed fails")
  check(takeCase({ noticeShown: false }).outcome === "fail", "a take with no notice fails")
  check(takeCase({}, { takeKeptBlackholeInput: false }).outcome === "fail", "a take that lost BlackHole's input fails")
  check(takeCase({}, { delta: {} }).outcome === "fail", "an output that never moves after the take fails")
  check(takeCase({}, {}, { secondTake: "tone heard: true" }).outcome === "fail", "a next take that still hears the old input fails")
  check(device(outputMarks({ "out-recording-keeps-devices": takeMarks().slice(0, 2) })).outcome === "fail", "a take with a missing observation fails")
  check(device(outputMarks({ "out-pause": [] })).editIndex === 5, "a step with no observation fails")
  check(device(outputMarks(), false, ["out-pause"]).outcome === "pass", "each step is judged on its own observations")
  // A step settles in the millisecond the next one starts: its observation is its own, not the next step's.
  const adjacentSteps = [{ index: 1, name: "out-play", editWallMs: 1000, settledWallMs: 2000 }, { index: 2, name: "out-pause", editWallMs: 2000, settledWallMs: 5000 }]
  const adjacent = judgeBurst(adjacentSteps, 9000,
    compareOutputDevice({ observations: [{ ...play(1, 0.04, "", { delta: { "host-spawn": 1 } }), wallMs: 2000 }, { ...pause(2, 0.5, ""), wallMs: 3000 }], editName: (index) => ["out-play", "out-pause"][index - 1] ?? "",
      editWallMs: (index) => index * 1000, instruments: false }), 0)
  check(adjacent.outcome === "pass", `an observation made in the millisecond the next step starts is the earlier step's: ${JSON.stringify(adjacent)}`)
  // The instruments row: the rebuilt session needs its plug-in worker (spawned and ready) and the sampler's assets back.
  const instrumentNames = ["out-play", "out-pause", "out-to-blackhole-paused", "out-play-after-paused-switch", "out-to-speakers-playing"]
  const workers = { "worker-spawn": 1, "worker-ready": 1, "asset-install": 1 }
  const instrumentMarks = (change: (marks: DeviceObservation[]) => DeviceObservation[] = (marks) => marks) => change([
    play(1, 0.04, "", { delta: { "device-session": 2, "device-stop": 4, "device-start-request": 2, "structural-rebuild": 2, "host-spawn": 1, "worker-spawn": 2, "worker-ready": 2, "asset-install": 3 } }),
    pause(2, 2.4, ""), switchOf(3, "blackhole", "paused", 2.4, { delta: { ...rebuild, ...workers } }), play(4, 2.43, blackholeId),
    switchOf(5, "speakers", "playing", 4.7, { delta: { ...rebuild, ...workers } })])
  const instruments = (marks: DeviceObservation[]) => judgeBurst(instrumentNames.map((name, position) => ({ index: position + 1, name, editWallMs: (position + 1) * 10_000, settledWallMs: (position + 1) * 10_000 + 9000 })), 200_000,
    compareOutputDevice({ observations: marks, editName: (index) => instrumentNames[index - 1] ?? "", editWallMs: (index) => index * 10_000, instruments: true }), 0)
  check(instruments(instrumentMarks()).outcome === "pass", `the instruments row with its worker and sampler back after each rebuild passes: ${JSON.stringify(instruments(instrumentMarks()))}`)
  check(instruments(instrumentMarks((marks) => marks.map((mark) => mark.step === "play" && mark.saved === "" ? grown(mark, { "worker-spawn": 1 }) : mark))).outcome === "pass", "the first Play's editor worker still starting is not a missing worker")
  check(instruments(instrumentMarks((marks) => marks.map((mark) => mark.step === "play" && mark.saved === "" ? grown(mark, { "worker-ready": -2 }) : mark))).editIndex === 1, "a first Play with no worker ready fails")
  check(instruments(instrumentMarks((marks) => marks.map((mark) => mark.step === "switch-to-blackhole" ? grown(mark, { "worker-spawn": -1, "worker-ready": -1 }) : mark))).editIndex === 3, "a rebuilt session with no plug-in worker fails")
  check(instruments(instrumentMarks((marks) => marks.map((mark) => mark.step === "switch-to-speakers" ? grown(mark, { "worker-ready": -1 }) : mark))).editIndex === 5, "a plug-in worker that is spawned but never ready fails")
  check(instruments(instrumentMarks((marks) => marks.map((mark) => mark.step === "switch-to-speakers" ? grown(mark, { "asset-install": -1 }) : mark))).editIndex === 5, "a rebuilt session with no sampler assets fails")
  check(instruments(instrumentMarks((marks) => marks.map((mark) => mark.step === "play" && mark.saved === blackholeId ? { ...mark, blackhole: JSON.stringify(heard.silent) } : mark))).editIndex === 4, "a sampler that is silent on the new device fails")
  // A plug-in row's edits start no worker beyond an insert's own and never touch the playing host (the editor window's host is another pid).
  const hostLine = (event: string, wallMs: number, pid = 7) => ({ event, wallMs, pid })
  const noRestart = (events: ReturnType<typeof lines>, edit: string) => one(compareNoRestart({ events, hostPid: 7, editWallMs: editedAt, workerSpawns: () => edit === "vst-insert" ? 1 : 0 }))
  check(noRestart(lines(hostLine("worker-spawn", 1200)), "vst-insert").outcome === "pass", "an insert's own worker passes")
  check(noRestart(lines(), "vst-remove").outcome === "pass", "a removal that starts nothing passes")
  check(noRestart(lines(hostLine("device-stop", 1200, 8), hostLine("worker-spawn", 1300, 8), hostLine("host-spawn", 1100, 8)), "vst-remove").outcome === "pass", "the editor host's own lifecycle is not the playing host's")
  check(noRestart(lines(hostLine("worker-spawn", 1200)), "vst-remove").outcome === "fail", "a removal that starts a worker fails")
  check(noRestart(lines(hostLine("worker-spawn", 1200), hostLine("worker-spawn", 1300)), "vst-insert").outcome === "fail", "an insert that starts a second worker fails")
  check(noRestart(lines(), "vst-insert").outcome === "fail", "an insert that starts no worker fails")
  check(noRestart(lines(hostLine("device-stop", 1200)), "vst-remove").outcome === "fail", "an edit that stops the playing host's device fails")
  check(noRestart(lines(hostLine("structural-rebuild", 1200)), "vst-insert").outcome === "fail", "an edit that rebuilds the playing host fails")
  check(noRestart(lines(hostLine("host-exit", 1200)), "vst-remove").outcome === "fail", "an edit that makes the playing host exit fails")
  // The plug-in's channel is not compared while it is swapped for the path that replaces it, the retained channel always is.
  const swapStates = [states[0], states[1]].map((entry) => entry ?? render())
  const swapped = (defect: (output: Pcm) => void) => { const output = render(); defect(output); return withoutSwap(output, swapStates, [seams[0] ?? 0], 992) }
  const swapSeam = seams[0] ?? 0
  const maskedRight = swapped((output) => { for (let frame = swapSeam; frame < swapSeam + 992; frame++) output.samples[frame * channels + 1] = 0.5 })
  check((maskedRight.samples[(swapSeam + 10) * channels + 1] ?? NaN) === (swapStates[1]?.samples[(swapSeam + 10) * channels + 1] ?? 0), "the swapped frames of the edited channel take the reference")
  check(swapped((output) => { output.samples[(swapSeam + 10) * channels] = 0.5 }).samples[(swapSeam + 10) * channels] === 0.5, "the retained channel is never masked")
  check(swapped((output) => { output.samples[(swapSeam + 992) * channels + 1] = 0.5 }).samples[(swapSeam + 992) * channels + 1] === 0.5, "the edited channel after the swap is never masked")
  check(Number.isNaN(swapped((output) => { output.samples[(swapSeam + 10) * channels + 1] = NaN }).samples[(swapSeam + 10) * channels + 1]), "a frame the capture never covered stays uncovered")
  check(delayedBy({ sampleRate, channels: 1, samples: Float32Array.of(1, 2, 3, 4) }, 2).samples.join() === "0,0,1,2", "a state is delayed by the pinned budget and keeps its length")
  console.log("ae-08 phase 9 compare self-test: pass")
}

if (import.meta.main) {
  if (Bun.argv[2] === "--self-test") selfTest()
  else throw new Error("Usage: ae-08-phase-9-compare.ts --self-test")
}
