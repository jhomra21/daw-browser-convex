import { isLocalId } from "@daw-browser/shared";
import type { CloudBackupStatus } from "~/hooks/useLocalProjectActions";
import type { LocalProjectMode } from "~/lib/local-project-db";

type SharedOutboxSummary = {
  pending: number;
  failed: number;
};

export type ProjectSaveStatusInput = {
  projectId: string;
  userId?: string;
  mode?: LocalProjectMode;
  sharedOutboxStatus?: SharedOutboxSummary | null;
  cloudBackupStatus?: CloudBackupStatus;
};

const badgeClassByStatus = {
  none: "border-neutral-800 bg-neutral-900/70 text-neutral-400",
  local: "border-emerald-900/70 bg-emerald-950/40 text-emerald-300",
  cloud: "border-sky-900/70 bg-sky-950/40 text-sky-300",
  signedOut: "border-amber-900/70 bg-amber-950/40 text-amber-300",
};

export const getProjectSaveStatus = (input: ProjectSaveStatusInput) => {
  if (!input.projectId) {
    return {
      label: "No project open",
      shortLabel: "No project",
      compactLabel: "None",
      class: badgeClassByStatus.none,
    };
  }

  const pending = input.sharedOutboxStatus?.pending ?? 0;
  const failed = input.sharedOutboxStatus?.failed ?? 0;
  if (pending + failed > 0) {
    return {
      label: `${pending} shared change${pending === 1 ? "" : "s"} pending, ${failed} failed`,
      shortLabel: "Sync pending",
      compactLabel: "Cloud",
      class: input.userId ? badgeClassByStatus.cloud : badgeClassByStatus.signedOut,
    };
  }

  const isLocalProject = isLocalId("project", input.projectId);
  if (isLocalProject && input.mode === "backup") {
    if (input.cloudBackupStatus === "backing-up") {
      return { label: "Backing up to cloud", shortLabel: "Backing up", compactLabel: "Local", class: badgeClassByStatus.local };
    }
    if (input.cloudBackupStatus === "backed-up") {
      return { label: "Backed up to cloud", shortLabel: "Backed up", compactLabel: "Local", class: badgeClassByStatus.local };
    }
    if (input.cloudBackupStatus === "failed") {
      return { label: "Cloud backup failed", shortLabel: "Backup failed", compactLabel: "Local", class: badgeClassByStatus.local };
    }
    return { label: "Cloud backup enabled", shortLabel: "Backup enabled", compactLabel: "Local", class: badgeClassByStatus.local };
  }

  if (isLocalProject) {
    return { label: "Saved locally on this device", shortLabel: "Saved locally", compactLabel: "Local", class: badgeClassByStatus.local };
  }

  if (input.userId) {
    return { label: "Saved to cloud project", shortLabel: "Cloud saved", compactLabel: "Cloud", class: badgeClassByStatus.cloud };
  }

  return { label: "Sign in to sync this project", shortLabel: "Sign in to sync", compactLabel: "Cloud", class: badgeClassByStatus.signedOut };
};
