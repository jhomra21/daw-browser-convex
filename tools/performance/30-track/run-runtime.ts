import { installBrowserProbe, type BrowserProbeCoordinator, type PhaseName, type ProbeIntegrityPatch } from "./probe"
import { assertThirtyTrackSnapshot, createTierTwoControlClient } from "./tier-two"

type BenchmarkApi = {
  startPhase: (name: PhaseName, parameters: Readonly<Record<string, boolean | number | string>>) => void
  finishPhase: () => void
  setIntegrity: (patch: ProbeIntegrityPatch) => void
  recordError: (message: string) => void
  verifyTier2Snapshot: () => Promise<void>
  state: () => {
    readonly url: string
    readonly localProjectId: string | null
    readonly trackLabels: string[]
    readonly clipTitles: string[]
    readonly timeline: HTMLElement | null
    readonly sidebar: HTMLElement | null
    readonly ruler: HTMLElement | null
    readonly playhead: string | null
    readonly saveStatus: string | null
    readonly isPlaying: boolean
    readonly serviceWorkerControllerAbsent: boolean
  }
  finish: () => void
}

const coordinator: BrowserProbeCoordinator = installBrowserProbe()
const localProjectPattern = /(?:^|[?&])projectId=([^&]+)/
const initialServiceWorkerControllerAbsent = navigator.serviceWorker === undefined || navigator.serviceWorker.controller === null

const state = () => {
  const labels = [...document.querySelectorAll<HTMLElement>("[aria-label^='Select track ']")]
    .map((element) => element.getAttribute("aria-label") ?? "")
  const clips = [...document.querySelectorAll<HTMLElement>("[title$=' Clip']")]
    .map((element) => element.getAttribute("title") ?? "")
  const timelineRuler = document.querySelector<HTMLElement>("[data-timeline-ruler='1']")
  let timeline: HTMLElement | null = timelineRuler?.parentElement ?? null
  while (timeline && getComputedStyle(timeline).overflowX !== "auto" && getComputedStyle(timeline).overflowY !== "auto") {
    timeline = timeline.parentElement
  }
  const sidebar = [...document.querySelectorAll<HTMLElement>("div")].find((element) => (
    getComputedStyle(element).overflowY === "auto"
    && element.querySelector("[aria-label^='Select track ']") !== null
  )) ?? null
  const playButton = document.querySelector<HTMLButtonElement>("button[aria-label='Play']")
  const pauseButton = document.querySelector<HTMLButtonElement>("button[aria-label='Pause']")
  const playhead = [...document.querySelectorAll<HTMLElement>("span")].find((element) => /^\d+\.\d{2}s$/.test(element.textContent?.trim() ?? ""))?.textContent?.trim() ?? null
  const saveStatus = document.querySelector<HTMLButtonElement>("button[aria-label^='Saved locally']")?.getAttribute("aria-label") ?? null
  return {
    url: location.href,
    localProjectId: (() => {
      const value = localProjectPattern.exec(location.search)?.[1]
      return value === undefined ? null : decodeURIComponent(value)
    })(),
    trackLabels: labels,
    clipTitles: clips,
    timeline,
    sidebar,
    ruler: timelineRuler,
    playhead,
    saveStatus,
    isPlaying: pauseButton !== null && playButton === null,
    serviceWorkerControllerAbsent: initialServiceWorkerControllerAbsent,
  }
}

const startPhase = (name: PhaseName, parameters: Readonly<Record<string, boolean | number | string>>) => coordinator.startPhase(name, parameters)

const benchmarkApi: BenchmarkApi = {
  startPhase,
  finishPhase: () => coordinator.finishPhase(),
  setIntegrity: (patch) => coordinator.setIntegrity(patch),
  recordError: (message) => coordinator.recordError(message),
  verifyTier2Snapshot: async () => {
    const projectId = state().localProjectId
    if (!projectId) throw new Error("Imported local project ID is unavailable.")
    const control = createTierTwoControlClient(projectId)
    assertThirtyTrackSnapshot(await control.snapshotV2())
  },
  state,
  finish: () => {
    const result = coordinator.finish()
    Object.defineProperty(window, "__thirtyTrackProbeResult", { configurable: true, value: result })
  },
}

Object.defineProperty(window, "__thirtyTrackBenchmark", {
  configurable: true,
  value: benchmarkApi,
})
