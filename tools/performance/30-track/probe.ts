import { z } from "zod"

z.config({ jitless: true })

export type QuantileStats = {
  readonly p50: number | null
  readonly p95: number | null
  readonly p99: number | null
  readonly max: number | null
}

export type ThresholdStats = {
  readonly over8_33Ms: number
  readonly over16_67Ms: number
  readonly over33_3Ms: number
  readonly over50Ms: number
}

export type BrowserProbeError = {
  readonly kind: "error" | "unhandledrejection"
  readonly message: string
}

export type PhaseName = "warmup" | "import" | "zoom" | "horizontal-pan" | "vertical-scroll" | "playback" | "stop"

export type PhaseResult = {
  readonly name: PhaseName
  readonly parameters: Readonly<Record<string, boolean | number | string>>
  readonly durationMs: number
  readonly raf: {
    readonly supported: boolean
    readonly unavailableReason: "raf-not-delivered" | null
    readonly sampleCount: number
    readonly intervalsMs: QuantileStats
    readonly thresholds: ThresholdStats
  }
  readonly longTasks: {
    readonly supported: boolean
    readonly count: number | null
    readonly totalDurationMs: number | null
    readonly maxDurationMs: number | null
  }
  readonly heap: {
    readonly supported: boolean
    readonly source: "performance.memory"
    readonly beforeBytes: number | null
    readonly afterBytes: number | null
    readonly totalBytes: number | null
    readonly limitBytes: number | null
  }
  readonly errors: readonly BrowserProbeError[]
  readonly unavailable: readonly string[]
}

export type BrowserProbeResult = {
  readonly version: "30-track-probe-v2"
  readonly phases: readonly PhaseResult[]
  readonly startupErrors: readonly BrowserProbeError[]
  readonly display: {
    readonly viewportSupported: boolean
    readonly viewportUnavailableReason: "viewport-not-reported" | null
    readonly viewportWidth: number | null
    readonly viewportHeight: number | null
    readonly devicePixelRatio: number
    readonly intervalEstimateMs: number | null
  }
  readonly canvasAttribution: {
    readonly supported: false
    readonly reason: "not-instrumented"
  }
  readonly integrity: {
    readonly fixtureHashVerified: boolean
    readonly semanticManifestVerified: boolean
    readonly tier2SemanticSnapshotVerified: boolean
    readonly starterProjectId: string | null
    readonly importedProjectId: string | null
    readonly importedProjectDifferent: boolean
    readonly trackCount: number
    readonly clipCount: number
    readonly expectedTrackLabels: number
    readonly expectedClipTitles: number
    readonly serviceWorkerControllerAbsent: boolean
    readonly transportPlaybackUiVerified: boolean
    readonly transportStopUiVerified: boolean
    readonly tier2VisibleWorkload: {
      readonly trackSelected: boolean
      readonly effectsPanelOpened: boolean
      readonly synthVisible: boolean
      readonly saturatorVisible: boolean
      readonly utilityVisible: boolean
    }
    readonly meterEvidence: {
      readonly status: "observed" | "unavailable"
      readonly activityDetected: boolean | null
      readonly maxHeightPercent: number | null
      readonly unavailableReason: "stable-rendered-meter-signal-unavailable" | null
    }
    readonly audioEvidence: {
      readonly kind: "rendered-meter-only" | "native-callbacks" | "not-observed"
      readonly audibleOutputVerified: false
    }
  }
}

export type ProbeIntegrityPatch = Partial<BrowserProbeResult["integrity"]>

export const quantileStatsSchema = z.object({
  p50: z.number().finite().nullable(),
  p95: z.number().finite().nullable(),
  p99: z.number().finite().nullable(),
  max: z.number().finite().nullable(),
}).strict()

export const thresholdStatsSchema = z.object({
  over8_33Ms: z.number().int().nonnegative(),
  over16_67Ms: z.number().int().nonnegative(),
  over33_3Ms: z.number().int().nonnegative(),
  over50Ms: z.number().int().nonnegative(),
}).strict()

const browserErrorSchema = z.object({
  kind: z.enum(["error", "unhandledrejection"]),
  message: z.string().max(512),
}).strict()

const phaseSchema = z.object({
  name: z.enum(["warmup", "import", "zoom", "horizontal-pan", "vertical-scroll", "playback", "stop"]),
  parameters: z.record(z.string(), z.union([z.boolean(), z.number().finite(), z.string()])),
  durationMs: z.number().finite().nonnegative(),
  raf: z.object({
    supported: z.boolean(),
    unavailableReason: z.literal("raf-not-delivered").nullable(),
    sampleCount: z.number().int().nonnegative(),
    intervalsMs: quantileStatsSchema,
    thresholds: thresholdStatsSchema,
  }).strict(),
  longTasks: z.object({
    supported: z.boolean(),
    count: z.number().int().nonnegative().nullable(),
    totalDurationMs: z.number().finite().nonnegative().nullable(),
    maxDurationMs: z.number().finite().nonnegative().nullable(),
  }).strict(),
  heap: z.object({
    supported: z.boolean(),
    source: z.literal("performance.memory"),
    beforeBytes: z.number().int().nonnegative().nullable(),
    afterBytes: z.number().int().nonnegative().nullable(),
    totalBytes: z.number().int().nonnegative().nullable(),
    limitBytes: z.number().int().nonnegative().nullable(),
  }).strict(),
  errors: z.array(browserErrorSchema),
  unavailable: z.array(z.string()),
}).strict()

export const browserProbeResultSchema = z.object({
  version: z.literal("30-track-probe-v2"),
  phases: z.array(phaseSchema),
  startupErrors: z.array(browserErrorSchema),
  display: z.object({
    viewportSupported: z.boolean(),
    viewportUnavailableReason: z.literal("viewport-not-reported").nullable(),
    viewportWidth: z.number().int().positive().nullable(),
    viewportHeight: z.number().int().positive().nullable(),
    devicePixelRatio: z.number().finite().positive(),
    intervalEstimateMs: z.number().finite().positive().nullable(),
  }).strict(),
  canvasAttribution: z.object({
    supported: z.literal(false),
    reason: z.literal("not-instrumented"),
  }).strict(),
  integrity: z.object({
    fixtureHashVerified: z.boolean(),
    semanticManifestVerified: z.boolean(),
    tier2SemanticSnapshotVerified: z.boolean(),
    starterProjectId: z.string().nullable(),
    importedProjectId: z.string().nullable(),
    importedProjectDifferent: z.boolean(),
    trackCount: z.number().int().nonnegative(),
    clipCount: z.number().int().nonnegative(),
    expectedTrackLabels: z.number().int().nonnegative(),
    expectedClipTitles: z.number().int().nonnegative(),
    serviceWorkerControllerAbsent: z.boolean(),
    transportPlaybackUiVerified: z.boolean(),
    transportStopUiVerified: z.boolean(),
    tier2VisibleWorkload: z.object({
      trackSelected: z.boolean(),
      effectsPanelOpened: z.boolean(),
      synthVisible: z.boolean(),
      saturatorVisible: z.boolean(),
      utilityVisible: z.boolean(),
    }).strict(),
    meterEvidence: z.object({
      status: z.enum(["observed", "unavailable"]),
      activityDetected: z.boolean().nullable(),
      maxHeightPercent: z.number().finite().nonnegative().max(100).nullable(),
      unavailableReason: z.literal("stable-rendered-meter-signal-unavailable").nullable(),
    }).strict().superRefine((value, context) => {
      if (value.status === "observed" && (value.activityDetected === null || value.maxHeightPercent === null || value.unavailableReason !== null)) {
        context.addIssue({ code: "custom", message: "Observed meter evidence requires activity and height without an unavailable reason." })
      }
      if (value.status === "unavailable" && (value.activityDetected !== null || value.maxHeightPercent !== null || value.unavailableReason === null)) {
        context.addIssue({ code: "custom", message: "Unavailable meter evidence must not claim observed activity." })
      }
    }),
    audioEvidence: z.object({
      kind: z.enum(["rendered-meter-only", "native-callbacks", "not-observed"]),
      audibleOutputVerified: z.literal(false),
    }).strict(),
  }).strict(),
}).strict()

export const browserProbeOutputSchema = z.union([
  browserProbeResultSchema,
  z.object({ error: z.string().min(1) }).strict(),
])

const percentile = (sorted: readonly number[], quantile: number): number | null => {
  if (sorted.length === 0) return null
  const position = (sorted.length - 1) * quantile
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  const lowerValue = sorted[lower]
  const upperValue = sorted[upper]
  if (lowerValue === undefined || upperValue === undefined) return null
  return lower === upper ? lowerValue : lowerValue + (upperValue - lowerValue) * (position - lower)
}

export const summarizeIntervals = (intervals: readonly number[]): QuantileStats => {
  const sorted = [...intervals].sort((left, right) => left - right)
  return {
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted.at(-1) ?? null,
  }
}

export const summarizeThresholds = (intervals: readonly number[]): ThresholdStats => ({
  over8_33Ms: intervals.filter((value) => value > 8.33).length,
  over16_67Ms: intervals.filter((value) => value > 16.67).length,
  over33_3Ms: intervals.filter((value) => value > 33.3).length,
  over50Ms: intervals.filter((value) => value > 50).length,
})

type PerformanceMemory = {
  usedJSHeapSize: number
  totalJSHeapSize: number
  jsHeapSizeLimit: number
}

const performanceMemory = (): PerformanceMemory | undefined => {
  if (!("memory" in performance)) return undefined
  const parsed = z.object({
    usedJSHeapSize: z.number().finite().nonnegative(),
    totalJSHeapSize: z.number().finite().nonnegative(),
    jsHeapSizeLimit: z.number().finite().nonnegative(),
  }).strict().safeParse(performance.memory)
  return parsed.success ? parsed.data : undefined
}

const emptyIntegrity = (): BrowserProbeResult["integrity"] => ({
  fixtureHashVerified: false,
  semanticManifestVerified: false,
  tier2SemanticSnapshotVerified: false,
  starterProjectId: null,
  importedProjectId: null,
  importedProjectDifferent: false,
  trackCount: 0,
  clipCount: 0,
  expectedTrackLabels: 0,
  expectedClipTitles: 0,
  serviceWorkerControllerAbsent: navigator.serviceWorker?.controller === null,
  transportPlaybackUiVerified: false,
  transportStopUiVerified: false,
  tier2VisibleWorkload: {
    trackSelected: false,
    effectsPanelOpened: false,
    synthVisible: false,
    saturatorVisible: false,
    utilityVisible: false,
  },
  meterEvidence: {
    status: "unavailable",
    activityDetected: null,
    maxHeightPercent: null,
    unavailableReason: "stable-rendered-meter-signal-unavailable",
  },
  audioEvidence: {
    kind: "not-observed",
    audibleOutputVerified: false,
  },
})

export type BrowserProbeCoordinator = {
  startPhase: (name: PhaseName, parameters: Readonly<Record<string, boolean | number | string>>) => void
  finishPhase: () => void
  recordError: (message: string) => void
  setIntegrity: (patch: ProbeIntegrityPatch) => void
  finish: () => BrowserProbeResult
}

export const installBrowserProbe = (): BrowserProbeCoordinator => {
  const startupErrors: BrowserProbeError[] = []
  const phaseErrors = new Map<PhaseName, BrowserProbeError[]>()
  const phases: PhaseResult[] = []
  let active: {
    name: PhaseName
    parameters: Readonly<Record<string, boolean | number | string>>
    startedAt: number
    beforeMemory: PerformanceMemory | undefined
    timestamps: number[]
    longTaskDurations: number[]
  } | undefined
  let integrity = emptyIntegrity()
  let lastTimestamp: number | undefined
  let rafId: number | undefined
  let longTaskObserver: PerformanceObserver | undefined
  const onError = (event: ErrorEvent) => {
    const error: BrowserProbeError = { kind: "error", message: event.message.slice(0, 512) }
    if (active) (phaseErrors.get(active.name) ?? []).push(error)
    else startupErrors.push(error)
  }
  const onUnhandledRejection = (event: PromiseRejectionEvent) => {
    const reason = event.reason instanceof Error ? event.reason.message : String(event.reason)
    const error: BrowserProbeError = { kind: "unhandledrejection", message: reason.slice(0, 512) }
    if (active) (phaseErrors.get(active.name) ?? []).push(error)
    else startupErrors.push(error)
  }
  const onAnimationFrame = (timestamp: number) => {
    if (active) {
      active.timestamps.push(timestamp)
      lastTimestamp = timestamp
    }
    rafId = requestAnimationFrame(onAnimationFrame)
  }
  window.addEventListener("error", onError)
  window.addEventListener("unhandledrejection", onUnhandledRejection)
  rafId = requestAnimationFrame(onAnimationFrame)
  try {
    longTaskObserver = new PerformanceObserver((list) => {
      if (!active) return
      for (const entry of list.getEntries()) active.longTaskDurations.push(entry.duration)
    })
    longTaskObserver.observe({ type: "longtask", buffered: true })
  } catch {
    longTaskObserver = undefined
  }
  return {
    startPhase(name, parameters) {
      if (active) throw new Error(`Phase ${active.name} is still active.`)
      active = {
        name,
        parameters,
        startedAt: performance.now(),
        beforeMemory: performanceMemory(),
        timestamps: lastTimestamp === undefined ? [] : [lastTimestamp],
        longTaskDurations: [],
      }
      phaseErrors.set(name, [])
    },
    finishPhase() {
      if (!active) throw new Error("No active benchmark phase.")
      const finished = active
      const intervals = finished.timestamps.slice(1).map((timestamp, index) => timestamp - (finished.timestamps[index] ?? timestamp))
      const memory = performanceMemory()
      const errors = phaseErrors.get(finished.name) ?? []
      phases.push({
        name: finished.name,
        parameters: finished.parameters,
        durationMs: performance.now() - finished.startedAt,
        raf: {
          supported: intervals.length > 0,
          unavailableReason: intervals.length > 0 ? null : "raf-not-delivered",
          sampleCount: intervals.length,
          intervalsMs: summarizeIntervals(intervals),
          thresholds: summarizeThresholds(intervals),
        },
        longTasks: {
          supported: longTaskObserver !== undefined,
          count: longTaskObserver ? finished.longTaskDurations.length : null,
          totalDurationMs: longTaskObserver ? finished.longTaskDurations.reduce((sum, value) => sum + value, 0) : null,
          maxDurationMs: longTaskObserver ? (finished.longTaskDurations.length > 0 ? Math.max(...finished.longTaskDurations) : null) : null,
        },
        heap: {
          supported: finished.beforeMemory !== undefined && memory !== undefined,
          source: "performance.memory",
          beforeBytes: finished.beforeMemory?.usedJSHeapSize ?? null,
          afterBytes: memory?.usedJSHeapSize ?? null,
          totalBytes: memory?.totalJSHeapSize ?? null,
          limitBytes: memory?.jsHeapSizeLimit ?? null,
        },
        errors: [...errors],
        unavailable: [
          ...(intervals.length > 0 ? [] : ["raf-not-delivered"]),
          ...(longTaskObserver ? [] : ["long-task-observer-unavailable"]),
          ...(finished.beforeMemory && memory ? [] : ["heap-unavailable"]),
        ],
      })
      active = undefined
    },
    recordError(message) {
      const error: BrowserProbeError = { kind: "error", message: message.slice(0, 512) }
      if (active) (phaseErrors.get(active.name) ?? []).push(error)
      else startupErrors.push(error)
    },
    setIntegrity(patch) {
      integrity = { ...integrity, ...patch }
    },
    finish() {
      if (active) throw new Error(`Phase ${active.name} was not finished.`)
      if (rafId !== undefined) cancelAnimationFrame(rafId)
      longTaskObserver?.disconnect()
      window.removeEventListener("error", onError)
      window.removeEventListener("unhandledrejection", onUnhandledRejection)
      const intervals = phases.flatMap((phase) => {
        const p50 = phase.raf.intervalsMs.p50
        return p50 === null ? [] : [p50]
      })
      return browserProbeResultSchema.parse({
        version: "30-track-probe-v2",
        phases,
        startupErrors,
        display: {
          viewportSupported: window.innerWidth > 0 && window.innerHeight > 0,
          viewportUnavailableReason: window.innerWidth > 0 && window.innerHeight > 0 ? null : "viewport-not-reported",
          viewportWidth: window.innerWidth > 0 ? window.innerWidth : null,
          viewportHeight: window.innerHeight > 0 ? window.innerHeight : null,
          devicePixelRatio: window.devicePixelRatio,
          intervalEstimateMs: intervals.at(0) ?? null,
        },
        canvasAttribution: { supported: false, reason: "not-instrumented" },
        integrity,
      })
    },
  }
}

export const collectBrowserProbe = async (sampleCount = 120): Promise<BrowserProbeResult> => {
  const coordinator = installBrowserProbe()
  coordinator.startPhase("warmup", { sampleCount })
  await new Promise<void>((resolve) => {
    const started = performance.now()
    const tick = () => performance.now() - started >= 2_000 ? resolve() : requestAnimationFrame(tick)
    requestAnimationFrame(tick)
  })
  coordinator.finishPhase()
  return coordinator.finish()
}
