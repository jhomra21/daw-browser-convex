import { describe, expect, test } from "bun:test";
import { getProjectSaveStatus } from "./project-save-status";

describe("project save status", () => {
  test("unknown shared queue never claims cloud saved", () => {
    const status = getProjectSaveStatus({
      projectId: "shared-project",
      userId: "user",
      sharedOutboxStatus: null,
    });
    expect(status.label).toContain("unknown");
    expect(status.shortLabel).not.toBe("Cloud saved");
  });

  test("signed-out shared project still asks to sign in", () => {
    expect(getProjectSaveStatus({ projectId: "shared-project", sharedOutboxStatus: null }).label)
      .toBe("Sign in to sync this project");
  });

  test("known empty queue retains existing saved claim", () => {
    expect(getProjectSaveStatus({
      projectId: "shared-project",
      userId: "user",
      sharedOutboxStatus: { pending: 0, failed: 0 },
    }).label).toBe("Saved to cloud project");
  });

  test("a known save failure never claims saved locally", () => {
    const status = getProjectSaveStatus({ projectId: "project:local", saveFailed: true });
    expect(status.shortLabel).toBe("Save failed");
    expect(status.compactLabel).toBe("Local");
  });

  test("a known save failure outranks a successful cloud backup", () => {
    expect(getProjectSaveStatus({
      projectId: "project:local",
      userId: "user",
      mode: "backup",
      cloudBackupStatus: "backed-up",
      saveFailed: true,
    }).shortLabel).toBe("Save failed");
  });

  test("a known save failure outranks unknown cloud sync and an empty queue", () => {
    for (const sharedOutboxStatus of [null, { pending: 0, failed: 0 }]) {
      const status = getProjectSaveStatus({ projectId: "shared-project", userId: "user", sharedOutboxStatus, saveFailed: true });
      expect(status.shortLabel).toBe("Save failed");
      expect(status.compactLabel).toBe("Cloud");
    }
  });

  test("no known save failure keeps the saved claim", () => {
    expect(getProjectSaveStatus({ projectId: "project:local", saveFailed: false }).shortLabel).toBe("Saved locally");
  });
});
