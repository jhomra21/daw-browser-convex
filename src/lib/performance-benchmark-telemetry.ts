export type PerformanceBenchmarkCollector = {
  increment: (owner: string, amount?: number) => void
  duration: (owner: string, durationMs: number) => void
  gauge: (owner: string, value: number) => void
  phase: (owner: string, active: boolean) => void
}

declare global {
  var __dawPerformanceBenchmark: PerformanceBenchmarkCollector | undefined
}

export const incrementPerformanceBenchmarkCounter = (owner: string, amount = 1) => {
  globalThis.__dawPerformanceBenchmark?.increment(owner, amount)
}

export const measurePerformanceBenchmarkDuration = (
  owner: string,
  startedAt: number,
  endedAt = performance.now(),
) => {
  const durationMs = Math.max(0, endedAt - startedAt)
  globalThis.__dawPerformanceBenchmark?.duration(owner, durationMs)
  return durationMs
}

export const setPerformanceBenchmarkGauge = (owner: string, value: number) => {
  globalThis.__dawPerformanceBenchmark?.gauge(owner, value)
}

export const withPerformanceBenchmarkPhase = async <Value>(
  owner: string,
  work: () => Promise<Value>,
): Promise<Value> => {
  globalThis.__dawPerformanceBenchmark?.phase(owner, true)
  try { return await work() }
  finally { globalThis.__dawPerformanceBenchmark?.phase(owner, false) }
}
