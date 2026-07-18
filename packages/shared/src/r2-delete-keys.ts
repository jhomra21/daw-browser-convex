export type R2DeleteKind = "backup-asset" | "sample" | "export" | "project-prefix";

export const isValidCloudBackupAssetKey = (projectId: string, key: string) => (
  key.startsWith(`projects/${projectId}/assets/`)
);

export const isValidControlAssetKey = (storageNamespace: string, key: string) => (
  key.startsWith(`asset-namespaces/${storageNamespace}/`)
);

export const isValidR2DeleteKey = (
  projectId: string,
  storageNamespace: string,
  kind: R2DeleteKind,
  key: string,
) => {
  if (kind === "project-prefix") return key === `asset-namespaces/${storageNamespace}/`;
  if (kind === "backup-asset") return isValidCloudBackupAssetKey(projectId, key);
  if (kind === "export") return key.startsWith(`projects/${projectId}/exports/`);
  return isValidControlAssetKey(storageNamespace, key);
};
