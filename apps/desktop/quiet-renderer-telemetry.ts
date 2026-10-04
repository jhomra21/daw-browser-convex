type RendererEvent = {
  elapsedMs: number
  name: string
  pid: number
  urlClass?: string
  reason?: string
}

type RendererMetric = {
  elapsedMs: number
  pid: number
  workingSetKiB: number
  peakWorkingSetKiB: number
  cpuPercent: number
}

export const classifyNavigationUrl = (url: string) => {
  try {
    const parsed = new URL(url)
    return parsed.protocol === "daw:" && parsed.hostname === "app" ? "app" : "other"
  } catch { return "invalid" }
}

export const boundedRendererEvents = (events: readonly RendererEvent[]) => events.slice(-32)

export const summarizeRendererMetrics = (samples: readonly RendererMetric[], pid: number, startAtMs = 0) => {
  const selected = samples.filter((sample) => sample.pid === pid && sample.elapsedMs >= startAtMs)
  if (selected.length === 0) return null
  const at = (elapsedMs: number) => selected.reduce((nearest, sample) =>
    Math.abs(sample.elapsedMs - startAtMs - elapsedMs) < Math.abs(nearest.elapsedMs - startAtMs - elapsedMs) ? sample : nearest)
  const cpus = selected.map((sample) => sample.cpuPercent).sort((a, b) => a - b)
  return {
    startBytes: selected[0]!.workingSetKiB * 1024,
    at30sBytes: at(30_000).workingSetKiB * 1024,
    at60sBytes: at(60_000).workingSetKiB * 1024,
    endBytes: selected.at(-1)!.workingSetKiB * 1024,
    peakBytes: Math.max(...selected.map((sample) => sample.workingSetKiB)) * 1024,
    deltaBytes: (selected.at(-1)!.workingSetKiB - selected[0]!.workingSetKiB) * 1024,
    cpuAveragePercent: cpus.reduce((sum, cpu) => sum + cpu, 0) / cpus.length,
    cpuP95Percent: cpus[Math.ceil(cpus.length * 0.95) - 1]!,
    cpuPeakPercent: cpus.at(-1)!,
  }
}
