import type { ExternalProcessor } from "@daw-browser/external-plugins";

export type Vst3ScanHealth = "filesystem-only" | "scanned" | "scan-failed";

const scanHealthLabels: Record<Vst3ScanHealth, string> = {
  "filesystem-only": "Filesystem-only",
  scanned: "Scanned",
  "scan-failed": "Scan failed",
};

export const vst3ScanHealthLabel = (health: Vst3ScanHealth) => scanHealthLabels[health];

export const externalProcessorStatusLabel = (
  processor: Pick<ExternalProcessor, "bypassed" | "health">,
) => {
  if (!processor.bypassed && processor.health.state === "ready") return "Enabled · Preflight passed";
  const bypass = processor.bypassed ? "Bypassed" : "Enabled";
  const health = processor.health.state.charAt(0).toUpperCase() + processor.health.state.slice(1);
  return `${bypass} · ${health}`;
};

export const selectExternalProcessorsForTarget = (
  processors: readonly ExternalProcessor[],
  targetId: string,
): ExternalProcessor[] => processors
  .filter((processor) => processor.targetId === targetId)
  .sort((left, right) => (
    left.chainIndex - right.chainIndex
    || left.updatedAt - right.updatedAt
    || left.instanceId.localeCompare(right.instanceId)
  ));
