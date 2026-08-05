import { z } from 'zod'
import {
  opaquePluginStateMetadataSchema,
  pluginHealthSchema,
  pluginIdentitySchema,
  pluginManifestSchema,
  type PluginHealth,
} from '@daw-browser/plugin-host-protocol'

const uuidSchema = z.string().uuid()
const finite = z.number().finite()

export const externalPluginEntityKind = 'external-plugin'

const fingerprint = z.string().regex(/^[a-f0-9]{64}$/)

export const vstLaunchReferenceSchema = z.object({
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
export const migrateVstLaunchReference = (value: unknown): VstLaunchReference => {
  const legacy = z.object({
    classId: z.string().min(1).max(128),
    vendor: z.string().min(1).max(256),
    architecture: z.literal('arm64'),
    bundleFingerprint: fingerprint.optional(),
    binaryFingerprint: fingerprint,
    scannerCatalogVersion: z.number().int().positive().max(0x7fffffff).optional(),
    scannerProtocolVersion: z.number().int().positive().max(0x7fffffff).optional(),
    stateHash: fingerprint.optional(),
    state: opaquePluginStateMetadataSchema.optional(),
  }).passthrough().parse(value)
  return vstLaunchReferenceSchema.parse({
    version: 1,
    classId: legacy.classId,
    vendorId: legacy.vendor,
    architecture: legacy.architecture,
    bundleFingerprint: legacy.bundleFingerprint ?? legacy.binaryFingerprint,
    binaryFingerprint: legacy.binaryFingerprint,
    scannerCatalogVersion: legacy.scannerCatalogVersion ?? legacy.scannerProtocolVersion ?? 1,
    ...(legacy.stateHash === undefined ? {} : { stateHash: legacy.stateHash }),
    ...(legacy.state === undefined ? {} : { state: legacy.state }),
  })
}

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

export const parseExternalProcessorValue = (value: unknown): ExternalProcessorParseResult => {
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

export const externalInstrumentSchema = externalProcessorSchema.extend({
  manifest: pluginManifestSchema.refine((manifest) => manifest.role === 'instrument', 'External instrument requires an instrument manifest.'),
})
export type ExternalInstrument = z.infer<typeof externalInstrumentSchema>

export const externalPluginDegradedPlaceholder = (
  processor: ExternalProcessor,
  health: PluginHealth,
): ExternalProcessor => ({
  ...processor,
  bypassed: true,
  health,
})

export type ExternalPluginRuntime =
  | { kind: 'unavailable'; processor: ExternalProcessor; reason: string }
  | { kind: 'degraded'; processor: ExternalProcessor; reason: string }

export const resolveExternalPluginRuntime = (
  processor: ExternalProcessor,
  bridge: BridgeFeasibilityResult,
): ExternalPluginRuntime => {
  if (bridge.status !== 'unsupported') {
    return { kind: 'unavailable', processor, reason: 'A supported native audio bridge has not been integrated.' }
  }
  return {
    kind: 'degraded',
    processor: externalPluginDegradedPlaceholder(processor, {
      state: 'degraded',
      reason: bridge.reason,
      updatedAt: Date.now(),
    }),
    reason: bridge.reason,
  }
}

export type ExternalEffectTiming = {
  latencyFrames: number
  tail: { kind: 'finite'; frames: number } | { kind: 'unbounded' }
}

export const getExternalEffectTiming = (processor: Pick<ExternalProcessor, 'latencyFrames' | 'tailFrames'>): ExternalEffectTiming => ({
  latencyFrames: processor.latencyFrames,
  tail: processor.tailFrames === null ? { kind: 'unbounded' } : { kind: 'finite', frames: processor.tailFrames },
})

export type BridgeCandidate = 'direct-native-mapping' | 'bounded-copy-transport' | 'browser-only-fallback'
export type BridgeFeasibilityResult = {
  candidate: BridgeCandidate
  status: 'supported' | 'unsupported'
  reason: string
  measuredAt: number
  integrationPoint?: string
}

export const evaluateBridgeFeasibility = (input: {
  candidate: BridgeCandidate
  browserSabAvailable: boolean
  nativeAudioBridgeIntegrationPoint?: string
  measuredAt: number
}): BridgeFeasibilityResult => {
  if (input.candidate === 'direct-native-mapping') {
    return {
      candidate: input.candidate,
      status: 'unsupported',
      reason: 'Browser SharedArrayBuffer memory cannot be mapped directly into a native helper process.',
      measuredAt: input.measuredAt,
    }
  }
  if (input.candidate === 'bounded-copy-transport') {
    if (!input.nativeAudioBridgeIntegrationPoint) {
      return {
        candidate: input.candidate,
        status: 'unsupported',
        reason: 'No browser-to-native audio bridge integration point exists in the current audio engine.',
        measuredAt: input.measuredAt,
      }
    }
    return {
      candidate: input.candidate,
      status: 'unsupported',
      reason: 'A named integration point requires measured realtime validation before native hosting can activate.',
      measuredAt: input.measuredAt,
      integrationPoint: input.nativeAudioBridgeIntegrationPoint,
    }
  }
  return {
    candidate: input.candidate,
    status: 'unsupported',
    reason: input.browserSabAvailable
      ? 'Browser-only fallback preserves the dry route; it does not host native plugins.'
      : 'Browser-only fallback preserves the dry route without SharedArrayBuffer.',
    measuredAt: input.measuredAt,
  }
}

export const M0_BRIDGE_DECISION = {
  decision: 'rejected',
  rationale: 'The browser AudioEngine owns the live graph and exposes no native audio bridge. Its SPSC SharedArrayBuffer ring is browser-only.',
  requiredEvidence: ['A measured browser-to-native bridge integration point', 'Realtime underrun and latency measurements', 'Desktop custom-scheme COOP/COEP compatibility tests'],
}

export type ScheduledPluginParameter = {
  id: number
  value: number
  sampleOffset: number
  gesture: 'begin' | 'update' | 'end'
}

export const scheduleExternalParameters = (input: {
  changes: readonly ScheduledPluginParameter[]
  sampleRate: number
  windowStartSec: number
  lookAheadSec: number
  maxEvents: number
}) => {
  const startOffset = Math.max(0, Math.round(input.lookAheadSec * input.sampleRate))
  const byParameter = new Map<number, ScheduledPluginParameter>()
  for (const change of input.changes) {
    if (!Number.isFinite(change.value) || change.sampleOffset < startOffset) continue
    byParameter.set(change.id, change)
  }
  return [...byParameter.values()]
    .sort((a, b) => a.sampleOffset - b.sampleOffset || a.id - b.id)
    .slice(0, input.maxEvents)
}

export const scheduleExternalAutomation = (input: {
  points: readonly { id: number; value: number; beat: number; gesture: ScheduledPluginParameter['gesture'] }[]
  beatsToTimelineSec: (beat: number) => number
  timelineToAbsoluteSample: (timelineSec: number) => number
  windowStartBeat: number
  windowEndBeat: number
  quantizationSamples: number
  maxEvents: number
}) => {
  const scheduled: ScheduledPluginParameter[] = []
  for (const point of input.points) {
    if (
      !Number.isFinite(point.value)
      || point.beat < input.windowStartBeat
      || point.beat > input.windowEndBeat
    ) continue
    const sampleOffset = input.timelineToAbsoluteSample(input.beatsToTimelineSec(point.beat))
    const quantizedOffset = Math.max(
      0,
      Math.round(sampleOffset / Math.max(1, input.quantizationSamples)) * Math.max(1, input.quantizationSamples),
    )
    scheduled.push({ id: point.id, value: point.value, sampleOffset: quantizedOffset, gesture: point.gesture })
  }
  return scheduleExternalParameters({
    changes: scheduled,
    sampleRate: 1,
    windowStartSec: 0,
    lookAheadSec: 0,
    maxEvents: input.maxEvents,
  })
}

export const assertBrowserExportHasNoLiveExternalPlugins = (
  processors: readonly Pick<ExternalProcessor, 'instanceId' | 'bypassed' | 'health'>[],
) => {
  const unresolved = processors.find((processor) => !processor.bypassed)
  if (unresolved) {
    throw new Error(`External plugin ${unresolved.instanceId} must be frozen or bypassed before browser export.`)
  }
}

export const hybridFreezeJobSchema = z.object({
  id: uuidSchema,
  processor: pluginIdentitySchema,
  state: opaquePluginStateMetadataSchema,
  browserSegment: z.object({ startSec: finite.nonnegative(), endSec: finite.nonnegative() }).strict()
    .refine((segment) => segment.endSec > segment.startSec),
  nativeSegment: z.object({ startSample: z.number().int().nonnegative(), endSample: z.number().int().nonnegative() }).strict()
    .refine((segment) => segment.endSample > segment.startSample),
}).strict()
export type HybridFreezeJob = z.infer<typeof hybridFreezeJobSchema>
