import { readFile } from "node:fs/promises"

const quantile = (values: readonly number[], percentile: number) => {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.round((sorted.length - 1) * percentile)] ?? null
}

const summarize = async (artifactPath: string) => {
  const artifact = JSON.parse(await readFile(artifactPath, "utf8"))
  const recording = artifact.recording ?? {}
  const gestures = artifact.zoomSweeps ?? recording.zoomSweeps ?? []
  const framePerformance = artifact.framePerformance ?? recording.framePerformance ?? null
  const visibleClipCounts = Object.entries(
    gestures.reduce((counts: Record<string, number>, gesture: { visibleClips: number }) => {
      const key = String(gesture.visibleClips)
      counts[key] = (counts[key] ?? 0) + 1
      return counts
    }, {}),
  ).map(([visibleClips, samples]) => ({ visibleClips: Number(visibleClips), samples }))
  return {
    artifactPath,
    status: artifact.status,
    stage: artifact.stage ?? null,
    error: artifact.error ?? null,
    gestureCount: gestures.length,
    visibleClipCounts,
    responseMs: {
      p50: quantile(gestures.map((gesture: { firstResponseMs: number }) => gesture.firstResponseMs), 0.5),
      p95: quantile(gestures.map((gesture: { firstResponseMs: number }) => gesture.firstResponseMs), 0.95),
      p99: quantile(gestures.map((gesture: { firstResponseMs: number }) => gesture.firstResponseMs), 0.99),
    },
    framePerformance,
    rendererMetrics: artifact.rendererMetrics ?? null,
    realtimePerformance: artifact.realtimePerformance ?? recording.realtimePerformance ?? null,
    vstWorkerPerformance: artifact.vstWorkerPerformance ?? recording.vstWorkerPerformance ?? null,
  }
}

const paths = Bun.argv.slice(2)
if (paths.length === 0) throw new Error("Usage: bun summarize-zoom.ts <artifact.json> [...]")
console.log(JSON.stringify(await Promise.all(paths.map(summarize)), null, 2))
