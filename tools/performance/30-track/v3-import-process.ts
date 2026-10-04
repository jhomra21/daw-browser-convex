import { z } from "zod"
import { descendantsOf } from "./electron"

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export const fullLoadFrameProbeScript = () => `(()=>{const limit=8192,longLimit=256;const state={active:true,last:null,raf:[],work:[],long:[],drop:{raf:0,work:0,long:0,longFrames:0},observer:null,loafObserver:null,id:0,currentPhase:'unattributed',phases:[],longFrames:[],marks:[],counters:{},durations:{},zoomResults:{}};
const push=(values,key,value)=>{if(values.length<limit)values.push(value);else state.drop[key]++};
const owner=(entry)=>{const scripts=entry.scripts||[];const script=scripts.reduce((best,item)=>(item.duration||0)>(best?.duration||0)?item:best,null);const source=String(script?.sourceURL||'').slice(-160),fn=String(script?.functionName||'').slice(0,120);const text=(source+' '+fn).toLowerCase();const category=text.includes('waveform')?'waveform-geometry':text.includes('record')?'recording-UI':text.includes('timeline')?'timeline-reactivity':text.includes('solid')?'Solid/reactive':scripts.length?'unknown':'layout/style';return {category,source:source||null,functionName:fn||null}};
const phase=(name,active)=>{const now=performance.now();if(active){state.currentPhase=name;state.phases.push({name,startTime:now,endTime:null})}else{const item=[...state.phases].reverse().find(candidate=>candidate.name===name&&candidate.endTime===null);if(item)item.endTime=now;state.currentPhase=[...state.phases].reverse().find(candidate=>candidate.endTime===null)?.name||'unattributed'};return true};
window.__dawPerformanceBenchmark={increment:(key,amount=1)=>{state.counters[key]=(state.counters[key]||0)+amount},duration:(key,value)=>{const values=state.durations[key]||(state.durations[key]=[]);if(values.length<limit)values.push(value)},gauge:(key,value)=>{state.counters[key]=value},mark:(owner)=>{if(state.marks.length<limit)state.marks.push({owner,timestamp:performance.now()})},phase,currentPhase:()=>state.currentPhase};
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
export const probeProjectCdp = async (port: string, projectId: string): Promise<"responsive" | "target-absent" | "endpoint-mismatch" | "deadline" | "evaluation-failed"> => {
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
export const pingProjectCdp = async (port: string, projectId: string) =>
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
  identityLosses: {
    elapsedMs: number
    expected: ProcessIdentity[]
    observed: ProcessIdentity[]
    replacementWaitMs: number
  }[]
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
export const createNativeProcessCpuSampler = async (
  appPid: number,
  durationMs: number,
  preferActiveWorkerGroup: boolean,
  onMeasurementStart?: (timestamp: number) => void,
): Promise<{ stop: () => Promise<NativeProcessCpu> }> => {
  const sampleIntervalMs = 1_000
  const replacementGraceMs = 3_000
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
  onMeasurementStart?.(startedAt)
  let nextSampleAt = startedAt
  const sample = async () => {
    let current = await rows()
    let currentByPid = new Map(current.map((row) => [row.pid, row]))
    const targets = [...generation.identities.audioHosts, ...generation.identities.workers]
    const valid = targets.every((identity) => {
      const row = currentByPid.get(identity.pid)
      return row !== undefined && row.command.trim().split(/\s+/)[0] === identity.command
        && row.parentPid === identity.parentPid && row.processGroupId === identity.processGroupId
    })
    if (!valid) {
      const elapsedMs = Math.max(0, Date.now() - startedAt)
      const expected = targets
      let nextIdentities = selectIdentities(current)
      let replacementWaitMs = 0
      while (!nextIdentities && replacementWaitMs < replacementGraceMs && !stopped) {
        await delay(100)
        replacementWaitMs += 100
        current = await rows()
        currentByPid = new Map(current.map((row) => [row.pid, row]))
        nextIdentities = selectIdentities(current)
      }
      identityLosses.push({
        elapsedMs, expected,
        observed: nextIdentities ? [...nextIdentities.audioHosts, ...nextIdentities.workers] : [],
        replacementWaitMs,
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
      nextSampleAt += sampleIntervalMs
      await delay(Math.max(0, nextSampleAt - Date.now()))
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
