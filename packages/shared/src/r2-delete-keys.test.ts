import { expect, test } from "bun:test";
import {
  isValidCloudBackupAssetKey,
  isValidControlAssetKey,
  isValidR2DeleteKey,
  projectR2DeletePrefixes,
} from "./r2-delete-keys";

test("R2 delete key validators keep backup projects and control namespaces separate", () => {
  expect(isValidCloudBackupAssetKey("project-1", "projects/project-1/assets/asset-1/object")).toBe(true);
  expect(isValidCloudBackupAssetKey("project-1", "projects/project-2/assets/asset-1/object")).toBe(false);
  expect(isValidControlAssetKey("namespace-1", "asset-namespaces/namespace-1/asset-1/object")).toBe(true);
  expect(isValidControlAssetKey("namespace-1", "asset-namespaces/namespace-2/asset-1/object")).toBe(false);
  expect(isValidR2DeleteKey("project-1", "namespace-1", "sample", "asset-namespaces/namespace-2/asset-1/object")).toBe(false);
  expect(isValidR2DeleteKey("project-1", "namespace-1", "backup-asset", "asset-namespaces/namespace-1/asset-1/object")).toBe(false);
});

test("project-prefix deletion keys are exactly the two project-owned prefixes", () => {
  const prefixes = projectR2DeletePrefixes("project-1", "namespace-1");
  expect(prefixes).toEqual([
    "asset-namespaces/namespace-1/",
    "projects/project-1/",
  ]);
  for (const prefix of prefixes) {
    expect(isValidR2DeleteKey("project-1", "namespace-1", "project-prefix", prefix)).toBe(true);
  }
  for (const key of [
    "asset-namespaces/namespace-1/nested/",
    "asset-namespaces/namespace-1",
    "asset-namespaces/namespace-2/",
    "projects/project-1/assets/",
    "projects/project-1/nested/",
    "projects/project-2/",
    "",
  ]) {
    expect(isValidR2DeleteKey("project-1", "namespace-1", "project-prefix", key)).toBe(false);
  }
  for (const [projectId, storageNamespace] of [["", "namespace-1"], ["project-1", ""], ["../project-1", "namespace-1"], ["project-1", "namespace/1"]]) {
    expect(isValidR2DeleteKey(projectId, storageNamespace, "project-prefix", projectR2DeletePrefixes(projectId, storageNamespace)[0])).toBe(false);
  }
});
