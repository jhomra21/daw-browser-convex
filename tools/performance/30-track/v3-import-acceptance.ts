#!/usr/bin/env bun
import { spawn } from "node:child_process"
import { mkdir, readFile, stat } from "node:fs/promises"
import path from "node:path"
import { browserCommand, waitForBrowserValue } from "../browser-harness"
import { cleanupOwnedRunDirectory, cleanupSurvivors, createCleanupPlan, createPrivateRunDirectory, descendantsOf, verifyElectronLaunchIdentity, electronRendererTarget, writePrivateArtifact } from "./electron"
import { controlApprovalResultSchemaV1, controlCapabilitiesSchemaV2, controlCommitResultSchemaV1, controlPreviewResultSchemaV1, projectSnapshotSchemaV2, type ProjectSnapshotV2 } from "@daw-browser/control"
import { desktopDiagnosticsSchemaV2, desktopHostVstInstancesResultSchemaV1, desktopHostVstParametersResultSchemaV1, desktopTransportStatusSchemaV1 } from "@daw-browser/desktop-protocol"
import { z } from "zod"
import { boundedRendererEvents, summarizeRendererMetrics } from "../../../apps/desktop/quiet-renderer-telemetry"

const root = path.resolve(import.meta.dir, "../../..")
const archive = path.join(root, "tools/performance/fixtures/30-track-v3-native.dawproject")
const executable = path.join(root, "apps/desktop/out/@daw-browser-desktop-darwin-arm64/@daw-browser-desktop.app/Contents/MacOS/@daw-browser-desktop")
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
export const parseControlMode = (option: string | undefined): "idle" | "playback" | "ui" | "paging" | "dsp" | "dsp-ui" | "dsp-soak" | "dsp-one" | "dsp-recording" | "dsp-ui-recording" | "zoom-profile" | "zoom-recording-profile" | "vst-reliability" | "media-recording" | "media-recording-probe" | "media-recording-probe-drop" | "media-recording-probe-drop-no-meters" | "media-recording-probe-metadata" | "media-recording-probe-batch4" | "media-recording-probe-batch8" | "media-recording-portable" | "recording" | "acceptance" => {
  if (option === undefined) return "acceptance"
  if (option === "--idle-control") return "idle"
  if (option === "--playback-control") return "playback"
  if (option === "--ui-control") return "ui"
  if (option === "--paging-control") return "paging"
  if (option === "--dsp-control") return "dsp"
  if (option === "--dsp-ui-control") return "dsp-ui"
  if (option === "--dsp-soak") return "dsp-soak"
  if (option === "--dsp-one-control") return "dsp-one"
  if (option === "--dsp-recording") return "dsp-recording"
  if (option === "--dsp-ui-recording") return "dsp-ui-recording"
  if (option === "--zoom-profile") return "zoom-profile"
  if (option === "--zoom-recording-profile") return "zoom-recording-profile"
  if (option === "--vst-reliability") return "vst-reliability"
  if (option === "--media-recording") return "media-recording"
  if (option === "--media-recording-probe") return "media-recording-probe"
  if (option === "--media-recording-probe-drop") return "media-recording-probe-drop"
  if (option === "--media-recording-probe-drop-no-meters") return "media-recording-probe-drop-no-meters"
  if (option === "--media-recording-probe-metadata") return "media-recording-probe-metadata"
  if (option === "--media-recording-probe-batch4") return "media-recording-probe-batch4"
  if (option === "--media-recording-probe-batch8") return "media-recording-probe-batch8"
  if (option === "--media-recording-portable") return "media-recording-portable"
  if (option === "--quiet-recording") return "recording"
  throw new Error("Unknown packaged v3 control mode")
}
export const controlDurationMs = (mode: ReturnType<typeof parseControlMode>) =>
  mode === "dsp-soak" ? 300_000 : mode === "vst-reliability" ? 20_000 : 60_000
const isDspControlMode = (mode: ReturnType<typeof parseControlMode>) => mode === "dsp" || mode === "dsp-ui"
  || mode === "dsp-soak" || mode === "dsp-one" || mode === "zoom-profile" || mode === "vst-reliability"
const isUiStressMode = (mode: ReturnType<typeof parseControlMode>) => mode === "ui" || mode === "dsp-ui"
  || mode === "dsp-ui-recording"
const isMediaRecordingMode = (mode: ReturnType<typeof parseControlMode>) => mode.startsWith("media-recording")
const recordingForwardMode = (mode: ReturnType<typeof parseControlMode>) =>
  mode.startsWith("media-recording-probe-drop") ? "drop"
    : mode === "media-recording-probe-metadata" ? "metadata"
      : mode === "media-recording-probe-batch4" ? "batch4"
        : mode === "media-recording-probe-batch8" ? "batch8" : "full"
const performanceQuantilesSchema = z.object({
  p50: z.number().finite().nullable(),
  p95: z.number().finite().nullable(),
  p99: z.number().finite().nullable(),
  max: z.number().finite().nullable(),
}).strict()
const performanceThresholdsSchema = z.object({
  over8_33Ms: z.number().int().nonnegative(),
  over16_67Ms: z.number().int().nonnegative(),
  over33_3Ms: z.number().int().nonnegative(),
  over50Ms: z.number().int().nonnegative(),
}).strict()
const fullLoadFramePerformanceSchema = z.object({
  display: z.object({
    refreshRateHz: z.number().finite().positive().nullable(),
    viewportWidth: z.number().int().positive(),
    viewportHeight: z.number().int().positive(),
    devicePixelRatio: z.number().finite().positive(),
  }).strict(),
  raf: z.object({
    sampleCount: z.number().int().nonnegative(),
    intervalsMs: performanceQuantilesSchema,
  }).strict(),
  applicationWork: z.object({
    sampleCount: z.number().int().nonnegative(),
    durationMs: performanceQuantilesSchema,
    thresholds: performanceThresholdsSchema,
  }).strict(),
  longTasks: z.object({
    supported: z.boolean(),
    count: z.number().int().nonnegative().nullable(),
    totalDurationMs: z.number().finite().nonnegative().nullable(),
    maxDurationMs: z.number().finite().nonnegative().nullable(),
  }).strict(),
  droppedSamples: z.object({
    raf: z.number().int().nonnegative(),
    applicationWork: z.number().int().nonnegative(),
    longTasks: z.number().int().nonnegative(),
  }).strict(),
  attribution: z.object({
    phases: z.array(z.object({
      name: z.string().min(1).max(80),
      startTime: z.number().finite(),
      endTime: z.number().finite().nullable(),
    }).strict()).max(256),
    longFrames: z.array(z.object({
      startTime: z.number().finite(),
      duration: z.number().finite().nonnegative(),
      phase: z.string().min(1).max(80),
      owner: z.string().min(1).max(80),
      scriptDuration: z.number().finite().nonnegative().nullable(),
      renderDuration: z.number().finite().nonnegative().nullable(),
      styleAndLayoutDuration: z.number().finite().nonnegative().nullable(),
      forcedStyleAndLayoutDuration: z.number().finite().nonnegative().nullable(),
      source: z.string().max(160).nullable(),
      functionName: z.string().max(120).nullable(),
    }).strict()).max(256),
    counters: z.record(z.string(), z.number().finite().nonnegative()),
    durations: z.record(z.string(), z.object({
      count: z.number().int().nonnegative(),
      totalMs: z.number().finite().nonnegative(),
      p95Ms: z.number().finite().nonnegative().nullable(),
      maxMs: z.number().finite().nonnegative().nullable(),
    }).strict()),
    droppedLongFrames: z.number().int().nonnegative(),
  }).strict(),
}).strict()

export const fullLoadFrameProbeScript = () => `(()=>{const limit=8192,longLimit=256;const state={active:true,last:null,raf:[],work:[],long:[],drop:{raf:0,work:0,long:0,longFrames:0},observer:null,loafObserver:null,id:0,currentPhase:'unattributed',phases:[],longFrames:[],marks:[],counters:{},durations:{},zoomResults:{}};
const push=(values,key,value)=>{if(values.length<limit)values.push(value);else state.drop[key]++};
const owner=(entry)=>{const scripts=entry.scripts||[];const script=scripts.reduce((best,item)=>(item.duration||0)>(best?.duration||0)?item:best,null);const source=String(script?.sourceURL||'').slice(-160),fn=String(script?.functionName||'').slice(0,120);const text=(source+' '+fn).toLowerCase();const category=text.includes('waveform')?'waveform-geometry':text.includes('record')?'recording-UI':text.includes('timeline')?'timeline-reactivity':text.includes('solid')?'Solid/reactive':scripts.length?'unknown':'layout/style';return {category,source:source||null,functionName:fn||null}};
const phase=(name,active)=>{const now=performance.now();if(active){state.currentPhase=name;state.phases.push({name,startTime:now,endTime:null})}else{const item=[...state.phases].reverse().find(candidate=>candidate.name===name&&candidate.endTime===null);if(item)item.endTime=now;state.currentPhase=[...state.phases].reverse().find(candidate=>candidate.endTime===null)?.name||'unattributed'};return true};
window.__dawPerformanceBenchmark={increment:(key,amount=1)=>{state.counters[key]=(state.counters[key]||0)+amount},duration:(key,value)=>{const values=state.durations[key]||(state.durations[key]=[]);if(values.length<limit)values.push(value)},gauge:(key,value)=>{state.counters[key]=value},mark:(owner)=>{if(state.marks.length<limit)state.marks.push({owner,timestamp:performance.now()})},phase};
window.__dawPerformancePhase=phase;
window.__dawMeasureZoomGesture=(token,deltaY,anchor)=>{void(async()=>{const timeline=document.querySelector('[data-timeline-scroll-viewport="1"]');if(!(timeline instanceof HTMLElement))throw new Error('Timeline zoom surface unavailable.');const rect=timeline.getBoundingClientRect(),inputTimestamp=performance.now(),beforeGeneration=state.counters['timeline.viewport-generation']||0,beforeMark=state.marks.length;timeline.dispatchEvent(new WheelEvent('wheel',{deltaY,deltaMode:0,ctrlKey:true,bubbles:true,clientX:rect.left+rect.width*anchor}));let firstStateChangeTimestamp=null,requestsQuiescentTimestamp=null,rasterStartTimestamp=null,rasterCompleteTimestamp=null,firstPresentedFrameTimestamp=null,settledTimestamp=null,stableFrames=0,lastSignature='',lastRaster=state.counters['waveform.raster-calls']||0;while(performance.now()-inputTimestamp<4000){await new Promise(requestAnimationFrame);const now=performance.now(),generation=state.counters['timeline.viewport-generation']||0,signature=[generation,state.counters['timeline.pixels-per-second']||0,state.counters['timeline.visible-start-sec']||0,state.counters['timeline.visible-end-sec']||0].join('|'),raster=state.counters['waveform.raster-calls']||0,pending=state.counters['waveform.requests-pending']||0,marks=state.marks.slice(beforeMark);if(firstStateChangeTimestamp===null&&generation!==beforeGeneration){firstStateChangeTimestamp=now;continue}if(firstStateChangeTimestamp!==null&&requestsQuiescentTimestamp===null&&pending===0)requestsQuiescentTimestamp=now;if(requestsQuiescentTimestamp!==null&&rasterStartTimestamp===null)rasterStartTimestamp=marks.find(mark=>mark.owner==='waveform.raster-start'&&mark.timestamp>=requestsQuiescentTimestamp)?.timestamp??null;if(rasterStartTimestamp!==null&&rasterCompleteTimestamp===null)rasterCompleteTimestamp=marks.find(mark=>mark.owner==='waveform.raster-complete'&&mark.timestamp>=rasterStartTimestamp)?.timestamp??null;if(firstStateChangeTimestamp!==null&&firstPresentedFrameTimestamp===null){firstPresentedFrameTimestamp=now;lastSignature=signature;lastRaster=raster;continue}if(firstPresentedFrameTimestamp!==null&&signature===lastSignature&&raster===lastRaster&&pending===0)stableFrames++;else stableFrames=0;lastSignature=signature;lastRaster=raster;if(stableFrames>=2){settledTimestamp=now;break}}const nonnegative=(value)=>value===null?null:Math.max(0,value);state.zoomResults[token]={stateChangeMs:nonnegative(firstStateChangeTimestamp===null?null:firstStateChangeTimestamp-inputTimestamp),firstVisualMs:nonnegative(firstPresentedFrameTimestamp===null?null:firstPresentedFrameTimestamp-inputTimestamp),settledMs:nonnegative(settledTimestamp===null?null:settledTimestamp-inputTimestamp),settled:settledTimestamp!==null,inputToViewportStateMs:nonnegative(firstStateChangeTimestamp===null?null:firstStateChangeTimestamp-inputTimestamp),viewportToRequestsQuiescentMs:nonnegative(firstStateChangeTimestamp===null||requestsQuiescentTimestamp===null?null:requestsQuiescentTimestamp-firstStateChangeTimestamp),quiescenceToRasterStartMs:nonnegative(requestsQuiescentTimestamp===null||rasterStartTimestamp===null?null:rasterStartTimestamp-requestsQuiescentTimestamp),rasterExecutionMs:nonnegative(rasterStartTimestamp===null||rasterCompleteTimestamp===null?null:rasterCompleteTimestamp-rasterStartTimestamp),rasterCompleteToPresentedFrameMs:nonnegative(rasterCompleteTimestamp===null||firstPresentedFrameTimestamp===null?null:firstPresentedFrameTimestamp-rasterCompleteTimestamp),firstPresentedToTwoStableFramesMs:nonnegative(firstPresentedFrameTimestamp===null||settledTimestamp===null?null:settledTimestamp-firstPresentedFrameTimestamp)}})();return true};
const frame=(timestamp)=>{if(!state.active)return;if(state.last!==null)push(state.raf,'raf',timestamp-state.last);state.last=timestamp;
queueMicrotask(()=>{if(state.active)push(state.work,'work',Math.max(0,performance.now()-timestamp))});state.id=requestAnimationFrame(frame)};
if(PerformanceObserver.supportedEntryTypes?.includes('longtask')){state.observer=new PerformanceObserver((list)=>{for(const entry of list.getEntries()){push(state.long,'long',entry.duration);if(state.longFrames.length===longLimit){state.drop.longFrames++;continue}state.longFrames.push({startTime:entry.startTime,duration:entry.duration,phase:state.currentPhase,owner:'unknown',scriptDuration:null,renderDuration:null,styleAndLayoutDuration:null,forcedStyleAndLayoutDuration:null,source:null,functionName:null})}});state.observer.observe({type:'longtask'})}
state.id=requestAnimationFrame(frame);window.__dawFullLoadFrameProbe=state;
if(PerformanceObserver.supportedEntryTypes?.includes('long-animation-frame')){try{state.loafObserver=new PerformanceObserver((list)=>{for(const entry of list.getEntries()){if(state.longFrames.length===longLimit){state.drop.longFrames++;continue}const attribution=owner(entry);state.longFrames.push({startTime:entry.startTime,duration:entry.duration,phase:state.currentPhase,owner:attribution.category,scriptDuration:Number.isFinite(entry.scripts?.reduce((sum,item)=>sum+(item.duration||0),0))?entry.scripts.reduce((sum,item)=>sum+(item.duration||0),0):null,renderDuration:Number.isFinite(entry.renderStart)?Math.max(0,entry.startTime+entry.duration-entry.renderStart):null,styleAndLayoutDuration:Number.isFinite(entry.styleAndLayoutStart)?Math.max(0,entry.startTime+entry.duration-entry.styleAndLayoutStart):null,forcedStyleAndLayoutDuration:Number.isFinite(entry.scripts?.reduce((sum,item)=>sum+(item.forcedStyleAndLayoutDuration||0),0))?entry.scripts.reduce((sum,item)=>sum+(item.forcedStyleAndLayoutDuration||0),0):null,source:attribution.source,functionName:attribution.functionName})}});state.loafObserver.observe({type:'long-animation-frame'})}catch{state.loafObserver=null}}
return true})()`

export const fullLoadFrameProbeResultScript = () => `(()=>{const state=window.__dawFullLoadFrameProbe;if(!state)throw new Error('Full-load frame probe unavailable.');
state.active=false;cancelAnimationFrame(state.id);state.observer?.disconnect();state.loafObserver?.disconnect();delete window.__dawPerformanceBenchmark;delete window.__dawPerformancePhase;
const q=(values,f)=>{if(values.length===0)return null;const sorted=[...values].sort((a,b)=>a-b);const p=(sorted.length-1)*f;const lo=Math.floor(p),hi=Math.ceil(p);return lo===hi?sorted[lo]:sorted[lo]+(sorted[hi]-sorted[lo])*(p-lo)};
const stats=(values)=>({p50:q(values,.5),p95:q(values,.95),p99:q(values,.99),max:values.length?Math.max(...values):null});
const durationStats=Object.fromEntries(Object.entries(state.durations).map(([key,values])=>[key,{count:values.length,totalMs:values.reduce((sum,value)=>sum+value,0),p95Ms:q(values,.95),maxMs:values.length?Math.max(...values):null}]));
const thresholds=(values)=>({over8_33Ms:values.filter(v=>v>8.33).length,over16_67Ms:values.filter(v=>v>16.67).length,over33_3Ms:values.filter(v=>v>33.3).length,over50Ms:values.filter(v=>v>50).length});
const median=q(state.raf,.5);return {display:{refreshRateHz:median&&median>0?1000/median:null,viewportWidth:innerWidth,viewportHeight:innerHeight,devicePixelRatio},
raf:{sampleCount:state.raf.length,intervalsMs:stats(state.raf)},applicationWork:{sampleCount:state.work.length,durationMs:stats(state.work),thresholds:thresholds(state.work)},
longTasks:{supported:state.observer!==null,count:state.observer?state.long.length:null,totalDurationMs:state.observer?state.long.reduce((a,b)=>a+b,0):null,maxDurationMs:state.observer&&state.long.length?Math.max(...state.long):null},
droppedSamples:{raf:state.drop.raf,applicationWork:state.drop.work,longTasks:state.drop.long},
attribution:{phases:state.phases,longFrames:state.longFrames,counters:state.counters,durations:durationStats,droppedLongFrames:state.drop.longFrames}}})()`
export const matchesControlProjectUrl = (url: string, projectId: string) => {
  try {
    const parsed = new URL(url)
    return parsed.protocol === "daw:" && parsed.hostname === "app"
      && parsed.searchParams.get("projectId") === projectId
  } catch { return false }
}
type CdpTarget = { id: string; type: string; url: string; webSocketDebuggerUrl?: string }
export const selectedProjectCdpTarget = (targets: readonly CdpTarget[], projectId: string) => {
  const matches = targets.filter((target) => target.type === "page" && target.webSocketDebuggerUrl
    && matchesControlProjectUrl(target.url, projectId))
  return matches.length === 1 ? matches[0] ?? null : null
}
const probeProjectCdp = async (port: string, projectId: string): Promise<"responsive" | "target-absent" | "endpoint-mismatch" | "deadline" | "evaluation-failed"> => {
  const targets = z.array(z.object({ id: z.string(), type: z.string(), url: z.string(),
    webSocketDebuggerUrl: z.string().optional() }).passthrough()).max(64)
    .parse(await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3_000) })).json())
  const target = selectedProjectCdpTarget(targets, projectId)
  if (!target?.webSocketDebuggerUrl) return "target-absent"
  const url = new URL(target.webSocketDebuggerUrl)
  if (!["127.0.0.1", "localhost"].includes(url.hostname) || url.port !== port) return "endpoint-mismatch"
  return new Promise((resolve) => {
    const socket = new WebSocket(url)
    const deadline = setTimeout(() => { socket.close(); resolve("deadline") }, 3_000)
    socket.onopen = () => socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate",
      params: { expression: "location.href", returnByValue: true } }))
    socket.onmessage = (event) => {
      try {
        const message = z.object({ id: z.number().optional(), result: z.object({
          result: z.object({ value: z.string().optional() }).passthrough(),
        }).passthrough().optional() }).passthrough().parse(JSON.parse(String(event.data)))
        if (message.id !== 1) return
        clearTimeout(deadline)
        socket.close()
        resolve(matchesControlProjectUrl(message.result?.result.value ?? "", projectId) ? "responsive" : "evaluation-failed")
      } catch { clearTimeout(deadline); socket.close(); resolve("evaluation-failed") }
    }
    socket.onerror = () => { clearTimeout(deadline); socket.close(); resolve("evaluation-failed") }
  })
}
const pingProjectCdp = async (port: string, projectId: string) =>
  (await probeProjectCdp(port, projectId)) === "responsive"
export const parseBrowserProjectId = (output: string) => {
  const encoded = z.string().min(1).parse(JSON.parse(output))
  return z.string().regex(/^project:[A-Za-z0-9-]+$/).parse(JSON.parse(encoded))
}
const rows = async () => {
  const child = Bun.spawn(["ps", "-axo", "pid=,ppid=,pgid=,time=,command="], { stdout: "pipe" })
  const text = await new Response(child.stdout).text()
  return text.split("\n").flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/)
    if (!match) return []
    const [, pid, parentPid, processGroupId, cpuTime, command] = match
    const timeParts = cpuTime.split(":")
    const seconds = Number(timeParts.pop())
    const minutes = Number(timeParts.pop() ?? 0)
    const hours = Number(timeParts.pop() ?? 0)
    if (!Number.isFinite(hours) || !Number.isFinite(minutes) || !Number.isFinite(seconds)) return []
    return [{
      pid: Number(pid), parentPid: Number(parentPid), processGroupId: Number(processGroupId),
      cpuTimeSec: hours * 3600 + minutes * 60 + seconds, command,
    }]
  })
}
type ProcessRow = Awaited<ReturnType<typeof rows>>[number]
type ProcessIdentity = Pick<ProcessRow, "pid" | "parentPid" | "processGroupId" | "command">
type ProcessCpuDistribution = {
  samples: number
  averagePercent: number | null
  p95Percent: number | null
  peakPercent: number | null
}
type NativeProcessGeneration = {
  index: number
  startElapsedMs: number
  endElapsedMs: number
  audioHosts: ProcessIdentity[]
  workers: ProcessIdentity[]
  samples: number
  audioHostCpu: ProcessCpuDistribution
  aggregateWorkerCpu: ProcessCpuDistribution
  workersCpu: { generation: number; identity: ProcessIdentity; cpu: ProcessCpuDistribution }[]
}
type NativeProcessCpu = {
  status: "available" | "blocked"
  reason: string | null
  sampleIntervalMs: number
  durationMs: number
  expectedSamples: number
  actualSamples: number
  audioHosts: ProcessIdentity[]
  workers: ProcessIdentity[]
  audioHostCpu: ProcessCpuDistribution
  aggregateWorkerCpu: ProcessCpuDistribution
  workersCpu: { identity: ProcessIdentity; cpu: ProcessCpuDistribution }[]
  generations: NativeProcessGeneration[]
  identityLosses: { elapsedMs: number; expected: ProcessIdentity[]; observed: ProcessIdentity[] }[]
}
const processCpuDistribution = (values: readonly number[]): ProcessCpuDistribution => {
  if (values.length === 0) return { samples: 0, averagePercent: null, p95Percent: null, peakPercent: null }
  const sorted = [...values].sort((left, right) => left - right)
  const position = (sorted.length - 1) * 0.95
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  return {
    samples: values.length,
    averagePercent: values.reduce((sum, value) => sum + value, 0) / values.length,
    p95Percent: lower === upper ? sorted[lower]! : sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower),
    peakPercent: sorted.at(-1)!,
  }
}
const processIdentity = (row: ProcessRow): ProcessIdentity => ({
  pid: row.pid, parentPid: row.parentPid, processGroupId: row.processGroupId,
  command: row.command.trim().split(/\s+/)[0]!,
})
const createNativeProcessCpuSampler = async (
  appPid: number,
  durationMs: number,
  preferActiveWorkerGroup: boolean,
): Promise<{ stop: () => Promise<NativeProcessCpu> }> => {
  const sampleIntervalMs = 1_000
  const selectIdentities = (processes: readonly ProcessRow[]) => {
    const owned = new Set([appPid, ...descendantsOf(processes, appPid)])
    const hostCandidates = processes.filter((row) => owned.has(row.pid)
      && row.command.trim().split(/\s+/)[0]?.endsWith("/daw-audio-host-macos"))
    const workerCandidates = processes.filter((row) => owned.has(row.pid)
      && row.pid === row.processGroupId
      && row.command.trim().split(/\s+/)[0]?.endsWith("/daw-vst3-worker"))
    const hostIds = new Set(hostCandidates.map((row) => row.pid))
    const workersByHost = new Map<number, ProcessRow[]>()
    for (const worker of workerCandidates) {
      if (!hostIds.has(worker.parentPid)) continue
      const children = workersByHost.get(worker.parentPid) ?? []
      children.push(worker)
      workersByHost.set(worker.parentPid, children)
    }
    const activeWorkerGroup = [...workersByHost.values()].find((children) => children.length === 8)
    const singletonWorkers = [...workersByHost.values()].filter((children) => children.length === 1).map((children) => children[0]!)
    const selectedWorkers = preferActiveWorkerGroup
      ? activeWorkerGroup ?? []
      : singletonWorkers.length === 8 ? singletonWorkers : activeWorkerGroup ?? []
    const workerParentIds = new Set(selectedWorkers.map((row) => row.parentPid))
    const selectedHosts = hostCandidates.filter((row) => workerParentIds.has(row.pid))
    return selectedHosts.length > 0 && selectedWorkers.length === 8
      ? { audioHosts: selectedHosts.map(processIdentity), workers: selectedWorkers.map(processIdentity) }
      : null
  }
  const sameIdentities = (
    left: { audioHosts: ProcessIdentity[]; workers: ProcessIdentity[] } | null,
    right: { audioHosts: ProcessIdentity[]; workers: ProcessIdentity[] } | null,
  ) => JSON.stringify(left) === JSON.stringify(right)
  const stabilityDeadline = Date.now() + 15_000
  let identities: { audioHosts: ProcessIdentity[]; workers: ProcessIdentity[] } | null = null
  let stableSince = 0
  while (Date.now() < stabilityDeadline && (stableSince === 0 || Date.now() - stableSince < 3_000)) {
    const observed = selectIdentities(await rows())
    if (observed !== null && sameIdentities(observed, identities)) {
      if (stableSince === 0) stableSince = Date.now()
    } else {
      identities = observed
      stableSince = observed === null ? 0 : Date.now()
    }
    await delay(250)
  }
  if (stableSince === 0 || Date.now() - stableSince < 3_000) identities = null
  const base: NativeProcessCpu = {
    status: identities ? "available" : "blocked",
    reason: identities ? null : "Expected owned runner descendants containing one native host generation and eight active VST workers stable for 3 seconds.",
    sampleIntervalMs, durationMs, expectedSamples: Math.floor(durationMs / sampleIntervalMs), actualSamples: 0,
    audioHosts: identities?.audioHosts ?? [], workers: identities?.workers ?? [],
    audioHostCpu: processCpuDistribution([]),
    aggregateWorkerCpu: processCpuDistribution([]),
    workersCpu: identities?.workers.map((identity) => ({ generation: 0, identity, cpu: processCpuDistribution([]) })) ?? [],
    generations: [], identityLosses: [],
  }
  if (!identities) return { stop: async () => base }
  type ActiveGeneration = {
    index: number
    identities: { audioHosts: ProcessIdentity[]; workers: ProcessIdentity[] }
    startElapsedMs: number
    previous: Map<number, number>
    hostValues: number[]
    workerValues: Map<number, number[]>
    aggregateValues: number[]
    samples: number
  }
  const createGeneration = (
    nextIdentities: { audioHosts: ProcessIdentity[]; workers: ProcessIdentity[] },
    index: number,
    startElapsedMs: number,
  ): ActiveGeneration => ({
    index, identities: nextIdentities, startElapsedMs, previous: new Map(),
    hostValues: [], workerValues: new Map(nextIdentities.workers.map((identity) => [identity.pid, []])),
    aggregateValues: [], samples: 0,
  })
  const generationResults: NativeProcessGeneration[] = []
  const identityLosses: NativeProcessCpu["identityLosses"] = []
  const allHostValues: number[] = []
  const allAggregateWorkerValues: number[] = []
  let generation = createGeneration(identities, 0, 0)
  let actualSamples = 0
  let stopped = false
  let reason: string | null = null
  const startedAt = Date.now()
  const sample = async () => {
    const current = await rows()
    const currentByPid = new Map(current.map((row) => [row.pid, row]))
    const targets = [...generation.identities.audioHosts, ...generation.identities.workers]
    const valid = targets.every((identity) => {
      const row = currentByPid.get(identity.pid)
      return row !== undefined && row.command.trim().split(/\s+/)[0] === identity.command
        && row.parentPid === identity.parentPid && row.processGroupId === identity.processGroupId
    })
    if (!valid) {
      const elapsedMs = Math.max(0, Date.now() - startedAt)
      const nextIdentities = selectIdentities(current)
      identityLosses.push({
        elapsedMs, expected: targets,
        observed: nextIdentities ? [...nextIdentities.audioHosts, ...nextIdentities.workers] : [],
      })
      if (!nextIdentities) {
        reason = "An owned native process changed identity without a replacement generation."
        return
      }
      generationResults.push({
        index: generation.index, startElapsedMs: generation.startElapsedMs, endElapsedMs: elapsedMs,
        audioHosts: generation.identities.audioHosts, workers: generation.identities.workers, samples: generation.samples,
        audioHostCpu: processCpuDistribution(generation.hostValues),
        aggregateWorkerCpu: processCpuDistribution(generation.aggregateValues),
        workersCpu: generation.identities.workers.map((identity) => ({
          generation: generation.index, identity, cpu: processCpuDistribution(generation.workerValues.get(identity.pid) ?? []),
        })),
      })
      generation = createGeneration(nextIdentities, generation.index + 1, elapsedMs)
    }
    if (reason !== null) return
    const targetsForSample = [...generation.identities.audioHosts, ...generation.identities.workers]
    const elapsedMs = Math.max(1, Date.now() - startedAt)
    const currentCpu = new Map(targetsForSample.map((identity) => [identity.pid, currentByPid.get(identity.pid)!.cpuTimeSec]))
    if (generation.previous.size > 0) {
      const intervalMs = Math.max(1, elapsedMs - (generation.previous.get(-1) ?? 0))
      const hostsCpu = generation.identities.audioHosts.map((identity) => (
        (currentCpu.get(identity.pid)! - generation.previous.get(identity.pid)!) * 100_000 / intervalMs
      ))
      const workersCpu = generation.identities.workers.map((identity) => (
        (currentCpu.get(identity.pid)! - generation.previous.get(identity.pid)!) * 100_000 / intervalMs
      ))
      if (hostsCpu.some((value) => value < 0) || workersCpu.some((value) => value < 0)) {
        reason = "Native process CPU time moved backwards during sampling."
        return
      }
      generation.hostValues.push(hostsCpu.reduce((sum, value) => sum + value, 0))
      workersCpu.forEach((value, index) => generation.workerValues.get(generation.identities.workers[index]!.pid)!.push(value))
      generation.aggregateValues.push(workersCpu.reduce((sum, value) => sum + value, 0))
      allHostValues.push(hostsCpu.reduce((sum, value) => sum + value, 0))
      allAggregateWorkerValues.push(workersCpu.reduce((sum, value) => sum + value, 0))
      generation.samples += 1
      actualSamples += 1
    }
    currentCpu.set(-1, elapsedMs)
    currentCpu.forEach((value, pid) => generation.previous.set(pid, value))
  }
  const sampling = (async () => {
    // This bounded benchmark sampler is intentionally process-level polling; it is not product runtime logic.
    while (!stopped && Date.now() - startedAt < durationMs) {
      await sample()
      await delay(sampleIntervalMs)
    }
    await sample()
  })()
  const stop = async () => {
    stopped = true
    await sampling
    const elapsedMs = Math.max(0, Date.now() - startedAt)
    generationResults.push({
      index: generation.index, startElapsedMs: generation.startElapsedMs, endElapsedMs: elapsedMs,
      audioHosts: generation.identities.audioHosts, workers: generation.identities.workers, samples: generation.samples,
      audioHostCpu: processCpuDistribution(generation.hostValues),
      aggregateWorkerCpu: processCpuDistribution(generation.aggregateValues),
      workersCpu: generation.identities.workers.map((identity) => ({
        generation: generation.index, identity, cpu: processCpuDistribution(generation.workerValues.get(identity.pid) ?? []),
      })),
    })
    const allHosts = [...new Map(generationResults.flatMap((item) => item.audioHosts).map((identity) => [identity.pid, identity])).values()]
    const allWorkers = [...new Map(generationResults.flatMap((item) => item.workers).map((identity) => [identity.pid, identity])).values()]
    const finished = {
      ...base,
      status: reason === null && actualSamples >= Math.max(2, Math.floor(base.expectedSamples * 0.8)) ? "available" as const : "blocked" as const,
      reason: reason ?? (actualSamples >= Math.max(2, Math.floor(base.expectedSamples * 0.8)) ? null : "Insufficient complete native process CPU samples were collected."),
      actualSamples, audioHosts: allHosts, workers: allWorkers,
      audioHostCpu: processCpuDistribution(allHostValues),
      aggregateWorkerCpu: processCpuDistribution(allAggregateWorkerValues),
      workersCpu: generationResults.flatMap((item) => item.workersCpu),
      generations: generationResults, identityLosses,
    }
    return finished
  }
  return { stop }
}
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
const prepareFullDsp = async (session: string, profile: string, projectId: string, audioTrackNames: readonly string[],
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
const deriveActiveClipProject = async (
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
const runFullLoadUiStress = async (
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
const runZoomSweeps = async (session: string, projectActiveClipCount: number) => {
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
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await browserCommand(session, ["eval",
        `window.__dawFullLoadFrameProbe??(${fullLoadFrameProbeScript()});true`])
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
        if (attempt === 1) throw error
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
const command = async (profile: string, args: string[], input?: string) => {
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
const main = async () => {
  const output = Bun.argv[2]
  const mode = parseControlMode(Bun.argv[3])
  const profileScale = Bun.argv[4] === undefined ? undefined : z.coerce.number().int().parse(Bun.argv[4])
  const zoomVisibleClipLimit = mode === "vst-reliability"
    ? 30
    : profileScale === undefined ? 30 : z.number().int().min(10).max(30).parse(profileScale)
  const reliabilityVstCount = mode === "vst-reliability"
    ? z.number().int().min(0).max(8).parse(profileScale ?? 8)
    : 8
  const reliabilityStress = mode === "vst-reliability" && Bun.argv[5] === "zoom"
  const quietRecording = mode === "recording" || mode === "dsp-recording" || mode === "dsp-ui-recording"
    || mode === "zoom-recording-profile"
    || isMediaRecordingMode(mode)
  if (!output || !path.isAbsolute(output) || Bun.argv.length > (mode === "vst-reliability" ? 6 : 5))
    throw new Error("Usage: bun v3-import-acceptance.ts <absolute-result-path> [--quiet-recording|--idle-control|--playback-control|--ui-control|--paging-control|--dsp-control|--dsp-ui-control|--dsp-soak|--dsp-recording|--dsp-ui-recording]")
  if ((await stat(archive)).size < 773_000_000) throw new Error("Unexpected v3 archive size")
  await stat(path.join(root, "apps/desktop/out/@daw-browser-desktop-darwin-arm64/@daw-browser-desktop.app/Contents/Resources/app.asar"))
  const directory = await createPrivateRunDirectory("/tmp")
  const profile = path.join(directory, "profile")
  const diagnosticDirectory = `${output}.diagnostics`
  await mkdir(diagnosticDirectory, { recursive: true, mode: 0o700 })
  await mkdir(profile, { mode: 0o700 })
  const session = `daw-30-track-electron-v3-${crypto.randomUUID()}`
  let stage = "launch"
  let attached = false
  let endpoint = ""
  let originalTarget = ""
  let quietStartedAt = 0
  let quietElapsedMs = 0
  let recordingZoomProfile: Awaited<ReturnType<typeof runZoomSweeps>> | null = null
  let beforeCaptureProcesses: Awaited<ReturnType<typeof rows>> = []
  let afterCaptureProcesses: Awaited<ReturnType<typeof rows>> = []
  let originalTargetAlive: boolean | null = null
  let reconnectSucceeded = false
  let directCdpResponsive: boolean | null = null
  let stopPresent: boolean | null = null
  let stopSucceeded = false
  let lifecycle = ""
  let vstReliability = ""
  let metricOutput = ""
  let healthOutput = ""
  let outputLine = ""
  let controlStartedAtMs = 0
  let rendererPid = 0
  let cdpError: string | null = null
  let interruptedSignal: NodeJS.Signals | null = null
  let targetsAfter: { type: string; urlClass: string; original: boolean }[] = []
  let nativeProcessCpuSampler: Awaited<ReturnType<typeof createNativeProcessCpuSampler>> | null = null
  const app = spawn(executable, ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", `--user-data-dir=${profile}`], {
    cwd: root, env: { ...process.env, DAW_DESKTOP_USER_DATA: profile, DAW_BENCHMARK_SAB_RECORDING: quietRecording && mode !== "media-recording-portable" ? "1" : "0",
      DAW_BENCHMARK_QUIET_CAPTURE: mode !== "acceptance" ? "1" : "0",
      DAW_BENCHMARK_ZOOM_PROFILE: mode === "zoom-profile" || mode === "zoom-recording-profile" ? "1" : "0",
      DAW_BENCHMARK_HEARTBEAT: mode.includes("media-recording-probe") ? "1" : "0",
      DAW_BENCHMARK_RECORDING_FORWARD_MODE: recordingForwardMode(mode),
      DAW_BENCHMARK_RECORDING_SUPPRESS_CHANNEL: mode === "media-recording-probe-drop-no-meters" ? "meter-batch" : "",
      DAW_BENCHMARK_VST_RELIABILITY: mode === "vst-reliability" ? "1" : "0" }, detached: true, stdio: ["ignore", "pipe", "pipe"],
  })
  let appOutput = ""
  const collectOutput = (chunk: Buffer) => {
    const text = chunk.toString()
    appOutput = (appOutput + text).slice(-3000)
    const lines = (outputLine + text).split(/\r?\n/)
    outputLine = (lines.pop() ?? "").slice(-512)
    for (const line of lines) {
      if (line.includes("[quiet-capture-lifecycle]") || line.includes("[quiet-capture-native]")
        || line.includes("[quiet-renderer-ping]") || line.includes("[quiet-renderer-pong]")
        || line.includes("[quiet-renderer-block-cost]")
        || line.includes("[quiet-block-sent]") || line.includes("[quiet-block-transit]")
        || line.includes("[quiet-recording-ipc]")
        || line.includes("native audio host closed"))
        lifecycle = (lifecycle + line.slice(0, line.includes("[quiet-recording-ipc]") ? 2048 : 512) + "\n")
          .slice(mode.includes("media-recording-probe") ? -32000 : -4000)
      const reliabilityMarker = line.indexOf("[vst-reliability]")
      if (reliabilityMarker >= 0)
        vstReliability = (vstReliability + line.slice(reliabilityMarker, reliabilityMarker + 1024) + "\n").slice(-64_000)
      if (line.startsWith("[quiet-renderer-metric]"))
        metricOutput = (metricOutput + line.slice(0, 512) + "\n").slice(-128_000)
      if (line.startsWith("[quiet-renderer-health]"))
        healthOutput = (healthOutput + line.slice(0, 512) + "\n").slice(-16_000)
    }
  }
  app.stdout?.on("data", collectOutput)
  app.stderr?.on("data", collectOutput)
  if (!app.pid) throw new Error("No Electron PID")
  let plan: ReturnType<typeof createCleanupPlan> | undefined
  let cleanupPromise: Promise<Awaited<ReturnType<typeof cleanupOwnedRunDirectory>>> | null = null
  const cleanupRun = () => {
    if (cleanupPromise) return cleanupPromise
    cleanupPromise = (async () => {
      if (attached) await browserCommand(session, ["close"]).catch(() => undefined)
      const current = await rows()
      const owned = current.find((row) => row.pid === app.pid && row.command.includes(executable)
        && row.command.includes(`--user-data-dir=${profile}`))
      const ownedPlan = plan ?? (owned ? createCleanupPlan(current, app.pid) : undefined)
      if (owned && ownedPlan?.processGroupId === owned.processGroupId && ownedPlan.processGroupId !== process.pid) {
        process.kill(-ownedPlan.processGroupId, "SIGTERM")
        await delay(1000)
        for (const pid of cleanupSurvivors(ownedPlan, await rows())) process.kill(pid, "SIGKILL")
      }
      return cleanupOwnedRunDirectory(directory, await rows())
    })()
    return cleanupPromise
  }
  const interrupt = (signal: NodeJS.Signals) => {
    interruptedSignal = signal
    void cleanupRun().then((cleanup) => {
      if (!cleanup.removed) {
        const cleanupPath = `${output}.cleanup.json`
        return writePrivateArtifact(cleanupPath, JSON.stringify({ cleanup, interruptedSignal }, null, 2))
      }
    }).finally(() => process.exit(128 + (signal === "SIGINT" ? 2 : 15)))
  }
  const interruptSigint = () => interrupt("SIGINT")
  const interruptSigterm = () => interrupt("SIGTERM")
  process.once("SIGINT", interruptSigint)
  process.once("SIGTERM", interruptSigterm)
  const telemetry = () => {
    const metrics = metricOutput.split("\n").flatMap((line) => {
      try {
        return [z.object({ elapsedMs: z.number(), epochMs: z.number(), pid: z.number(), renderer: z.boolean(),
          type: z.string(),
          workingSetKiB: z.number(), peakWorkingSetKiB: z.number(),
          privateKiB: z.number().nullable(), cpuPercent: z.number() })
          .parse(JSON.parse(line.slice("[quiet-renderer-metric] ".length)))]
      } catch { return [] }
    })
    const rendererMetrics = metrics.filter((metric) => metric.renderer)
    const events = healthOutput.split("\n").flatMap((line) => {
      try {
        return [z.object({ elapsedMs: z.number(), name: z.string(), pid: z.number(),
          urlClass: z.string(), reason: z.string() })
          .parse(JSON.parse(line.slice("[quiet-renderer-health] ".length)))]
      } catch { return [] }
    })
    const startAtMs = rendererMetrics.find((metric) => metric.epochMs >= controlStartedAtMs)?.elapsedMs ?? 0
    return { rendererMetrics: summarizeRendererMetrics(rendererMetrics, rendererMetrics.at(-1)?.pid ?? 0, startAtMs),
      rendererEvents: boundedRendererEvents(events), rendererSamples: metrics.slice(-120) }
  }
  try {
    for (let i = 0; i < 30 && !endpoint; i++) {
      try {
        const [portText, capability] = (await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).trim().split(/\r?\n/)
        const port = Number(portText)
        const listener = Bun.spawn(["lsof", "-nP", `-iTCP@127.0.0.1:${port}`, "-sTCP:LISTEN", "-t"], { stdout: "pipe" })
        const pids = (await new Response(listener.stdout).text()).trim().split(/\s+/).map(Number)
        const url = `ws://127.0.0.1:${port}${capability}`
        const processes = await rows()
        const identity = verifyElectronLaunchIdentity({ rootPid: app.pid, executablePath: executable, profilePath: profile, port, listenerPids: pids, processes, websocketUrl: url })
        if (!identity.verified) throw new Error(identity.reason)
        plan = createCleanupPlan(processes, app.pid)
        if (!plan) throw new Error("No owned process group")
        endpoint = url
      } catch { await delay(1000) }
    }
    if (!endpoint || !plan) throw new Error("Owned CDP endpoint unavailable")
    if (process.env.DAW_BENCHMARK_FORCE_FAILURE === "after-launch") {
      throw new Error("Forced benchmark failure after verified launch.")
    }
    await browserCommand(session, ["connect", endpoint])
    attached = true
    let target: string | undefined
    let lastTabs = ""
    for (let i = 0; i < 30 && !target; i++) {
      lastTabs = await browserCommand(session, ["tab"])
      target = electronRendererTarget(lastTabs)?.targetId
      if (!target) await delay(1000)
    }
    if (!target) throw new Error(`Renderer unavailable: ${lastTabs.slice(0, 1000)}; app: ${appOutput}`)
    originalTarget = target
    await browserCommand(session, ["tab", target])
    if ((await browserCommand(session, ["get", "url"])) !== (electronRendererTarget(await browserCommand(session, ["tab"]))?.url)) {
      throw new Error("Renderer identity mismatch")
    }
    stage = "upload"
    await waitForBrowserValue(session, "document.querySelector(\"input[accept='.dawproject,application/vnd.dawproject,application/zip']\") ? true : null", 30000)
    await browserCommand(session, ["upload", "input[accept='.dawproject,application/vnd.dawproject,application/zip']", archive])
    stage = "import"
    const projectId = parseBrowserProjectId(await waitForBrowserValue(session, "new URL(location.href).searchParams.get('projectId') && document.querySelector('[data-timeline-ruler=\"1\"]') ? new URL(location.href).searchParams.get('projectId') : null", 180000))
    await waitForBrowserValue(session, "document.querySelectorAll('[aria-label^=\"Select track \"]').length === 30 ? true : null", 60_000)
    let snapshot = assertArchiveSnapshot(projectSnapshotSchemaV2.parse(await command(profile, ["snapshot-v2", projectId, "--target", "host"])))
    if (mode === "zoom-profile" || mode === "zoom-recording-profile") {
      snapshot = await deriveActiveClipProject(profile, snapshot, zoomVisibleClipLimit)
    }
    let pagingSetup: { clipId: string; timelineStartSec: number; sourceOffsetSec: number; durationSec: number } | null = null
    if (mode === "paging") {
      stage = "paging-setup"
      const request = createLaterOffsetPagingRequest(snapshot)
      const preview = controlPreviewResultSchemaV1.parse(await command(
        profile,
        ["preview", "--request", "-", "--target", "host"],
        JSON.stringify(request),
      ))
      if (preview.approval?.required) throw new Error("Later-offset paging setup unexpectedly requires approval.")
      controlCommitResultSchemaV1.parse(await command(
        profile,
        ["commit", "--request", "-", "--target", "host"],
        JSON.stringify({ ...request, idempotencyKey: `v3-paging-${crypto.randomUUID()}` }),
      ))
      const moved = projectSnapshotSchemaV2.parse(await command(profile, ["snapshot-v2", projectId, "--target", "host"]))
      const clipId = request.actions[0].clip.id
      const clip = moved.clips.find((entry) => entry.id === clipId)
      if (!clip || clip.startSec !== 540 || clip.bufferOffsetSec !== 540 || clip.duration !== 60) {
        throw new Error("Later-offset paging clip did not persist.")
      }
      pagingSetup = { clipId, timelineStartSec: 540, sourceOffsetSec: 540, durationSec: 60 }
    }
    if (isMediaRecordingMode(mode)) {
      stage = "media-only-setup"
      for (let index = 25; index <= 30; index++) {
        await browserCommand(session, ["eval", `(()=>{const button=document.querySelector('button[aria-label="Deactivate track ${index}"]');if(!(button instanceof HTMLButtonElement))throw new Error('MIDI track mute control unavailable.');button.click();return true})()`])
      }
      const muted = projectSnapshotSchemaV2.parse(await command(profile, ["snapshot-v2", projectId, "--target", "host"]))
      if (muted.tracks.filter((track) => track.kind === "instrument" && track.muted).length !== 6)
        throw new Error("Six MIDI tracks were not muted for media-only recording.")
    }
    let dspSetup: Awaited<ReturnType<typeof prepareFullDsp>> | null = null
    if (mode === "idle" || isDspControlMode(mode) || mode === "dsp-recording" || mode === "dsp-ui-recording"
      || mode === "zoom-recording-profile") {
      stage = "dsp-setup"
      const instanceCount = mode === "dsp-one" ? 1 : mode === "vst-reliability" ? reliabilityVstCount : 8
      if (instanceCount > 0) {
        dspSetup = await prepareFullDsp(session, profile, projectId,
          snapshot.tracks.filter((track) => track.kind === "audio").map((track) => track.name), instanceCount,
          mode !== "vst-reliability" || process.env.DAW_BENCHMARK_VST_AUTOMATION === "1")
      }
    }
    if (mode === "idle") {
      stage = "idle-control"
      controlStartedAtMs = Date.now()
      nativeProcessCpuSampler = await createNativeProcessCpuSampler(app.pid, 60_000, false)
      await delay(60_000)
      stage = "idle-verify"
      const responsive = await pingProjectCdp(new URL(endpoint).port, projectId)
      if (!responsive) throw new Error("Idle project renderer URL changed.")
      const diagnostics = desktopDiagnosticsSchemaV2.parse(await command(profile, ["host", "diagnostics-v2"]))
      const nativeProcessCpu = await nativeProcessCpuSampler.stop()
      await writePrivateArtifact(output, JSON.stringify({
        status: "complete", mode, responsive, projectId, lifecycle, tracks: snapshot.tracks.length,
        dspSetup, workerPids: nativeProcessCpu.workers, nativeProcessCpu,
        realtimePerformance: diagnostics.native.status === "available"
          ? diagnostics.native.diagnostics.realtimePerformance ?? null : null,
        vstWorkerPerformance: diagnostics.native.status === "available"
          ? diagnostics.native.diagnostics.vstWorkerPerformance ?? null : null,
        ...telemetry(),
      }, null, 2))
      return
    }
    stage = "playback"
    await browserCommand(session, ["reload"])
    await waitForBrowserValue(session, "document.querySelector('button[aria-label=\"Play\"]') && !document.querySelector('[role=\"dialog\"]') ? true : null", 60_000)
    const pagingSeek = mode === "paging"
      ? desktopTransportStatusSchemaV1.parse(await command(profile, ["host", "seek", "540"]))
      : null
    if (pagingSeek && pagingSeek.playheadSec !== 540) throw new Error("Later-offset transport seek was not applied.")
    const before = desktopDiagnosticsSchemaV2.parse(await command(profile, ["host", "diagnostics-v2"]))
    await browserCommand(session, ["find", "role", "button", "click", "--name", "Play"])
    await waitForBrowserValue(session, "document.querySelector('button[aria-label=\"Pause\"]') ? true : null", 30000)
    await delay(mode === "vst-reliability" ? 500 : 4000)
    const playing = desktopTransportStatusSchemaV1.parse(await command(profile, ["host", "transport-status"]))
    const after = desktopDiagnosticsSchemaV2.parse(await command(profile, ["host", "diagnostics-v2"]))
    if (!isDspControlMode(mode) && mode !== "dsp-recording" && mode !== "dsp-ui-recording"
      && mode !== "zoom-recording-profile"
      && (playing.state !== "playing" || after.native.status !== "available" ||
      !playbackCountersValid(before.native.status === "available" ? before.native.diagnostics : null, after.native.diagnostics)))
      throw new Error(`Playback callbacks missing or native blocks rejected: ${JSON.stringify({
        state: playing.state, before: before.native.status === "available" ? before.native.diagnostics.callbacks : null,
        after: after.native.status === "available" ? after.native.diagnostics.callbacks : null,
        rejected: after.native.status === "available" ? after.native.diagnostics.rejectedBlocks : null,
      })}`)
    if (mode === "playback" || mode === "ui" || mode === "paging" || isDspControlMode(mode)) {
      stage = `${mode}-control`
      let framePerformance: z.infer<typeof fullLoadFramePerformanceSchema> | null = null
      let zoomProfile: Awaited<ReturnType<typeof runZoomSweeps>> | null = null
      const transportDrift: { elapsedMs: number; transportFrame: string; expectedFrame: string; errorFrames: string }[] = []
      const transportBaseline = mode === "dsp-soak"
        ? desktopDiagnosticsSchemaV2.parse(await command(profile, ["host", "diagnostics-v2"])) : null
      controlStartedAtMs = Date.now()
      nativeProcessCpuSampler = await createNativeProcessCpuSampler(app.pid, controlDurationMs(mode), true)
      if (isUiStressMode(mode) || mode === "zoom-profile" || reliabilityStress) {
        await browserCommand(session, ["eval", fullLoadFrameProbeScript()])
        if (reliabilityStress) zoomProfile = await runZoomSweeps(session, snapshot.clips.length)
        else await runFullLoadUiStress(session, snapshot, dspSetup)
        if (isDspControlMode(mode)) {
          for (let attempt = 0; attempt < 60; attempt++) {
            const recovered = desktopDiagnosticsSchemaV2.parse(await command(profile, ["host", "diagnostics-v2"]))
            if (recovered.native.status === "available"
              && BigInt(recovered.native.diagnostics.realtimePerformance?.observationCount ?? "0") > 0n) break
            if (attempt === 59) throw new Error("Native playback did not recover after UI interactions.")
            await delay(250)
          }
        }
      }
      if (mode === "zoom-profile") {
        await browserCommand(session, ["eval", fullLoadFrameProbeScript()])
        zoomProfile = await runZoomSweeps(session, snapshot.clips.length)
      }
      if (mode === "dsp-soak" && transportBaseline?.native.status === "available"
        && transportBaseline.native.diagnostics.transportFrame !== undefined) {
        const startFrame = BigInt(transportBaseline.native.diagnostics.transportFrame)
        for (const targetMs of [10_000, 60_000, 300_000]) {
          const remainingMs = targetMs - (Date.now() - controlStartedAtMs)
          if (remainingMs > 0) await delay(remainingMs)
          const checkpoint = desktopDiagnosticsSchemaV2.parse(await command(profile, ["host", "diagnostics-v2"]))
          if (checkpoint.native.status !== "available"
            || checkpoint.native.diagnostics.transportFrame === undefined) {
            throw new Error("Native transport drift checkpoint unavailable.")
          }
          const elapsedMs = Date.now() - controlStartedAtMs
          const transportFrame = BigInt(checkpoint.native.diagnostics.transportFrame)
          const sampleRate = BigInt(checkpoint.native.diagnostics.realtimePerformance?.sampleRateHz ?? 0)
          const expectedFrame = startFrame + BigInt(Math.round(elapsedMs)) * sampleRate / 1_000n
          transportDrift.push({
            elapsedMs,
            transportFrame: transportFrame.toString(),
            expectedFrame: expectedFrame.toString(),
            errorFrames: (transportFrame - expectedFrame).toString(),
          })
        }
      } else {
        const remainingMs = controlDurationMs(mode) - (Date.now() - controlStartedAtMs)
        if (remainingMs > 0) await delay(remainingMs)
      }
      if (isUiStressMode(mode) || mode === "zoom-profile" || reliabilityStress) {
        framePerformance = fullLoadFramePerformanceSchema.parse(
          JSON.parse(JSON.parse(await browserCommand(session, ["eval", `JSON.stringify(${fullLoadFrameProbeResultScript()})`]))),
        )
      }
      stage = "playback-verify"
      const nativeProcessCpu = await nativeProcessCpuSampler.stop()
      const responsive = await pingProjectCdp(new URL(endpoint).port, projectId)
      if (!responsive) throw new Error("Playback project renderer URL changed.")
      const vst = isDspControlMode(mode)
        ? desktopHostVstInstancesResultSchemaV1.parse(await command(profile, ["host", "vst-instances", projectId])) : null
      const workerPids = nativeProcessCpu.workers
      let finalNativeCallbacks = after.native.status === "available" ? after.native.diagnostics.callbacks : null
      let realtimePerformance = after.native.status === "available"
        ? after.native.diagnostics.realtimePerformance ?? null : null
      let vstWorkerPerformance = after.native.status === "available"
        ? after.native.diagnostics.vstWorkerPerformance ?? null : null
      let transportFrame = after.native.status === "available"
        ? after.native.diagnostics.transportFrame ?? null : null
      if (isDspControlMode(mode)) {
        let finalNative = desktopDiagnosticsSchemaV2.parse(await command(profile, ["host", "diagnostics-v2"]))
        for (let attempt = 0; finalNative.native.status !== "available" && attempt < 20; attempt += 1) {
          await delay(250)
          finalNative = desktopDiagnosticsSchemaV2.parse(await command(profile, ["host", "diagnostics-v2"]))
        }
        if (finalNative.native.status !== "available"
          || BigInt(finalNative.native.diagnostics.realtimePerformance?.observationCount ?? "0") === 0n
          || finalNative.native.diagnostics.rejectedBlocks !== 0) {
          throw new Error(`Full DSP playback native health failed: ${JSON.stringify({
            status: finalNative.native.status,
            callbacks: finalNative.native.status === "available" ? finalNative.native.diagnostics.callbacks : null,
          })}`)
        }
        finalNativeCallbacks = finalNative.native.diagnostics.callbacks
        realtimePerformance = finalNative.native.diagnostics.realtimePerformance ?? null
        vstWorkerPerformance = finalNative.native.diagnostics.vstWorkerPerformance ?? null
        transportFrame = finalNative.native.diagnostics.transportFrame ?? null
        if (!realtimePerformance || !vstWorkerPerformance
          || BigInt(realtimePerformance.deadlineMisses) !== 0n
          || BigInt(vstWorkerPerformance.deadlineMisses) !== 0n
          || BigInt(vstWorkerPerformance.watchdogMisses) !== 0n
          || BigInt(vstWorkerPerformance.faults) !== 0n
          || BigInt(vstWorkerPerformance.restarts) !== 0n) {
          throw new Error("Full DSP realtime deadline health failed.")
        }
      }
      if (nativeProcessCpu.status === "available" && nativeProcessCpu.generations.length > 1
        && (!vstWorkerPerformance
          || BigInt(vstWorkerPerformance.faults) !== 0n
          || BigInt(vstWorkerPerformance.restarts) !== 0n)) {
        nativeProcessCpu.status = "blocked"
        nativeProcessCpu.reason = "Native process generations changed while worker fault or restart counters were nonzero."
      }
      const expectedReadyVstWorkers = mode === "vst-reliability" ? reliabilityVstCount : dspSetup?.processors
      if (vst && vst.instances.filter((instance) => instance.health.state === "ready").length !== expectedReadyVstWorkers)
        throw new Error("Expected live VST instances were not available after measured playback.")
      await writePrivateArtifact(output, JSON.stringify({ status: "complete", mode, responsive, projectId, lifecycle,
        vstReliability: vstReliability.trim().split("\n").filter(Boolean), ...telemetry(), dspSetup, pagingSetup,
        framePerformance,
        zoomSweeps: zoomProfile?.gestures ?? [],
        zoomMemoryCheckpoints: zoomProfile?.memoryCheckpoints ?? [],
        transportDrift,
        pagingSeek, playing,
        transportFrame, realtimePerformance, vstWorkerPerformance,
        vstInstances: vst?.instances.length ?? 0, workerPids, nativeProcessCpu,
        rejectedBlocks: after.native.status === "available" ? after.native.diagnostics.rejectedBlocks
          - (before.native.status === "available" ? before.native.diagnostics.rejectedBlocks : 0) : null,
        nativeCallbacksBefore: before.native.status === "available" ? before.native.diagnostics.callbacks : null,
        nativeCallbacksAfter: finalNativeCallbacks }, null, 2))
      return
    }
    let recordingResult: object | null = null
    if (quietRecording) {
      const audioTrack = snapshot.tracks.find((track) => track.kind === "audio")
      if (!audioTrack) throw new Error("No audio track to record.")
      const audioIndex = snapshot.tracks.filter((track) => track.kind === "audio").findIndex((track) => track.id === audioTrack.id) + 1
      stage = "quiet-recording"
      await browserCommand(session, ["find", "role", "button", "click", "--name", `Arm track ${audioIndex} for recording`])
      const recordingBefore = desktopDiagnosticsSchemaV2.parse(await command(profile, ["host", "diagnostics-v2"]))
      const started = performance.now()
      beforeCaptureProcesses = await rows()
      rendererPid = Number(/stage=loaded rendererPid=(\d+)/.exec(lifecycle)?.[1] ?? 0)
      await writePrivateArtifact(path.join(diagnosticDirectory, "quiet-identity.json"), JSON.stringify({
        mainPid: app.pid, rendererPid, processGroupId: plan.processGroupId,
        webContentsId: Number(/stage=created webContentsId=(\d+)/.exec(lifecycle)?.[1] ?? 0),
        targetId: originalTarget, profile, port: new URL(endpoint).port,
        owned: beforeCaptureProcesses.filter((row) => plan.recordedProcesses.some((entry) => entry.pid === row.pid))
          .map(({ pid, parentPid }) => ({ pid, parentPid })),
      }))
      if (mode === "dsp-ui-recording" || mode === "zoom-recording-profile") {
        await command(profile, ["host", "stop"])
        await command(profile, ["host", "seek", "0"])
      }
      await quietCapture({
        start: async () => {
          stage = "quiet-start"
          await browserCommand(session, ["eval", "window.__dawPerformancePhase?.('recording-start',true)??true"])
          await browserCommand(session, ["find", "role", "button", "click", "--name", "Start recording"])
          await browserCommand(session, ["eval", "window.__dawPerformancePhase?.('recording-start',false)??true"])
          quietStartedAt = Date.now()
          controlStartedAtMs = quietStartedAt
          stage = "quiet-wait"
        },
        wait: async () => {
          if (mode === "dsp-ui-recording" || mode === "zoom-recording-profile") {
            await browserCommand(session, ["eval", fullLoadFrameProbeScript()])
            if (mode === "zoom-recording-profile") recordingZoomProfile = await runZoomSweeps(session, snapshot.clips.length)
            else await runFullLoadUiStress(session, snapshot, dspSetup, true)
            const remainingMs = 61_000 - (Date.now() - quietStartedAt)
            if (remainingMs > 0) await delay(remainingMs)
            return
          }
          if (!mode.includes("media-recording-probe")) return delay(61_000)
          const probeResults: { elapsedMs: number; result: string; latencyMs: number }[] = []
          for (let index = 0; index < 12; index++) {
            await delay(5_000)
            const started = performance.now()
            let result: string
            try { result = await probeProjectCdp(new URL(endpoint).port, projectId) }
            catch { result = "evaluation-failed" }
            probeResults.push({ elapsedMs: Date.now() - quietStartedAt, result,
              latencyMs: Math.round(performance.now() - started) })
          }
          await writePrivateArtifact(path.join(diagnosticDirectory, "diagnostic-cdp-latencies.json"), JSON.stringify(probeResults))
        },
        stop: async () => {
          stage = "quiet-stop"
          await browserCommand(session, ["eval", "window.__dawPerformancePhase?.('recording-stop',true)??true"])
          quietElapsedMs = Date.now() - quietStartedAt
          afterCaptureProcesses = await rows()
          const port = new URL(endpoint).port
          try {
            const targets = z.array(z.object({ id: z.string(), type: z.string(), url: z.string() }).passthrough()).max(64)
              .parse(await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3_000) })).json())
            originalTargetAlive = targets.some((item) => item.id === originalTarget && item.url.startsWith("daw://app/"))
            targetsAfter = targets.slice(0, 16).map((item) => ({
              type: item.type,
              urlClass: item.url.startsWith("daw://app/") ? "app" : "other",
              original: item.id === originalTarget,
            }))
          } catch (error) { originalTargetAlive = false; cdpError = error instanceof Error ? error.name : "unknown" }
          await writePrivateArtifact(path.join(diagnosticDirectory, "quiet-after-wait.json"), JSON.stringify({
            elapsedMs: quietElapsedMs,
            mainAlive: afterCaptureProcesses.some((row) => row.pid === app.pid),
            rendererAlive: rendererPid > 0 && afterCaptureProcesses.some((row) => row.pid === rendererPid),
            originalTargetAlive, cdpError, targetsAfter,
            lifecycle: lifecycle.slice(-2000),
          }))
          let directProbe: Awaited<ReturnType<typeof probeProjectCdp>>
          try { directProbe = await probeProjectCdp(port, projectId) }
          catch { directProbe = "evaluation-failed" }
          directCdpResponsive = directProbe === "responsive"
          cdpError = directProbe === "responsive" ? null : directProbe
          const activeSession = await recoverQuietTarget({
            original: () => browserCommand(session, ["get", "url"]),
            reconnect: async () => {
              await browserCommand(session, ["connect", endpoint])
              const candidate = importedProjectTarget(await browserCommand(session, ["tab"]), projectId)
              if (!candidate) throw new Error("Verified app target unavailable")
              await browserCommand(session, ["tab", candidate])
              return browserCommand(session, ["get", "url"])
            },
          }, projectId)
          reconnectSucceeded = activeSession.recovered
          stopPresent = (await browserCommand(session, ["eval", "document.querySelector('button[aria-label=\"Stop recording\"]') !== null"])).trim() === "true"
          if (!stopPresent) throw new Error("Stop recording absent after quiet interval.")
          await browserCommand(session, ["find", "role", "button", "click", "--name", "Stop recording"])
          stopSucceeded = true
          await browserCommand(session, ["eval", "window.__dawPerformancePhase?.('recording-stop',false)??true"])
          stage = "quiet-observe"
        },
        observe: async () => {
          const completed = desktopDiagnosticsSchemaV2.parse(await command(profile, ["host", "diagnostics-v2"]))
          let persisted = projectSnapshotSchemaV2.parse(await command(profile, ["snapshot-v2", projectId, "--target", "host"]))
          // The recording clip commit follows writer finalization asynchronously; bound observation to ten seconds.
          for (let attempt = 0; attempt < 40 && persisted.clips.length === snapshot.clips.length; attempt++) {
            await delay(250)
            persisted = projectSnapshotSchemaV2.parse(await command(profile, ["snapshot-v2", projectId, "--target", "host"]))
          }
          const newClips = persisted.clips.filter((clip) => !snapshot.clips.some((previous) => previous.id === clip.id)
            && clip.trackId === audioTrack.id && clip.source?.sourceKind === "recording")
          const capturedFrames = (completed.recording.capturedFrames ?? 0) - (recordingBefore.recording.capturedFrames ?? 0)
          const realtimePerformance = completed.native.status === "available"
            ? completed.native.diagnostics.realtimePerformance ?? null : null
          const vstWorkerPerformance = completed.native.status === "available"
            ? completed.native.diagnostics.vstWorkerPerformance ?? null : null
          if (performance.now() - started < 60_000 || capturedFrames < 58 * (completed.recording.activeSampleRate ?? 0)
            || !completed.recording.activeSampleRate || completed.recording.droppedFrames !== 0
            || completed.recording.overrunFrames !== 0 || completed.recording.lastFailurePresent
            || ((mode === "dsp-ui-recording" || mode === "zoom-recording-profile")
              && (!realtimePerformance || !vstWorkerPerformance
              || BigInt(realtimePerformance.deadlineMisses) !== 0n
              || BigInt(vstWorkerPerformance.deadlineMisses) !== 0n
              || BigInt(vstWorkerPerformance.watchdogMisses) !== 0n
              || BigInt(vstWorkerPerformance.faults) !== 0n || BigInt(vstWorkerPerformance.restarts) !== 0n))
            || completed.recording.peakSabWriterOccupancy > 8 || newClips.length !== 1) {
            throw new Error(`Quiet capture failed: ${JSON.stringify({
              capturedFrames, sampleRate: completed.recording.activeSampleRate,
              droppedFrames: completed.recording.droppedFrames,
              peakOccupancy: completed.recording.peakSabWriterOccupancy,
              failure: completed.recording.lastFailurePresent, newClips: newClips.length,
            })}`)
          }
          recordingResult = { capturedFrames, sampleRate: completed.recording.activeSampleRate,
            droppedFrames: completed.recording.droppedFrames, peakOccupancy: completed.recording.peakSabWriterOccupancy,
            clipId: newClips[0]?.id, writerTiming: completed.recording.writerTiming,
            transportFrame: completed.native.status === "available"
              ? completed.native.diagnostics.transportFrame ?? null : null,
            realtimePerformance, vstWorkerPerformance,
            zoomSweeps: recordingZoomProfile?.gestures ?? [],
            zoomMemoryCheckpoints: recordingZoomProfile?.memoryCheckpoints ?? [],
            framePerformance: mode === "dsp-ui-recording" || mode === "zoom-recording-profile"
              ? fullLoadFramePerformanceSchema.parse(JSON.parse(JSON.parse(await browserCommand(
                session,
                ["eval", `JSON.stringify(${fullLoadFrameProbeResultScript()})`],
              )))) : null }
        },
      })
    }
    await command(profile, ["host", "stop"])
    await mkdir(path.dirname(output), { recursive: true })
    await writePrivateArtifact(output, JSON.stringify({ status: "complete", archive, projectId: snapshot.project.id, tracks: snapshot.tracks.length, clips: snapshot.clips.length, assets: snapshot.assets.length, midiNotes: countMidiNotes(snapshot.clips), nativeCallbacksBefore: before.native.status === "available" ? before.native.diagnostics.callbacks : null, nativeCallbacksAfter: after.native.status === "available" ? after.native.diagnostics.callbacks : null, rejectedBlocks: after.native.status === "available" ? after.native.diagnostics.rejectedBlocks - (before.native.status === "available" ? before.native.diagnostics.rejectedBlocks : 0) : null, recording: recordingResult }, null, 2))
  } catch (error) {
    await mkdir(path.dirname(output), { recursive: true })
    let samplePath: string | null = null
    if (quietElapsedMs >= 60_000 && rendererPid > 0 && afterCaptureProcesses.some((row) => row.pid === rendererPid)) {
      const sample = Bun.spawn(["sample", String(rendererPid), "5", "-file", path.join(diagnosticDirectory, "quiet-renderer-sample.txt")], {
        stdout: "ignore", stderr: "pipe",
      })
      await Promise.race([sample.exited, delay(8_000)])
      if (sample.exitCode === null) sample.kill()
      if (sample.exitCode === 0) samplePath = path.join(diagnosticDirectory, "quiet-renderer-sample.txt")
    }
    await writePrivateArtifact(output, JSON.stringify({
      status: "failed", stage, error: String(error),
      quietCaptureStarted: quietStartedAt > 0, quietCaptureElapsedMs: quietElapsedMs,
      processesBefore: beforeCaptureProcesses.filter((row) => plan?.recordedProcesses.some((entry) => entry.pid === row.pid)).map(({ pid, parentPid, processGroupId }) => ({ pid, parentPid, processGroupId })),
      processesAfter: afterCaptureProcesses.filter((row) => plan?.recordedProcesses.some((entry) => entry.pid === row.pid)).map(({ pid, parentPid, processGroupId }) => ({ pid, parentPid, processGroupId })),
      mainAlive: afterCaptureProcesses.some((row) => row.pid === app.pid),
      rendererPid, rendererAlive: rendererPid > 0 && afterCaptureProcesses.some((row) => row.pid === rendererPid),
      originalTargetAlive, cdpError, targetsAfter, reconnectSucceeded, directCdpResponsive, stopPresent, stopSucceeded,
      classification: classifyQuietCapture({
        mainAlive: afterCaptureProcesses.some((row) => row.pid === app.pid),
        rendererAlive: rendererPid > 0 && afterCaptureProcesses.some((row) => row.pid === rendererPid),
        targetFound: targetsAfter.some((target) => target.urlClass === "app"),
        stopPresent, stopSucceeded, rendererFailure: lifecycle.includes("stage=renderer-gone"),
      }),
      lifecycle: lifecycle.slice(mode.includes("media-recording-probe") ? -32000 : -3000),
      vstReliability: vstReliability.trim().split("\n").filter(Boolean),
      zoomSweeps: recordingZoomProfile?.gestures ?? [],
      zoomMemoryCheckpoints: recordingZoomProfile?.memoryCheckpoints ?? [],
      ...telemetry(),
      samplePath,
      postmortem: await command(profile, ["host", "diagnostics-v2"]).catch(() => null),
      host: await command(profile, ["host", "status"]).catch(() => null),
      rendererProjectId: attached ? await browserCommand(session, ["eval", "new URL(location.href).searchParams.get('projectId')"]).catch(() => null) : null,
      rendererSnapshot: attached ? (await browserCommand(session, ["snapshot", "-c"]).catch(() => "")).slice(0, 6000) : null,
      dialogHtml: attached ? (await browserCommand(session, ["eval", "document.querySelector('[role=\"dialog\"]')?.outerHTML.slice(0, 5000) ?? null"]).catch(() => "")).slice(0, 5500) : null,
    }, null, 2))
    throw error
  } finally {
    process.off("SIGINT", interruptSigint)
    process.off("SIGTERM", interruptSigterm)
    const cleanup = await cleanupRun()
    if (!cleanup.removed) {
      const cleanupPath = `${output}.cleanup.json`
      await writePrivateArtifact(cleanupPath, JSON.stringify({ cleanup, interruptedSignal }, null, 2)).catch(() => undefined)
      console.error(`Benchmark profile cleanup failed; diagnostic: ${cleanupPath}`)
      process.exitCode = 1
    }
    if (interruptedSignal) process.exitCode = 128 + (interruptedSignal === "SIGINT" ? 2 : 15)
  }
}
if (import.meta.main) await main()
