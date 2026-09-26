import type { BrowserProbeResult } from "./probe"
import type { runTierThree } from "./tier-three"
export type TierThreeEvidence = Awaited<ReturnType<typeof runTierThree>>
export type TierThreeOutcome = TierThreeEvidence | {
  readonly status: "failed"
  readonly stage: string
  readonly reason: string
  readonly failureEvidencePath: string
  readonly issue48LiveReEnableCertification: "not-attempted"
}

export const deriveTierThreeFailures = (requested: boolean, outcome: TierThreeOutcome | undefined): string[] => {
  if (!requested) return []
  if (!outcome) return ["Tier 3 workload did not produce a result."]
  return outcome.status === "failed" ? [`Tier 3 failed at ${outcome.stage}: ${outcome.reason}`] : []
}
import type { NativeDiagnosticDelta, ProcessMetric } from "./electron"
import type { z } from "zod"
import type { desktopDiagnosticsSchemaV2, desktopHostStatusSchemaV1, desktopTransportStatusSchemaV1 } from "@daw-browser/desktop-protocol"

export type SourceIdentity = {
  readonly commit: string
  readonly dirty: boolean
}

export type ElectronBenchmarkEvidence = {
  readonly package: {
    readonly identity: "electron-forge-production"
    readonly platform: "darwin"
    readonly architecture: "arm64"
    readonly electronVersion: string
    readonly appVersion: string
    readonly asarSha256: string
    readonly sourceCommit: string
  }
  readonly rendererProbe: BrowserProbeResult
  readonly host: {
    readonly beforeImport: z.infer<typeof desktopHostStatusSchemaV1>
    readonly mounted: z.infer<typeof desktopHostStatusSchemaV1>
    readonly beforePlayback: z.infer<typeof desktopDiagnosticsSchemaV2>
    readonly afterPlayback: z.infer<typeof desktopDiagnosticsSchemaV2>
    readonly afterStop: z.infer<typeof desktopDiagnosticsSchemaV2>
    readonly nativePlaybackDelta: NativeDiagnosticDelta | null
  }
  readonly transport: {
    readonly playing: z.infer<typeof desktopTransportStatusSchemaV1>
    readonly stopped: z.infer<typeof desktopTransportStatusSchemaV1>
  }
  readonly processMetrics: {
    readonly availability: "available" | "unavailable"
    readonly reason: string | null
    readonly before: readonly ProcessMetric[]
    readonly duringPlayback: readonly ProcessMetric[]
    readonly afterStop: readonly ProcessMetric[]
  }
  readonly hardGates: {
    readonly packageFresh: boolean
    readonly hostReady: boolean
    readonly diagnosticsClean: boolean
    readonly transportVerified: boolean
    readonly nativeCallbacksIncreased: boolean
    readonly tier2DevicesVisible: boolean
    readonly noRendererErrors: boolean
  }
}

export type ElectronBenchmarkProgress = {
  readonly status: "running" | "complete" | "failed"
  readonly stage: string
  readonly error?: string
  readonly failureEvidencePath?: string
  readonly package?: ElectronBenchmarkEvidence["package"]
  readonly rendererProbe?: BrowserProbeResult
  readonly host?: Partial<ElectronBenchmarkEvidence["host"]>
  readonly transport?: Partial<ElectronBenchmarkEvidence["transport"]>
  readonly processMetrics?: Partial<ElectronBenchmarkEvidence["processMetrics"]>
  readonly hardGates?: Partial<ElectronBenchmarkEvidence["hardGates"]>
  readonly tier3?: TierThreeOutcome
}

export const electronHardGatesPassed = (
  hardGates: ElectronBenchmarkEvidence["hardGates"],
): boolean => Object.values(hardGates).every(Boolean)

export const tierTwoDevicesVisible = (
  probe: BrowserProbeResult,
): boolean => Object.values(probe.integrity.tier2VisibleWorkload).every(Boolean)

export const deriveUnavailable = (surface: "browser" | "electron", probe: BrowserProbeResult | null): string[] => {
  const unavailable = new Set<string>()
  if (surface === "electron" && probe === null) unavailable.add("electron-surface-not-run")
  if (probe === null || probe.phases.every((phase) => !phase.raf.supported)) unavailable.add("raf-not-delivered")
  if (probe === null || !probe.display.viewportSupported) unavailable.add("viewport-not-reported")
  if (probe === null || probe.phases.every((phase) => !phase.longTasks.supported)) unavailable.add("long-task-observer-unavailable")
  unavailable.add("canvas-attribution-not-instrumented")
  return [...unavailable]
}

export const deriveProbeErrors = (probe: BrowserProbeResult): string[] => (
  [
    ...probe.startupErrors,
    ...probe.phases.flatMap((phase) => phase.errors),
  ].map((error) => `${error.kind}: ${error.message}`)
)

export const deriveRequiredTier2Failures = (
  surface: "browser" | "electron",
  probe: BrowserProbeResult,
): string[] => {
  const visible = probe.integrity.tier2VisibleWorkload
  return [
    ...(visible.trackSelected ? [] : ["Tier 2 Synth track was not selected through the rendered UI."]),
    ...(visible.effectsPanelOpened ? [] : ["Effects panel was not opened through the rendered UI."]),
    ...(visible.synthVisible ? [] : ["Tier 2 Synth device was not visibly rendered."]),
    ...(visible.saturatorVisible ? [] : ["Tier 2 Saturator device was not visibly rendered."]),
    ...(visible.utilityVisible ? [] : ["Tier 2 Utility device was not visibly rendered."]),
    ...(surface !== "browser" || probe.integrity.meterEvidence.status === "observed"
      ? []
      : ["Tier 2 selected-track meter activity was unavailable."]),
    ...(surface !== "browser" || probe.integrity.meterEvidence.activityDetected
      ? []
      : probe.integrity.meterEvidence.status === "observed"
        ? ["Tier 2 selected-track meter did not show playback activity."]
        : []),
  ]
}
