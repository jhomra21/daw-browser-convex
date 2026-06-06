export type ProjectManifestEntityRow = {
  kind: string;
  id: string;
  value: unknown;
  updatedAt: number;
};

export type ProjectManifestStateRow = {
  key: string;
  value: unknown;
  updatedAt: number;
};

export type ProjectManifestAsset = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  storagePath: string;
  missing?: boolean;
  originalFileName?: string;
  originalLastModified?: number;
  contentHash?: string;
  durationSec?: number;
  sampleRate?: number;
  createdAt: number;
  updatedAt: number;
  cloudKey?: string;
};

export type ProjectManifest = {
  schemaVersion: number;
  projectId: string;
  name: string;
  mode: "backup" | "shared";
  updatedAt: number;
  entityCount: number;
  assetCount: number;
  entities: ProjectManifestEntityRow[];
  assets: ProjectManifestAsset[];
  projectState: ProjectManifestStateRow[];
  syncState: ProjectManifestStateRow[];
};

export const PROJECT_MANIFEST_SCHEMA_VERSION = 1;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readNumber = (value: unknown, field: string) => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Project manifest has invalid ${field}.`);
  }
  return value;
};

const readString = (value: unknown, field: string) => {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Project manifest has invalid ${field}.`);
  }
  return value;
};

const readArray = (value: unknown, field: string) => {
  if (!Array.isArray(value)) throw new Error(`Project manifest has invalid ${field}.`);
  return value;
};

const readOptionalString = (value: unknown) => typeof value === "string" && value ? value : undefined;
const readOptionalNumber = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;

const readEntityRow = (value: unknown): ProjectManifestEntityRow => {
  if (!isRecord(value)) throw new Error("Project manifest has invalid entity.");
  return {
    kind: readString(value.kind, "entity.kind"),
    id: readString(value.id, "entity.id"),
    value: value.value,
    updatedAt: readNumber(value.updatedAt, "entity.updatedAt"),
  };
};

const readProjectStateRow = (value: unknown): ProjectManifestStateRow => {
  if (!isRecord(value)) throw new Error("Project manifest has invalid project state row.");
  return {
    key: readString(value.key, "projectState.key"),
    value: value.value,
    updatedAt: readNumber(value.updatedAt, "projectState.updatedAt"),
  };
};

const readSyncStateRow = (value: unknown): ProjectManifestStateRow => {
  if (!isRecord(value)) throw new Error("Project manifest has invalid sync state row.");
  return {
    key: readString(value.key, "syncState.key"),
    value: value.value,
    updatedAt: readNumber(value.updatedAt, "syncState.updatedAt"),
  };
};

const assertUnique = <T>(
  rows: T[],
  readKey: (row: T) => string,
  label: string,
) => {
  const seen = new Set<string>();
  for (const row of rows) {
    const key = readKey(row);
    if (seen.has(key)) throw new Error(`Project manifest has duplicate ${label}.`);
    seen.add(key);
  }
};

export const assertProjectManifestBaseIntegrity = (manifest: ProjectManifest) => {
  if (!manifest.projectId.trim() || !manifest.name.trim()) {
    throw new Error("Project manifest has invalid identity.");
  }
  if (manifest.entityCount !== manifest.entities.length) {
    throw new Error("Project manifest entity count does not match entities.");
  }
  if (manifest.assetCount !== manifest.assets.length) {
    throw new Error("Project manifest asset count does not match assets.");
  }
  assertUnique(manifest.entities, (row) => JSON.stringify([row.kind, row.id]), "entity identity");
  assertUnique(manifest.assets, (row) => row.id, "asset id");
  assertUnique(manifest.assets, (row) => row.storagePath, "asset storage path");
  assertUnique(manifest.projectState, (row) => row.key, "project state key");
  assertUnique(manifest.syncState, (row) => row.key, "sync state key");
};

export const assertProjectManifestPublishIntegrity = (manifest: ProjectManifest) => {
  assertProjectManifestBaseIntegrity(manifest);
  const hasInvalidCloudKey = manifest.assets.some((asset) => (
    asset.missing
      ? asset.cloudKey !== undefined
      : !asset.cloudKey?.startsWith(`projects/${manifest.projectId}/assets/${asset.id}/`)
  ));
  if (hasInvalidCloudKey) {
    throw new Error("Project manifest contains invalid cloud asset key.");
  }
};

export const normalizeProjectManifest = (raw: unknown): ProjectManifest => {
  if (!isRecord(raw)) throw new Error("Project manifest must be an object.");
  const schemaVersion = readNumber(raw.schemaVersion, "schemaVersion");
  if (schemaVersion !== PROJECT_MANIFEST_SCHEMA_VERSION) {
    throw new Error(`Unsupported project manifest schema version ${schemaVersion}.`);
  }
  if (raw.mode !== "backup" && raw.mode !== "shared") {
    throw new Error("Project manifest has invalid mode.");
  }
  const mode: ProjectManifest["mode"] = raw.mode === "backup" ? "backup" : "shared";
  const entities = readArray(raw.entities, "entities").map(readEntityRow);
  const assets = readArray(raw.assets, "assets").map((asset) => {
    if (!isRecord(asset)) throw new Error("Project manifest has invalid asset.");
    return {
      id: readString(asset.id, "asset.id"),
      name: readString(asset.name, "asset.name"),
      mimeType: readString(asset.mimeType, "asset.mimeType"),
      sizeBytes: readNumber(asset.sizeBytes, "asset.sizeBytes"),
      storagePath: readString(asset.storagePath, "asset.storagePath"),
      missing: typeof asset.missing === "boolean" ? asset.missing : undefined,
      originalFileName: readOptionalString(asset.originalFileName),
      originalLastModified: readOptionalNumber(asset.originalLastModified),
      contentHash: readOptionalString(asset.contentHash),
      durationSec: readOptionalNumber(asset.durationSec),
      sampleRate: readOptionalNumber(asset.sampleRate),
      createdAt: readNumber(asset.createdAt, "asset.createdAt"),
      updatedAt: readNumber(asset.updatedAt, "asset.updatedAt"),
      cloudKey: readOptionalString(asset.cloudKey),
    };
  });
  const manifest = {
    schemaVersion,
    projectId: readString(raw.projectId, "projectId"),
    name: readString(raw.name, "name"),
    mode,
    updatedAt: readNumber(raw.updatedAt, "updatedAt"),
    entityCount: readNumber(raw.entityCount, "entityCount"),
    assetCount: readNumber(raw.assetCount, "assetCount"),
    entities,
    assets,
    projectState: readArray(raw.projectState, "projectState").map(readProjectStateRow),
    syncState: readArray(raw.syncState, "syncState").map(readSyncStateRow),
  };
  assertProjectManifestBaseIntegrity(manifest);
  return manifest;
};

export const parseProjectManifest = (json: string) => normalizeProjectManifest(JSON.parse(json));

export const readProjectManifestCloudKeys = (
  projectId: string,
  manifest: ProjectManifest | undefined,
) => (
  manifest?.assets
    .flatMap((asset) => asset.cloudKey ? [asset.cloudKey] : [])
    .filter((key) => key.startsWith(`projects/${projectId}/assets/`)) ?? []
);

export const withProjectManifestAssetKeys = (
  manifest: ProjectManifest,
  uploadedAssetKeys: Readonly<Record<string, string>>,
): ProjectManifest => {
  const assets = manifest.assets.map((asset) => ({
    ...asset,
    cloudKey: uploadedAssetKeys[asset.id] ?? asset.cloudKey,
  }));
  return {
    ...manifest,
    assets,
    assetCount: assets.length,
  };
};
