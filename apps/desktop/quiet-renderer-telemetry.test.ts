import { expect, test } from "bun:test"
import { boundedRendererEvents, classifyNavigationUrl, summarizeRendererMetrics } from "./quiet-renderer-telemetry"

test("keeps only the latest 32 safe renderer events", () => {
  const events = Array.from({ length: 40 }, (_, index) => ({
    elapsedMs: index, name: "navigation", pid: 42, urlClass: "app",
  }))
  expect(boundedRendererEvents(events)).toHaveLength(32)
  expect(boundedRendererEvents(events)[0]?.elapsedMs).toBe(8)
  expect(classifyNavigationUrl("daw://app/?projectId=secret")).toBe("app")
  expect(classifyNavigationUrl("https://example.com/private?token=secret")).toBe("other")
})

test("summarizes samples in Electron memory kilobytes and CPU percentages", () => {
  const samples = [
    { elapsedMs: 0, pid: 12, workingSetKiB: 100, peakWorkingSetKiB: 110, cpuPercent: 10 },
    { elapsedMs: 30_000, pid: 12, workingSetKiB: 150, peakWorkingSetKiB: 150, cpuPercent: 20 },
    { elapsedMs: 60_000, pid: 12, workingSetKiB: 200, peakWorkingSetKiB: 240, cpuPercent: 30 },
  ]
  expect(summarizeRendererMetrics(samples, 12)).toEqual({
    startBytes: 102400, at30sBytes: 153600, at60sBytes: 204800,
    endBytes: 204800, peakBytes: 204800, deltaBytes: 102400,
    cpuAveragePercent: 20, cpuP95Percent: 30, cpuPeakPercent: 30,
  })
})

test("measurement excludes import and preload memory peaks", () => {
  const samples = [
    { elapsedMs: 1000, pid: 12, workingSetKiB: 1000, peakWorkingSetKiB: 1100, cpuPercent: 30 },
    { elapsedMs: 10_000, pid: 12, workingSetKiB: 200, peakWorkingSetKiB: 1100, cpuPercent: 10 },
    { elapsedMs: 70_000, pid: 12, workingSetKiB: 210, peakWorkingSetKiB: 1100, cpuPercent: 12 },
  ]
  expect(summarizeRendererMetrics(samples, 12, 10_000)?.deltaBytes).toBe(10 * 1024)
  expect(summarizeRendererMetrics(samples, 12, 10_000)?.startBytes).toBe(200 * 1024)
  expect(summarizeRendererMetrics(samples, 12, 10_000)?.peakBytes).toBe(210 * 1024)
})
