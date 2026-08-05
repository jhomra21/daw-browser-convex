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
  sourceKind?: "upload" | "url" | "recording";
  durationSec?: number;
  sampleRate?: number;
  channelCount?: number;
  folderId?: string;
  createdAt: number;
  updatedAt: number;
  cloudKey?: string;
};

export type ProjectManifestPluginArtifact = {
  id: string;
  sha256: string;
  byteLength: number;
  kind: "plugin-state" | "plugin-freeze";
  ownerId: string;
  acl: "owner" | "project-members";
  bucket: "local" | "r2-plugin-artifacts";
  location: string;
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
  externalPluginArtifacts: ProjectManifestPluginArtifact[];
};

export const PROJECT_MANIFEST_SCHEMA_VERSION = 4;
export const SUPPORTED_PROJECT_MANIFEST_SCHEMA_VERSIONS: readonly number[] = [
  1,
  2,
  3,
  PROJECT_MANIFEST_SCHEMA_VERSION,
];

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
const readOptionalSourceKind = (value: unknown): ProjectManifestAsset["sourceKind"] => (
  value === "upload" || value === "url" || value === "recording" ? value : undefined
);
const readPluginArtifact = (value: unknown): ProjectManifestPluginArtifact => {
  if (!isRecord(value)) throw new Error("Project manifest has invalid external plugin artifact.");
  const id = readString(value.id, "externalPluginArtifact.id");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error("Project manifest has invalid external plugin artifact id.");
  }
  const sha256 = readString(value.sha256, "externalPluginArtifact.sha256");
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Project manifest has invalid external plugin artifact hash.");
  const kind = value.kind;
  if (kind !== "plugin-state" && kind !== "plugin-freeze") {
    throw new Error("Project manifest has invalid external plugin artifact kind.");
  }
  const acl = value.acl;
  if (acl !== "owner" && acl !== "project-members") {
    throw new Error("Project manifest has invalid external plugin artifact ACL.");
  }
  const bucket = value.bucket;
  if (bucket !== "local" && bucket !== "r2-plugin-artifacts") {
    throw new Error("Project manifest has invalid external plugin artifact bucket.");
  }
  const byteLength = readNumber(value.byteLength, "externalPluginArtifact.byteLength");
  if (!Number.isInteger(byteLength) || byteLength <= 0 || byteLength > 512 * 1024 * 1024) {
    throw new Error("Project manifest has invalid external plugin artifact byte length.");
  }
  const ownerId = readString(value.ownerId, "externalPluginArtifact.ownerId");
  const location = readString(value.location, "externalPluginArtifact.location");
  if (ownerId.length > 256 || location.length > 1024) {
    throw new Error("Project manifest has invalid external plugin artifact metadata.");
  }
  return {
    id,
    sha256,
    byteLength,
    kind,
    ownerId,
    acl,
    bucket,
    location,
  };
};

export const normalizeProjectManifestPluginArtifact = (
  value: unknown,
): ProjectManifestPluginArtifact => readPluginArtifact(value);

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
  assertUnique(manifest.externalPluginArtifacts, (artifact) => artifact.id, "external plugin artifact id");
};

export const assertProjectManifestPublishIntegrity = (manifest: ProjectManifest) => {
  assertProjectManifestBaseIntegrity(manifest);
  if (manifest.externalPluginArtifacts.some((artifact) => artifact.bucket === "r2-plugin-artifacts")) {
    throw new Error("Project manifest external plugin artifacts cannot be published to the configured backup bucket.");
  }
  const hasInvalidCloudKey = manifest.assets.some((asset) => (
    asset.missing
      ? asset.cloudKey !== undefined
      : !asset.cloudKey?.startsWith(`projects/${manifest.projectId}/assets/${asset.id}/`)
  ));
  if (hasInvalidCloudKey) {
    throw new Error("Project manifest contains invalid cloud asset key.");
  }
};

const readProjectManifest = (raw: Record<string, unknown>): ProjectManifest => {
  const schemaVersion = readNumber(raw.schemaVersion, "schemaVersion");
  if (!SUPPORTED_PROJECT_MANIFEST_SCHEMA_VERSIONS.includes(schemaVersion)) {
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
      sourceKind: readOptionalSourceKind(asset.sourceKind),
      durationSec: readOptionalNumber(asset.durationSec),
      sampleRate: readOptionalNumber(asset.sampleRate),
      channelCount: readOptionalNumber(asset.channelCount),
      folderId: readOptionalString(asset.folderId),
      createdAt: readNumber(asset.createdAt, "asset.createdAt"),
      updatedAt: readNumber(asset.updatedAt, "asset.updatedAt"),
      cloudKey: readOptionalString(asset.cloudKey),
    };
  });
  const manifest = {
    schemaVersion: PROJECT_MANIFEST_SCHEMA_VERSION,
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
    externalPluginArtifacts: schemaVersion >= 3
      ? readArray(raw.externalPluginArtifacts, "externalPluginArtifacts").map(readPluginArtifact)
      : [],
  };
  assertProjectManifestBaseIntegrity(manifest);
  return manifest;
};

export const normalizeProjectManifest = (raw: unknown): ProjectManifest => {
  if (!isRecord(raw)) throw new Error("Project manifest must be an object.");
  return readProjectManifest(raw);
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
