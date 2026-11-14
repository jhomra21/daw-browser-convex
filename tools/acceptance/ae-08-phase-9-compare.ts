import { readFile } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { appliedLatencyMatches, attributePublications, compareLatency, judgeBurst as judgeStates } from "./analyze-ae-08-continuity"
import { readWav, type Pcm } from "./ae08-wav"
import { phase5AssetSample } from "./ae-08-phase-5-fixture"
import { judgeBurst, parseHostLines, type BurstVerdict, type Compare, type HostEvent } from "./ae-08-phase-9-matrix"
import type { Row } from "./ae-08-phase-9-rows"

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

// One analyzer call per burst; the callback reads its answer for each oracle window. Step k of the burst is publication k: window
// index k (1-based) is the analyzer's edit k - 1.
export const compareStates = (input: { output: Pcm; states: readonly Pcm[]; seams: readonly number[]; endFrame: number }): Compare => {
  const { output, states, seams, endFrame } = input
  const verdict = judgeStates(output, states, seams, { fadeFrames: fadeFramesFor(output.sampleRate), endFrame })
  return (window) => {
    if (!verdict.wellFormed) return "the capture, the state references and the seams do not line up (rate, channels, length or seam order)"
    const found = verdict.windows[window.index - 1]
    if (found === undefined) return `no analyzer window for edit ${window.index}`
    return verdict.failedEdits.includes(found.edit)
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
export type LatencyEdit = { name: string; fromLatencyFrames: number; toLatencyFrames: number; wallMs: number }
export type LatencyPublication = { wallMs: number; publicationFrame: number; graphLatencyFrames: number; pinnedLatencyFrames: number }
export const compareLatencyMoves = (input: { output: Pcm; edits: readonly LatencyEdit[]; publications: readonly LatencyPublication[]; endFrame: number }): Compare => {
  const { output, edits, publications, endFrame } = input
  const attributed = attributePublications([...edits], publications)
  if (!attributed) return () => `${publications.length} publications do not match the ${edits.length} declared edits (a lost, extra or early revision)`
  const reported = attributed.findIndex((_, index) => !appliedLatencyMatches(attributed.slice(0, index + 1)))
  if (reported >= 0) return (window) => window.index === reported + 1
    ? `the published latency ${publications[reported]?.graphLatencyFrames}/${publications[reported]?.pinnedLatencyFrames} (graph/pinned) differs from the declared move of edit ${window.index}` : undefined
  const initial = attributed[0]?.edits[0]?.fromLatencyFrames ?? 0
  let pinned = initial
  const moves = attributed.map(({ publication, edits: group }) => {
    const graph = group.at(-1)?.toLatencyFrames ?? 0
    const raiseFrames = Math.max(0, graph - pinned)
    pinned = Math.max(pinned, graph)
    return { publicationFrame: publication.publicationFrame, raiseFrames }
  })
  const source: Pcm = { sampleRate: output.sampleRate, channels: 1,
    samples: Float32Array.from({ length: endFrame }, (_, frame) => frame < initial ? 0 : phase5AssetSample(frame - initial, false)) }
  const left: Pcm = { ...output, channels: 1, samples: Float32Array.from({ length: endFrame }, (_, frame) => output.samples[frame * output.channels] ?? NaN) }
  const verdict = compareLatency(left, source, moves.filter((move) => move.raiseFrames > 0), 0, endFrame, publications.map((publication) => publication.publicationFrame))
  return (window) => verdict.passed || window.index !== (verdict.failedPublication ?? 0) + 1 ? undefined
    : `${verdict.mismatches} retained-channel samples differ from the source shifted by the published moves (first at ${verdict.firstMismatch}, max ${verdict.maxAbsDifference})`
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
export const compareDelete = (input: { output: Pcm; seam: number; endFrame: number }): Compare => {
  const { output, seam, endFrame } = input
  const fade = fadeFramesFor(output.sampleRate)
  return () => {
    const beforeFrom = seam - output.sampleRate / 2, afterFrom = seam + fade
    if (beforeFrom < 0 || endFrame - afterFrom < fade) return "the capture does not hold a window before and after the delete"
    const present = peakOf(output, 1, beforeFrom, seam)
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

const logged = z.object({ edits: z.array(z.object({ index: z.number(), name: z.string(), wallMs: z.number(), settledWallMs: z.number().optional(), publicationFrame: z.number(),
  fromLatencyFrames: z.number(), toLatencyFrames: z.number() })) })
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
    settledWallMs: group[0]?.settledWallMs, publicationFrame: group[0]?.publicationFrame ?? 0 }))
  if (row.judge === "take") return judgeBurst(steps, input.captureEndWallMs, compareTake(takeResult.parse(JSON.parse(await readFile(path.join(directory, takeFile), "utf8")))))
  const texts = await Promise.all(input.natives.map((name) => readFile(path.join(launchOut, name), "utf8")))
  const blocks = texts.flatMap(nativeLines).flatMap((entry) => entry.event === "capture-block" ? [captureBlock.parse(entry)] : [])
  const played = playedBlocks(blocks, steps[0]?.editWallMs ?? 0)
  if (!played) return { outcome: "setup", detail: "no capture blocks after the first edit", judged: 0 }
  const { owner, mine } = played
  const capture = await readWav(path.join(launchOut, `output-${owner.pid}-${owner.captureId}.wav`))
  const seams = steps.map((step) => step.publicationFrame)
  const captured = Math.max(...mine.map((block) => block.transportFrame + block.frames))
  if (row.judge === "states") {
    const states = await Promise.all([row.start, ...steps.map((step) => row.cycle[(step.index - 1) % row.cycle.length]?.state ?? "")]
      .map((state) => readWav(input.stateFile(state))))
    const endFrame = Math.min(captured, ...states.map((state) => state.samples.length / state.channels))
    return judgeBurst(steps, input.captureEndWallMs, compareStates({ output: transportIndexed(capture, mine, endFrame), states, seams, endFrame }))
  }
  const output = transportIndexed(capture, mine, captured)
  if (row.judge === "latency") {
    const firstEditWallMs = steps[0]?.editWallMs ?? 0
    const publications = texts.flatMap(nativeLines).flatMap((entry) => {
      const line = publicationLine.safeParse(entry)
      return line.success && line.data.pid === owner.pid && line.data.transportEpoch === owner.transportEpoch
        && line.data.wallMs >= firstEditWallMs && line.data.wallMs <= input.captureEndWallMs ? [line.data] : []
    }).sort((a, b) => a.publicationFrame - b.publicationFrame)
    return judgeBurst(steps, input.captureEndWallMs, compareLatencyMoves({ output, edits, publications, endFrame: captured }))
  }
  if (row.judge === "sustained") return judgeBurst(steps, input.captureEndWallMs, compareSustained({ output, seams, endFrame: captured }))
  if (row.judge === "delete") {
    const cold = lifecycleBetween(texts.flatMap(parseHostLines), steps[0]?.editWallMs ?? 0, input.captureEndWallMs)
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
  const states9 = (output: Pcm) => verdictOf(compareStates({ output, states, seams, endFrame }))
  check(states9(render()).outcome === "pass", "a clean burst passes")
  const held = states9(render((output) => { for (let frame = seams[2] ?? 0; frame < (seams[3] ?? 0); frame++) output.samples[frame * channels + 1] = states[2]?.samples[frame * channels + 1] ?? NaN }))
  check(held.outcome === "fail" && held.editIndex === 3, `a publication that holds the old state fails at its own edit: ${JSON.stringify(held)}`)
  const click = states9(render((output) => { output.samples[((seams[4] ?? 0) + 5000) * channels] += 1e-3 }))
  check(click.outcome === "fail" && click.editIndex === 5, `a click on the retained channel fails at its edit: ${JSON.stringify(click)}`)
  const gap = states9(render((output) => { for (let frame = (seams[1] ?? 0) + 9000; frame < (seams[1] ?? 0) + 9100; frame++) output.samples[frame * channels] = NaN }))
  check(gap.outcome === "fail" && gap.editIndex === 2, `frames no capture block covered fail: ${JSON.stringify(gap)}`)
  const crowded = judgeBurst(steps.map((step, position) => position === 2 ? { ...step, publicationFrame: (seams[1] ?? 0) + fade - 1 } : step), 100_000,
    compareStates({ output: render(), states, seams: [seams[0] ?? 0, seams[1] ?? 0, (seams[1] ?? 0) + fade - 1, ...seams.slice(3)], endFrame }))
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
      samples[frame * channels] = frame < shift ? 0 : Math.fround(Math.fround(phase5AssetSample(frame - shift, false)) * Math.fround(gain))
    }
    return { sampleRate, channels, samples }
  }
  const raised = (frames: number) => [{ publicationFrame: publicationFrames[0] ?? 0, raiseFrames: frames }]
  const latencySteps = latencyEdits.map((edit, position) => ({ index: position + 1, editWallMs: edit.wallMs, settledWallMs: edit.wallMs + 1500 }))
  const raiseRow = (output: Pcm, reports = honest, publications = reportedBy(reports)) =>
    judgeBurst(latencySteps, 20_000, compareLatencyMoves({ output, edits: latencyEdits, publications, endFrame: latencyEnd }))
  check(raiseRow(retainedAfter(raised(high - low))).outcome === "pass", "a raise row whose master path follows the declared moves passes")
  const monitored = raiseRow(retainedAfter([], 0), [0, 0, 0, 0].map(() => ({ graph: 0, pinned: 0 })))
  check(monitored.outcome === "fail" && monitored.editIndex === 1 && /published latency 0\/0/.test(monitored.detail ?? ""), `a fixture whose Spectral is monitored reports 0 and fails at the first publication: ${JSON.stringify(monitored)}`)
  const lostLower = raiseRow(retainedAfter(raised(high - low)), honest.map((report, index) => index === 1 ? { ...report, graph: high } : report))
  check(lostLower.outcome === "fail" && lostLower.editIndex === 2, `a lower that is reported as the pinned level fails at its own edit: ${JSON.stringify(lostLower)}`)
  const wrongShift = raiseRow(retainedAfter(raised(high - low + 1)))
  check(wrongShift.outcome === "fail" && wrongShift.editIndex === 1, `a raise that shifts by one frame too many fails at its edit: ${JSON.stringify(wrongShift)}`)
  const unpinned = raiseRow(retainedAfter([...raised(high - low), { publicationFrame: publicationFrames[2] ?? 0, raiseFrames: high - low }]))
  check(unpinned.outcome === "fail" && unpinned.editIndex === 3, `a second raise to a level already reached must not shift again: ${JSON.stringify(unpinned)}`)
  const extra = raiseRow(retainedAfter(raised(high - low)), honest, [...reportedBy(honest), { wallMs: 9000, publicationFrame: 150_000, graphLatencyFrames: high, pinnedLatencyFrames: high }]
    .sort((a, b) => a.publicationFrame - b.publicationFrame))
  check(extra.outcome === "fail", `a publication no edit made fails: ${JSON.stringify(extra)}`)
  const event = (name: string, wallMs: number) => parseHostLines(`${JSON.stringify({ event: name, wallMs })}\n`)
  check(lifecycleBetween([...event("host-spawn", 1500), ...event("graph-publish", 1600)], 1000, 2000).length === 1, "a host restart after the edit is a lifecycle event")
  check(lifecycleBetween(event("transport-stop", 500), 1000, 2000).length === 0, "an event before the edit is not")
  console.log("ae-08 phase 9 compare self-test: pass")
}

if (import.meta.main) {
  if (Bun.argv[2] === "--self-test") selfTest()
  else throw new Error("Usage: ae-08-phase-9-compare.ts --self-test")
}
