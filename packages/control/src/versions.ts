import { z } from 'zod'
import { recoveryLimitsV1 } from './recovery-limits'
import { executionTargetSchemaV1 } from './primitives'

export const CONTROL_API_VERSION_V1 = 'v1'
export const CONTROL_API_VERSION_V2 = 'v2'

export const controlLimitsV1 = {
  maxActions: 100,
  maxSerializedBodyBytes: 256 * 1024,
  maxRecoveryEntities: recoveryLimitsV1.maxEntities,
  maxRecoveryMappings: recoveryLimitsV1.maxMappings,
  maxRecoveryMidiNotes: recoveryLimitsV1.maxMidiNotes,
  maxRecoveryAutomationPoints: recoveryLimitsV1.maxAutomationPoints,
  maxRecoveryWarpMarkers: recoveryLimitsV1.maxWarpMarkers,
  maxRecoverySends: recoveryLimitsV1.maxSends,
  maxAssetsPerSnapshot: 1_000,
  maxAssetFoldersPerSnapshot: 500,
  maxAssetUploadBytes: 10 * 1024 * 1024,
  maxMidiNotesPerCommit: 500,
  maxAutomationPointsPerCommit: 1000,
  maxErrorDetails: 16,
  defaultHistoryPageSize: 50,
  maxHistoryPageSize: 100,
  defaultRecoveryPageSize: 50,
  maxRecoveryPageSize: 100,
}
export const controlLimitsV2 = {
  ...controlLimitsV1,
  maxMidiPerformanceEventsPerCommit: 500,
  maxMidiPerformanceEventsPerClip: 500,
  maxMidiEventsPerArray: 500,
  maxMidiMappingsPerClip: 64,
}

export const controlCapabilitiesSchemaV1 = z.object({
  version: z.literal(CONTROL_API_VERSION_V1),
  executionTarget: executionTargetSchemaV1,
  actionKinds: z.array(z.string()).readonly(),
  approvals: z.object({
    requiredForDestructiveActions: z.literal(true),
    expiresInSeconds: z.literal(600),
    tool: z.literal('control_request_approval'),
  }).strict(),
  recovery: z.object({
    supportedKinds: z.array(z.string().min(1).max(64)).readonly(),
    unavailableKinds: z.array(z.string().min(1).max(64)).readonly(),
    expiresInSeconds: z.literal(7 * 24 * 60 * 60),
  }).strict(),
  limits: z.object({
    maxActions: z.number().int().positive(),
    maxSerializedBodyBytes: z.number().int().positive(),
    maxRecoveryEntities: z.number().int().positive(),
    maxRecoveryMappings: z.number().int().positive(),
    maxRecoveryMidiNotes: z.number().int().positive(),
    maxRecoveryAutomationPoints: z.number().int().positive(),
    maxRecoveryWarpMarkers: z.number().int().positive(),
    maxRecoverySends: z.number().int().positive(),
    maxAssetsPerSnapshot: z.number().int().positive(),
    maxAssetFoldersPerSnapshot: z.number().int().positive(),
    maxAssetUploadBytes: z.number().int().positive(),
    maxMidiNotesPerCommit: z.number().int().positive(),
    maxAutomationPointsPerCommit: z.number().int().positive(),
    maxErrorDetails: z.number().int().positive(),
    defaultHistoryPageSize: z.number().int().positive(),
    maxHistoryPageSize: z.number().int().positive(),
    defaultRecoveryPageSize: z.number().int().positive(),
    maxRecoveryPageSize: z.number().int().positive(),
  }).strict(),
}).strict()

export const controlCapabilitiesQuerySchemaV1 = z.object({}).strict()
const controlCapabilityLimitFields = {
  maxActions: z.number().int().positive(),
  maxSerializedBodyBytes: z.number().int().positive(),
  maxRecoveryEntities: z.number().int().positive(),
  maxRecoveryMappings: z.number().int().positive(),
  maxRecoveryMidiNotes: z.number().int().positive(),
  maxRecoveryAutomationPoints: z.number().int().positive(),
  maxRecoveryWarpMarkers: z.number().int().positive(),
  maxRecoverySends: z.number().int().positive(),
  maxAssetsPerSnapshot: z.number().int().positive(),
  maxAssetFoldersPerSnapshot: z.number().int().positive(),
  maxAssetUploadBytes: z.number().int().positive(),
  maxMidiNotesPerCommit: z.number().int().positive(),
  maxAutomationPointsPerCommit: z.number().int().positive(),
  maxErrorDetails: z.number().int().positive(),
  defaultHistoryPageSize: z.number().int().positive(),
  maxHistoryPageSize: z.number().int().positive(),
  defaultRecoveryPageSize: z.number().int().positive(),
  maxRecoveryPageSize: z.number().int().positive(),
}
export const controlCapabilitiesSchemaV2 = controlCapabilitiesSchemaV1.extend({
  version: z.literal(CONTROL_API_VERSION_V2),
  limits: z.object({
    ...controlCapabilityLimitFields,
    maxMidiPerformanceEventsPerCommit: z.number().int().positive(),
    maxMidiPerformanceEventsPerClip: z.number().int().positive(),
    maxMidiEventsPerArray: z.number().int().positive(),
    maxMidiMappingsPerClip: z.number().int().positive(),
  }).strict(),
}).strict()
export const controlCapabilitiesQuerySchemaV2 = z.object({}).strict()

const localOnlyControlActionKindsV1 = ['external-plugin.parameters.set']

export const controlCapabilitiesV1 = {
  version: CONTROL_API_VERSION_V1,
  executionTarget: 'cloud-project',
  actionKinds: [
    'project.rename', 'project.settings.set', 'track.create', 'track.rename',
    'track.mix.set', 'track.routing.set', 'track.reorder', 'track.group.set',
    'track.delete', 'clip.midi.create', 'clip.move', 'clip.timing.set',
    'clip.rename', 'clip.delete', 'master.volume.set',
    'timeline.range.delete',
    'effect.upsert', 'effect.remove', 'effect.reorder',
    'instrument.set', 'arpeggiator.set',
    'automation.set', 'automation.delete', 'sidechain.set', 'sidechain.remove',
    'clip.audio.create', 'clip.source.set', 'clip.midi.set', 'clip.fades.set',
    'clip.audioWarp.set', 'clip.color.set', 'track.collapsed.set', 'track.color.set',
    'track.color.cascade', 'track.ungroup', 'instrument.remove', 'arpeggiator.remove',
    'asset.delete', 'recovery.restore',
  ],
  approvals: {
    requiredForDestructiveActions: true,
    expiresInSeconds: 600,
    tool: 'control_request_approval',
  },
  recovery: {
    supportedKinds: [
      'clip.delete', 'effect.remove', 'instrument.remove', 'arpeggiator.remove',
      'automation.delete', 'sidechain.remove', 'asset.delete', 'track.delete', 'track.ungroup',
      'timeline.range.delete',
    ],
    unavailableKinds: [],
    expiresInSeconds: 7 * 24 * 60 * 60,
  },
  limits: controlLimitsV1,
} satisfies z.input<typeof controlCapabilitiesSchemaV1>
export const localControlCapabilitiesV1 = {
  ...controlCapabilitiesV1,
  executionTarget: 'local-project',
  actionKinds: [...controlCapabilitiesV1.actionKinds, ...localOnlyControlActionKindsV1],
} satisfies z.input<typeof controlCapabilitiesSchemaV1>
export const controlCapabilitiesV2 = {
  ...controlCapabilitiesV1,
  version: CONTROL_API_VERSION_V2,
  limits: controlLimitsV2,
} satisfies z.input<typeof controlCapabilitiesSchemaV2>
export const localControlCapabilitiesV2 = {
  ...localControlCapabilitiesV1,
  version: CONTROL_API_VERSION_V2,
  limits: controlLimitsV2,
  executionTarget: 'local-project',
} satisfies z.input<typeof controlCapabilitiesSchemaV2>


export const canonicalControlApiVersion = CONTROL_API_VERSION_V2
export const canonicalControlLimits = controlLimitsV2
export const canonicalControlCapabilitiesSchema = controlCapabilitiesSchemaV2
export const canonicalControlCapabilitiesQuerySchema = controlCapabilitiesQuerySchemaV2
export const canonicalControlCapabilities = controlCapabilitiesV2
export const canonicalLocalControlCapabilities = localControlCapabilitiesV2
export const CONTROL_API_VERSION = canonicalControlApiVersion
export const controlLimits = canonicalControlLimits
export const controlCapabilitiesSchema = canonicalControlCapabilitiesSchema
export const controlCapabilitiesQuerySchema = canonicalControlCapabilitiesQuerySchema
export const controlCapabilities = canonicalControlCapabilities
export const localControlCapabilities = canonicalLocalControlCapabilities

export type ControlCapabilitiesV1 = z.infer<typeof controlCapabilitiesSchemaV1>
export type ControlCapabilitiesV2 = z.infer<typeof controlCapabilitiesSchemaV2>
export type CanonicalControlCapabilities = ControlCapabilitiesV2
export type ControlCapabilities = CanonicalControlCapabilities
