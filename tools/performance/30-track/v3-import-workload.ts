import path from "node:path"
import { z } from "zod"
import {
  controlApprovalResultSchemaV1,
  controlCapabilitiesSchemaV2,
  controlCommitResultSchemaV1,
  controlPreviewResultSchemaV1,
  projectSnapshotSchemaV2,
  type ProjectSnapshotV2,
} from "@daw-browser/control"
import {
  desktopHostVstInstancesResultSchemaV1,
  desktopHostVstParametersResultSchemaV1,
} from "@daw-browser/desktop-protocol"
import { browserCommand, waitForBrowserValue } from "../browser-harness"
import { fullLoadFrameProbeScript } from "./v3-import-process"

const root = path.resolve(import.meta.dir, "../../..")
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export const countMidiNotes = (clips: readonly { midi?: { notes: readonly { beat: number }[] } }[]) =>
  clips.reduce((total, clip) => total + (clip.midi?.notes.length ?? 0), 0)
export const playbackCountersValid = (
  before: { callbacks: number; rejectedBlocks: number } | null,
  after: { callbacks: number; rejectedBlocks: number },
) => after.callbacks > (before?.callbacks ?? 0) && after.rejectedBlocks === (before?.rejectedBlocks ?? 0)

export const createLaterOffsetPagingRequest = (snapshot: {
  project: { id: string; revision: number }
  assets: readonly { id: string; durationSec?: number }[]
  clips: readonly { id: string; trackId: string; source?: { assetId: string } }[]
}) => {
  const longAssets = snapshot.assets.filter((asset) => asset.durationSec === 600)
  if (longAssets.length !== 1 || !longAssets[0]) throw new Error("Unique 600-second paging source unavailable.")
  const longClips = snapshot.clips.filter((clip) => clip.source?.assetId === longAssets[0]!.id)
  if (longClips.length !== 1 || !longClips[0]) throw new Error("Unique long-media clip unavailable.")
  const clip = longClips[0]
  return {
    version: "v1" as const,
    projectId: snapshot.project.id,
    expectedRevision: snapshot.project.revision,
    actions: [
      {
        kind: "clip.move" as const,
        clip: { source: "persisted" as const, id: clip.id },
        track: { source: "persisted" as const, id: clip.trackId },
        startSec: 540,
      },
      {
        kind: "clip.timing.set" as const,
        clip: { source: "persisted" as const, id: clip.id },
        duration: 60,
        bufferOffsetSec: 540,
      },
    ],
  }
}

export const assertArchiveSnapshot = (value: ProjectSnapshotV2) => {
  if (value.tracks.length !== 30 || value.clips.length !== 30 || value.assets.length !== 24 ||
    countMidiNotes(value.clips) !== 96)
    throw new Error(`V3 semantic mismatch: ${value.tracks.length} tracks, ${value.clips.length} clips, ${value.assets.length} assets, ${countMidiNotes(value.clips)} MIDI notes`)
  return value
}
export const prepareFullDsp = async (session: string, profile: string, projectId: string, audioTrackNames: readonly string[],
  instanceCount: number, automationActive = true) => {
  await browserCommand(session, ["eval", "(()=>{const url=new URL(location.href);url.searchParams.set('dashboard','plugins');history.pushState(null,'',url);window.dispatchEvent(new PopStateEvent('popstate'));return true})()"])
  await waitForBrowserValue(session, "document.body.textContent?.includes('VST3 Plug-ins') ? true : null", 30_000)
  await browserCommand(session, ["eval", "(()=>{const input=document.querySelector('input[type=checkbox]');if(!(input instanceof HTMLInputElement))throw new Error('VST3 trust acknowledgement UI unavailable.');input.click();return true})()"])
  await waitForBrowserValue(session, "(()=>{const row=[...document.querySelectorAll('[role=\"dialog\"] *')].find((e)=>e.textContent?.trim()==='Catalog scan');return row?.parentElement?.textContent?.match(/[1-9]\\d* VST3 bundles? discovered/) ? true : null})()", 60_000)
  await browserCommand(session, ["press", "Escape"])
  await waitForBrowserValue(session, "document.querySelector('[data-timeline-left-browser=\"1\"]') !== null ? true : null", 30_000)
  for (const trackName of audioTrackNames.slice(0, instanceCount)) {
    await browserCommand(session, ["eval", `(()=>{const button=document.querySelector(${JSON.stringify(`button[aria-label="Select track ${audioTrackNames.indexOf(trackName) + 1}: ${trackName}"]`)});if(!(button instanceof HTMLButtonElement))throw new Error('Audio track selection unavailable.');button.click();return true})()`])
    await browserCommand(session, ["eval", "(()=>{const tab=[...document.querySelectorAll('[data-timeline-left-browser=\"1\"] button')].find((button)=>button.textContent?.trim()==='Effects');if(!(tab instanceof HTMLButtonElement))throw new Error('Effects browser tab unavailable.');tab.click();return true})()"])
    for (const name of ["Saturator", "Utility"]) {
      await browserCommand(session, ["fill", "[data-timeline-left-browser='1'] input[type='search']", name])
      await browserCommand(session, ["eval", `(()=>{const button=[...document.querySelectorAll('[data-timeline-left-browser="1"] button')].find((entry)=>entry.textContent?.trim()===${JSON.stringify(name)});if(!(button instanceof HTMLButtonElement)||button.disabled)throw new Error(${JSON.stringify(`${name} effect unavailable.`)});button.click();return true})()`])
      await delay(500)
    }
    await browserCommand(session, ["fill", "[data-timeline-left-browser='1'] input[type='search']", "ValhallaSupermassive"])
    await waitForBrowserValue(session, "(()=>{const row=[...document.querySelectorAll('[data-timeline-left-browser=\"1\"] button')].find((b)=>b.textContent?.trim()==='ValhallaSupermassive');return row && !row.disabled ? true : null})()", 60_000)
    await browserCommand(session, ["eval", "(()=>{const button=[...document.querySelectorAll('[data-timeline-left-browser=\"1\"] button')].find((entry)=>entry.textContent?.trim()==='ValhallaSupermassive');if(!(button instanceof HTMLButtonElement)||button.disabled)throw new Error('ValhallaSupermassive unavailable.');button.click();return true})()"])
    await waitForBrowserValue(session, "(()=>{const row=[...document.querySelectorAll('[data-timeline-left-browser=\"1\"] button')].find((b)=>b.textContent?.trim()==='ValhallaSupermassive');return row?.getAttribute('aria-description')?.includes('Enabled · Preflight passed') ? true : null})()", 60_000)
  }
  const snapshot = projectSnapshotSchemaV2.parse(await command(profile, ["snapshot-v2", projectId, "--target", "host"]))
  const processors = snapshot.processors.filter((entry) => entry.processor.kind === "external-vst3"
    && entry.processor.params.identity.name === "ValhallaSupermassive")
  if (processors.length !== instanceCount) throw new Error(`Expected ${instanceCount} trusted VST processors, found ${processors.length}.`)
  const builtInEffects = snapshot.processors.filter((entry) => entry.processor.kind !== "external-vst3")
  if (builtInEffects.length < instanceCount * 2) throw new Error("Built-in DSP effects were not persisted.")
  const first = processors[0]
  if (!first || !("trackId" in first.target)) throw new Error("First VST audio track is missing.")
  const instances = desktopHostVstInstancesResultSchemaV1.parse(await command(profile, ["host", "vst-instances", projectId]))
  const instance = instances.instances.find((item) => item.targetId === first.target.trackId
    && item.identity.classId === first.processor.params.identity.classId)
  if (!instance || instance.health.state !== "ready") throw new Error("First trusted VST worker is not ready.")
  const parameters = desktopHostVstParametersResultSchemaV1.parse(await command(profile, ["host", "vst-parameters", projectId, instance.instanceId]))
  const mix = parameters.parameters.filter((item) => item.title.toLowerCase() === "mix" && !item.readOnly && !item.hidden)
  if (mix.length !== 1 || !mix[0]) throw new Error("Unique writable Mix parameter unavailable.")
  if (!automationActive) {
    return { processors: processors.length, builtInEffects: builtInEffects.length,
      automatedInstanceId: null, mixParameterId: mix[0].id }
  }
  const capabilities = controlCapabilitiesSchemaV2.parse(await command(profile, ["capabilities-v2", "--target", "host"]))
  if (!capabilities.actionKinds.includes("automation.set")) throw new Error("Local automation action not advertised.")
  const request = {
    version: "v1", projectId, expectedRevision: snapshot.project.revision,
    actions: [{ kind: "automation.set",
      target: { kind: "track", track: { source: "persisted", id: first.target.trackId } },
      effect: { source: "persisted", id: first.id },
      parameterId: `vst3:${instance.instanceId}:${mix[0].id}`, enabled: true,
      points: [{ id: "v3-dsp-mix-0", timeSec: 0, value: 0.25, interpolation: "linear" },
        { id: "v3-dsp-mix-4", timeSec: 4, value: 0.75, interpolation: "linear" },
        { id: "v3-dsp-mix-8", timeSec: 8, value: 0.25, interpolation: "linear" }],
    }],
  }
  const preview = controlPreviewResultSchemaV1.parse(await command(profile, ["preview", "--request", "-", "--target", "host"], JSON.stringify(request)))
  if (preview.approval?.required) throw new Error("VST automation unexpectedly requires approval.")
  controlCommitResultSchemaV1.parse(await command(profile, ["commit", "--request", "-", "--target", "host"],
    JSON.stringify({ ...request, idempotencyKey: `v3-dsp-${crypto.randomUUID()}` })))
  const persisted = projectSnapshotSchemaV2.parse(await command(profile, ["snapshot-v2", projectId, "--target", "host"]))
  if (!persisted.automation.some((entry) => entry.effectInstanceId === instance.instanceId
    && entry.parameterId === `vst3:${instance.instanceId}:${mix[0].id}` && entry.enabled && entry.points.length === 3))
    throw new Error("VST Mix automation did not persist.")
  return { processors: processors.length, builtInEffects: builtInEffects.length,
    automatedInstanceId: instance.instanceId, mixParameterId: mix[0].id }
}
export const deriveActiveClipProject = async (
  profile: string,
  snapshot: ProjectSnapshotV2,
  activeClipCount: number,
) => {
  if (activeClipCount >= snapshot.clips.length) return snapshot
  const request = {
    version: "v1",
    projectId: snapshot.project.id,
    expectedRevision: snapshot.project.revision,
    actions: snapshot.clips.slice(activeClipCount).map((clip) => ({
      kind: "clip.delete",
      clip: { source: "persisted", id: clip.id },
    })),
  }
  const preview = controlPreviewResultSchemaV1.parse(await command(
    profile,
    ["preview", "--request", "-", "--target", "host"],
    JSON.stringify(request),
  ))
  const approvalToken = preview.approval?.required
    ? controlApprovalResultSchemaV1.parse(await command(
      profile,
      ["approval", "--request", "-", "--target", "host"],
      JSON.stringify(request),
    )).approvalToken
    : undefined
  controlCommitResultSchemaV1.parse(await command(
    profile,
    ["commit", "--request", "-", "--target", "host"],
    JSON.stringify({ ...request, idempotencyKey: `zoom-clips-${activeClipCount}-${crypto.randomUUID()}`, approvalToken }),
  ))
  const derived = projectSnapshotSchemaV2.parse(await command(
    profile,
    ["snapshot-v2", snapshot.project.id, "--target", "host"],
  ))
  if (derived.clips.length !== activeClipCount) {
    throw new Error(`Expected ${activeClipCount} active benchmark clips, found ${derived.clips.length}.`)
  }
  return derived
}
export const runFullLoadUiStress = async (
  session: string,
  snapshot: ProjectSnapshotV2,
  dspSetup: Awaited<ReturnType<typeof prepareFullDsp>> | null,
  preserveRecording = false,
) => {
  const audioTrack = snapshot.tracks.find((track) => track.kind === "audio")
  const instrumentTrack = snapshot.tracks.find((track) => track.kind === "instrument")
  const audioClip = snapshot.clips.find((clip) => clip.trackId === audioTrack?.id && clip.source)
  if (!audioTrack || !instrumentTrack || !audioClip) throw new Error("Full-load UI stress targets unavailable.")
  const audioTrackIndex = snapshot.tracks.findIndex((track) => track.id === audioTrack.id) + 1
  const instrumentTrackIndex = snapshot.tracks.findIndex((track) => track.id === instrumentTrack.id) + 1
  const settle = () => delay(1_250)
  const evalTrue = async (script: string, failure: string) => {
    const result = await browserCommand(session, ["eval", script])
    if (!result.includes("true")) throw new Error(failure)
    await settle()
  }
  const phase = async (name: string, action: () => Promise<void>) => {
    await browserCommand(session, ["eval", `window.__dawPerformancePhase?.(${JSON.stringify(name)},true)??true`])
    try { await action() }
    finally {
      await browserCommand(session, ["eval", `window.__dawPerformancePhase?.(${JSON.stringify(name)},false)??true`])
    }
  }
  const zoom = (deltaY: number, anchor: number) => evalTrue(
    `(()=>{const ruler=document.querySelector('[data-timeline-ruler="1"]');const timeline=ruler?.closest('.overflow-auto');if(!(timeline instanceof HTMLElement))return false;const rect=timeline.getBoundingClientRect();timeline.dispatchEvent(new WheelEvent('wheel',{deltaY:${deltaY},deltaMode:0,ctrlKey:true,bubbles:true,clientX:rect.left+rect.width*${anchor}}));return true})()`,
    "Timeline zoom surface unavailable.",
  )
  await phase("timeline-pan", () => evalTrue("(()=>{const ruler=document.querySelector('[data-timeline-ruler=\"1\"]');const timeline=ruler?.closest('.overflow-auto');if(!(timeline instanceof HTMLElement))return false;timeline.scrollLeft+=900;timeline.dispatchEvent(new Event('scroll'));return true})()", "Timeline horizontal pan unavailable."))
  await phase("vertical-scroll", () => evalTrue("(()=>{const ruler=document.querySelector('[data-timeline-ruler=\"1\"]');const timeline=ruler?.closest('.overflow-auto');if(!(timeline instanceof HTMLElement))return false;timeline.scrollTop=Math.max(0,timeline.scrollHeight-timeline.clientHeight);timeline.dispatchEvent(new Event('scroll'));return true})()", "Timeline vertical scroll unavailable."))
  await phase("timeline-zoom-out", () => zoom(480, 0.5))
  await phase("timeline-deep-zoom", async () => {
    for (let index = 0; index < 5; index++) await zoom(-360, index === 4 ? 0.8 : 0.35)
  })
  await phase("sample-detail-open", () => evalTrue(`(()=>{const clip=[...document.querySelectorAll('[title=${JSON.stringify(audioClip.name)}]')].find((entry)=>entry instanceof HTMLElement);if(!(clip instanceof HTMLElement))return false;clip.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,detail:2}));return true})()`, "Audio clip Sample Detail interaction unavailable."))
  await waitForBrowserValue(session, "document.body.textContent?.includes('Sample Detail') && document.querySelector('canvas') ? true : null", 30_000)
  await phase("sample-detail-zoom", async () => {
    for (let index = 0; index < 4; index++) await evalTrue(
      `(()=>{const heading=[...document.querySelectorAll('*')].find((entry)=>entry.textContent?.trim()==='Sample Detail');const panel=heading?.parentElement?.parentElement;const canvas=panel?.querySelector('canvas');if(!(canvas instanceof HTMLCanvasElement))return false;const rect=canvas.getBoundingClientRect();canvas.dispatchEvent(new WheelEvent('wheel',{deltaY:-320,ctrlKey:true,bubbles:true,clientX:rect.left+rect.width*.65}));return true})()`,
      "Sample Detail waveform zoom unavailable.",
    )
  })
  if (!preserveRecording) await evalTrue("(()=>{const ruler=document.querySelector('[data-timeline-ruler=\"1\"]');if(!(ruler instanceof HTMLElement))return false;const rect=ruler.getBoundingClientRect();for(const ratio of [.5,.92]){const x=rect.left+rect.width*ratio,y=rect.top+rect.height*.75;ruler.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,clientX:x,clientY:y,pointerId:1,buttons:1}));ruler.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,clientX:x,clientY:y,pointerId:1}))}return true})()", "Timeline seek interaction unavailable.")
  if (preserveRecording) return
  await evalTrue("(()=>{const button=document.querySelector('button[aria-label=\"Toggle loop region\"]');if(!(button instanceof HTMLButtonElement))return false;button.click();return button.getAttribute('aria-pressed')==='true'})()", "Loop interaction unavailable.")
  await evalTrue(`(()=>{const button=document.querySelector(${JSON.stringify(`button[aria-label="Select track ${audioTrackIndex}: ${audioTrack.name}"]`)});if(!(button instanceof HTMLButtonElement))return false;button.click();return true})()`, "DSP audio track unavailable.")
  await evalTrue("(()=>{const slider=document.querySelector('[aria-label=\"Drive\"][role=\"slider\"]');if(!(slider instanceof HTMLElement))return false;const rect=slider.getBoundingClientRect();slider.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,clientX:rect.left+rect.width/2,clientY:rect.top+rect.height/2,pointerId:2,buttons:1}));slider.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,clientX:rect.left+rect.width/2,clientY:rect.top+rect.height*.25,pointerId:2,buttons:1}));slider.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,clientX:rect.left+rect.width/2,clientY:rect.top+rect.height*.25,pointerId:2}));return true})()", "Built-in effect interaction unavailable.")
  await evalTrue(`(()=>{const button=document.querySelector(${JSON.stringify(`button[aria-label="Select track ${instrumentTrackIndex}: ${instrumentTrack.name}"]`)});if(!(button instanceof HTMLButtonElement))return false;button.click();return true})()`, "Instrument track unavailable.")
  await evalTrue("(()=>{const button=[...document.querySelectorAll('button[aria-label]')].find((entry)=>entry.getAttribute('aria-label')?.endsWith(': square'));if(button instanceof HTMLButtonElement)button.click();return true})()", "Instrument interaction failed.")
  if (dspSetup) {
    await evalTrue(`(()=>{const button=document.querySelector(${JSON.stringify(`button[aria-label="Select track ${audioTrackIndex}: ${audioTrack.name}"]`)});if(!(button instanceof HTMLButtonElement))return false;button.click();const show=[...document.querySelectorAll('button')].find((entry)=>entry.textContent?.startsWith('Show parameters'));if(show instanceof HTMLButtonElement)show.click();return true})()`, "VST parameter panel unavailable.")
    await evalTrue("(()=>{const rows=[...document.querySelectorAll('input[type=\"range\"]')];const slider=rows.find((entry)=>entry.parentElement?.parentElement?.textContent?.includes('Mix'));if(!(slider instanceof HTMLInputElement))return false;slider.value=String(Math.min(1,Number(slider.value)+.08));slider.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertReplacementText'}));slider.dispatchEvent(new Event('change',{bubbles:true}));return true})()", "Real VST Mix interaction unavailable.")
  }
  if (!preserveRecording) await evalTrue("(()=>{const stop=document.querySelector('button[aria-label=\"Stop\"]');if(stop instanceof HTMLButtonElement)stop.click();const play=document.querySelector('button[aria-label=\"Play\"]');if(!(play instanceof HTMLButtonElement))return false;play.click();return true})()", "Playback recovery failed.")
}
export const runZoomSweeps = async (
  session: string,
  projectActiveClipCount: number,
  recoverTarget?: () => Promise<void>,
) => {
  const gestures: {
    sweep: number
    direction: "in" | "out"
    anchor: number
    elapsedMs: number
    firstResponseMs: number
    settleMs: number
    stateChangeMs: number
    firstVisualMs: number
    settled: boolean
    inputToViewportStateMs: number | null
    viewportToRequestsQuiescentMs: number | null
    quiescenceToRasterStartMs: number | null
    rasterExecutionMs: number | null
    rasterCompleteToPresentedFrameMs: number | null
    firstPresentedToTwoStableFramesMs: number | null
    browserCommandRoundTripMs: number
    projectActiveClipCount: number
    mountedClipCount: number
    viewportIntersectingClipCount: number
  }[] = []
  const memoryCheckpoints: {
    name: string
    heapUsedBytes: number | null
    heapTotalBytes: number | null
    waveformRequestStarts: number
    waveformRasterCalls: number
  }[] = []
  const ensureProbe = async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        const present = (await browserCommand(session, ["eval", "Boolean(window.__dawFullLoadFrameProbe)"])).trim() === "true"
        if (present) return
      } catch { /* The renderer may be between targets during a reload. */ }
      if (!recoverTarget) throw new Error("Full-load frame probe unavailable.")
      await recoverTarget()
      await browserCommand(session, ["eval", fullLoadFrameProbeScript()])
    }
    throw new Error("Full-load frame probe could not be installed on the recovered target after bounded retries.")
  }
  await ensureProbe()
  await browserCommand(session, ["eval",
    `(()=>{const timeline=document.querySelector('[data-timeline-scroll-viewport="1"]');if(!(timeline instanceof HTMLElement))throw new Error('Timeline viewport unavailable.');timeline.scrollTop=0;timeline.dispatchEvent(new Event('scroll'));return true})()`])
  await delay(100)
  const checkpoint = async (name: string) => {
    memoryCheckpoints.push(z.object({
      name: z.string(),
      heapUsedBytes: z.number().nonnegative().nullable(),
      heapTotalBytes: z.number().nonnegative().nullable(),
      waveformRequestStarts: z.number().nonnegative(),
      waveformRasterCalls: z.number().nonnegative(),
    }).parse(JSON.parse(await browserCommand(session, ["eval",
      `(()=>{const probe=window.__dawFullLoadFrameProbe,memory=performance.memory;return {name:${JSON.stringify(name)},heapUsedBytes:Number.isFinite(memory?.usedJSHeapSize)?memory.usedJSHeapSize:null,heapTotalBytes:Number.isFinite(memory?.totalJSHeapSize)?memory.totalJSHeapSize:null,waveformRequestStarts:probe?.counters?.['waveform.requests-started']||0,waveformRasterCalls:probe?.counters?.['waveform.raster-calls']||0}})()`]))))
  }
  await checkpoint("before-sweeps")
  const zoom = async (sweep: number, direction: "in" | "out", anchor: number, deltaY: number) => {
    const name = `zoom-${direction}-${sweep}-${Math.round(anchor * 100)}`
    const startedAt = performance.now()
    let token = ""
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await ensureProbe()
      await browserCommand(session, ["eval", `window.__dawPerformancePhase?.(${JSON.stringify(name)},true)??true`])
      token = crypto.randomUUID()
      await browserCommand(session, ["eval",
        `window.__dawMeasureZoomGesture?.(${JSON.stringify(token)},${deltaY},${anchor})??false`])
      try {
        await waitForBrowserValue(session,
          `window.__dawFullLoadFrameProbe?.zoomResults?.[${JSON.stringify(token)}]??null`,
          8_000)
        break
      } catch (error) {
        if (attempt === 9) throw error
        if (recoverTarget) await recoverTarget()
      }
    }
    const timing = z.object({
      stateChangeMs: z.number().nonnegative().nullable(),
      firstVisualMs: z.number().nonnegative().nullable(),
      settledMs: z.number().nonnegative().nullable(),
      settled: z.boolean(),
      inputToViewportStateMs: z.number().nonnegative().nullable(),
      viewportToRequestsQuiescentMs: z.number().nonnegative().nullable(),
      quiescenceToRasterStartMs: z.number().nonnegative().nullable(),
      rasterExecutionMs: z.number().nonnegative().nullable(),
      rasterCompleteToPresentedFrameMs: z.number().nonnegative().nullable(),
      firstPresentedToTwoStableFramesMs: z.number().nonnegative().nullable(),
    }).parse(JSON.parse(await browserCommand(session, ["eval",
      `window.__dawFullLoadFrameProbe.zoomResults[${JSON.stringify(token)}]`])))
    const browserCommandRoundTripMs = performance.now() - startedAt
    if (timing.stateChangeMs === null || timing.firstVisualMs === null || timing.settledMs === null) {
      throw new Error(`Zoom gesture did not settle: ${name}`)
    }
    const clipCounts = z.object({
      mountedClipCount: z.number().int().nonnegative(),
      viewportIntersectingClipCount: z.number().int().nonnegative(),
      viewportRect: z.object({ left: z.number(), top: z.number(), right: z.number(), bottom: z.number() }),
      firstClipRect: z.object({ left: z.number(), top: z.number(), right: z.number(), bottom: z.number() }).nullable(),
    }).parse(JSON.parse(await browserCommand(session, ["eval",
      `(()=>{const timeline=document.querySelector('[data-timeline-scroll-viewport="1"]');if(!(timeline instanceof HTMLElement))throw new Error('Timeline viewport unavailable.');const viewport=timeline.getBoundingClientRect(),clips=[...document.querySelectorAll('[data-timeline-clip-id]')].filter(entry=>entry instanceof HTMLElement&&entry.offsetWidth>0&&entry.offsetHeight>0),rect=clips[0]?.getBoundingClientRect();return {mountedClipCount:clips.length,viewportIntersectingClipCount:clips.filter(entry=>{const rect=entry.getBoundingClientRect();return rect.right>viewport.left&&rect.left<viewport.right&&rect.bottom>viewport.top&&rect.top<viewport.bottom}).length,viewportRect:{left:viewport.left,top:viewport.top,right:viewport.right,bottom:viewport.bottom},firstClipRect:rect?{left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom}:null}})()`])))
    await browserCommand(session, ["eval", `window.__dawPerformancePhase?.(${JSON.stringify(name)},false)??true`])
    gestures.push({ sweep, direction, anchor, elapsedMs: performance.now() - startedAt,
      firstResponseMs: timing.firstVisualMs, settleMs: timing.settledMs,
      stateChangeMs: timing.stateChangeMs, firstVisualMs: timing.firstVisualMs,
      settled: timing.settled,
      inputToViewportStateMs: timing.inputToViewportStateMs,
      viewportToRequestsQuiescentMs: timing.viewportToRequestsQuiescentMs,
      quiescenceToRasterStartMs: timing.quiescenceToRasterStartMs,
      rasterExecutionMs: timing.rasterExecutionMs,
      rasterCompleteToPresentedFrameMs: timing.rasterCompleteToPresentedFrameMs,
      firstPresentedToTwoStableFramesMs: timing.firstPresentedToTwoStableFramesMs,
      browserCommandRoundTripMs, projectActiveClipCount,
      ...clipCounts })
  }
  for (let sweep = 0; sweep < 10; sweep++) {
    for (const anchor of [0.25, 0.5, 0.75]) await zoom(sweep, "in", anchor, -720)
    await zoom(sweep, "in", 0.5, -1_440)
    await delay(100)
    for (const anchor of [0.75, 0.5, 0.25]) await zoom(sweep, "out", anchor, 720)
    await zoom(sweep, "out", 0.5, 1_440)
    if (sweep === 0) await checkpoint("after-first-overview")
    if (sweep === 4) await checkpoint("after-sweep-5")
    if (sweep === 9) await checkpoint("after-sweep-10")
  }
  await delay(5_000)
  await checkpoint("after-5s-settle")
  await delay(5_000)
  await checkpoint("after-10s-settle")
  return { gestures, memoryCheckpoints }
}
export const quietCapture = async (steps: {
  start: () => Promise<void>
  wait: () => Promise<void>
  stop: () => Promise<void>
  observe: () => Promise<void>
}) => {
  await steps.start()
  await steps.wait()
  await steps.stop()
  await steps.observe()
}
export const recoverQuietTarget = async (steps: {
  original: () => Promise<string>
  reconnect: () => Promise<string>
}, expectedProjectId?: string) => {
  const matches = (url: string) => {
    try {
      const page = new URL(url)
      return page.protocol === "daw:" && page.hostname === "app"
        && (expectedProjectId === undefined || page.searchParams.get("projectId") === expectedProjectId)
    } catch { return false }
  }
  try {
    const url = await steps.original()
    if (matches(url)) return { recovered: false, url }
  } catch { /* A disconnected browser session is expected during recovery. */ }
  const url = await steps.reconnect()
  if (!matches(url)) throw new Error("Verified app target unavailable")
  return { recovered: true, url }
}
export const importedProjectTarget = (tabs: string, projectId: string): string | null => {
  const matches = [...tabs.matchAll(/\[(t[0-9]+)\][^\n]*\s(daw:\/\/app\/[^\s]*)/g)]
    .filter(([, , url]) => {
      try { return new URL(url).searchParams.get("projectId") === projectId } catch { return false }
    })
  return matches.length === 1 ? matches[0]?.[1] ?? null : null
}
export const classifyQuietCapture = (state: {
  mainAlive: boolean
  rendererAlive: boolean
  targetFound: boolean
  stopPresent: boolean | null
  stopSucceeded: boolean
  rendererFailure: boolean
}) => {
  if (!state.mainAlive) return "electron-main-exited"
  if (!state.rendererAlive || state.rendererFailure) return "renderer-gone"
  if (!state.targetFound || state.stopPresent === null) return "renderer-unresponsive"
  if (!state.stopPresent) return "recording-ended-before-stop"
  return state.stopSucceeded ? "explicit-stop-completed" : "stop-control-failed"
}
export const command = async (profile: string, args: string[], input?: string) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const child = Bun.spawn(["bun", path.join(root, "packages/control-cli/dist/daw-control.js"), ...args], {
      cwd: root, env: { ...process.env, DAW_DESKTOP_USER_DATA: profile, DAW_CONTROL_AUTH_PATH: path.join(profile, "control-auth.json") }, stdout: "pipe", stderr: "pipe",
      stdin: input === undefined ? "ignore" : "pipe",
    })
    if (input !== undefined && child.stdin) { child.stdin.write(input); child.stdin.end() }
    const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
    if (await child.exited === 0) return JSON.parse(out).data
    if (!err.includes('"code":"unavailable"') || attempt === 19) {
      throw new Error(`Control command failed: ${err.slice(0, 500)}`)
    }
    await delay(250)
  }
  throw new Error("Control command retry bound exhausted.")
}
