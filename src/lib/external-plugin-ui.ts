import type { ExternalProcessor } from "@daw-browser/external-plugins";

export type Vst3ScanHealth = "filesystem-only" | "scanned" | "scan-failed";

export const vst3TrustDisclosure = {
  title: "VST3 plug-ins are native software",
  body: "Only install plug-ins you trust. They run with your desktop user's authority; process isolation protects stability, but it is not a security sandbox.",
  acknowledgement: "I understand and trust the VST3 plug-ins I add.",
} satisfies Readonly<Record<"title" | "body" | "acknowledgement", string>>;

export const vst3TrustAcknowledgementStorageKey = "daw:vst3-trust-acknowledged";

export type NativeVst3PlaybackFaultKind = "launch-authorization-required";

const nativeVst3LaunchAuthorizationRequiredMessage =
  "A native VST3 attachment is stale or no longer trusted.";

export const classifyNativeVst3PlaybackFault = (
  message: string,
): NativeVst3PlaybackFaultKind | undefined => (
  message === nativeVst3LaunchAuthorizationRequiredMessage
    ? "launch-authorization-required"
    : undefined
);

export const canUseVst3CatalogAction = (
  action: "read" | "add-directory" | "remove-directory" | "scan",
  trustAcknowledged: boolean,
): boolean => action === "read" || action === "remove-directory" || trustAcknowledged;

export const hasVst3TrustAcknowledgement = (
  storage: Pick<Storage, "getItem"> | undefined,
): boolean => {
  try {
    return storage?.getItem(vst3TrustAcknowledgementStorageKey) === "true";
  } catch {
    return false;
  }
};

export const saveVst3TrustAcknowledgement = (
  storage: Pick<Storage, "setItem"> | undefined,
): void => {
  try {
    storage?.setItem(vst3TrustAcknowledgementStorageKey, "true");
  } catch {
    // A restricted browser profile must not block the desktop UI.
  }
};

const scanHealthLabels = {
  "filesystem-only": "Filesystem-only",
  scanned: "Scanned",
  "scan-failed": "Scan failed",
} satisfies Record<Vst3ScanHealth, string>;

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
    left.index - right.index
    || left.updatedAt - right.updatedAt
    || left.instanceId.localeCompare(right.instanceId)
  ));
