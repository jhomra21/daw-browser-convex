import {
  normalizeProjectManifestPluginArtifact,
  type ProjectManifestPluginArtifact,
} from '@daw-browser/shared'
import {
  maxVst3WorkerStateBytes,
  opaquePluginStateMetadataSchema,
  type OpaquePluginStateMetadata,
} from '@daw-browser/plugin-host-protocol'
import { sha256 } from '@noble/hashes/sha2.js'
import { openLocalProjectDb, type LocalProjectExternalPluginArtifactRow } from '~/lib/local-project-db'
import { notifyLocalProjectChanged } from '~/lib/local-project-changes'

export const localVstStateArtifactLocation = (artifactId: string) => `plugin-artifacts/${artifactId}`

export const localVstStateOwnerId = (projectId: string, ownerId?: string) => {
  const normalizedOwnerId = ownerId?.trim()
  return normalizedOwnerId && normalizedOwnerId.length > 0 ? normalizedOwnerId : projectId
}

const hexHash = (bytes: Uint8Array) => Array.from(sha256(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')

const artifactRowForMetadata = (metadata: OpaquePluginStateMetadata) => ({
  id: metadata.artifactId,
  sha256: metadata.sha256,
  byteLength: metadata.byteLength,
  kind: metadata.artifactKind,
  ownerId: metadata.ownerId,
  acl: metadata.acl,
  bucket: metadata.bucket,
  location: metadata.location,
})

const validLocalStateMetadata = (
  metadata: OpaquePluginStateMetadata,
  ownerId?: string,
): OpaquePluginStateMetadata => {
  const parsed = opaquePluginStateMetadataSchema.parse(metadata)
  if (
    parsed.artifactKind !== 'plugin-state'
    || parsed.bucket !== 'local'
    || parsed.location !== localVstStateArtifactLocation(parsed.artifactId)
    || parsed.byteLength <= 0
    || parsed.byteLength > maxVst3WorkerStateBytes
    || (ownerId !== undefined && parsed.ownerId !== ownerId)
  ) throw new Error(`Local VST state artifact "${parsed.artifactId}" metadata is invalid.`)
  return parsed
}

export const validateLocalVstStateBytes = (
  bytes: Uint8Array,
  expectedSha256: string,
) => {
  if (
    bytes.byteLength <= 0
    || bytes.byteLength > maxVst3WorkerStateBytes
    || !/^[a-f0-9]{64}$/.test(expectedSha256)
    || hexHash(bytes) !== expectedSha256
  ) throw new Error('Native VST state bytes are invalid or exceed the shared limit.')
  return { bytes: new Uint8Array(bytes), sha256: expectedSha256 }
}

export const readLocalExternalPluginState = async (
  projectId: string,
  metadata: OpaquePluginStateMetadata | undefined,
  ownerId?: string,
): Promise<{ bytes: Uint8Array; sha256: string } | undefined> => {
  if (!metadata) return undefined
  const parsed = validLocalStateMetadata(metadata, ownerId)
  const db = await openLocalProjectDb(projectId)
  const artifact = await db.get('externalPluginArtifacts', parsed.artifactId)
  if (!artifact) throw new Error(`Native VST state artifact "${parsed.artifactId}" is missing.`)
  const { payload, updatedAt: _updatedAt, ...metadataRow } = artifact
  const normalized = normalizeProjectManifestPluginArtifact(metadataRow)
  if (
    normalized.id !== parsed.artifactId
    || normalized.sha256 !== parsed.sha256
    || normalized.byteLength !== parsed.byteLength
    || normalized.kind !== parsed.artifactKind
    || normalized.ownerId !== parsed.ownerId
    || normalized.acl !== parsed.acl
    || normalized.bucket !== parsed.bucket
    || normalized.location !== parsed.location
  ) throw new Error(`Native VST state artifact "${parsed.artifactId}" metadata does not match its processor.`)
  if (!(payload instanceof Uint8Array)) {
    throw new Error(`Native VST state artifact "${parsed.artifactId}" bytes are missing.`)
  }
  const bytes = validateLocalVstStateBytes(payload, parsed.sha256)
  if (bytes.bytes.byteLength !== parsed.byteLength) {
    throw new Error(`Native VST state artifact "${parsed.artifactId}" byte length does not match its metadata.`)
  }
  return bytes
}

export const writeLocalExternalPluginState = async (
  projectId: string,
  metadata: OpaquePluginStateMetadata,
  bytes: Uint8Array,
  updatedAt = Date.now(),
): Promise<LocalProjectExternalPluginArtifactRow> => {
  const parsed = validLocalStateMetadata(metadata)
  const validated = validateLocalVstStateBytes(bytes, parsed.sha256)
  if (validated.bytes.byteLength !== parsed.byteLength) {
    throw new Error(`Native VST state artifact "${parsed.artifactId}" byte length does not match its metadata.`)
  }
  const row = { ...artifactRowForMetadata(parsed), payload: validated.bytes, updatedAt }
  const db = await openLocalProjectDb(projectId)
  await db.put('externalPluginArtifacts', row)
  notifyLocalProjectChanged(projectId)
  return row
}

export const deleteLocalExternalPluginState = async (
  projectId: string,
  metadata: OpaquePluginStateMetadata,
): Promise<void> => {
  const parsed = validLocalStateMetadata(metadata)
  const db = await openLocalProjectDb(projectId)
  await db.delete('externalPluginArtifacts', parsed.artifactId)
  notifyLocalProjectChanged(projectId)
}

export const setLocalExternalPluginArtifact = async (
  projectId: string,
  artifact: ProjectManifestPluginArtifact,
  updatedAt = Date.now(),
): Promise<LocalProjectExternalPluginArtifactRow> => {
  const parsed = normalizeProjectManifestPluginArtifact(artifact)
  const row = { ...parsed, updatedAt }
  const db = await openLocalProjectDb(projectId)
  await db.put('externalPluginArtifacts', row)
  notifyLocalProjectChanged(projectId)
  return row
}