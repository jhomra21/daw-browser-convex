import { readFile } from "node:fs/promises"

type Gesture = {
  sweep: number
  direction: "in" | "out"
  anchor: number
  stateChangeMs: number
  firstVisualMs: number
  settledMs: number
  browserCommandRoundTripMs: number
  projectActiveClipCount: number
  mountedClipCount: number
  viewportIntersectingClipCount: number
}

const quantile = (values: readonly number[], percentile: number) => {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.round((sorted.length - 1) * percentile)] ?? null
}

const distribution = (values: readonly number[]) => ({
  p50: quantile(values, 0.5),
  p95: quantile(values, 0.95),
  p99: quantile(values, 0.99),
  max: values.length === 0 ? null : Math.max(...values),
})

const counts = (values: readonly number[]) =>
  Object.entries(values.reduce<Record<string, number>>((result, value) => {
    result[value] = (result[value] ?? 0) + 1
    return result
  }, {})).map(([value, samples]) => ({ value: Number(value), samples }))

const gestureSummary = (gestures: readonly Gesture[]) => ({
  samples: gestures.length,
  stateChangeMs: distribution(gestures.map((gesture) => gesture.stateChangeMs)),
  firstVisualMs: distribution(gestures.map((gesture) => gesture.firstVisualMs)),
  settledMs: distribution(gestures.map((gesture) => gesture.settledMs)),
  browserCommandRoundTripMs: distribution(gestures.map((gesture) => gesture.browserCommandRoundTripMs)),
})

const summarize = async (artifactPath: string) => {
  const artifact = JSON.parse(await readFile(artifactPath, "utf8"))
  const recording = artifact.recording ?? {}
  const gestures: Gesture[] = artifact.zoomSweeps ?? recording.zoomSweeps ?? []
  const processSamples: {
    type: string
    cpuPercent: number
    workingSetKiB: number
    peakWorkingSetKiB: number
    privateKiB: number | null
  }[] = artifact.rendererSamples ?? recording.rendererSamples ?? []
  const processTypes = [...new Set(processSamples.map((sample) => sample.type))]
  return {
    artifactPath,
    status: artifact.status,
    stage: artifact.stage ?? null,
    error: artifact.error ?? null,
    projectActiveClipCounts: counts(gestures.map((gesture) => gesture.projectActiveClipCount)),
    mountedClipCounts: counts(gestures.map((gesture) => gesture.mountedClipCount)),
    viewportIntersectingClipCounts: counts(gestures.map((gesture) => gesture.viewportIntersectingClipCount)),
    gestures: {
      all: gestureSummary(gestures),
      byDirection: Object.fromEntries(["in", "out"].map((direction) => [
        direction, gestureSummary(gestures.filter((gesture) => gesture.direction === direction)),
      ])),
      bySweepDepth: Object.fromEntries([...new Set(gestures.map((gesture) => gesture.sweep))].map((sweep) => [
        sweep, gestureSummary(gestures.filter((gesture) => gesture.sweep === sweep)),
      ])),
    },
    framePerformance: artifact.framePerformance ?? recording.framePerformance ?? null,
    processes: Object.fromEntries(processTypes.map((type) => {
      const samples = processSamples.filter((sample) => sample.type === type)
      return [type, {
        samples: samples.length,
        cpuPercent: distribution(samples.map((sample) => sample.cpuPercent)),
        workingSetBytes: distribution(samples.map((sample) => sample.workingSetKiB * 1024)),
        peakWorkingSetBytes: Math.max(0, ...samples.map((sample) => sample.peakWorkingSetKiB * 1024)),
        privateBytes: distribution(samples.flatMap((sample) => sample.privateKiB === null ? [] : [sample.privateKiB * 1024])),
      }]
    })),
    memoryCheckpoints: artifact.zoomMemoryCheckpoints ?? recording.zoomMemoryCheckpoints ?? [],
    rendererMetrics: artifact.rendererMetrics ?? recording.rendererMetrics ?? null,
    realtimePerformance: artifact.realtimePerformance ?? recording.realtimePerformance ?? null,
    vstWorkerPerformance: artifact.vstWorkerPerformance ?? recording.vstWorkerPerformance ?? null,
  }
}

const paths = Bun.argv.slice(2)
if (paths.length === 0) throw new Error("Usage: bun summarize-zoom.ts <artifact.json> [...]")
console.log(JSON.stringify(await Promise.all(paths.map(summarize)), null, 2))
