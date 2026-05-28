import { type Accessor, type JSX, createSignal } from "solid-js";
import { runProjectBackup } from "~/lib/cloud-backup";
import { setLocalProjectAssetDirectory } from "~/lib/local-assets";
import { isLocalId } from "~/lib/local-ids";
import { exportDawProjectArchive, importDawProjectArchive } from "~/lib/project-archive";

type Input = {
  projectId: Accessor<string>;
  navigateToRoom: (projectId: string) => void;
};

export const useLocalProjectActions = (input: Input) => {
  const [localSaveFailure, setLocalSaveFailure] = createSignal<string | null>(null);
  const [backupConflictProjectId, setBackupConflictProjectId] = createSignal<string | null>(null);

  const chooseProjectStorageFolder = async () => {
    const rid = input.projectId();
    const openDirectoryPicker = window.showDirectoryPicker;
    if (!rid || !isLocalId("project", rid) || !openDirectoryPicker) {
      window.alert("Folder storage is not supported in this browser.");
      return;
    }

    try {
      const handle = await openDirectoryPicker();
      await setLocalProjectAssetDirectory(rid, handle);
      setLocalSaveFailure(null);
      window.alert("Project storage folder is ready.");
    } catch {
      window.alert("Project storage folder was not changed.");
    }
  };

  const onArchiveInput: JSX.EventHandler<HTMLInputElement, Event> = async (event) => {
    const inputElement = event.currentTarget;
    const file = inputElement.files?.[0];
    if (file) {
      try {
        const nextProjectId = await importDawProjectArchive(file);
        input.navigateToRoom(nextProjectId);
      } catch (error) {
        setLocalSaveFailure(error instanceof Error ? error.message : "Archive import failed.");
      }
    }
    inputElement.value = "";
  };

  const backUpNow = async (options: { skipIfUnchanged?: boolean } = {}) => {
    const rid = input.projectId();
    if (!rid || !isLocalId("project", rid)) return;
    const conflictAction = backupConflictProjectId() === rid
      && !options.skipIfUnchanged
      && window.confirm("Overwrite the existing cloud backup with this local project?")
      ? "overwrite"
      : "detect";
    const result = await runProjectBackup(rid, conflictAction, options);
    if (!result.ok) {
      setBackupConflictProjectId(result.conflict ? rid : null);
      setLocalSaveFailure(result.conflict
        ? "Cloud backup conflict detected. Use Back up now again after reviewing the cloud project, or restore from backup in a fresh profile."
        : result.error ?? "Cloud backup failed.");
      return;
    }
    setBackupConflictProjectId(null);
    setLocalSaveFailure(null);
  };

  const exportArchive = async () => {
    const rid = input.projectId();
    if (!isLocalId("project", rid)) return;
    try {
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
    chooseProjectStorageFolder,
    onArchiveInput,
    backUpNow,
    exportArchive,
  };
};
