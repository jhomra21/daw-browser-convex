import path from "node:path"
import { watch } from "node:fs"
import { writeFile } from "node:fs/promises"
import { z } from "zod"
import type { ProjectSnapshotV2 } from "@daw-browser/control"
import { createDefaultSpectralParams, createDefaultSynthParams, createDefaultUtilityParams, getSpectralLatencyFrames } from "@daw-browser/shared"
import { command } from "../performance/30-track/v3-import-workload"
import { waitForAcceptanceEvent } from "../performance/30-track/native-acceptance-ui"
import { browserCommandTimeoutMs } from "../performance/browser-harness"
import { writeWav } from "./ae08-wav"

export const phase5Rows = ["delete-clip", "move-trim", "unchanged-span", "add-paged-asset",
  "remove-readd-track", "held-note", "raw-tempo", "rapid-burst", "effect-state"]
export type Phase5Context = {
  out: string
  profile: string
  row: string
  snapshot: () => Promise<ProjectSnapshotV2>
  mutate: (actions: z.infer<ReturnType<typeof z.json>>[]) => Promise<void>
  interact: (args: string[]) => Promise<void>
  evaluate: (script: string) => Promise<void>
  read: <Value>(script: string, schema: z.ZodType<Value>) => Promise<Value>
  reload: () => Promise<void>
  mark: (event: string, fields?: Record<string, string | number | boolean>) => Promise<void>
  // Phase 9 only: how long the playing content must last, since a burst outlasts phase 5's own 17 s. Phase 5 leaves it unset.
  contentSeconds?: number
}
// What the UI helpers use of the context.
type UiContext = Pick<Phase5Context, "evaluate" | "interact">
const ref = (id: string) => ({ source: "persisted", id })
const record = z.record(z.string(), z.json())
// browserCommand aborts an eval after browserCommandTimeoutMs; every page-side
// deadline fires first, so the page's named error, not the abort, reports a stall.
export const pageDeadlineMs = browserCommandTimeoutMs([]) - 5_000
// Observe the UI commit, not an arbitrary delay. The deadline is failure-only.
export const waitForUi = (context: Pick<Phase5Context, "evaluate">, failure: string, ready: string) => context.evaluate(`new Promise((resolve,reject)=>{
  const ready=()=>(${ready});
  const observer=new MutationObserver(()=>{if(ready()){observer.disconnect();clearTimeout(timer);resolve(true)}});
  const timer=setTimeout(()=>{observer.disconnect();reject(new Error(${JSON.stringify(failure)}))},${pageDeadlineMs});
  observer.observe(document.body,{childList:true,subtree:true,characterData:true,attributes:true});
  if(ready()){observer.disconnect();clearTimeout(timer);resolve(true)}
})`)
export const waitImportedClip = (context: Pick<Phase5Context, "evaluate">, name: string) => waitForUi(context, `Import UI deadline: ${name}`,
  `[...document.querySelectorAll('[data-timeline-clip]')].some(e=>e.getAttribute('title')?.includes(${JSON.stringify(name)}))`)

// The Spectral device's FFT size buttons on the selected track.
export const selectFftSize = async (context: Pick<Phase5Context, "evaluate">, fftSize: 512 | 4096) => {
  await context.evaluate(`(()=>{
    const button=[...(document.querySelector('.device-spectral')?.querySelectorAll('button')??[])].find(b=>b.textContent?.trim()===${JSON.stringify(String(fftSize))});
    if(!button||button.disabled)throw new Error("FFT button unavailable");button.click();return true;
  })()`)
  await waitForUi(context, `Spectral FFT ${fftSize} not selected`, `[...(document.querySelector('.device-spectral')?.querySelectorAll('button')??[])]
    .find(b=>b.textContent?.trim()===${JSON.stringify(String(fftSize))})?.getAttribute('aria-pressed')==='true'`)
}

// The product's undo and redo shortcuts (Ctrl+Z, Ctrl+Shift+Z) on the timeline window.
export const pressHistoryKey = (context: Pick<Phase5Context, "evaluate">, redo: boolean) => context.evaluate(`(()=>{
  document.activeElement?.blur();
  window.dispatchEvent(new KeyboardEvent('keydown',{key:${redo ? "'Z'" : "'z'"},code:'KeyZ',ctrlKey:true,shiftKey:${redo},bubbles:true}));return true;
})()`)

// Deletes the track whose selector ends in `: ${name}` through its context menu and the confirmation dialog.
export const deleteTrackThroughUi = async (context: UiContext, name: string) => {
  await context.evaluate(`(()=>{
    const button=[...document.querySelectorAll('button[aria-label]')].find(b=>b.getAttribute('aria-label')?.endsWith(${JSON.stringify(`: ${name}`)}));
    if(!button)throw new Error("Delete track selector missing");
    button.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:250,clientY:250}));return true;
  })()`)
  await context.interact(["find", "text", "Delete track", "click", "--exact"])
  await context.interact(["find", "role", "button", "click", "--name", "Delete Track", "--exact"])
}

// Nonperiodic envelope plus DC prevents a single missing sample from landing
// on a sine zero and makes a block shift observably wrong at every seam.
export const writePhase5Asset = async (file: string, seconds: number, right: boolean) => {
  const sampleRate = 48000
  const samples = new Float32Array(seconds * sampleRate * 2)
  for (let frame = 0; frame < seconds * sampleRate; frame++) {
    const value = 0.08 + 0.025 * Math.sin(frame * (right ? 0.039 : 0.027))
      + 0.015 * Math.sin(frame * frame * (right ? 1.7e-8 : 1e-8))
    samples[frame * 2 + (right ? 1 : 0)] = value
  }
  await writeWav(file, { sampleRate, channels: 2, samples })
}

// The Utility Gain knob on the selected track. Exactly one must exist.
const utilityGainKnob = `(()=>{const knobs=[...document.querySelectorAll('.effect-shell')]
  .filter(shell=>shell.querySelector('[data-effect-shell-header]')?.textContent?.includes('Utility'))
  .flatMap(shell=>[...shell.querySelectorAll('[role="slider"][aria-label="Gain"]')]);
  if(knobs.length!==1)throw new Error("Utility gain knob missing");return knobs[0]})()`
const readKnobDb = async (context: Phase5Context) =>
  context.read(`Number(${utilityGainKnob}.getAttribute('aria-valuenow'))`, z.number())
// A knob gate's failure carries the pointer record: which press the knob took, and whether a capture or the window was lost.
const waitForKnob = async (context: Phase5Context, failure: string, ready: string) => {
  try { await waitForUi(context, failure, ready) } catch (cause) {
    const drag = await context.read("JSON.stringify((({listeners:_listeners,...drag})=>drag)(window.__ae08EffectState.drag))", z.json())
    throw new Error(`${failure}: ${JSON.stringify(drag)}`, { cause })
  }
}
const latestFrame = async (context: Phase5Context) =>
  context.read("Number(window.__ae08EffectState.progress.at(-1)?.renderedThroughFrame)", z.number().int())
const utilityGainDb = (state: ProjectSnapshotV2, trackId: string) => {
  for (const entry of state.processors)
    if ("trackId" in entry.target && entry.target.trackId === trackId && entry.processor.kind === "utility")
      return entry.processor.params.state.gainDb
}

// Processor state through the product UI only: an FFT size click while
// playing, then a Gain knob drag whose release dispatches the keyboard pause in
// the same task, so the pause always lands while the release is flushing.
// Native progress frames are lower bounds that place the analyzer's windows.
const runEffectStateEdit = async (context: Phase5Context, input: {
  trackId: string; waitFrame: (frame: number) => Promise<void>; snapshot: () => Promise<ProjectSnapshotV2>
  resume: () => Promise<void>
}) => {
  const fftAfterFrame = 48000 * 2, dragAfterFrame = 48000 * 5
  const before = await readKnobDb(context)
  await context.mark("effect-fft-edit")
  await selectFftSize(context, 4096)
  await input.waitFrame(dragAfterFrame)
  const knob = await context.read(`JSON.stringify((()=>{
    const box=${utilityGainKnob}.getBoundingClientRect();return {x:Math.round(box.x+box.width/2),y:Math.round(box.y+box.height/2)};
  })())`, z.object({ x: z.number(), y: z.number() }))
  await context.mark("effect-gain-drag")
  // A returned input command proves only that it was sent. Each step waits for the knob's own state (useDrag's drag,
  // then aria-valuenow), so no step runs before the page consumed the one before it, and a press the knob never took
  // fails here by name instead of releasing an unmoved knob. The recorder names a miss, a lost capture or a blur.
  await context.evaluate(`(()=>{
    const knob=${utilityGainKnob}, hit=document.elementFromPoint(${knob.x},${knob.y});
    if(!hit||!knob.contains(hit))throw new Error("Utility gain knob is not under the press point");
    const drag={downs:[],captures:0,lost:0,blurs:0,listeners:new AbortController()}, signal=drag.listeners.signal;
    knob.addEventListener('pointerdown',e=>drag.downs.push({x:e.clientX,y:e.clientY}),{capture:true,signal});
    knob.addEventListener('gotpointercapture',()=>{drag.captures++},{signal});
    knob.addEventListener('lostpointercapture',()=>{drag.lost++},{signal});
    window.addEventListener('blur',()=>{drag.blurs++},{signal});
    window.__ae08EffectState.drag=drag;
    return true;
  })()`)
  await context.interact(["mouse", "move", String(knob.x), String(knob.y)])
  await context.interact(["mouse", "down"])
  await waitForKnob(context, "Utility gain press did not start a drag", "document.body.classList.contains('select-none')")
  // Registered after useDrag's own capture listener, so the release runs first.
  await context.evaluate(`(()=>{
    const state=window.__ae08EffectState;
    window.addEventListener('pointerup',()=>{
      state.release={wallMs:Date.now(),dragEnded:!document.body.classList.contains('select-none'),
        knobDb:Number(${utilityGainKnob}.getAttribute('aria-valuenow'))};
      window.dispatchEvent(new KeyboardEvent('keydown',{key:' ',code:'Space',bubbles:true}));
      state.pause={wallMs:Date.now()};
      state.drag.listeners.abort();
    },{capture:true,once:true});
    return true;
  })()`)
  // 40 px down a 240 px traversal of the 84 dB range previews -14 dB in four ticks of -3.5 dB.
  for (let step = 1; step <= 4; step++) {
    await context.interact(["mouse", "move", String(knob.x), String(knob.y + step * 10)])
    await waitForKnob(context, `Utility gain preview did not reach tick ${step}`,
      `Math.abs(Number(${utilityGainKnob}.getAttribute('aria-valuenow'))-(${before - 3.5 * step}))<0.05`)
  }
  const previewFromFrame = await latestFrame(context)
  const releaseAfterFrame = previewFromFrame + 48000
  await input.waitFrame(releaseAfterFrame)
  await context.interact(["mouse", "up"])
  await context.evaluate(`new Promise((resolve,reject)=>{
    const state=window.__ae08EffectState, session=window.dawDesktop.audioHost.session;
    const last=state.progress.at(-1);
    if(last&&!last.running&&last.wallMs>=state.release.wallMs)return resolve(true);
    // Deadline only. Native progress, not wall time, reports the pause.
    const timer=setTimeout(()=>{unsubscribe();reject(new Error("Native pause deadline"))},${pageDeadlineMs});
    const unsubscribe=session.onScheduleProgress(progress=>{if(!progress.running){unsubscribe();clearTimeout(timer);resolve(true)}});
  })`)
  const pausedFrame = await latestFrame(context)
  const paused = await readKnobDb(context)
  const pausedSnapshot = await input.snapshot()
  await writeFile(path.join(context.out, "paused-snapshot.json"), JSON.stringify(pausedSnapshot, null, 2))
  await context.mark("effect-resume")
  await input.resume()
  await input.waitFrame(pausedFrame + 48000)
  const spectral = createDefaultSpectralParams()
  return { trackId: input.trackId, fromLatencyFrames: getSpectralLatencyFrames(512, spectral.overlap),
    toLatencyFrames: getSpectralLatencyFrames(4096, spectral.overlap), fftAfterFrame, dragAfterFrame, previewFromFrame,
    releaseAfterFrame, pausedFrame, pausedSnapshotGainDb: utilityGainDb(pausedSnapshot, input.trackId) ?? null,
    knob: { before, paused, resumed: await readKnobDb(context) } }
}

const exportReference = async (context: Phase5Context, name: string) => {
  const destination = path.join(context.out, `${name}.wav`)
  // The filesystem notifies completion/progress. No status polling or fixed
  // sleep; the deadline is failure-only and the watcher always closes.
  let jobId: string | undefined
  let complete: () => void = () => undefined
  let reject: (error: Error) => void = () => undefined
  const terminal = new Promise<void>((resolve, fail) => { complete = resolve; reject = fail })
  const inspect = async () => {
    if (!jobId) return
    const status = z.object({ status: z.string(), job: z.object({ id: z.string() }).nullable().optional() })
      .passthrough().parse(await command(context.profile, ["host", "export-status"]))
    if (status.job?.id !== jobId) return
    if (status.status === "completed") complete()
    else if (["failed", "canceled"].includes(String(status.status))) reject(new Error(JSON.stringify(status)))
  }
  const watcher = watch(context.out, (_event, filename) => {
    if (filename === path.basename(destination)) void inspect().catch(reject)
  })
  try {
    const request = { mode: "mixdown", format: "wav", destination: { kind: "file", path: destination },
      range: { mode: "custom", startSec: 0, endSec: 24 },
      render: { sampleRate: 48000, channels: 2, normalization: { mode: "none" }, tail: { mode: "none" } },
      encoding: { wav: { codec: "pcm-f32", dither: "none" } } }
    const result = record.parse(await command(context.profile, ["host", "export", "--request", "-"], JSON.stringify(request)))
    jobId = z.string().parse(result.jobId)
    await inspect()
    if (await waitForAcceptanceEvent(terminal.then(() => true), 120000) !== true)
      throw new Error(`Offline ${name} reference did not complete`)
    await writeFile(path.join(context.out, `${name}-export.json`), JSON.stringify({ jobId, request }, null, 2))
  } finally { watcher.close() }
}

// Deadline only. Audio progress, not wall time, advances the fixture.
export const waitNativeFrame = (context: Phase5Context, frame: number) => context.evaluate(`new Promise((resolve,reject)=>{
  const session=window.dawDesktop.audioHost.session;
  const timer=setTimeout(()=>{unsubscribe();reject(new Error("Native progress deadline"))},${pageDeadlineMs});
  const unsubscribe=session.onScheduleProgress(progress=>{
    if(progress.running&&Number(progress.renderedThroughFrame)>=${frame}){
      unsubscribe();clearTimeout(timer);resolve(true);
    }
  });
})`)

// Builds the row's project (retained 180 s source, "Changed right" track and its clip, the row's devices or notes) and
// reloads it. It plays nothing and captures nothing, so phase 9 reuses it as the start state of a burst.
export const setupPhase5Fixture = async (context: Phase5Context) => {
  const { out, profile, row, mutate, snapshot } = context
  const { contentSeconds } = context
  const runtime = (args: string[]) => command(profile, ["host", ...args])
  const retainedFile = path.join(out, "retained.wav")
  const changedFile = path.join(out, "changed.wav")
  await writePhase5Asset(retainedFile, Math.max(180, contentSeconds ?? 0), false)
  await writePhase5Asset(changedFile, row === "add-paged-asset" ? 180 : (contentSeconds ?? 24) + 6, true)
  await runtime(["import", "--path", retainedFile])
  await waitImportedClip(context, "retained")
  let state = await snapshot()
  const retained = state.clips.find((clip) => clip.name.includes("retained"))
  if (!retained?.source) throw new Error("Retained fixture import missing")
  await mutate([{ kind: "clip.move", clip: ref(retained.id), track: ref(retained.trackId), startSec: 0 },
    { kind: "clip.timing.set", clip: ref(retained.id), duration: Math.max(180, contentSeconds ?? 0) },
    { kind: "project.settings.set", tempoBpm: 120, loopEnabled: false }])
  await mutate([{ kind: "track.create", name: "Changed right", trackKind: "audio" }])
  state = await snapshot()
  const changedTrack = state.tracks.find((track) => track.name === "Changed right")
  if (!changedTrack) throw new Error("Changed track missing")
  await context.evaluate(`(()=>{
    const button=[...document.querySelectorAll('button[aria-label]')].find(b=>b.getAttribute('aria-label')?.endsWith(': Changed right'));
    if(!button)throw new Error("Changed track selector missing");button.click();return true;
  })()`)
  let changedId: string | undefined
  if (row !== "add-paged-asset") {
    await runtime(["import", "--path", changedFile])
    await waitImportedClip(context, "changed")
    state = await snapshot()
    const clip = state.clips.find((item) => item.name.includes("changed"))
    if (!clip) throw new Error("Changed fixture import missing")
    changedId = clip.id
    await mutate([{ kind: "clip.move", clip: ref(clip.id), track: ref(changedTrack.id), startSec: 0 },
      { kind: "clip.timing.set", clip: ref(clip.id), duration: contentSeconds ?? 24 }])
  }
  if (row === "effect-state") {
    // Spectral then Utility on the right-only source: the FFT size is audible
    // as content delay and the gain as level. No DC block, so gain stays pure.
    const target = { kind: "track", track: ref(changedTrack.id) }
    await mutate([
      { kind: "effect.upsert", target, effectKind: "spectral",
        params: { version: 1, state: { ...createDefaultSpectralParams(), fftSize: 512, mix: 1 } } },
      { kind: "effect.upsert", target, effectKind: "utility",
        params: { version: 1, state: { ...createDefaultUtilityParams(), gainDb: 0, dcBlock: false } } },
    ])
  }
  if (row === "held-note") {
    await mutate([{ kind: "track.create", name: "Held phase 5", trackKind: "instrument" }])
    const synth = (await snapshot()).tracks.find((track) => track.name === "Held phase 5")
    if (!synth) throw new Error("Held synth missing")
    const base = createDefaultSynthParams()
    await mutate([
      { kind: "instrument.set", target: { kind: "track", track: ref(synth.id) }, instrumentKind: "synth",
        params: { ...base, oscillators: [
          { ...base.oscillators[0], enabled: true, wave: "sine", level: 0.2 },
          { ...base.oscillators[1], enabled: false },
        ],
          filter: { ...base.filter, enabled: false },
          ampEnvelope: { attackSec: 0.005, decaySec: 0.01, sustain: 1, releaseSec: 0.05 } } },
      { kind: "effect.upsert", target: { kind: "track", track: ref(synth.id) }, effectKind: "utility",
        params: { version: 1, state: { ...createDefaultUtilityParams(), balance: 1 } } },
      { kind: "clip.midi.create", track: ref(synth.id), name: "Held finite note", startSec: 0, duration: contentSeconds ?? 16, wave: "sine", gain: 0.1,
        notes: [{ id: "phase5-held", beat: 0, length: contentSeconds === undefined ? 24 : contentSeconds * 2, pitch: 69, velocity: 0.4 }] },
    ])
  }
  // Setup is outside the measured interval. A normal product reload makes
  // the offline reference independent of any stale mounted projection.
  await context.reload()
  await waitImportedClip(context, "retained")
  if (row === "effect-state") {
    const index = (await snapshot()).tracks.findIndex((track) => track.id === changedTrack.id) + 1
    await context.evaluate(`(()=>{
      const button=[...document.querySelectorAll('button[aria-label]')].find(b=>b.getAttribute('aria-label')?.endsWith(': Changed right'));
      if(!button)throw new Error("Effect-state track selector missing");button.click();return true;
    })()`)
    await waitForUi(context, "Effect-state devices missing",
      `document.querySelectorAll('.device-spectral').length===1&&(()=>{try{return !!${utilityGainKnob}}catch{return false}})()`)
    // Monitoring keeps the edited FFT path out of compensation (phase 4 Keep
    // Latency), so the left source keeps zero latency and nulls exactly.
    await context.evaluate(`(()=>{
      const button=document.querySelector(${JSON.stringify(`button[aria-label="Arm track ${index} for recording"]`)});
      if(!button)throw new Error("Record arm unavailable");button.click();return true;
    })()`)
    await waitForUi(context, "Record arm not pressed",
      `document.querySelector(${JSON.stringify(`button[aria-label="Disarm track ${index} for recording"]`)})?.getAttribute('aria-pressed')==='true'`)
    await context.evaluate(`(()=>{
      const session=window.dawDesktop.audioHost.session, state={progress:[]};
      state.unsubscribe=session.onScheduleProgress(progress=>state.progress.push({wallMs:Date.now(),revision:progress.revision,
        epoch:progress.epoch,running:progress.running,renderedThroughFrame:String(progress.renderedThroughFrame),
        appliedProcessorSequence:String(progress.appliedProcessorSequence)}));
      window.__ae08EffectState=state;return true;
    })()`)
  }
  return { changedTrack, changedId, changedFile }
}

export const runPhase5Fixture = async (context: Phase5Context) => {
  const { out, profile, row, mutate, snapshot, mark } = context
  const runtime = (args: string[]) => command(profile, ["host", ...args])
  const waitFrame = (frame: number) => waitNativeFrame(context, frame)
  const { changedTrack, changedId, changedFile } = await setupPhase5Fixture(context)
  await writeFile(path.join(out, "initial-snapshot.json"), JSON.stringify(await snapshot(), null, 2))
  await exportReference(context, "initial-reference")
  await runtime(["seek", "0"])
  await mark("capture-start")
  await runtime(["play"])
  await waitFrame(48000 * 2)
  const editStart = Date.now()
  await mark("phase5-edit-start", { row })
  const commits: { wallMs: number; revision: number }[] = []
  let sameTrackId = true
  let effectState: Awaited<ReturnType<typeof runEffectStateEdit>> | undefined
  const edit = async (actions: z.infer<ReturnType<typeof z.json>>[]) => {
    await mutate(actions)
    const state = await snapshot()
    commits.push({ wallMs: Date.now(), revision: state.project.revision })
    await writeFile(path.join(out, `commit-${commits.length}-snapshot.json`), JSON.stringify(state, null, 2))
  }
  if (row === "delete-clip") {
    if (!changedId) throw new Error("Delete clip missing")
    await edit([{ kind: "clip.delete", clip: ref(changedId) }])
  } else if (row === "move-trim") {
    if (!changedId) throw new Error("Move clip missing")
    await edit([{ kind: "clip.move", clip: ref(changedId), track: ref(changedTrack.id), startSec: 0.25 },
      { kind: "clip.timing.set", clip: ref(changedId), bufferOffsetSec: 1.125, duration: 22 }])
  } else if (row === "add-paged-asset") {
    await runtime(["import", "--path", changedFile])
    await waitImportedClip(context, "changed")
    const fresh = await snapshot()
    const clip = fresh.clips.find((item) => item.name.includes("changed"))
    if (!clip?.source || !fresh.assets.some((asset) => asset.id === clip.source?.assetId && asset.durationSec === 180))
      throw new Error("Live page-prepared new asset missing")
    commits.push({ wallMs: Date.now(), revision: fresh.project.revision })
  } else if (row === "remove-readd-track") {
    // Public recovery remaps IDs. UI deletion records local history, whose
    // undo restores the original ID; an external deletion has no UI undo entry.
    await deleteTrackThroughUi(context, "Changed right")
    const deleted = await snapshot()
    if (deleted.tracks.some((track) => track.id === changedTrack.id)) throw new Error("UI track deletion did not commit")
    commits.push({ wallMs: Date.now(), revision: deleted.project.revision })
    await writeFile(path.join(out, `commit-${commits.length}-snapshot.json`), JSON.stringify(deleted, null, 2))
    await waitFrame(48000 * 5)
    await pressHistoryKey(context, false)
    await waitImportedClip(context, "changed")
    const restored = await snapshot()
    sameTrackId = restored.tracks.some((track) => track.id === changedTrack.id)
    commits.push({ wallMs: Date.now(), revision: restored.project.revision })
    await writeFile(path.join(out, `commit-${commits.length}-snapshot.json`), JSON.stringify(restored, null, 2))
    await writeFile(path.join(out, "restored-snapshot.json"), JSON.stringify(restored, null, 2))
    const restoredClip = restored.clips.find((clip) => clip.trackId === changedTrack.id && clip.name.includes("changed"))
    if (!restoredClip || !sameTrackId) throw new Error("UI undo did not restore the same track ID and clip")
    await edit([{ kind: "clip.timing.set", clip: ref(restoredClip.id), bufferOffsetSec: 2.125, duration: 21 }])
  } else if (row === "held-note" || row === "unchanged-span") {
    await edit([{ kind: "track.create", name: "Silent publication target", trackKind: "audio" }])
  } else if (row === "rapid-burst") {
    if (!changedId) throw new Error("Burst clip missing")
    // The first four topology intents are audio-neutral; the last deletes the
    // sounding source. Coalescing is legal, but stale final audio cannot pass.
    // No publication wait separates these five distinct keyed commits.
    for (let index = 0; index < 4; index++)
      await edit([{ kind: "track.create", name: `Burst ${index + 1}`, trackKind: "audio" }])
    await edit([{ kind: "clip.delete", clip: ref(changedId) }])
  } else if (row === "effect-state") {
    effectState = await runEffectStateEdit(context, { trackId: changedTrack.id, waitFrame, snapshot,
      resume: async () => { await runtime(["play"]) } })
  } else {
    // Raw tempo is deliberately independent of asset cursor.
    await edit([{ kind: "project.settings.set", tempoBpm: 137 }])
  }
  await waitFrame(48000 * 18)
  await mark("capture-end")
  const finalEffectState = effectState && { ...effectState, knob: { ...effectState.knob, end: await readKnobDb(context) } }
  if (finalEffectState) {
    await writeFile(path.join(out, "effect-state-progress.json"), JSON.stringify(await context.read(`JSON.stringify((()=>{
      const state=window.__ae08EffectState;state.unsubscribe();
      const {listeners:_listeners,...drag}=state.drag;return {progress:state.progress,release:state.release,pause:state.pause,drag};
    })())`, z.json()), null, 2))
  }
  await writeFile(path.join(out, "diagnostics-active.json"), JSON.stringify(await runtime(["diagnostics-v2"]), null, 2))
  await runtime(["stop"])
  await writeFile(path.join(out, "final-snapshot.json"), JSON.stringify(await snapshot(), null, 2))
  // Reload ONLY after capture-end/Stop. Never repair or retry live audio.
  await context.reload()
  await waitImportedClip(context, "retained")
  await exportReference(context, "final-reference")
  await writeFile(path.join(out, "phase5-edits.json"), JSON.stringify({ phase: 5, row, editStart, commits,
    sameTrackId, unchangedChannel: 0, sampleRate: 48000, endFrame: 48000 * 17, ...(finalEffectState && { effectState: finalEffectState }) }, null, 2))
}
