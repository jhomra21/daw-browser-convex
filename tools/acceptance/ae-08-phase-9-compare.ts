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

// No cold lifecycle event between the edit and the end of the capture: a delete is one session, never a stop and start.
export const lifecycleBetween = (events: readonly HostEvent[], fromWallMs: number, toWallMs: number) =>
  events.filter((event) => event.wallMs >= fromWallMs && event.wallMs <= toWallMs && /stop|teardown|rebuild|host-exit|host-spawn|device-configure/i.test(event.event))

// The VST rows that judge on host evidence. A restart is a worker spawned again or a host restart request after the edit.
const restartsBetween = (events: readonly HostEvent[], fromWallMs: number, toWallMs: number) =>
  [...lifecycleBetween(events, fromWallMs, toWallMs), ...events.filter((event) => /^(worker-spawn|host-restart-request)$/.test(event.event) && event.wallMs >= fromWallMs && event.wallMs <= toWallMs)]
const named = (events: readonly HostEvent[]) => events.map((event) => event.event).join(", ")

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
const publicationLine = z.object({ event: z.literal("graph-publish"), cause: z.literal("block-boundary"), pid: z.number(), wallMs: z.number(), transportEpoch: z.number(),
  publicationFrame: z.number().positive(), graphLatencyFrames: z.number(), pinnedLatencyFrames: z.number() })
const nativeLines = (text: string) => text.slice(0, text.lastIndexOf("\n") + 1).split("\n").filter(Boolean).map((line) => JSON.parse(line))

// Judges one stored row of a launch: steps and seams from its phase9-edits.json, the capture from the launch folder.
// `stateFile` names the offline export of a state (only "states" rows read it).
export const judgeRowCapture = async (input: { launchOut: string; directory: string; row: Row; stateFile: (state: string) => string; captureEndWallMs: number
  natives: readonly string[] }): Promise<BurstVerdict> => {
  const { launchOut, directory, row } = input
  const { edits } = logged.parse(JSON.parse(await readFile(path.join(directory, "phase9-edits.json"), "utf8")))
  const steps = [...Map.groupBy(edits, (edit) => edit.index)].map(([index, group]) => ({ index, editWallMs: Math.min(...group.map((edit) => edit.wallMs)),
    settledWallMs: group[0]?.settledWallMs, publicationFrame: group[0]?.publicationFrame ?? 0, startSec: group.find((edit) => edit.startSec !== undefined)?.startSec }))
  if (row.judge === "take") return judgeBurst(steps, input.captureEndWallMs, compareTake(takeResult.parse(JSON.parse(await readFile(path.join(directory, takeFile), "utf8")))))
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
  if (row.judge === "states") {
    const [initial, ...entered] = await Promise.all([row.start, ...steps.map((step) => row.cycle[(step.index - 1) % row.cycle.length]?.state ?? "")]
      .map((state) => readWav(input.stateFile(state))))
    const states = initial ? [initial, ...entered.map((state, position) => {
      const startSec = steps[position]?.startSec
      return startSec === undefined ? state : placedAt(state, initial, startSec)
    })] : []
    const endFrame = Math.min(captured, ...states.map((state) => state.samples.length / state.channels))
    const entries = steps.map((step) => row.cycle[(step.index - 1) % row.cycle.length]?.entry)
    return judgeBurst(steps, input.captureEndWallMs, compareStates({ output: transportIndexed(capture, mine, endFrame), states, seams, entries, endFrame }))
  }
  const output = transportIndexed(capture, mine, captured)
  if (row.judge === "latency") {
    const firstEditWallMs = steps[0]?.editWallMs ?? 0
    const launchPublications = texts.flatMap(nativeLines).flatMap((entry) => {
      const line = publicationLine.safeParse(entry)
      return line.success && line.data.pid === owner.pid && line.data.transportEpoch === owner.transportEpoch ? [line.data] : []
    }).sort((a, b) => a.publicationFrame - b.publicationFrame)
    const publications = launchPublications.filter((line) => line.wallMs >= firstEditWallMs && line.wallMs <= input.captureEndWallMs)
    const startingPinned = launchPublications.findLast((line) => line.wallMs < firstEditWallMs)?.pinnedLatencyFrames ?? edits[0]?.fromLatencyFrames ?? 0
    const rowEnd = Math.max(...mine.filter((block) => block.wallMs <= input.captureEndWallMs).map((block) => block.transportFrame + block.frames))
    return judgeBurst(steps, input.captureEndWallMs, compareLatencyMoves({ output, edits, publications, startingPinned, endFrame: Math.min(captured, rowEnd) }))
  }
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
  console.log("ae-08 phase 9 compare self-test: pass")
}

if (import.meta.main) {
  if (Bun.argv[2] === "--self-test") selfTest()
  else throw new Error("Usage: ae-08-phase-9-compare.ts --self-test")
}
