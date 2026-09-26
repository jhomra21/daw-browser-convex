import { z } from "zod"

export type TaskSourceGap = { startEpochMs: number; endEpochMs: number }
const gapSchema = z.object({
  startEpochMs: z.number().finite().nonnegative(), endEpochMs: z.number().finite().nonnegative(),
}).strict()
const sourceSchema = z.object({ samples: z.array(gapSchema).max(1024), total: z.number().int().nonnegative() }).strict()
const evidenceSchema = z.object({
  supported: z.boolean(), message: sourceSchema, animation: sourceSchema, electron: sourceSchema,
  messageDelivery: sourceSchema, electronToMain: sourceSchema, electronMainToRenderer: sourceSchema,
  clockOffsetMs: z.number().finite(),
}).strict()
export type TaskSourceEvidence = z.infer<typeof evidenceSchema>

export const diagnosticReturnInterval = (value: {
  data?: { recording?: { writerReturnDeliveryWorst?: { returnedAtEpochMs: number; receivedAtEpochMs: number } | null } }
}) => value.data?.recording?.writerReturnDeliveryWorst ?? null

export const parseTaskSourceEvidence = (encoded: string): TaskSourceEvidence => {
  const first = z.string().max(500_000).parse(encoded)
  const second = z.string().max(500_000).parse(JSON.parse(first))
  return evidenceSchema.parse(JSON.parse(second))
}

// Run only in the disposable packaged benchmark; every source is stopped and its ports closed.
export const taskSourceProbeScript = () => `(()=>{
  const limit=1024, intervalMs=40;
  const source=()=>({samples:[],total:0,last:null});
  const epoch=()=>performance.timeOrigin+performance.now();
  const streams={message:source(),animation:source(),electron:source(),
    messageDelivery:source(),electronToMain:source(),electronMainToRenderer:source()};
  const record=(stream,start,end)=>{
    if(!Number.isFinite(start)||start>end)return;
    stream.total++;
    if(stream.samples.length===limit)stream.samples.shift();
    stream.samples.push({startEpochMs:start,endEpochMs:end});
  };
  const stamp=(stream,now)=>{
    if(stream.last!==null){
      record(stream,stream.last,now);
    }
    stream.last=now;
  };
  const channel=new MessageChannel();
  let active=true, raf=0, pending=false, messageTimer=0;
  channel.port1.onmessage=(event)=>{if(!active)return;const now=epoch();
    stamp(streams.message,now);record(streams.messageDelivery,event.data,now);
    messageTimer=setTimeout(()=>{if(active)channel.port2.postMessage(epoch())},intervalMs)};
  channel.port2.postMessage(epoch());
  // Sample every ~40 ms, while using rAF as the independent rendering task source.
  const frame=()=>{if(!active)return;const now=epoch();
    if(streams.animation.last===null||now-streams.animation.last>=32)stamp(streams.animation,now);
    raf=requestAnimationFrame(frame)};
  raf=requestAnimationFrame(frame);
  // Limit IPC to 25 in-flight-free requests per second; no Electron data is retained.
  const timer=setInterval(()=>{
    if(!active||pending||!window.dawDesktop?.benchmarkHeartbeat)return;
    pending=true;
    const sentAt=epoch();
    window.dawDesktop.benchmarkHeartbeat().then((reply)=>{
      if(active&&reply&&Number.isFinite(reply.mainEpochMs)){
        const now=epoch();stamp(streams.electron,now);
        // Main uses integer Date.now; clamp its sub-millisecond rounding against renderer's epoch.
        record(streams.electronToMain,sentAt,Math.max(sentAt,reply.mainEpochMs));
        record(streams.electronMainToRenderer,Math.min(now,reply.mainEpochMs),now);
      }
    }).catch(()=>{}).finally(()=>{pending=false});
  },intervalMs);
  window.__tier3TaskSourceProbe={
    stop:()=>{
      active=false;clearInterval(timer);clearTimeout(messageTimer);cancelAnimationFrame(raf);
      channel.port1.close();channel.port2.close();
      const take=(stream)=>({samples:stream.samples,total:stream.total});
      return {supported:typeof window.dawDesktop?.benchmarkHeartbeat==="function",
        clockOffsetMs:Date.now()-epoch(),
        message:take(streams.message),animation:take(streams.animation),electron:take(streams.electron),
        messageDelivery:take(streams.messageDelivery),electronToMain:take(streams.electronToMain),
        electronMainToRenderer:take(streams.electronMainToRenderer)};
    },
  };
})()`

export const summarizeTaskSourceGaps = (gaps: readonly TaskSourceGap[]) => {
  if (gaps.length === 0) return null
  const durations = gaps.map((gap) => gap.endEpochMs - gap.startEpochMs).sort((a, b) => a - b)
  const quantile = (fraction: number) => durations[Math.ceil(fraction * durations.length) - 1] ?? 0
  const worst = gaps.reduce((current, gap) =>
    gap.endEpochMs - gap.startEpochMs > current.endEpochMs - current.startEpochMs ? gap : current)
  return {
    count: gaps.length, p50Ms: quantile(0.5), p95Ms: quantile(0.95),
    p99Ms: quantile(0.99), maxMs: quantile(1), worst,
    firstEpochMs: gaps[0]!.startEpochMs, lastEpochMs: gaps[gaps.length - 1]!.endEpochMs,
  }
}

export const analyzeTaskSourceEvidence = (
  evidence: TaskSourceEvidence,
  delayed: { returnedAtEpochMs: number; receivedAtEpochMs: number } | null,
) => {
  const message = summarizeTaskSourceGaps(evidence.message.samples)
  const animation = summarizeTaskSourceGaps(evidence.animation.samples)
  const electron = summarizeTaskSourceGaps(evidence.electron.samples)
  const messageDelivery = summarizeTaskSourceGaps(evidence.messageDelivery.samples)
  const electronToMain = summarizeTaskSourceGaps(evidence.electronToMain.samples)
  const electronMainToRenderer = summarizeTaskSourceGaps(evidence.electronMainToRenderer.samples)
  const covers = (samples: TaskSourceGap[]) => samples.length > 0
    && samples[0]!.startEpochMs <= delayed!.returnedAtEpochMs
    && samples[samples.length - 1]!.endEpochMs >= delayed!.receivedAtEpochMs
    && samples.every((gap, index) => index === 0 || gap.startEpochMs === samples[index - 1]!.endEpochMs)
  const coverageDebug = (samples: TaskSourceGap[]) => ({
    startBeforeReturn: delayed !== null && (samples[0]?.startEpochMs ?? Infinity) <= delayed.returnedAtEpochMs,
    endAfterReceipt: delayed !== null && (samples[samples.length - 1]?.endEpochMs ?? -Infinity) >= delayed.receivedAtEpochMs,
    discontinuities: samples.reduce((total, gap, index) =>
      total + (index > 0 && gap.startEpochMs !== samples[index - 1]!.endEpochMs ? 1 : 0), 0),
  })
  const animationCovered = delayed !== null && covers(evidence.animation.samples)
  const dispatchBoundary = (() => {
    if (!delayed || !evidence.supported || !animationCovered) return "unknown" as const
    const overlapsMost = (gap: TaskSourceGap) =>
      Math.min(gap.endEpochMs, delayed.receivedAtEpochMs)
      - Math.max(gap.startEpochMs, delayed.returnedAtEpochMs)
      >= (delayed.receivedAtEpochMs - delayed.returnedAtEpochMs) * 0.65
    const animationBusy = evidence.animation.samples.some((gap) => overlapsMost(gap))
    const postedMessagesDelayed = evidence.messageDelivery.samples.some(overlapsMost)
      && evidence.electronMainToRenderer.samples.some(overlapsMost)
    const mainReachedQuickly = evidence.electronToMain.samples.some((gap) =>
      gap.startEpochMs >= delayed.returnedAtEpochMs && gap.endEpochMs <= delayed.receivedAtEpochMs
      && gap.endEpochMs - gap.startEpochMs <= 20)
    return !animationBusy && postedMessagesDelayed && mainReachedQuickly
      ? "renderer-message-delivery-delay" as const : "unknown" as const
  })()
  const coverage = { animation: coverageDebug(evidence.animation.samples),
    message: coverageDebug(evidence.message.samples),
    electron: coverageDebug(evidence.electron.samples) }
  if (!delayed || !evidence.supported || !covers(evidence.message.samples)
    || !covers(evidence.animation.samples) || !covers(evidence.electron.samples)) {
    return { message, animation, electron, messageDelivery, electronToMain, electronMainToRenderer,
      classification: "unknown" as const, dispatchBoundary, coverage }
  }
  const intersectingWorst = (samples: TaskSourceGap[]): TaskSourceGap | null => {
    let worst: TaskSourceGap | null = null
    for (const gap of samples) {
      if (gap.startEpochMs >= delayed.receivedAtEpochMs || gap.endEpochMs <= delayed.returnedAtEpochMs) continue
      if (!worst || gap.endEpochMs - gap.startEpochMs > worst.endEpochMs - worst.startEpochMs) worst = gap
    }
    return worst
  }
  return {
    message, animation, electron, messageDelivery, electronToMain, electronMainToRenderer, dispatchBoundary, coverage,
    classification: classifyTaskSourceGap(
      { startEpochMs: delayed.returnedAtEpochMs, endEpochMs: delayed.receivedAtEpochMs },
      { message: intersectingWorst(evidence.message.samples), animation: intersectingWorst(evidence.animation.samples),
        electron: intersectingWorst(evidence.electron.samples) },
    ),
  }
}

// A worst gap alone cannot establish continuous liveness; this is only a candidate classification.
export const classifyTaskSourceGap = (
  delayed: TaskSourceGap,
  sources: { message: TaskSourceGap | null; animation: TaskSourceGap | null; electron: TaskSourceGap | null },
) => {
  if (!sources.message || !sources.animation || !sources.electron) return "unknown" as const
  const overlaps = (gap: TaskSourceGap) => gap.startEpochMs < delayed.endEpochMs
    && gap.endEpochMs > delayed.startEpochMs
  if (!overlaps(sources.message) || !overlaps(sources.animation) || !overlaps(sources.electron)) return "unknown" as const
  const stalled = (gap: TaskSourceGap) => gap.endEpochMs - gap.startEpochMs >=
    (delayed.endEpochMs - delayed.startEpochMs) * 0.75
  if (stalled(sources.message) && stalled(sources.animation) && stalled(sources.electron)) return "renderer-global-stall" as const
  if (!stalled(sources.message) && !stalled(sources.animation) && stalled(sources.electron)) return "electron-ipc-delay" as const
  if (!stalled(sources.message) && !stalled(sources.animation) && !stalled(sources.electron)) return "worker-message-starvation" as const
  return "unknown" as const
}
