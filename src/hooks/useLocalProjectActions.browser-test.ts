import { afterEach, describe, expect, mock, test } from "bun:test";
import "fake-indexeddb/auto";
import { createRoot, createSignal } from "solid-js";
import { notifyLocalProjectChanged } from "~/lib/local-project-changes";
import { installHermeticWindow } from "~/lib/test/hermetic-browser-environment";

// Run with `bun test --conditions browser ./src/hooks/useLocalProjectActions.browser-test.ts`.
// Module mocks persist for the whole Bun process, so this file stays out of the default `bun test` glob.

type Summary = { pending: number; failed: number };

const actualOutbox = { ...(await import("~/lib/shared-outbox")) };
const actualAssets = { ...(await import("~/lib/local-assets")) };
const actualBackup = { ...(await import("~/lib/cloud-backup")) };
type BackupResult = Awaited<ReturnType<typeof actualBackup.runProjectBackup>>;
const actualAssetCache = { ...(await import("~/lib/cloud-asset-cache")) };
const summaryReads: { projectId: string; userId: string; read: PromiseWithResolvers<Summary> }[] = [];
const flushes: PromiseWithResolvers<Summary>[] = [];
let setAssetDirectory = async (): Promise<void> => undefined;
const cloud = {
  backup: async (): Promise<BackupResult> => ({ ok: true }),
  restore: async (): Promise<void> => undefined,
  duplicate: async (): Promise<string> => "project:duplicate",
  download: async (): Promise<number> => 0,
};
const defaultCloud = { ...cloud };

mock.module("~/lib/shared-outbox", () => ({
  ...actualOutbox,
  readSharedOutboxSummary: (projectId: string, userId: string) => {
    const read = Promise.withResolvers<Summary>();
    summaryReads.push({ projectId, userId, read });
    return read.promise;
  },
  flushSharedOutbox: () => {
    const flush = Promise.withResolvers<Summary>();
    flushes.push(flush);
    return flush.promise;
  },
}));
mock.module("~/lib/local-assets", () => ({
  ...actualAssets,
  setLocalProjectAssetDirectory: () => setAssetDirectory(),
}));
mock.module("~/lib/cloud-backup", () => ({
  ...actualBackup,
  runProjectBackup: () => cloud.backup(),
  disableProjectBackup: async () => undefined,
  restoreCloudBackupToLocalProject: () => cloud.restore(),
  duplicateCloudBackupAsLocalProject: () => cloud.duplicate(),
}));
mock.module("~/lib/cloud-asset-cache", () => ({
  ...actualAssetCache,
  downloadCloudAssetsForOffline: () => cloud.download(),
}));

const { useLocalProjectActions } = await import("./useLocalProjectActions");

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  setAssetDirectory = async () => undefined;
  Object.assign(cloud, defaultCloud);
});

const settle = async () => {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
};
const lastRead = () => {
  const entry = summaryReads.at(-1);
  if (!entry) throw new Error("Expected an outbox summary read.");
  return entry;
};
const abortError = () => new DOMException("The user aborted a request.", "AbortError");

type PickerWindow = {
  showDirectoryPicker?: () => Promise<object>;
  showSaveFilePicker?: () => Promise<object>;
};

const mount = (initial: { projectId: string; userId?: string }, browserWindow: PickerWindow = {}) => {
  cleanups.push(installHermeticWindow(browserWindow));
  const [projectId, setProjectId] = createSignal(initial.projectId);
  const [userId, setUserId] = createSignal(initial.userId);
  const notices: { title: string; message: string }[] = [];
  const actions = createRoot((dispose) => {
    cleanups.push(dispose);
    return useLocalProjectActions({
      projectId,
      userId,
      navigateToRoom: () => undefined,
      notify: (title, message) => { notices.push({ title, message }); },
    });
  });
  return { actions, notices, setProjectId, setUserId };
};

describe("shared outbox summary scope", () => {
  test("a failed outbox read stays unknown until a verified read succeeds", async () => {
    const view = mount({ projectId: "shared-a", userId: "user-a" });
    expect(view.actions.sharedOutboxStatus()).toBeNull();
    lastRead().read.reject(new Error("IndexedDB unavailable"));
    await settle();
    expect(view.actions.sharedOutboxStatus()).toBeNull();

    notifyLocalProjectChanged("shared-a");
    lastRead().read.resolve({ pending: 0, failed: 0 });
    await settle();
    expect(view.actions.sharedOutboxStatus()).toEqual({ pending: 0, failed: 0 });
  });

  test("delayed summaries from a previous project or user never replace the current scope", async () => {
    const view = mount({ projectId: "shared-a", userId: "user-a" });
    lastRead().read.resolve({ pending: 0, failed: 0 });
    await settle();
    notifyLocalProjectChanged("shared-a");
    const delayedProjectA = lastRead();

    view.setProjectId("shared-b");
    expect(view.actions.sharedOutboxStatus()).toBeNull();
    const delayedUserA = lastRead();
    view.setUserId("user-b");
    const current = lastRead();
    expect([current.projectId, current.userId]).toEqual(["shared-b", "user-b"]);

    current.read.resolve({ pending: 2, failed: 1 });
    delayedUserA.read.resolve({ pending: 0, failed: 0 });
    delayedProjectA.read.resolve({ pending: 0, failed: 0 });
    await settle();
    expect(view.actions.sharedOutboxStatus()).toEqual({ pending: 2, failed: 1 });
  });

  test("an older refresh in the same scope cannot overwrite a newer one", async () => {
    const view = mount({ projectId: "shared-a", userId: "user-a" });
    const older = lastRead();
    notifyLocalProjectChanged("shared-a");
    const newer = lastRead();
    newer.read.resolve({ pending: 1, failed: 0 });
    older.read.resolve({ pending: 0, failed: 0 });
    await settle();
    expect(view.actions.sharedOutboxStatus()).toEqual({ pending: 1, failed: 0 });
  });

  test("a retry that completes after leaving the project is ignored", async () => {
    const view = mount({ projectId: "shared-a", userId: "user-a" });
    const retry = view.actions.retrySharedChanges();
    view.setProjectId("shared-b");
    flushes.at(-1)?.resolve({ pending: 0, failed: 0 });
    await retry;
    expect(view.actions.sharedOutboxStatus()).toBeNull();
  });
});

describe("local save failure ownership", () => {
  test("folder selection never touches the save channel and reports only real failures as notices", async () => {
    const picker = { next: (): Promise<object> => Promise.resolve({}) };
    const view = mount({ projectId: "project:local-a" }, { showDirectoryPicker: () => picker.next() });

    await view.actions.chooseProjectStorageFolder();
    view.actions.setLocalSaveFailure("project:local-a", "Mix write failed.");
    await view.actions.chooseProjectStorageFolder();
    picker.next = () => Promise.reject(abortError());
    await view.actions.chooseProjectStorageFolder();
    expect(view.notices).toEqual([]);
    expect(view.actions.localSaveFailure()).toBe("Mix write failed.");

    view.actions.setLocalSaveFailure("project:local-a", null);
    picker.next = () => Promise.resolve({});
    setAssetDirectory = () => Promise.reject(new Error("Project storage permission is required."));
    await view.actions.chooseProjectStorageFolder();
    expect(view.actions.localSaveFailure()).toBeNull();
    expect(view.notices).toEqual([{ title: "Project folder not changed", message: "Project storage folder was not changed." }]);
  });

  test("unsupported folder storage is a notice, not a save failure", async () => {
    const view = mount({ projectId: "project:local-a" });
    await view.actions.chooseProjectStorageFolder();
    expect(view.actions.localSaveFailure()).toBeNull();
    expect(view.notices).toEqual([{ title: "Project folder not changed", message: "Folder storage is not supported in this browser." }]);
  });

  test("archive export cancel is quiet and a denied archive write is a notice", async () => {
    const picker = { next: (): Promise<object> => Promise.reject(abortError()) };
    const view = mount({ projectId: "project:local-a" }, { showSaveFilePicker: () => picker.next() });

    await view.actions.exportArchive();
    expect(view.notices).toEqual([]);

    picker.next = () => Promise.resolve({
      createWritable: () => Promise.reject(new DOMException("Write permission denied.", "NotAllowedError")),
    });
    await view.actions.exportArchive();
    expect(view.actions.localSaveFailure()).toBeNull();
    expect(view.notices).toEqual([{ title: "Archive export failed", message: "Write permission denied." }]);
  });

  test("cloud backup actions never set, replace, or clear a save failure", async () => {
    const view = mount({ projectId: "project:local-a", userId: "user-a" });
    view.actions.setLocalSaveFailure("project:local-a", "Mix write failed.");

    await view.actions.backUpNow();
    await view.actions.overwriteCloudBackup();
    await view.actions.disableBackup();
    await view.actions.confirmRestoreCloudBackup();
    await view.actions.duplicateCloudBackup();
    await view.actions.downloadForOffline();
    expect(view.actions.localSaveFailure()).toBe("Mix write failed.");

    cloud.backup = async () => ({ ok: false, error: "Backup offline." });
    cloud.restore = () => Promise.reject(new Error("Restore offline."));
    cloud.duplicate = () => Promise.reject(new Error("Duplicate offline."));
    cloud.download = () => Promise.reject(new Error("Download offline."));
    await view.actions.backUpNow();
    await view.actions.overwriteCloudBackup();
    await view.actions.confirmRestoreCloudBackup();
    await view.actions.duplicateCloudBackup();
    await view.actions.downloadForOffline();
    expect(view.actions.localSaveFailure()).toBe("Mix write failed.");
    expect(view.notices).toEqual([]);
  });

  test("cloud backup failures report through the backup dialog, except background ticks", async () => {
    const view = mount({ projectId: "project:local-a", userId: "user-a" });
    cloud.backup = async () => ({ ok: false, error: "Backup offline." });

    await view.actions.backUpNow({ projectId: "project:local-a", skipIfUnchanged: true });
    expect(view.actions.cloudBackupStatus()).toBe("failed");
    expect(view.actions.cloudBackupDialog()).toBeNull();

    await view.actions.backUpNow();
    expect(view.actions.cloudBackupDialog()).toEqual({ type: "message", title: "Cloud backup failed", message: "Backup offline." });

    cloud.restore = () => Promise.reject(new Error("Restore offline."));
    await view.actions.confirmRestoreCloudBackup();
    expect(view.actions.cloudBackupDialog()).toEqual({ type: "message", title: "Cloud backup restore failed", message: "Restore offline." });

    cloud.download = () => Promise.reject(new Error("Download offline."));
    await view.actions.downloadForOffline();
    expect(view.actions.cloudBackupDialog()).toEqual({ type: "message", title: "Download for offline failed", message: "Download offline." });
    expect(view.actions.localSaveFailure()).toBeNull();
  });

  test("a save failure belongs to the project it was reported in and clears only on dismissal", async () => {
    const view = mount({ projectId: "project:local-a" });
    view.actions.setLocalSaveFailure("project:local-a", "Mix write failed.");

    view.setProjectId("project:local-b");
    expect(view.actions.localSaveFailure()).toBeNull();
    view.setProjectId("project:local-a");
    expect(view.actions.localSaveFailure()).toBe("Mix write failed.");

    view.actions.setLocalSaveFailure("project:local-a", null);
    expect(view.actions.localSaveFailure()).toBeNull();
  });

  test("a late failure for the previous project never shows in the open one and waits for its owner", async () => {
    const view = mount({ projectId: "project:local-a" });
    view.setProjectId("project:local-b");
    view.actions.setLocalSaveFailure("project:local-a", "Late mix write failed.");
    expect(view.actions.localSaveFailure()).toBeNull();

    view.setProjectId("project:local-a");
    expect(view.actions.localSaveFailure()).toBe("Late mix write failed.");
  });

  test("each project keeps its own failure until that project dismisses it", async () => {
    const view = mount({ projectId: "project:local-b" });
    view.actions.setLocalSaveFailure("project:local-a", "Late mix write failed.");
    view.actions.setLocalSaveFailure("project:local-b", "Effect write failed.");
    expect(view.actions.localSaveFailure()).toBe("Effect write failed.");

    view.actions.setLocalSaveFailure("project:local-b", null);
    expect(view.actions.localSaveFailure()).toBeNull();
    view.setProjectId("project:local-a");
    expect(view.actions.localSaveFailure()).toBe("Late mix write failed.");
  });
});
