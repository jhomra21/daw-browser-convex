import { z } from 'zod'
import {
  opaquePluginStateMetadataSchema,
  pluginHealthSchema,
  pluginIdentitySchema,
  pluginManifestSchema,
} from '@daw-browser/plugin-host-protocol'

const uuidSchema = z.string().uuid()
const finite = z.number().finite()

export const externalPluginEntityKind = 'external-plugin'

export type ExternalPluginJsonValue =
  | null
  | boolean
  | number
  | string
  | ExternalPluginJsonValue[]
  | { [key: string]: ExternalPluginJsonValue }

const fingerprint = z.string().regex(/^[a-f0-9]{64}$/)

const vstLaunchReferenceSchema = z.object({
  version: z.literal(1),
  classId: z.string().min(1).max(128),
  vendorId: z.string().min(1).max(256),
  architecture: z.literal('arm64'),
  bundleFingerprint: fingerprint,
  binaryFingerprint: fingerprint,
  scannerCatalogVersion: z.number().int().positive().max(0x7fffffff),
  stateHash: fingerprint.optional(),
  state: opaquePluginStateMetadataSchema.optional(),
}).strict()

export type VstLaunchReference = z.infer<typeof vstLaunchReferenceSchema>

/* Legacy scanner rows can contain a local discovery path. Convert only their
 * portable identity and state metadata before a project is persisted, shared,
 * or archived; native catalog resolution remains a trusted desktop concern. */

export const externalProcessorSchema = z.object({
  instanceId: uuidSchema,
  targetId: z.string().min(1).max(256),
  index: z.number().int().nonnegative(),
  manifest: pluginManifestSchema,
  parameterOverrides: z.record(z.string().regex(/^\d+$/), finite),
  latencyFrames: z.number().int().nonnegative(),
  tailFrames: z.number().int().nonnegative().nullable(),
  bypassed: z.boolean(),
  state: opaquePluginStateMetadataSchema.optional(),
  launchReference: vstLaunchReferenceSchema.optional(),
  health: pluginHealthSchema,
  updatedAt: z.number().int().nonnegative(),
}).strict()

export type ExternalProcessor = z.infer<typeof externalProcessorSchema>

const legacyExternalProcessorSchema = externalProcessorSchema.omit({ index: true }).extend({
  chainIndex: z.number().int().nonnegative(),
}).strict()

export type ExternalProcessorParseResult =
  | { success: true; data: ExternalProcessor; migrated: boolean }
  | { success: false; error: z.ZodError }

const canonicalExternalProcessor = (processor: ExternalProcessor): ExternalProcessor => (
  processor.manifest.role === 'instrument'
    ? { ...processor, index: 0 }
    : processor
)

export const parseExternalProcessorValue = (value: ExternalPluginJsonValue): ExternalProcessorParseResult => {
  const current = externalProcessorSchema.safeParse(value)

  if (current.success) {
    const data = canonicalExternalProcessor(current.data)

    return {
      success: true,
      data,
      migrated: data.index !== current.data.index,
    }
  }

  const legacy = legacyExternalProcessorSchema.safeParse(value)

  if (!legacy.success) return { success: false, error: current.error }
  const { chainIndex, ...processor } = legacy.data
  const data = canonicalExternalProcessor({ ...processor, index: chainIndex })

  return { success: true, data, migrated: true }
}

export const assertBrowserExportHasNoLiveExternalPlugins = (
  processors: readonly Pick<ExternalProcessor, 'instanceId' | 'bypassed' | 'health'>[],
) => {
  const unresolved = processors.find((processor) => !processor.bypassed)

  if (unresolved) {
    throw new Error(`External plugin ${unresolved.instanceId} must be frozen or bypassed before browser export.`)
  }
}

const hybridFreezeJobSchema = z.object({
  id: uuidSchema,
  processor: pluginIdentitySchema,
  state: opaquePluginStateMetadataSchema,
  browserSegment: z.object({ startSec: finite.nonnegative(), endSec: finite.nonnegative() }).strict()
    .refine((segment) => segment.endSec > segment.startSec),
  nativeSegment: z.object({ startSample: z.number().int().nonnegative(), endSample: z.number().int().nonnegative() }).strict()
    .refine((segment) => segment.endSample > segment.startSample),
}).strict()

export type HybridFreezeJob = z.infer<typeof hybridFreezeJobSchema>
