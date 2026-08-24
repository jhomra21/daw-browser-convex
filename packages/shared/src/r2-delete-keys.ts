export type R2DeleteKind = "backup-asset" | "sample" | "export" | "project-prefix";

const isSafeR2PathSegment = (value: string) => (
  value.length > 0
  && value !== "."
  && value !== ".."
  && !value.includes("..")
  && !value.includes("/")
  && !value.includes("\\")
);

export const projectR2DeletePrefixes = (
  projectId: string,
  storageNamespace: string,
): readonly [string, string] => [
  `asset-namespaces/${storageNamespace}/`,
  `projects/${projectId}/`,
];

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
  if (kind === "project-prefix") {
    if (!isSafeR2PathSegment(projectId) || !isSafeR2PathSegment(storageNamespace)) return false;
    return projectR2DeletePrefixes(projectId, storageNamespace).includes(key);
  }
  if (kind === "backup-asset") return isValidCloudBackupAssetKey(projectId, key);
  if (kind === "export") return key.startsWith(`projects/${projectId}/exports/`);
  return isValidControlAssetKey(storageNamespace, key);
};
