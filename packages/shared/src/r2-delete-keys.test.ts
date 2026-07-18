import { expect, test } from "bun:test";
import {
  isValidCloudBackupAssetKey,
  isValidControlAssetKey,
  isValidR2DeleteKey,
} from "./r2-delete-keys";

test("R2 delete key validators keep backup projects and control namespaces separate", () => {
  expect(isValidCloudBackupAssetKey("project-1", "projects/project-1/assets/asset-1/object")).toBe(true);
  expect(isValidCloudBackupAssetKey("project-1", "projects/project-2/assets/asset-1/object")).toBe(false);
  expect(isValidControlAssetKey("namespace-1", "asset-namespaces/namespace-1/asset-1/object")).toBe(true);
  expect(isValidControlAssetKey("namespace-1", "asset-namespaces/namespace-2/asset-1/object")).toBe(false);
  expect(isValidR2DeleteKey("project-1", "namespace-1", "sample", "asset-namespaces/namespace-2/asset-1/object")).toBe(false);
  expect(isValidR2DeleteKey("project-1", "namespace-1", "backup-asset", "asset-namespaces/namespace-1/asset-1/object")).toBe(false);
});
