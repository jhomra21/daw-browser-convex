import { type Accessor, type JSX, createEffect, createSignal, onCleanup } from "solid-js";
import {
  disableProjectBackup,
  duplicateCloudBackupAsLocalProject,
  restoreCloudBackupToLocalProject,
  runProjectBackup,
} from "~/lib/cloud-backup";
import { downloadCloudAssetsForOffline } from "~/lib/cloud-asset-cache";
import { setLocalProjectAssetDirectory } from "~/lib/local-assets";
import { isLocalId } from "@daw-browser/shared";
import { subscribeToLocalProjectChanges } from "~/lib/local-project-changes";
import { flushSharedOutbox, readSharedOutboxSummary } from "~/lib/shared-outbox";
import type { CloudBackupDialogState } from "~/components/timeline/cloud-backup-dialog";

type Input = {
  projectId: Accessor<string>;
  userId: Accessor<string | undefined>;
  navigateToRoom: (projectId: string) => void;
};

export type CloudBackupStatus = "idle" | "backing-up" | "backed-up" | "failed";

export const useLocalProjectActions = (input: Input) => {
  const [localSaveFailure, setLocalSaveFailure] = createSignal<string | null>(null);
  const [backupConflictProjectId, setBackupConflictProjectId] = createSignal<string | null>(null);
  const [cloudBackupDialog, setCloudBackupDialog] = createSignal<CloudBackupDialogState | null>(null);
  const [cloudBackupBusy, setCloudBackupBusy] = createSignal(false);
  const [cloudBackupStatus, setCloudBackupStatus] = createSignal<CloudBackupStatus>("idle");
  const [sharedOutboxStatus, setSharedOutboxStatus] = createSignal({ pending: 0, failed: 0 });
  const [localTimelineReloadVersion, setLocalTimelineReloadVersion] = createSignal(0);

  createEffect(() => {
    const rid = input.projectId();
    const uid = input.userId();
    if (!rid || !uid || isLocalId("project", rid)) {
      setSharedOutboxStatus({ pending: 0, failed: 0 });
      return;
    }
    const refresh = () => {
      void readSharedOutboxSummary(rid, uid)
        .then(setSharedOutboxStatus)
        .catch(() => setSharedOutboxStatus({ pending: 0, failed: 0 }));
    };
    refresh();
    const unsubscribe = subscribeToLocalProjectChanges(rid, refresh);
    onCleanup(unsubscribe);
  });

  const describeBackupConflict = (conflict: Awaited<ReturnType<typeof runProjectBackup>>["conflict"]) => {
    if (!conflict) return "Cloud backup conflict detected.";
    return [
      "Cloud backup conflict detected.",
      `Local updated: ${new Date(conflict.localUpdatedAt).toLocaleString()}.`,
      `Cloud updated: ${new Date(conflict.cloudUpdatedAt).toLocaleString()}.`,
      `Local rows/assets: ${conflict.localEntityCount}/${conflict.localAssetCount}.`,
      `Cloud rows/assets: ${conflict.cloudEntityCount}/${conflict.cloudAssetCount}.`,
      "Choose Back up now again to overwrite cloud, Restore cloud backup, or Duplicate cloud backup.",
    ].join(" ");
  };

  const chooseProjectStorageFolder = async () => {
    const rid = input.projectId();
    const openDirectoryPicker = window.showDirectoryPicker;
    if (!rid || !isLocalId("project", rid) || !openDirectoryPicker) {
      setLocalSaveFailure("Folder storage is not supported in this browser.");
      return;
    }

    try {
      const handle = await openDirectoryPicker();
      await setLocalProjectAssetDirectory(rid, handle);
      setLocalSaveFailure("Project storage folder is ready.");
    } catch {
      setLocalSaveFailure("Project storage folder was not changed.");
    }
  };

  const onArchiveInput: JSX.EventHandler<HTMLInputElement, Event> = async (event) => {
    const inputElement = event.currentTarget;
    const file = inputElement.files?.[0];
    if (file) {
      try {
        const { importDawProjectArchive } = await import("~/lib/project-archive");
        const nextProjectId = await importDawProjectArchive(file);
        input.navigateToRoom(nextProjectId);
      } catch (error) {
        setLocalSaveFailure(error instanceof Error ? error.message : "Archive import failed.");
      }
    }
    inputElement.value = "";
  };

  const backUpNow = async (options: { projectId?: string; skipIfUnchanged?: boolean } = {}) => {
    const rid = options.projectId ?? input.projectId();
    if (!rid || !isLocalId("project", rid)) return;
    setCloudBackupStatus("backing-up");
    const result = await runProjectBackup(rid, "detect", options);
    if (!result.ok) {
      setBackupConflictProjectId(result.conflict ? rid : null);
      const message = result.conflict ? describeBackupConflict(result.conflict) : result.error ?? "Cloud backup failed.";
      setLocalSaveFailure(message);
      if (result.conflict) setCloudBackupDialog({ type: "conflict", message });
      setCloudBackupStatus("failed");
      return;
    }
    setBackupConflictProjectId(null);
    setLocalSaveFailure(null);
    setCloudBackupStatus("backed-up");
  };

  const overwriteCloudBackup = async () => {
    const rid = backupConflictProjectId() ?? input.projectId();
    if (!rid || !isLocalId("project", rid)) return;
    setCloudBackupBusy(true);
    setCloudBackupStatus("backing-up");
    const result = await runProjectBackup(rid, "overwrite");
    if (!result.ok) {
      const message = result.conflict ? describeBackupConflict(result.conflict) : result.error ?? "Cloud backup failed.";
      setLocalSaveFailure(message);
      if (result.conflict) setCloudBackupDialog({ type: "conflict", message });
      setCloudBackupStatus("failed");
      setCloudBackupBusy(false);
      return;
    }
    setBackupConflictProjectId(null);
    setLocalSaveFailure(null);
    setCloudBackupDialog(null);
    setCloudBackupStatus("backed-up");
    setCloudBackupBusy(false);
  };

  const disableBackup = async () => {
    const rid = input.projectId();
    if (!rid || !isLocalId("project", rid)) return;
    await disableProjectBackup(rid);
    setLocalSaveFailure(null);
    setCloudBackupStatus("idle");
  };

  const restoreCloudBackup = async () => {
    setCloudBackupDialog({ type: "restore" });
  };

  const confirmRestoreCloudBackup = async () => {
    const rid = input.projectId();
    if (!rid || !isLocalId("project", rid)) return;
    setCloudBackupBusy(true);
    try {
      await restoreCloudBackupToLocalProject(rid);
      setLocalTimelineReloadVersion((version) => version + 1);
      setBackupConflictProjectId(null);
      setLocalSaveFailure(null);
      setCloudBackupDialog(null);
    } catch (error) {
      setLocalSaveFailure(error instanceof Error ? error.message : "Cloud backup restore failed.");
    } finally {
      setCloudBackupBusy(false);
    }
  };

  const duplicateCloudBackup = async () => {
    const rid = input.projectId();
    if (!rid || !isLocalId("project", rid)) return;
    setCloudBackupBusy(true);
    try {
      const nextProjectId = await duplicateCloudBackupAsLocalProject(rid);
      setBackupConflictProjectId(null);
      setLocalSaveFailure(null);
      setCloudBackupDialog(null);
      input.navigateToRoom(nextProjectId);
    } catch (error) {
      setLocalSaveFailure(error instanceof Error ? error.message : "Cloud backup duplicate failed.");
    } finally {
      setCloudBackupBusy(false);
    }
  };

  const downloadForOffline = async () => {
    const rid = input.projectId();
    if (!rid || !isLocalId("project", rid)) return;
    try {
      const downloaded = await downloadCloudAssetsForOffline(rid);
      setLocalSaveFailure(null);
      setCloudBackupDialog({
        type: "message",
        title: "Download for offline complete",
        message: downloaded === 0 ? "All cloud assets are already available offline." : `Downloaded ${downloaded} cloud asset${downloaded === 1 ? "" : "s"} for offline use.`,
      });
    } catch (error) {
      setLocalSaveFailure(error instanceof Error ? error.message : "Download for offline failed.");
    }
  };

  const retrySharedChanges = async () => {
    const rid = input.projectId();
    const uid = input.userId();
    if (!rid || isLocalId("project", rid) || !uid) return;
    const status = await flushSharedOutbox(rid, uid, { retryFailed: true });
    setSharedOutboxStatus(status);
  };

  const exportArchive = async () => {
    const rid = input.projectId();
    if (!isLocalId("project", rid)) return;
    try {
      const { exportDawProjectArchive } = await import("~/lib/project-archive");
      const blob = await exportDawProjectArchive(rid);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${rid}.dawproject`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setLocalSaveFailure(error instanceof Error ? error.message : "Archive export failed.");
    }
  };

  return {
    localSaveFailure,
    setLocalSaveFailure,
    cloudBackupStatus,
    chooseProjectStorageFolder,
    onArchiveInput,
    backUpNow,
    cloudBackupDialog,
    cloudBackupBusy,
    setCloudBackupDialog,
    overwriteCloudBackup,
    disableBackup,
    restoreCloudBackup,
    confirmRestoreCloudBackup,
    duplicateCloudBackup,
    downloadForOffline,
    sharedOutboxStatus,
    localTimelineReloadVersion,
    retrySharedChanges,
    exportArchive,
  };
};
