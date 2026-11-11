import { type Accessor, type JSX, createEffect, createSignal, onCleanup } from "solid-js";
import {
  disableProjectBackup,
  duplicateCloudBackupAsLocalProject,
  restoreCloudBackupToLocalProject,
  runProjectBackup,
} from "~/lib/cloud-backup";
import { downloadCloudAssetsForOffline } from "~/lib/cloud-asset-cache";
import { isAbortError } from "~/lib/dom-errors";
import { setLocalProjectAssetDirectory } from "~/lib/local-assets";
import { isLocalId } from "@daw-browser/shared";
import { chooseLocalExportFile, createLocalExportWritable, downloadBlob } from "~/lib/local-export";
import { subscribeToLocalProjectChanges } from "~/lib/local-project-changes";
import { flushSharedOutbox, readSharedOutboxSummary } from "~/lib/shared-outbox";
import type { CloudBackupDialogState } from "~/components/timeline/cloud-backup-dialog";

type Input = {
  projectId: Accessor<string>;
  userId: Accessor<string | undefined>;
  navigateToRoom: (projectId: string) => void;
  notify: (title: string, message: string) => void;
};

export type CloudBackupStatus = "idle" | "backing-up" | "backed-up" | "failed";

export const useLocalProjectActions = (input: Input) => {
  // Persistence producers report failures without a success signal, so each project's
  // failure stays until it is dismissed while that project is open.
  const [saveFailures, setSaveFailures] = createSignal<ReadonlyMap<string, string>>(new Map());
  const localSaveFailure = () => saveFailures().get(input.projectId()) ?? null;
  const setLocalSaveFailure = (projectId: string, message: string | null) => {
    setSaveFailures((current) => {
      const next = new Map(current);
      if (message === null) next.delete(projectId);
      else next.set(projectId, message);
      return next;
    });
  };
  const [backupConflictProjectId, setBackupConflictProjectId] = createSignal<string | null>(null);
  const [cloudBackupDialog, setCloudBackupDialog] = createSignal<CloudBackupDialogState | null>(null);
  const [cloudBackupBusy, setCloudBackupBusy] = createSignal(false);
  const [cloudBackupStatus, setCloudBackupStatus] = createSignal<CloudBackupStatus>("idle");
  const [sharedOutboxStatus, setSharedOutboxStatus] = createSignal<{ pending: number; failed: number } | null>(null);
  const [localTimelineReloadVersion, setLocalTimelineReloadVersion] = createSignal(0);

  createEffect(() => {
    const rid = input.projectId();
    const uid = input.userId();
    setSharedOutboxStatus(null);
    if (!rid || !uid || isLocalId("project", rid)) return;
    let active = true;
    let latestRequest = 0;
    onCleanup(() => { active = false; });
    const refresh = () => {
      const request = ++latestRequest;
      const isCurrent = () => active && request === latestRequest;
      void readSharedOutboxSummary(rid, uid).then(
        (summary) => { if (isCurrent()) setSharedOutboxStatus(summary); },
        () => { if (isCurrent()) setSharedOutboxStatus(null); },
      );
    };
    refresh();
    onCleanup(subscribeToLocalProjectChanges(rid, refresh));
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
      input.notify("Project folder not changed", "Folder storage is not supported in this browser.");
      return;
    }

    try {
      const handle = await openDirectoryPicker();
      await setLocalProjectAssetDirectory(rid, handle);
    } catch (error) {
      if (!isAbortError(error)) input.notify("Project folder not changed", "Project storage folder was not changed.");
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
        input.notify("Archive import failed", error instanceof Error ? error.message : "Archive import failed.");
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
      if (result.conflict) setCloudBackupDialog({ type: "conflict", message: describeBackupConflict(result.conflict) });
      // Background sync ticks pass skipIfUnchanged; their failures surface through the badge, not a dialog per tick.
      else if (!options.skipIfUnchanged) setCloudBackupDialog({ type: "message", title: "Cloud backup failed", message: result.error ?? "Cloud backup failed." });
      setCloudBackupStatus("failed");
      return;
    }
    setBackupConflictProjectId(null);
    setCloudBackupStatus("backed-up");
  };

  const overwriteCloudBackup = async () => {
    const rid = backupConflictProjectId() ?? input.projectId();
    if (!rid || !isLocalId("project", rid)) return;
    setCloudBackupBusy(true);
    setCloudBackupStatus("backing-up");
    const result = await runProjectBackup(rid, "overwrite");
    if (!result.ok) {
      setCloudBackupDialog(result.conflict
        ? { type: "conflict", message: describeBackupConflict(result.conflict) }
        : { type: "message", title: "Cloud backup failed", message: result.error ?? "Cloud backup failed." });
      setCloudBackupStatus("failed");
      setCloudBackupBusy(false);
      return;
    }
    setBackupConflictProjectId(null);
    setCloudBackupDialog(null);
    setCloudBackupStatus("backed-up");
    setCloudBackupBusy(false);
  };

  const disableBackup = async () => {
    const rid = input.projectId();
    if (!rid || !isLocalId("project", rid)) return;
    await disableProjectBackup(rid);
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
      setCloudBackupDialog(null);
    } catch (error) {
      setCloudBackupDialog({
        type: "message",
        title: "Cloud backup restore failed",
        message: error instanceof Error ? error.message : "Cloud backup restore failed.",
      });
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
      setCloudBackupDialog(null);
      input.navigateToRoom(nextProjectId);
    } catch (error) {
      setCloudBackupDialog({
        type: "message",
        title: "Cloud backup duplicate failed",
        message: error instanceof Error ? error.message : "Cloud backup duplicate failed.",
      });
    } finally {
      setCloudBackupBusy(false);
    }
  };

  const downloadForOffline = async () => {
    const rid = input.projectId();
    if (!rid || !isLocalId("project", rid)) return;
    try {
      const downloaded = await downloadCloudAssetsForOffline(rid);
      setCloudBackupDialog({
        type: "message",
        title: "Download for offline complete",
        message: downloaded === 0 ? "All cloud assets are already available offline." : `Downloaded ${downloaded} cloud asset${downloaded === 1 ? "" : "s"} for offline use.`,
      });
    } catch (error) {
      setCloudBackupDialog({
        type: "message",
        title: "Download for offline failed",
        message: error instanceof Error ? error.message : "Download for offline failed.",
      });
    }
  };

  const retrySharedChanges = async () => {
    const rid = input.projectId();
    const uid = input.userId();
    if (!rid || isLocalId("project", rid) || !uid) return;
    const status = await flushSharedOutbox(rid, uid, { retryFailed: true });
    if (input.projectId() === rid && input.userId() === uid) setSharedOutboxStatus(status);
  };

  const exportArchive = async () => {
    const rid = input.projectId();
    if (!isLocalId("project", rid)) return;
    const suggestedName = `${rid}.dawproject`;
    try {
      const { exportDawProjectArchive, exportDawProjectArchiveStreamed } = await import("~/lib/project-archive");
      let handle: FileSystemFileHandle | undefined;
      try {
        handle = await chooseLocalExportFile({ suggestedName });
      } catch (error) {
        if (isAbortError(error)) return;
        throw error;
      }
      if (!handle) {
        const blob = await exportDawProjectArchive(rid);
        downloadBlob({ blob, suggestedName });
        return;
      }
      const { writable } = await createLocalExportWritable(handle);
      try {
        await exportDawProjectArchiveStreamed(rid, (chunk) => {
          const bytes = new Uint8Array(chunk.byteLength);
          bytes.set(chunk);
          return writable.write(bytes.buffer);
        });
        await writable.close();
      } catch (error) {
        try {
          await writable.abort();
        } catch {}
        throw error;
      }
    } catch (error) {
      input.notify("Archive export failed", error instanceof Error ? error.message : "Archive export failed.");
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
