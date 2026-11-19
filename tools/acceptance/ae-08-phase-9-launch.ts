import path from "node:path"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { z } from "zod"
import type { ProjectSnapshotV2 } from "@daw-browser/control"
import { createDefaultLimiterParams, createDefaultSpectralParams, getSpectralLatencyFrames } from "@daw-browser/shared"
import { createAvailableDesktopHostClient } from "@daw-browser/desktop-protocol/client"
import { command } from "../performance/30-track/v3-import-workload"
import { deleteTrackThroughUi, dragUtilityGainKnob, exportReference, heldInstrumentTrack, heldSynthTrack, insertTargetTrack, pressHistoryKey, reorderTargetTrack, required,
  sampledInstrumentParams, pageDeadlineMs, selectFftSize, setupPhase5Fixture, sineSynthParams, waitForUi, waitNativeFrame, liveMidiTrack, type Phase5Context, type SampleAsset } from "./ae-08-phase-5-fixture"
import { awaitPublicationComplete, burstSchedule, judgeStored, MIN_WINDOW_MS, parseHostLines, repetitionsFor, runBurst, type Perform, type Requested, type Timings } from "./ae-08-phase-9-matrix"
import { phase9Presets, type Row } from "./ae-08-phase-9-rows"
import { nativeUnavailableReported, takeFile } from "./ae-08-phase-9-compare"
import { writeWav } from "./ae08-wav"
import { blackhole, describeAudioInputScript, iacPort, makeTone, nativeInputDeviceSchema, playToneIntoBlackhole, selectAudioInputScript, selectMidiInputScript, sendMidiNote } from "./ae-08-phase-9-devices"
import { armRecordTarget, finishRecording, recordingTargetLockedReason, startRecording, toneSeconds, verifyHandedOverTake } from "./ae-08-phase-9-record"
import { createOutputDeviceSteps } from "./ae-08-phase-9-output-device"
import { awaitTestPluginFailure, closeTestPluginEditor, insertTestPlugin, openTestPluginEditor, prepareTestPlugin, refuseUntrustedPlugin, removeTestPlugin, showUntrustedEffectsBrowser } from "./ae-08-phase-9-vst"

// One packaged launch of phase 9: the row's phase 5 start state, then a burst of its edits (settled on host evidence). Edits go
// through the public control actions or the UI steps phase 5 already uses; there is no second protocol.
const sampleRate = 48000
const warmupFrames = sampleRate * 2
const ref = (id: string) => ({ source: "persisted", id })
const move = (fromLatencyFrames: number, toLatencyFrames: number) => ({ fromLatencyFrames, toLatencyFrames })
const unmoved = move(0, 0)
const spectralFrames = (fftSize: 512 | 4096) => getSpectralLatencyFrames(fftSize, createDefaultSpectralParams().overlap)
const silentTrack = "Silent publication target"
// An out-of-process plug-in adds one transport block of latency to what it declares (audio-host.cpp: transport_latency_frames equals
// the attachment's transport.maximum_frames); the packaged runs use the 512-frame device block.
const vstTransportFrames = 512
// Native progress frames are lower bounds on what has been heard, so a window is closed this long after its second.
const windowMarginMs = 250
export type Phase9Launch = { rows: Row[]; requested: Requested; directory: string; contentSeconds: number }

// The ids a performer needs from the project; `observe` reads them from a fresh snapshot, so a performer never holds a stale one.
export type Observed = { spectralEffectId: string | undefined; limiterEffectId: string | undefined; externalEffectId: string | undefined; trackId: (name: string) => string | undefined; clipId: (name: string) => string | undefined
  clipStartSec: (name: string) => number | undefined; effectId: (trackName: string, kind: string) => string | undefined; asset: (name: string) => SampleAsset | undefined }
export const observeSnapshot = (state: ProjectSnapshotV2, changedTrackId: string): Observed => ({
  spectralEffectId: state.processors.find((entry) => "trackId" in entry.target && entry.target.trackId === changedTrackId && entry.processor.kind === "spectral")?.id,
  limiterEffectId: state.processors.find((entry) => "trackId" in entry.target && entry.target.trackId === changedTrackId && entry.processor.kind === "limiter")?.id,
  externalEffectId: state.processors.find((entry) => "trackId" in entry.target && entry.target.trackId === changedTrackId && entry.processor.kind === "external-vst3")?.id,
  trackId: (name) => state.tracks.find((track) => track.name === name)?.id,
  clipId: (name) => state.clips.find((clip) => clip.name.includes(name))?.id,
  clipStartSec: (name) => state.clips.find((clip) => clip.name.includes(name))?.startSec,
  effectId: (trackName, kind) => {
    const trackId = state.tracks.find((track) => track.name === trackName)?.id
    return state.processors.find((entry) => "trackId" in entry.target && entry.target.trackId === trackId && entry.processor.kind === kind)?.id
  },
  asset: (name) => {
    const found = state.assets.find((entry) => entry.name.includes(name))
    return found?.durationSec === undefined || found.sampleRate === undefined || found.channelCount === undefined ? undefined
      : { id: found.id, name: found.name, durationSec: found.durationSec, sampleRate: found.sampleRate, channelCount: found.channelCount }
  },
})

type Performers = {
  context: Pick<Phase5Context, "mutate" | "evaluate" | "interact" | "read" | "reload" | "mark">
  runtime: (args: string[]) => Promise<void>
  // Play then Pause as two requests in order on one control connection; returns when the Pause was issued.
  playThenPause: () => Promise<number>
  transportStatus: () => Promise<{ state: string; playheadSec: number }>
  // The audio host process the app spawned last, and a way to kill one (the host-loss row kills it by pid).
  hostPid: () => Promise<number>
  // Resolves when the app logged a plug-in state read from the playback worker at or after the wall time.
  stateCaptured: (sinceWallMs: number) => Promise<void>
  kill: (pid: number) => void
  observe: () => Promise<Observed>
  setup: { changedTrackId: string; changedFile: string }
}

// The edit names of the built rows (ae-08-phase-9-matrix.ts) and what each does. Each returns the latency move it declares.
export const createPerformer = ({ context, runtime, playThenPause, transportStatus, hostPid, stateCaptured, kill, observe, setup }: Performers): Perform => {
  // An edit through the control protocol is stamped when the app receives its commit.
  const commit = async (actions: Parameters<Performers["context"]["mutate"]>[0]) => ({ ...unmoved, wallMs: await context.mutate(actions) })
  const target = { kind: "track", track: ref(setup.changedTrackId) }
  const changedClip = (present: boolean) => waitForUi(context, `Changed clip ${present ? "not restored" : "not removed"} in the UI`,
    `${present ? "" : "!"}[...document.querySelectorAll('[data-timeline-clip]')].some(e=>e.getAttribute('title')?.includes('changed'))`)
  const settings = (tempoBpm: number) => () => commit([{ kind: "project.settings.set", tempoBpm }])
  const fft = (from: 512 | 4096, to: 512 | 4096) => async () => { await selectFftSize(context, to); return move(spectralFrames(from), spectralFrames(to)) }
  const history = (redo: boolean, clipPresent: boolean) => async () => { await pressHistoryKey(context, redo); await changedClip(clipPresent); return unmoved }
  const deleteImportedClip = async () => {
    const committed = await commit([{ kind: "clip.delete", clip: ref(required((await observe()).clipId("changed"), "Imported changed clip")) }])
    await changedClip(false)
    return committed
  }
  // The test plug-in's Latency parameter (id 1, four steps) in normalized units: 0 is 0 frames, 1 is 4096 (run-ae08-test-plugin.ts). The
  // host reports the plug-in's declared latency plus one transport block (vstTransportFrames), so the moves are declared with it.
  const testPluginLatency = (normalizedValue: number, from: number, to: number) => async () => {
    const { wallMs } = await commit([{ kind: "external-plugin.parameters.set", target,
      processor: ref(required((await observe()).externalEffectId, "Test plug-in processor")), changes: [{ parameterId: 1, normalizedValue }] }])
    return { ...move(from, to), wallMs }
  }
  // The armed recording target can be neither deleted nor rerouted: the commit must be refused with the lock's reason, and a commit that goes
  // through fails the row.
  const refuseTargetChange = (change: string, action: () => Promise<z.infer<ReturnType<typeof z.json>>>) => async () => {
    const refusal = await context.mutate([await action()]).then(() => undefined, (error) => String(error))
    if (refusal === undefined) throw new Error(`${change} the armed recording target was committed`)
    if (!refusal.includes(recordingTargetLockedReason)) throw new Error(`${change} the armed recording target was refused for another reason: ${refusal}`)
    return unmoved
  }
  // The held-instrument rows edit the instrument or an unrelated track under a note that holds on the right channel.
  const trackNamed = async (name: string) => ({ kind: "track", track: ref(required((await observe()).trackId(name), name)) })
  const instrumentEdit = (kind: "sampler" | "drum-rack" | "granular", assetName: string, change: { gain?: number; densityHz?: number }) => async () =>
    commit([{ kind: "instrument.set", target: await trackNamed(heldInstrumentTrack), instrumentKind: kind,
      params: sampledInstrumentParams(kind, required((await observe()).asset(assetName), `${assetName} asset`), change) }])
  const polyphony = (voices: number) => async () => commit([{ kind: "instrument.set", target: await trackNamed(heldSynthTrack), instrumentKind: "synth", params: sineSynthParams(voices) }])
  // The Utility then the Saturator on the target track, or the other way round.
  const reorder = (saturatorFirst: boolean) => async () => {
    const observed = await observe()
    const [utility, saturator] = [required(observed.effectId(reorderTargetTrack, "utility"), "Utility device"), required(observed.effectId(reorderTargetTrack, "saturator"), "Saturator device")]
    const order = [{ effect: ref(utility), kind: "utility" }, { effect: ref(saturator), kind: "saturator" }]
    return commit([{ kind: "effect.reorder", target: await trackNamed(reorderTargetTrack), order: saturatorFirst ? order.toReversed() : order }])
  }
  const lookahead = (lookaheadMs: number) => async () => commit([{ kind: "effect.upsert", target, effectKind: "limiter",
    effect: ref(required((await observe()).limiterEffectId, "Limiter device")), params: { version: 1, state: { ...createDefaultLimiterParams(), lookaheadMs } } }])
  // The transport rows (PackagedRun.transport) start and cancel the transport themselves and mark what they observed for the judge
  // (compareHostLoss, compareCancelledStart). `cancelWallMs` is when the command that cancels or kills was issued.
  const observeTransport = async (edit: string, cancelWallMs: number, status: { state: string; playheadSec: number }, failure = "") =>
    context.mark("transport-observed", { edit, pid: await hostPid(), cancelWallMs, state: status.state, playheadSec: status.playheadSec, failure })
  // A Play whose start has not landed. The Play button is aria-busy while its start is pending, stays "Play" until a start lands (then it
  // reads "Pause"), and has no Pause to press meanwhile. A trail of its attribute changes shows the cancel arrived while the Play was
  // pending: it went busy and the label never left "Play". A run without that trail fails as oracle, whatever the transport shows.
  const watchPlayButton = () => context.evaluate(`(()=>{const b=document.querySelector('button[aria-label="Play"]');if(!b)throw new Error('Play unavailable')
    window.ae08PlayWatch?.disconnect();const trail=[];window.ae08PlayTrail=trail
    window.ae08PlayWatch=new MutationObserver(records=>{for(const r of records)trail.push(r.attributeName+':'+r.oldValue)})
    window.ae08PlayWatch.observe(b,{attributes:true,attributeOldValue:true,attributeFilter:['aria-busy','aria-label']});return true})()`)
  const provePendingCancel = async (cancel: string) => {
    await waitForUi(context, `${cancel} never cleared the pending Play`, `document.querySelector('button[aria-label="Play"]')?.getAttribute('aria-busy')!=='true'`)
    const trail = await context.read(`JSON.stringify(window.ae08PlayTrail)`, z.array(z.string()))
    if (!trail.includes("aria-busy:true")) throw new Error(`Oracle: the Play was never pending when ${cancel} cancelled it`)
    if (trail.includes("aria-label:Play")) throw new Error(`Oracle: the Play's start landed (the button read Pause) before ${cancel} cancelled it`)
  }
  // Stop is always pressable, so one renderer task presses Play and then Stop. Pause is not (the control protocol's pause is the only one a
  // pending Play meets), so the two requests go in order down one control connection.
  const cancelledPlay = (cancel: "pause" | "stop") => async () => {
    await watchPlayButton()
    const cancelWallMs = cancel === "pause" ? await playThenPause() : await context.read(`JSON.stringify((()=>{
      const play=document.querySelector('button[aria-label="Play"]'),stop=document.querySelector('button[aria-label="Stop"]')
      if(!play||!stop)throw new Error('Play or Stop unavailable');play.click();const at=Date.now();stop.click();return at})())`, z.number())
    await provePendingCancel(cancel)
    await observeTransport(`play-then-${cancel}`, cancelWallMs, await transportStatus())
    return unmoved
  }
  const performers = new Map([
    ["target-delete-refused", refuseTargetChange("Deleting", async () => ({ kind: "track.delete", track: ref(setup.changedTrackId) }))],
    // The armed track already outputs to Master, so a null output is no change, and the planner drops a send to anything but a return track.
    // The control actions cannot create one: Shift + R adds it, and a send to it changes what the take is bound to.
    ["target-reroute-refused", refuseTargetChange("Rerouting", async () => {
      await context.evaluate(`window.dispatchEvent(new KeyboardEvent("keydown",{key:"R",shiftKey:true,bubbles:true,cancelable:true}))`)
      const returnLabel = `[...document.querySelectorAll('button[aria-label]')].map(b=>b.getAttribute('aria-label')??'').find(label=>/: Return \\d+$/.test(label))`
      await waitForUi(context, "No return track appeared", `Boolean(${returnLabel})`)
      const name = (await context.read(`JSON.stringify(${returnLabel}?.split(': ').at(-1))`, z.string()))
      return { kind: "track.routing.set", track: ref(setup.changedTrackId), sends: [{ target: ref(required((await observe()).trackId(name), name)), amount: 0.5 }] }
    })],
    ["instrument-remove", async () => commit([{ kind: "instrument.remove", target: await trackNamed(insertTargetTrack) }])],
    ["instrument-insert", async () => commit([{ kind: "instrument.set", target: await trackNamed(insertTargetTrack), instrumentKind: "synth", params: sineSynthParams() }])],
    ["effects-reverse", reorder(true)],
    ["effects-restore", reorder(false)],
    ["polyphony-2", polyphony(2)],
    ["polyphony-16", polyphony(16)],
    ["sampler-gain-half", instrumentEdit("sampler", "changed", { gain: 0.5 })],
    ["sampler-gain-full", instrumentEdit("sampler", "changed", {})],
    ["drum-rack-gain-half", instrumentEdit("drum-rack", "changed", { gain: 0.5 })],
    ["drum-rack-gain-full", instrumentEdit("drum-rack", "changed", {})],
    ["granular-density-48", instrumentEdit("granular", "changed", { densityHz: 48 })],
    ["granular-density-40", instrumentEdit("granular", "changed", {})],
    // A 1 % louder copy of the sample: the note switches to it at the same playback position and stays unbroken.
    ["sampler-swap-asset", instrumentEdit("sampler", "swap", {})],
    ["sampler-swap-back", instrumentEdit("sampler", "changed", {})],
    ...[1, 2, 3, 4, 5].map((copy): [string, ReturnType<typeof instrumentEdit>] => [`sampler-swap-asset-${copy}`, instrumentEdit("sampler", `swap-${copy}`, {})]),
    // The user's Play press, the audio host killed by pid while the press is pending, and the app's own report of it.
    ["play-kill-host", async () => {
      const pid = await hostPid()
      await context.evaluate(`(()=>{const b=document.querySelector('button[aria-label="Play"]');if(!b)throw new Error('Play unavailable');b.click();return true})()`)
      await waitForUi(context, "Play never became pending", `document.querySelector('button[aria-label="Play"]')?.getAttribute('aria-busy')==='true'`)
      const cancelWallMs = Date.now()
      kill(pid)
      await waitForUi(context, "No native-unavailable fault was reported", `/native[^.\\n]*(unavailable|stopped)/i.test(document.body.innerText)`)
      const stopped = await context.read(`JSON.stringify(document.querySelector('button[aria-label="Pause"]')===null)`, z.boolean())
      await context.mark("transport-observed", { edit: "play-kill-host", pid, cancelWallMs, state: stopped ? "stopped" : "playing", playheadSec: 0, failure: nativeUnavailableReported })
      return unmoved
    }],
    // A paused session to cancel over: from a stopped or paused transport it plays first.
    ["session-pause", async () => {
      if ((await transportStatus()).state !== "playing") await runtime(["play"])
      const cancelWallMs = Date.now()
      await runtime(["pause"])
      await observeTransport("session-pause", cancelWallMs, await transportStatus())
      return unmoved
    }],
    ["play-then-pause", cancelledPlay("pause")],
    ["play-then-stop", cancelledPlay("stop")],
    // The next Play over the cancelled one: no rebuild, so the Play simply plays.
    ["play-resume", async () => {
      const cancelWallMs = Date.now()
      await runtime(["play"])
      await observeTransport("play-resume", cancelWallMs, await transportStatus())
      return unmoved
    }],
    ["lookahead-1ms", lookahead(1)],
    ["lookahead-5ms", lookahead(5)],
    // The drag overrides the lane on the Utility Gain knob; the transport's red button re-enables it.
    ["knob-drag", async () => { await dragUtilityGainKnob(context, 10); return unmoved }],
    ["lane-rearm", async () => {
      await context.evaluate(`(()=>{const b=document.querySelector('button[aria-label^="Re-enable automation"]');if(!b)throw new Error('Re-enable automation unavailable');b.click();return true})()`)
      await waitForUi(context, "Automation not re-enabled", `!document.querySelector('button[aria-label^="Re-enable automation"]')`)
      return unmoved
    }],
    ["fft-4096", fft(512, 4096)],
    ["fft-512", fft(4096, 512)],
    ["spectral-remove", async () => {
      const { wallMs } = await commit([{ kind: "effect.remove", target, effectKind: "spectral", effect: ref(required((await observe()).spectralEffectId, "Spectral device")) }])
      return { ...move(spectralFrames(512), 0), wallMs }
    }],
    ["spectral-attach", async () => {
      const { wallMs } = await commit([{ kind: "effect.upsert", target, effectKind: "spectral",
        params: { version: 1, state: { ...createDefaultSpectralParams(), fftSize: 512, mix: 1 } } }])
      return { ...move(0, spectralFrames(512)), wallMs }
    }],
    ["track-delete", async () => { await deleteTrackThroughUi(context, "Changed right"); await changedClip(false); return unmoved }],
    ["undo", history(false, true)],
    ["redo", history(true, false)],
    // The import takes the playhead for its start; the oracle needs the start the clip really took (placedAt in the compare).
    // A clip edit during playback pauses Follow, so a later import lands at the playhead beyond the unscrolled viewport and renders no
    // clip node. The snapshot is the only viewport-independent signal that the import was adopted; it has no event, so it is polled
    // until the page deadline.
    ["asset-import", async () => {
      await runtime(["import", "--path", setup.changedFile])
      const deadline = Date.now() + pageDeadlineMs
      let startSec = (await observe()).clipStartSec("changed")
      while (startSec === undefined) {
        if (Date.now() > deadline) throw new Error("Import UI deadline: changed")
        await Bun.sleep(50)
        startSec = (await observe()).clipStartSec("changed")
      }
      return { ...unmoved, startSec }
    }],
    ["asset-clip-delete", deleteImportedClip],
    ["clip-delete", deleteImportedClip],
    ["vst-insert", async () => { await insertTestPlugin(context); return unmoved }],
    ["vst-remove", async () => { await removeTestPlugin(context); return unmoved }],
    ["editor-open", async () => {
      await stateCaptured(await closeTestPluginEditor(context))
      await openTestPluginEditor(context)
      return unmoved
    }],
    // The test plug-in's Fault parameter (id 2): its second step, 1/3 normalized, aborts the worker's next process call.
    ["vst-fault", async () => {
      const { wallMs } = await commit([{ kind: "external-plugin.parameters.set", target,
        processor: ref(required((await observe()).externalEffectId, "Test plug-in processor")), changes: [{ parameterId: 2, normalizedValue: 1 / 3 }] }])
      await awaitTestPluginFailure(context)
      return { ...unmoved, wallMs }
    }],
    ["untrusted-insert", async () => { await refuseUntrustedPlugin(context); return unmoved }],
    ["latency-high", testPluginLatency(1, vstTransportFrames, vstTransportFrames + 4096)],
    ["latency-low", testPluginLatency(0, vstTransportFrames + 4096, vstTransportFrames)],
    ["silent-track-create", () => commit([{ kind: "track.create", name: silentTrack, trackKind: "audio" }])],
    ["silent-track-delete", async () => {
      return commit([{ kind: "track.delete", track: ref(required((await observe()).trackId(silentTrack), silentTrack)) }])
    }],
    ["tempo-137", settings(137)],
    ["tempo-120", settings(120)],
  ])
  return async (edit) => {
    const perform = performers.get(edit)
    if (!perform) throw new Error(`No phase 9 performer for ${edit}`)
    return perform()
  }
}

// The playing content must outlast the longest merged burst, with the assumed edit time doubled for slack and a tail for the last window.
export const contentSecondsFor = (rows: readonly Row[], requested: Requested, timings: Timings) =>
  Math.max(24, Math.ceil(rows.reduce((total, row) => total + burstSchedule(row, repetitionsFor(row, requested)).length
    * 2 * (row.repeat === "vst-burst" ? timings.vstStepSeconds : timings.stepSeconds), 0)) + 30)

// Phase 5 fixtures name a row ("phase5:effect-state"); a launch's merged rows share one.
const fixtureRow = (rows: readonly Row[]) => {
  const names = new Set(rows.map((row) => row.fixture))
  const [only] = names
  if (names.size !== 1 || !only?.startsWith("phase5:")) throw new Error(`A phase 9 launch needs one phase 5 fixture, got ${[...names].join(", ")}`)
  return only.slice("phase5:".length)
}

// What a row's `prepare` steps do. They run on the fixture's start state before the capture, except the held note, which is played
// once the transport runs and released after the last window.
const heldNote = 69
export const performPrepare = async (context: Pick<Phase5Context, "evaluate" | "interact" | "reload">, step: string) => {
  if (step === "record-select-input") {
    await context.evaluate(selectAudioInputScript(blackhole))
    return context.reload()
  }
  if (step === "record-arm") return armRecordTarget(context)
  if (step === "vst-trust") return prepareTestPlugin(context, "Changed right")
  if (step === "vst-insert") return insertTestPlugin(context)
  if (step === "vst-untrusted-browser") return showUntrustedEffectsBrowser(context, "Changed right")
  if (step === "midi-select-iac") {
    await context.evaluate(selectMidiInputScript(iacPort))
    await context.reload()
    return context.evaluate(`(()=>{const b=[...document.querySelectorAll('button[aria-label]')].find(b=>b.getAttribute('aria-label')?.endsWith(': ${liveMidiTrack}'));if(!b)throw new Error('Live MIDI track selector missing');b.click();return true})()`)
  }
  if (step === "midi-hold") return void await sendMidiNote("on", heldNote)
  throw new Error(`No phase 9 prepare step ${step}`)
}
export const stateName = (row: string, state: string) => `state-${row}-${state}`
const transportStatusSchema = z.object({ state: z.string(), playheadSec: z.number() })
// The audio host still running: the main process's host-spawn lines name its pid. A spawn the host-exit lines already closed (the app
// starts and ends a short-lived host while it inserts a plug-in) is not the session's host.
const lastHostPid = async (out: string) => {
  const events = parseHostLines(await readFile(path.join(out, "host.jsonl"), "utf8"))
  const exited = new Set(events.filter((event) => event.event === "host-exit").map((event) => event.pid))
  const spawned = events.findLast((event) => event.event === "host-spawn" && event.pid > 0 && !exited.has(event.pid))
  if (!spawned) throw new Error("The app logged no running audio host")
  return spawned.pid
}
const diagnosticsSchema = z.object({ native: z.object({ diagnostics: z.object({ installedAssets: z.number() }) }) })
const refusedDiagnosticsSchema = z.object({ native: z.object({ status: z.literal("failed") }) })
const refusedDiagnosticsAttempts = 40

export const runPhase9Launch = async (context: Phase5Context, launch: Phase9Launch) => {
  const { out, profile, mark } = context
  const runtime = (args: string[]) => command(profile, ["host", ...args])
  const setup = await setupPhase5Fixture({ ...context, row: fixtureRow(launch.rows), contentSeconds: launch.contentSeconds })
  const prepare = [...new Set(launch.rows.flatMap((row) => row.prepare ?? []))]
  for (const step of prepare.filter((entry) => entry !== "midi-hold")) await performPrepare(context, step)
  if (prepare.includes("record-select-input")) {
    const listed = await context.read(describeAudioInputScript(blackhole), nativeInputDeviceSchema)
    await mark("native-input-device", listed)
  }
  const transportStatus = async () => transportStatusSchema.parse(await runtime(["transport-status"]))
  const playThenPause = async () => {
    const client = await createAvailableDesktopHostClient({ userDataDirectory: profile, actorPath: path.join(profile, "host-actor-v1.json") })
    try {
      const play = client.request("transport.play", {})
      const cancelWallMs = Date.now()
      await Promise.allSettled([play, client.request("transport.pause", {})])
      return cancelWallMs
    } finally { client.close() }
  }
  const performEdit = createPerformer({ context, runtime: async (args) => { await runtime(args) }, playThenPause, transportStatus,
    hostPid: () => lastHostPid(out), kill: (pid) => process.kill(pid, "SIGKILL"),
    stateCaptured: async (sinceWallMs) => { await awaitPublicationComplete(out, sinceWallMs, false, 10_000, "state-capture") },
    setup: { changedTrackId: setup.changedTrack.id, changedFile: setup.changedFile },
    observe: async () => observeSnapshot(await context.snapshot(), setup.changedTrack.id) })
  const outputDeviceSteps = createOutputDeviceSteps({ context, out, transportStatus })
  const perform: Perform = async (edit) => {
    const step = outputDeviceSteps.get(edit)
    if (!step) return performEdit(edit)
    await step()
    return unmoved
  }
  await runtime(["seek", "0"])
  await mark("capture-start")
  const playWallMs = Date.now()
  // A row whose edits drive the transport plays, cancels and kills on their own: no Play here, no audio to wait for.
  const driven = launch.rows.some((row) => row.transport === "driven")
  // A recording row starts the transport by Start recording and plays its tone into BlackHole from the start of the burst, so its edit
  // lands inside the take.
  const takeRow = launch.rows.find((row) => row.judge === "take")
  const before = takeRow ? await startRecording(context) : driven ? undefined : (await runtime(["play"]), undefined)
  if (!driven) await waitNativeFrame(context, warmupFrames)
  if (prepare.includes("midi-hold")) await performPrepare(context, "midi-hold")
  const tone = takeRow ? playToneIntoBlackhole(path.join(out, "tone.wav"), toneSeconds).then(() => undefined, (error) => error instanceof Error ? error : new Error(String(error))) : undefined
  // Asset inventory: the installed-asset count the host reports, recorded before the burst and after each publication with that
  // publication's revision.
  // The main process refuses a native diagnostics read while another host request is pending (it answers status "failed"), and a
  // publication can still be in flight after its edit settles, so a refused read is asked again once that request has had its turn.
  const installedAssets = async () => {
    for (let attempt = 1; ; attempt++) {
      const reply = await runtime(["diagnostics-v2"])
      if (attempt < refusedDiagnosticsAttempts && refusedDiagnosticsSchema.safeParse(reply).success) {
        await Bun.sleep(50)
        continue
      }
      return diagnosticsSchema.parse(reply).native.diagnostics.installedAssets
    }
  }
  if (!driven) await mark("asset-inventory", { revision: 0, installedAssets: await installedAssets() })
  for (const row of launch.rows) {
    const logged = await runBurst({ out, directory: path.join(launch.directory, row.name), row, perform, mark, sampleRate,
      frameAt: (wallMs) => Math.max(1, Math.round((wallMs - playWallMs) * sampleRate / 1000)),
      repetitions: repetitionsFor(row, launch.requested),
      afterSettle: async (settled) => { if (!driven) await mark("asset-inventory", { revision: settled.revision, installedAssets: await installedAssets() }) },
      hold: async (frame) => { if (!driven) await waitNativeFrame(context, frame) } })
    // The last edit's window needs its second (and the next row's first window starts after it), so hold until the transport
    // has rendered that far. The transport started at frame 0 at playWallMs.
    const lastSettled = logged.at(-1)?.settledWallMs
    if (lastSettled !== undefined && !driven) await waitNativeFrame(context, Math.ceil((lastSettled + MIN_WINDOW_MS + windowMarginMs - playWallMs) * sampleRate / 1000))
  }
  if (prepare.includes("midi-hold")) await sendMidiNote("off", heldNote)
  if (takeRow && before) {
    const toneFailure = await tone
    if (toneFailure !== undefined) throw toneFailure
    const verdict = await finishRecording(context, { before, file: path.join(out, "take.wav") })
    await writeFile(path.join(launch.directory, takeRow.name, takeFile), JSON.stringify(verdict))
  }
  await mark("capture-end")
  // The host of a driven row may be the one it killed, or paused mid-cancel; the runner quits the app.
  if (driven) return
  await writeFile(path.join(out, "diagnostics-active.json"), JSON.stringify(await runtime(["diagnostics-v2"]), null, 2))
  await runtime(["stop"])
  // One offline export per state of each compared row, with the project in that state: the references of judgeBurst. Each row's burst
  // ended on its start state, and one pass over its cycle returns it there.
  for (const row of launch.rows.filter((entry) => entry.judge === "states")) {
    const wanted = (state: string) => row.reference === undefined || row.reference === state
    const exported = new Set([row.start])
    if (wanted(row.start)) await exportReference(context, stateName(row.name, row.start), launch.contentSeconds)
    // The transport is stopped: put the playhead at 0 so an import places its clip at 0, the start placedAt shifts from.
    await runtime(["seek", "0"])
    for (const step of row.cycle) {
      for (const edit of step.edits) {
        const { startSec } = await perform(edit)
        if (startSec !== undefined && startSec !== 0) throw new Error(`The reference ${edit} placed its clip at ${startSec} s, not 0`)
      }
      if (wanted(step.state) && !exported.has(step.state)) await exportReference(context, stateName(row.name, step.state), launch.contentSeconds)
      exported.add(step.state)
    }
  }
}

// ---- Per-row evidence in the shape ae-08-latency-gates.ts reads: <run>/phase9/<row>/{host,actions,phase9-edits,latency-class} ----
const edits = z.object({ edits: z.array(z.object({ wallMs: z.number() })) })
const lines = async (file: string) => (await readFile(file, "utf8")).split("\n").filter(Boolean)

// A merged launch's host.jsonl holds every row's publications, so each row keeps the events from its first step to the next row's
// first step (and every device-session line, which the gates need), and its capture ends where the next row's first step begins.
export const exportRowEvidence = async (launchOut: string, directory: string, rows: readonly Row[]) => {
  const starts = await Promise.all(rows.map(async (row) => edits.parse(JSON.parse(await readFile(path.join(directory, row.name, "phase9-edits.json"), "utf8")))
    .edits.reduce((first, edit) => Math.min(first, edit.wallMs), Number.POSITIVE_INFINITY)))
  const host = await lines(path.join(launchOut, "host.jsonl"))
  const events = parseHostLines(host.join("\n") + "\n")
  const actions = await lines(path.join(launchOut, "actions.jsonl"))
  for (const [position, row] of rows.entries()) {
    const from = starts[position] ?? Number.POSITIVE_INFINITY, to = starts[position + 1] ?? Number.POSITIVE_INFINITY
    const inRow = (wallMs: number) => wallMs >= from && wallMs < to
    await writeFile(path.join(directory, row.name, "host.jsonl"), host.filter((_, index) => {
      const event = events[index]
      return event !== undefined && (event.event === "device-session" || inRow(event.wallMs))
    }).join("\n") + "\n")
    await writeFile(path.join(directory, row.name, "actions.jsonl"), actions.map((line) => {
      const action = z.object({ event: z.string() }).passthrough().parse(JSON.parse(line))
      return action.event === "capture-end" && to !== Number.POSITIVE_INFINITY ? JSON.stringify({ ...action, wallMs: to }) : line
    }).join("\n") + "\n")
  }
}

// ---- Self-test: each performer's request against a recorded fake context ----
const check = (condition: boolean, message: string) => { if (!condition) throw new Error(`phase 9 launch self-test: ${message}`) }

export const selfTest = async () => {
  const calls: string[] = []
  let trail = ["aria-busy:false", "aria-busy:true"]
  const transport = { state: "stopped", playheadSec: 0 }
  const observed: Observed = { spectralEffectId: "spectral-1", limiterEffectId: "limiter-1", externalEffectId: "external-1", trackId: (name) => name === silentTrack ? "silent-1" : `track-of-${name}`, clipId: (name) => name === "changed" ? "clip-1" : undefined, clipStartSec: (name) => name === "changed" ? 2 : undefined,
    effectId: (trackName, kind) => trackName === reorderTargetTrack ? `${kind}-1` : undefined,
    asset: (name) => ({ id: `asset-${name}`, name: `${name}.wav`, durationSec: 30, sampleRate: 48000, channelCount: 2 }) }
  const perform = createPerformer({
    context: {
      mutate: async (actions) => { calls.push(`mutate ${JSON.stringify(actions)}`); return 4242 },
      evaluate: async (script) => { calls.push(`evaluate ${script}`) },
      interact: async (args) => { calls.push(`interact ${args.join(" ")}`) },
      read: async (script, schema) => { calls.push(`read ${script}`); return schema.parse(script.includes("getBoundingClientRect") ? { x: 300, y: 200 } : script.includes("ae08PlayTrail") ? trail
        : script.includes("play.click()") ? 4242 : script.includes("Pause") ? true : 0) },
      reload: async () => { calls.push("reload") },
      mark: async (event, fields) => { calls.push(`mark ${event} ${JSON.stringify(fields)}`) },
    },
    runtime: async (args) => { calls.push(`runtime ${args.join(" ")}`) },
    playThenPause: async () => { calls.push("control play then pause"); return 4243 },
    transportStatus: async () => { calls.push("runtime transport-status"); return { state: transport.state, playheadSec: transport.playheadSec } },
    hostPid: async () => 4711,
    stateCaptured: async (sinceWallMs) => { calls.push(`state-captured ${sinceWallMs > 0}`) },
    kill: (pid) => { calls.push(`kill ${pid}`) },
    observe: async () => observed,
    setup: { changedTrackId: "track-1", changedFile: "/tmp/changed.wav" },
  })
  const run = async (edit: string) => {
    calls.length = 0
    const moved = await perform(edit)
    return { moved, calls: [...calls] }
  }
  const spectral512 = spectralFrames(512), spectral4096 = spectralFrames(4096)
  check(spectral512 > 0 && spectral4096 > spectral512, "the Spectral latency grows with the FFT size")

  const tempo = await run("tempo-137")
  check(tempo.calls[0] === `mutate ${JSON.stringify([{ kind: "project.settings.set", tempoBpm: 137 }])}` && tempo.moved.toLatencyFrames === 0, `tempo-137: ${tempo.calls}`)
  check(tempo.moved.wallMs === 4242, "a control edit reports the wall time of its commit")
  check((await run("tempo-120")).calls[0] === `mutate ${JSON.stringify([{ kind: "project.settings.set", tempoBpm: 120 }])}`, "tempo-120")

  const raise = await run("fft-4096")
  check(raise.calls[0]?.includes("'4096'") === true || raise.calls[0]?.includes('"4096"') === true, `fft-4096 clicks the 4096 button: ${raise.calls[0]}`)
  check(raise.moved.fromLatencyFrames === spectral512 && raise.moved.toLatencyFrames === spectral4096, "fft-4096 declares 512 to 4096")
  const lower = await run("fft-512")
  check(lower.moved.fromLatencyFrames === spectral4096 && lower.moved.toLatencyFrames === spectral512, "fft-512 declares 4096 to 512")

  const remove = await run("spectral-remove")
  check(remove.calls[0] === `mutate ${JSON.stringify([{ kind: "effect.remove", target: { kind: "track", track: ref("track-1") }, effectKind: "spectral", effect: ref("spectral-1") }])}`,
    `spectral-remove names the observed Spectral: ${remove.calls[0]}`)
  check(remove.moved.fromLatencyFrames === spectral512 && remove.moved.toLatencyFrames === 0, "spectral-remove declares a lower to zero")
  const attach = await run("spectral-attach")
  check(attach.calls[0]?.includes('"kind":"effect.upsert"') === true && attach.calls[0]?.includes('"effectKind":"spectral"') === true && attach.calls[0]?.includes('"fftSize":512') === true,
    `spectral-attach upserts a 512 Spectral: ${attach.calls[0]}`)
  check(attach.moved.fromLatencyFrames === 0 && attach.moved.toLatencyFrames === spectral512, "spectral-attach declares a raise from zero")

  // The lookahead rows patch the observed Limiter in place; the lane row drags the knob once and re-enables the lane from the transport.
  const limiterAction = (lookaheadMs: number) => `mutate ${JSON.stringify([{ kind: "effect.upsert", target: { kind: "track", track: ref("track-1") }, effectKind: "limiter",
    effect: ref("limiter-1"), params: { version: 1, state: { ...createDefaultLimiterParams(), lookaheadMs } } }])}`
  check((await run("lookahead-1ms")).calls[0] === limiterAction(1) && (await run("lookahead-5ms")).calls[0] === limiterAction(5), "the lookahead edits upsert the observed Limiter at 1 and 5 ms")
  const drag = await run("knob-drag")
  check(drag.calls.filter((call) => call.startsWith("interact mouse")).join("|") === "interact mouse move 300 200|interact mouse down|interact mouse move 300 210|interact mouse up",
    `knob-drag presses, moves once and releases: ${drag.calls.filter((call) => call.startsWith("interact"))}`)
  const rearm = await run("lane-rearm")
  check(rearm.calls[0]?.includes('button[aria-label^="Re-enable automation"]') === true && rearm.calls[0]?.includes(".click()") === true, "lane-rearm clicks the transport's Re-enable automation button")

  const create = await run("silent-track-create")
  check(create.calls[0] === `mutate ${JSON.stringify([{ kind: "track.create", name: silentTrack, trackKind: "audio" }])}`, "silent-track-create")
  const drop = await run("silent-track-delete")
  check(drop.calls[0] === `mutate ${JSON.stringify([{ kind: "track.delete", track: ref("silent-1") }])}`, "silent-track-delete names the observed track")

  const imported = await run("asset-import")
  check(imported.calls[0] === "runtime import --path /tmp/changed.wav", "asset-import imports the changed file")
  check(imported.moved.startSec === 2, "asset-import reports the start the clip took")
  const deleted = await run("asset-clip-delete")
  check(deleted.calls[0] === `mutate ${JSON.stringify([{ kind: "clip.delete", clip: ref("clip-1") }])}`, "asset-clip-delete names the observed clip")

  const trackDelete = await run("track-delete")
  check(trackDelete.calls.some((call) => call.startsWith("interact find text Delete track click")), "track-delete opens the Delete track menu item")
  const undo = await run("undo"), redo = await run("redo")
  check(undo.calls[0]?.includes("shiftKey:false") === true && redo.calls[0]?.includes("shiftKey:true") === true, "undo and redo differ by shift")

  // The VST rows: insert and remove go through the UI, the latency switch through the control action with the observed processor.
  const insert = await run("vst-insert")
  check(insert.calls[0]?.includes("ae08") === true && insert.calls[0]?.includes(".click()") === true && insert.calls.some((call) => call.includes("[data-external-effect-id]")), `vst-insert clicks the plug-in's browser entry and waits for its card: ${insert.calls[0]}`)
  const take = await run("vst-remove")
  check(take.calls[0]?.includes("'Delete'") === true && take.calls.every((call) => !call.startsWith("interact")), "vst-remove clicks the device card's Delete button")
  const high = await run("latency-high"), low = await run("latency-low")
  const latencyAction = (normalizedValue: number) => `mutate ${JSON.stringify([{ kind: "external-plugin.parameters.set", target: { kind: "track", track: ref("track-1") }, processor: ref("external-1"), changes: [{ parameterId: 1, normalizedValue }] }])}`
  check(high.calls[0] === latencyAction(1) && high.moved.fromLatencyFrames === 512 && high.moved.toLatencyFrames === 4608, `latency-high sets the Latency parameter to its top step: ${high.calls[0]}`)
  check(low.calls[0] === latencyAction(0) && low.moved.fromLatencyFrames === 4608 && low.moved.toLatencyFrames === 512, "latency-low sets it back")
  // The editor opens through the card's Open UI button and is awaited as Close UI; the fault sets the Fault parameter's crash step and
  // waits for the card to report it; the untrusted insert opens the dashboard, finds the trust prompt and no plug-in entry, and clicks nothing.
  // The inserted plug-in's editor is already open: the step closes it through Close UI, waits for the state capture, then clicks Open UI.
  const editor = await run("editor-open")
  const closeClick = editor.calls.findIndex((call) => call.includes(`"Close UI"`) && call.includes(".click()"))
  const captured = editor.calls.indexOf("state-captured true")
  const openClick = editor.calls.findIndex((call) => call.includes(`"Open UI"`) && call.includes(".click()") && !call.includes(`"Close UI"`))
  check(closeClick >= 0 && captured > closeClick && openClick > captured && editor.calls.some((call) => call.includes(`"Close UI"`) && !call.includes(".click()")),
    `editor-open closes the auto-opened editor, awaits its state capture, then clicks Open UI and awaits Close UI: ${editor.calls}`)
  const faulty = await run("vst-fault")
  const faultAction = `mutate ${JSON.stringify([{ kind: "external-plugin.parameters.set", target: { kind: "track", track: ref("track-1") }, processor: ref("external-1"), changes: [{ parameterId: 2, normalizedValue: 1 / 3 }] }])}`
  check(faulty.calls[0] === faultAction && faulty.moved.wallMs === 4242 && faulty.calls.some((call) => call.includes("Plug-in failed")), `vst-fault crashes the plug-in and awaits its failure on the card: ${faulty.calls[0]}`)
  const refusal = await run("untrusted-insert")
  check(refusal.calls.some((call) => call.includes("I understand and trust the VST3 plug-ins I add.")) && refusal.calls.some((call) => call.includes("'Rescan','Add directory'"))
    && refusal.calls.every((call) => !call.includes(".click()") || !call.includes("ae08")), `untrusted-insert asks for trust and clicks no plug-in entry: ${refusal.calls}`)
  // The transport rows: the Play press goes through the UI and the host is killed by the pid the app spawned; a cancelled Play issues Play,
  // then its cancel, and marks the transport it finds; an unknown cancel would not exist.
  const killed = await run("play-kill-host")
  const clicked = killed.calls.findIndex((call) => call.startsWith("evaluate") && call.includes('aria-label="Play"') && call.includes(".click()"))
  const killedAt = killed.calls.indexOf("kill 4711")
  check(clicked === 0 && killedAt > clicked && killed.calls.some((call) => call.includes("aria-busy")), `play-kill-host presses Play, waits for it to be pending, then kills the host: ${killed.calls}`)
  check(killed.calls.at(-1)?.startsWith(`mark transport-observed {"edit":"play-kill-host","pid":4711`) === true && killed.calls.at(-1)?.includes(`"state":"stopped"`) === true
    && killed.calls.at(-1)?.includes(`"failure":"native-unavailable"`) === true, `play-kill-host marks the host it killed and a stopped transport: ${killed.calls.at(-1)}`)
  transport.state = "paused"
  transport.playheadSec = 1.5
  const cancelled = await run("play-then-pause")
  check(cancelled.calls.some((call) => call === "control play then pause") && cancelled.calls.at(-1)?.includes(`"edit":"play-then-pause"`) === true
    && cancelled.calls.at(-1)?.includes(`"cancelWallMs":4243`) === true
    && cancelled.calls.at(-1)?.includes(`"state":"paused","playheadSec":1.5`) === true, `play-then-pause issues Play then Pause in order and marks the paused transport: ${cancelled.calls}`)
  const stopped = await run("play-then-stop")
  check(stopped.calls.some((call) => call.includes("play.click()") && call.indexOf("play.click()") < call.indexOf("stop.click()")) && !stopped.calls.some((call) => call === "runtime play" || call === "runtime stop"),
    `play-then-stop presses Play then Stop in one renderer task: ${stopped.calls}`)
  check(stopped.calls.at(-1)?.includes(`"cancelWallMs":4242`) === true, "play-then-stop marks the time between the two presses")
  // A cancel that was not over a pending Play fails as oracle, whatever the transport shows afterwards.
  const badTrails: [string, string[]][] = [["never pending", ["aria-busy:false"]], ["start landed", ["aria-busy:true", "aria-label:Play"]]]
  for (const [label, bad] of badTrails) {
    trail = bad
    const refused = await run("play-then-pause").then(() => "", (error) => String(error))
    check(refused.includes("Oracle:"), `a cancel with a trail of ${label} fails as oracle: ${refused}`)
  }
  trail = ["aria-busy:false", "aria-busy:true"]
  const preparing = await run("session-pause")
  check(preparing.calls.slice(0, 3).join("|") === "runtime transport-status|runtime play|runtime pause", `session-pause plays a session that is not playing, then pauses it: ${preparing.calls}`)
  transport.state = "playing"
  check((await run("session-pause")).calls.filter((call) => call === "runtime play").length === 0, "session-pause does not play again over a playing transport")
  check((await run("play-resume")).calls[0] === "runtime play", "play-resume plays")
  // The held-instrument rows: the instrument under the note is edited through its own track, the unrelated tracks through theirs.
  const target = (name: string) => ({ kind: "track", track: ref(`track-of-${name}`) })
  const instrumentSet = (name: string, kind: string, params: ReturnType<typeof sineSynthParams> | ReturnType<typeof sampledInstrumentParams>) => `mutate ${JSON.stringify([{ kind: "instrument.set", target: target(name), instrumentKind: kind, params }])}`
  const sampleAsset = (name: string) => ({ id: `asset-${name}`, name: `${name}.wav`, durationSec: 30, sampleRate: 48000, channelCount: 2 })
  check((await run("sampler-gain-half")).calls[0] === instrumentSet(heldInstrumentTrack, "sampler", sampledInstrumentParams("sampler", sampleAsset("changed"), { gain: 0.5 })), "sampler-gain-half sets the zone gain to half")
  check((await run("sampler-gain-full")).calls[0] === instrumentSet(heldInstrumentTrack, "sampler", sampledInstrumentParams("sampler", sampleAsset("changed"))), "sampler-gain-full restores it")
  check((await run("drum-rack-gain-half")).calls[0] === instrumentSet(heldInstrumentTrack, "drum-rack", sampledInstrumentParams("drum-rack", sampleAsset("changed"), { gain: 0.5 })), "drum-rack-gain-half sets the pad gain to half")
  check((await run("granular-density-48")).calls[0] === instrumentSet(heldInstrumentTrack, "granular", sampledInstrumentParams("granular", sampleAsset("changed"), { densityHz: 48 })), "granular-density-48 raises the grain density")
  check((await run("sampler-swap-asset")).calls[0] === instrumentSet(heldInstrumentTrack, "sampler", sampledInstrumentParams("sampler", sampleAsset("swap"))), "sampler-swap-asset points the zone at the copy")
  check((await run("sampler-swap-asset-3")).calls[0] === instrumentSet(heldInstrumentTrack, "sampler", sampledInstrumentParams("sampler", sampleAsset("swap-3"))), "sampler-swap-asset-3 points the zone at the third sized copy")
  check((await run("sampler-swap-back")).calls[0] === instrumentSet(heldInstrumentTrack, "sampler", sampledInstrumentParams("sampler", sampleAsset("changed"))), "sampler-swap-back points it at the changed asset again")
  check((await run("polyphony-2")).calls[0] === instrumentSet(heldSynthTrack, "synth", sineSynthParams(2)) && (await run("polyphony-16")).calls[0] === instrumentSet(heldSynthTrack, "synth", sineSynthParams(16)), "the polyphony edits set the held synth's voices to 2 and 16")
  check((await run("instrument-insert")).calls[0] === instrumentSet(insertTargetTrack, "synth", sineSynthParams()), "instrument-insert sets a synth on the insert target")
  check((await run("instrument-remove")).calls[0] === `mutate ${JSON.stringify([{ kind: "instrument.remove", target: target(insertTargetTrack) }])}`, "instrument-remove removes it")
  const order = [{ effect: ref("utility-1"), kind: "utility" }, { effect: ref("saturator-1"), kind: "saturator" }]
  check((await run("effects-restore")).calls[0] === `mutate ${JSON.stringify([{ kind: "effect.reorder", target: target(reorderTargetTrack), order }])}`, "effects-restore orders Utility then Saturator")
  check((await run("effects-reverse")).calls[0] === `mutate ${JSON.stringify([{ kind: "effect.reorder", target: target(reorderTargetTrack), order: order.toReversed() }])}`, "effects-reverse orders Saturator then Utility")
  check((await run("clip-delete")).calls[0] === `mutate ${JSON.stringify([{ kind: "clip.delete", clip: ref("clip-1") }])}`, "clip-delete names the observed clip")
  // Prepare steps: the trust flow opens the plug-ins dashboard and acknowledges trust; an unknown step is refused.
  const prepared: string[] = []
  const prepareContext = { evaluate: async (script: string) => { prepared.push(`evaluate ${script}`) }, interact: async (args: string[]) => { prepared.push(`interact ${args.join(" ")}`) },
    reload: async () => { prepared.push("reload") } }
  await performPrepare(prepareContext, "vst-trust")
  check(prepared[0]?.includes("dashboard") === true && prepared.some((call) => call.includes("input[type=checkbox]")) && prepared.includes("reload") && prepared.includes("interact press Escape"), "vst-trust opens the plug-ins dashboard, acknowledges trust and reloads")
  prepared.length = 0
  await performPrepare(prepareContext, "vst-untrusted-browser")
  check(prepared.includes("reload"), "the untrusted effects browser is shown, with its reload, before the capture")
  prepared.length = 0
  await performPrepare(prepareContext, "midi-select-iac")
  check(prepared[0]?.includes("selectedInputIds") === true && prepared[1] === "reload" && prepared[2]?.includes("Live MIDI") === true, "midi-select-iac writes the profile's MIDI input, reloads and selects the live track")
  prepared.length = 0
  await performPrepare(prepareContext, "record-select-input")
  check(prepared[0]?.includes("nativeInputDeviceId") === true && prepared[0]?.includes(blackhole) === true && prepared[1] === "reload", "record-select-input selects BlackHole in the profile's preferences and reloads")
  prepared.length = 0
  await performPrepare(prepareContext, "record-arm")
  check(prepared[0]?.includes("Arm track") === true && prepared[0]?.includes("Changed right") === true && prepared[0]?.includes(".click()") === true && prepared[1]?.includes("Disarm track") === true,
    "record-arm clicks the arm button of the changed track and waits for it to be pressed")
  // The armed target's delete must be refused with the lock's reason; a commit that goes through, or another refusal, fails the row.
  const guard = (mutate: () => Promise<number>) => createPerformer({
    context: { mutate, evaluate: async () => undefined, interact: async () => undefined, read: async (_, schema) => schema.parse(0), reload: async () => undefined, mark: async () => undefined },
    runtime: async () => undefined, playThenPause: async () => 0, transportStatus: async () => ({ state: "paused", playheadSec: 0 }), hostPid: async () => 1, stateCaptured: async () => undefined, kill: () => undefined, observe: async () => observed, setup: { changedTrackId: "track-1", changedFile: "/tmp/changed.wav" } })("target-delete-refused")
  check((await guard(async () => { throw new Error(`validation: ${recordingTargetLockedReason}`) })).toLatencyFrames === 0, "a refusal carrying the lock's reason is the expected outcome")
  const reroute = (mutate: (actions: unknown[]) => Promise<number>) => createPerformer({
    context: { mutate, evaluate: async () => undefined, interact: async () => undefined, read: async (_, schema) => schema.parse("Return 4"), reload: async () => undefined, mark: async () => undefined },
    runtime: async () => undefined, playThenPause: async () => 0, transportStatus: async () => ({ state: "paused", playheadSec: 0 }), hostPid: async () => 1, stateCaptured: async () => undefined, kill: () => undefined, observe: async () => observed,
    setup: { changedTrackId: "track-1", changedFile: "/tmp/changed.wav" } })("target-reroute-refused")
  let requested = ""
  await reroute(async (actions) => { requested = JSON.stringify(actions); throw new Error(`validation: ${recordingTargetLockedReason}`) })
  check(requested === JSON.stringify([{ kind: "track.routing.set", track: ref("track-1"), sends: [{ target: ref("track-of-Return 4"), amount: 0.5 }] }]), `the reroute row asks the armed target for a send to a new return track: ${requested}`)
  check(await reroute(async () => 1).then(() => "performed", (error) => error instanceof Error && /Rerouting the armed recording target was committed/.test(error.message) ? "committed" : "other") === "committed", "a reroute that is committed fails the row")
  check(await guard(async () => 1).then(() => "performed", (error) => error instanceof Error && /was committed/.test(error.message) ? "committed" : "other") === "committed", "a delete that is committed fails the row")
  check(await guard(async () => { throw new Error("validation: stale revision") }).then(() => "performed", (error) => error instanceof Error && /another reason/.test(error.message) ? "other reason" : "other") === "other reason", "a refusal for another reason fails the row")
  // The take as the page hands it over: the tone behind a silent lead is the tone; the same take with one sample changed is not.
  const handedOver = await mkdtemp(path.join(tmpdir(), "ae08-phase9-take-"))
  try {
    const tone = makeTone(toneSeconds)
    const take = (change?: (samples: Float32Array) => void) => {
      const samples = new Float32Array(tone.samples.length + 2 * 4800)
      samples.set(tone.samples, 2 * 2400)
      change?.(samples)
      return writeWav(path.join(handedOver, "built.wav"), { ...tone, samples }).then(() => readFile(path.join(handedOver, "built.wav")).then((bytes) => bytes.toString("base64")))
    }
    const exact = await verifyHandedOverTake(await take(), path.join(handedOver, "take.wav"))
    check(exact.passed && exact.offset === 2400, `a take equal to the tone passes at its own offset: ${JSON.stringify(exact)}`)
    check(!(await verifyHandedOverTake(await take((samples) => { samples[2 * 2400 + 1000] += 1e-6 }), path.join(handedOver, "take.wav"))).passed, "a take with one changed sample fails")
  } finally { await rm(handedOver, { recursive: true }) }
  check(await performPrepare(prepareContext, "no-such-step").then(() => false, (error) => error instanceof Error && error.message === "No phase 9 prepare step no-such-step"), "an unknown prepare step is refused")
  const rejected = await perform("no-such-edit").then(() => "performed", (error) => error instanceof Error ? error.message : "other")
  check(rejected === "No phase 9 performer for no-such-edit", `an unknown edit is refused, got ${rejected}`)

  // One merged launch's host.jsonl is split per row at each row's first step, and each row is judged from its own part.
  const [first, second] = [phase9Presets.cert.find((row) => row.name === "fft-transition"), phase9Presets.cert.find((row) => row.name === "raise-lower-burst")]
  if (!first || !second) throw new Error("phase 9 launch self-test: rows missing")
  const directory = await mkdtemp(path.join(tmpdir(), "ae08-phase9-export-"))
  try {
    const publication = (wallMs: number, publicationFrame: number) => ({ event: "graph-publish", cause: "block-boundary", wallMs, publicationFrame, revision: 1, transportEpoch: 1 })
    const host = [{ event: "device-session", wallMs: 1, sampleRate: 48000, blockSize: 512 }, publication(2_000, 96_000), publication(5_000, 240_000), publication(12_000, 576_000)]
    const launchOut = path.join(directory, "launch")
    await mkdir(launchOut)
    await writeFile(path.join(launchOut, "host.jsonl"), host.map((line) => JSON.stringify(line)).join("\n") + "\n")
    await writeFile(path.join(launchOut, "actions.jsonl"), [{ event: "capture-start", wallMs: 0 }, { event: "capture-end", wallMs: 20_000 }].map((line) => JSON.stringify(line)).join("\n") + "\n")
    const stored = [{ row: first, edits: [{ index: 1, wallMs: 1_500 }, { index: 2, wallMs: 4_500 }] }, { row: second, edits: [{ index: 1, wallMs: 10_000 }] }]
    for (const { row, edits } of stored) {
      await mkdir(path.join(directory, row.name))
      await writeFile(path.join(directory, row.name, "phase9-edits.json"), JSON.stringify({ phase: 9, row: row.name,
        edits: edits.map((edit) => ({ ...edit, fromLatencyFrames: 0, toLatencyFrames: 0 })) }))
    }
    await exportRowEvidence(launchOut, directory, [first, second])
    const firstHost = (await lines(path.join(directory, first.name, "host.jsonl"))).map((line) => JSON.parse(line).wallMs)
    const secondHost = (await lines(path.join(directory, second.name, "host.jsonl"))).map((line) => JSON.parse(line).wallMs)
    check(firstHost.join() === "1,2000,5000" && secondHost.join() === "1,12000", `rows keep their own publications and the device session: ${firstHost} | ${secondHost}`)
    const ends = await Promise.all([first, second].map(async (row) => (await lines(path.join(directory, row.name, "actions.jsonl"))).map((line) => JSON.parse(line)).find((action) => action.event === "capture-end").wallMs))
    check(ends.join() === "10000,20000", `the first row's capture ends where the next row begins: ${ends}`)
    const judged = await judgeStored(directory)
    check(judged.length === 2 && judged.every((entry) => entry.phase === 9) && judged.find((entry) => entry.row === first.name)?.edits === 2, `stored phase 9 rows are judged by step: ${JSON.stringify(judged)}`)
    check(judged.every((entry) => entry.verdict.outcome === "pass"), `settled windows over 1 s pass: ${JSON.stringify(judged.map((entry) => entry.verdict))}`)
    // A failed launch leaves a row directory with no host.jsonl: it is that row's setup failure, and the other rows are still judged.
    await mkdir(path.join(directory, "failed-launch"))
    await writeFile(path.join(directory, "failed-launch", "phase9-edits.json"), JSON.stringify({ phase: 9, row: "failed-launch", edits: [] }))
    const withFailure = await judgeStored(directory)
    check(withFailure.length === 3 && withFailure.find((entry) => entry.row === "failed-launch")?.verdict.outcome === "setup"
      && withFailure.filter((entry) => entry.verdict.outcome === "pass").length === 2, `a row with no host.jsonl is a setup failure and the rest are judged: ${JSON.stringify(withFailure)}`)
  } finally { await rm(directory, { recursive: true }) }
  console.log("ae-08 phase 9 launch self-test: pass")
}

if (import.meta.main) {
  if (Bun.argv[2] === "--self-test") await selfTest()
  else throw new Error("Usage: ae-08-phase-9-launch.ts --self-test")
}
