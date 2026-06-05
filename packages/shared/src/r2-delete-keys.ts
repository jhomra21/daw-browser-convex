export type R2DeleteKind = "backup-asset" | "sample" | "export" | "project-prefix";

export const isValidR2DeleteKey = (projectId: string, kind: R2DeleteKind, key: string) => {
  if (kind === "project-prefix") return key === `projects/${projectId}/`;
  if (kind === "export") return key.startsWith(`projects/${projectId}/exports/`);
  return key.startsWith(`projects/${projectId}/assets/`);
};
