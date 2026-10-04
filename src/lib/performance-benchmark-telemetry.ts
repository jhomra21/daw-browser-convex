type PerformanceBenchmarkCollector = {
  increment: (owner: string, amount?: number) => void
  duration: (owner: string, durationMs: number) => void
  gauge: (owner: string, value: number) => void
  mark: (owner: string) => void
  phase: (owner: string, active: boolean) => void
  currentPhase?: () => string
}

declare global {
  var __dawPerformanceBenchmark: PerformanceBenchmarkCollector | undefined
}

export const incrementPerformanceBenchmarkCounter = (owner: string, amount = 1) => {
  globalThis.__dawPerformanceBenchmark?.increment(owner, amount)
}

export const measurePerformanceBenchmark = <Value>(
  owner: string,
  work: () => Value,
): Value => {
  const collector = globalThis.__dawPerformanceBenchmark
  if (!collector) return work()
  const startedAt = performance.now()
  try { return work() }
  finally { collector.duration(owner, Math.max(0, performance.now() - startedAt)) }
}

export const beginPerformanceBenchmark = (): number | undefined => (
  globalThis.__dawPerformanceBenchmark ? performance.now() : undefined
)

export const endPerformanceBenchmark = (owner: string, startedAt: number | undefined) => {
  if (startedAt === undefined) return
  globalThis.__dawPerformanceBenchmark?.duration(owner, Math.max(0, performance.now() - startedAt))
}

export const setPerformanceBenchmarkGauge = (owner: string, value: number) => {
  globalThis.__dawPerformanceBenchmark?.gauge(owner, value)
}

export const markPerformanceBenchmark = (owner: string) => {
  globalThis.__dawPerformanceBenchmark?.mark(owner)
}

export const withPerformanceBenchmarkPhase = async <Value>(
  owner: string,
  work: () => Promise<Value>,
): Promise<Value> => {
  globalThis.__dawPerformanceBenchmark?.phase(owner, true)
  try { return await work() }
  finally { globalThis.__dawPerformanceBenchmark?.phase(owner, false) }
}
