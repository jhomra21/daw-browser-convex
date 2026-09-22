import { z } from "zod"

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

export type BrowserProbeResult = {
  readonly version: "30-track-probe-v1"
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
    readonly usedBytes: number | null
    readonly totalBytes: number | null
    readonly limitBytes: number | null
  }
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
  readonly errors: readonly {
    readonly kind: "error" | "unhandledrejection"
    readonly message: string
  }[]
}

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

export const browserProbeResultSchema = z.object({
  version: z.literal("30-track-probe-v1"),
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
    usedBytes: z.number().int().nonnegative().nullable(),
    totalBytes: z.number().int().nonnegative().nullable(),
    limitBytes: z.number().int().nonnegative().nullable(),
  }).strict(),
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
  errors: z.array(z.object({
    kind: z.enum(["error", "unhandledrejection"]),
    message: z.string().max(512),
  }).strict()),
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

export const collectBrowserProbe = async (sampleCount = 120): Promise<BrowserProbeResult> => {
  const errors: BrowserProbeResult["errors"][number][] = []
  const onError = (event: ErrorEvent) => errors.push({ kind: "error", message: event.message.slice(0, 512) })
  const onUnhandledRejection = (event: PromiseRejectionEvent) => {
    const reason = event.reason instanceof Error ? event.reason.message : String(event.reason)
    errors.push({ kind: "unhandledrejection", message: reason.slice(0, 512) })
  }
  window.addEventListener("error", onError)
  window.addEventListener("unhandledrejection", onUnhandledRejection)
  const longTaskDurations: number[] = []
  let longTaskObserver: PerformanceObserver | undefined
  let longTasksSupported = false
  // oxlint-disable-next-line anti-slop/no-runtime-typeof
  if (typeof PerformanceObserver !== "undefined") {
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) longTaskDurations.push(entry.duration)
      })
      observer.observe({ type: "longtask", buffered: true })
      longTaskObserver = observer
      longTasksSupported = true
    } catch {
      longTaskObserver = undefined
    }
  }
  const timestamps: number[] = []
  let fallback: ReturnType<typeof setTimeout> | undefined
  try {
    await new Promise<void>((resolve, reject) => {
      // Bounded fallback handles background tabs where RAF delivery is suspended.
      fallback = setTimeout(resolve, 2_000)
      const frame = (timestamp: number) => {
        try {
          timestamps.push(timestamp)
          if (timestamps.length >= Math.max(1, sampleCount)) {
            clearTimeout(fallback)
            resolve()
            return
          }
          requestAnimationFrame(frame)
        } catch (error) {
          reject(error)
        }
      }
      try {
        requestAnimationFrame(() => requestAnimationFrame(frame))
      } catch (error) {
        reject(error)
      }
    })
    const intervals = timestamps.slice(1).map((timestamp, index) => timestamp - (timestamps[index] ?? timestamp))
    const intervalStats = summarizeIntervals(intervals)
    const memory = performanceMemory()
    const longTaskMax = longTaskDurations.length > 0 ? Math.max(...longTaskDurations) : null
    return browserProbeResultSchema.parse({
      version: "30-track-probe-v1",
      raf: {
        supported: intervals.length > 0,
        unavailableReason: intervals.length > 0 ? null : "raf-not-delivered",
        sampleCount: intervals.length,
        intervalsMs: intervalStats,
        thresholds: summarizeThresholds(intervals),
      },
      longTasks: {
        supported: longTasksSupported,
        count: longTasksSupported ? longTaskDurations.length : null,
        totalDurationMs: longTasksSupported ? longTaskDurations.reduce((sum, value) => sum + value, 0) : null,
        maxDurationMs: longTasksSupported ? longTaskMax : null,
      },
      heap: {
        supported: memory !== undefined,
        usedBytes: memory?.usedJSHeapSize ?? null,
        totalBytes: memory?.totalJSHeapSize ?? null,
        limitBytes: memory?.jsHeapSizeLimit ?? null,
      },
      display: {
        viewportSupported: window.innerWidth > 0 && window.innerHeight > 0,
        viewportUnavailableReason: window.innerWidth > 0 && window.innerHeight > 0 ? null : "viewport-not-reported",
        viewportWidth: window.innerWidth > 0 ? window.innerWidth : null,
        viewportHeight: window.innerHeight > 0 ? window.innerHeight : null,
        devicePixelRatio: window.devicePixelRatio,
        intervalEstimateMs: intervalStats.p50,
      },
      canvasAttribution: { supported: false, reason: "not-instrumented" },
      errors,
    })
  } finally {
    if (fallback !== undefined) clearTimeout(fallback)
    longTaskObserver?.disconnect()
    window.removeEventListener("error", onError)
    window.removeEventListener("unhandledrejection", onUnhandledRejection)
  }
}
