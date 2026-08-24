import { sha256 } from '@noble/hashes/sha2.js'
import { z } from 'zod'
import {
  isJsonBoolean,
  isJsonNumber,
  isJsonObject,
  isJsonString,
  type JsonObject,
  type JsonValue,
} from '@daw-browser/shared'
import {
  controlLimitsV1,
} from './versions'
import {
  controlApprovalRequestSchemaV1,
  controlCommitRequestSchemaV1,
  controlPreviewRequestSchemaV1,
  controlHistoryQuerySchemaV1,
  controlRecoveriesQuerySchemaV1,
  canonicalControlSnapshotQuerySchema,
  controlSnapshotQuerySchemaV1,
  type ControlApprovalRequestV1,
  type ControlCommitRequestV1,
  type ControlPreviewRequestV1,
  type CanonicalControlSnapshotQuery,
} from './actions'
import type { ProjectSnapshotV2 } from './snapshots'
import type { RecoveryOwnershipV1 } from './recovery'

const isPlainObject = (value: JsonValue): value is JsonObject => {
  if (!isJsonObject(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

const jsonValueSchema = z.json()
const traversableJsonObjectSchema = z.record(z.string(), z.any())

const validateCanonicalJsonInput = <Value>(value: Value, arrayEntry = false): void => {
  const tag = Object.prototype.toString.call(value)
  if (tag === '[object Undefined]') {
    if (arrayEntry) throw new Error('Canonical JSON does not support undefined array entries.')
    return
  }
  if (tag === '[object Null]' || tag === '[object Boolean]' || tag === '[object String]') return
  if (tag === '[object Number]') {
    if (!Number.isFinite(z.number().parse(value))) throw new Error('Canonical JSON only supports JSON values.')
    return
  }
  if (Array.isArray(value)) {
    for (const entry of value) validateCanonicalJsonInput(entry, true)
    return
  }
  if (tag !== '[object Object]') throw new Error('Canonical JSON only supports JSON values.')
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error('Canonical JSON only supports plain JSON objects.')
  }
  const record = traversableJsonObjectSchema.parse(value)
  for (const entry of Object.values(record)) validateCanonicalJsonInput(entry)
}

export const canonicalJson = <Value>(value: Value): string => {
  validateCanonicalJsonInput(value)
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw new Error('Canonical JSON only supports JSON values.')
  const parsed = jsonValueSchema.parse(JSON.parse(serialized))
  const canonicalize = (entry: JsonValue): string => {
    if (entry === null) return 'null'
    if (isJsonBoolean(entry)) return entry ? 'true' : 'false'
    if (isJsonNumber(entry)) {
      if (!Number.isFinite(entry)) throw new Error('Canonical JSON only supports finite numbers.')
      return JSON.stringify(entry)
    }
    if (isJsonString(entry)) return JSON.stringify(entry)
    if (Array.isArray(entry)) {
      for (let index = 0; index < entry.length; index += 1) {
        if (!(index in entry)) throw new Error('Canonical JSON does not support sparse arrays.')
      }
      return `[${entry.map(canonicalize).join(',')}]`
    }
    if (!isPlainObject(entry)) throw new Error('Canonical JSON only supports plain JSON objects.')
    return `{${Object.keys(entry).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(entry[key])}`).join(',')}}`
  }
  return canonicalize(parsed)
}

const sha256Hex = (value: string) => (
  Array.from(sha256(new TextEncoder().encode(value)), (byte) => byte.toString(16).padStart(2, '0')).join('')
)
export const hashCanonicalJsonSyncV1 = (value: JsonValue) => sha256Hex(canonicalJson(value))
const timelineRangeRecoveryClipSemanticValueV2 = (clip: ProjectSnapshotV2['clips'][number]) => {
  const { id: _id, ...semantic } = clip
  return semantic
}
export const timelineRangeRecoveryClipDigestV2 = (clip: ProjectSnapshotV2['clips'][number]) => (
  hashCanonicalJsonSyncV1(JSON.parse(JSON.stringify(timelineRangeRecoveryClipSemanticValueV2(clip))))
)
export const timelineRangeRecoveryOwnershipDigestV2 = (ownership: RecoveryOwnershipV1) => (
  hashCanonicalJsonSyncV1(JSON.parse(JSON.stringify(ownership)))
)
export const timelineRangeRecoveryAutomationDigestV2 = (
  automation: ProjectSnapshotV2['automation'][number],
) => hashCanonicalJsonSyncV1(JSON.parse(JSON.stringify(automation)))
export const hashRecoveryPayloadSyncV1 = (payload: string) => sha256Hex(payload)
export const hashRecoveryPayloadV1 = async (payload: string) => hashRecoveryPayloadSyncV1(payload)

export const assertControlSerializedBodyV1 = <Value>(value: Value): Value => {
  const serialized = canonicalJson(value)
  if (new TextEncoder().encode(serialized).byteLength > controlLimitsV1.maxSerializedBodyBytes) {
    throw new Error('Control body exceeds the serialized body limit.')
  }
  return value
}

export const parseControlCommitRequestV1 = <Input>(input: Input): ControlCommitRequestV1 => {
  const parsed = controlCommitRequestSchemaV1.parse(assertControlSerializedBodyV1(input))
  assertControlSerializedBodyV1(parsed)
  return parsed
}

export const parseControlPreviewRequestV1 = <Input>(input: Input): ControlPreviewRequestV1 => {
  const parsed = controlPreviewRequestSchemaV1.parse(assertControlSerializedBodyV1(input))
  assertControlSerializedBodyV1(parsed)
  return parsed
}
export const parseControlApprovalRequestV1 = <Input>(input: Input): ControlApprovalRequestV1 => {
  const parsed = controlApprovalRequestSchemaV1.parse(assertControlSerializedBodyV1(input))
  assertControlSerializedBodyV1(parsed)
  return parsed
}

export const parseControlSnapshotQueryV1 = <Input>(input: Input) => (
  controlSnapshotQuerySchemaV1.parse(input)
)
export const parseControlSnapshotQueryV2 = <Input>(input: Input) => (
  controlSnapshotQuerySchemaV1.parse(input)
)

export const parseControlHistoryQueryV1 = <Input>(input: Input) => (
  controlHistoryQuerySchemaV1.parse(input)
)
export const parseControlRecoveriesQueryV1 = <Input>(input: Input) => (
  controlRecoveriesQuerySchemaV1.parse(input)
)

export const controlRequestDigestInputV1 = (
  request: ControlCommitRequestV1 | ControlPreviewRequestV1 | ControlApprovalRequestV1,
) => canonicalJson({
  version: request.version,
  projectId: request.projectId,
  expectedRevision: request.expectedRevision,
  actions: request.actions,
})

export const controlRequestDigestSyncV1 = (
  request: ControlCommitRequestV1 | ControlPreviewRequestV1 | ControlApprovalRequestV1,
) => sha256Hex(controlRequestDigestInputV1(request))
export const controlRequestDigestV1 = async (
  request: ControlCommitRequestV1 | ControlPreviewRequestV1 | ControlApprovalRequestV1,
) => controlRequestDigestSyncV1(request)


export const parseCanonicalControlSnapshotQuery = <Input>(input: Input): CanonicalControlSnapshotQuery => (
  canonicalControlSnapshotQuerySchema.parse(input)
)
export const parseControlSnapshotQuery = parseCanonicalControlSnapshotQuery
