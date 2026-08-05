import { z } from 'zod'

export const pluginHostProtocolVersion = 2
export const pluginHostProtocolCompatibility = { minimum: 1, maximum: 2 }
export const maxPluginHostControlFrameBytes = 1_048_576
export const maxPluginHostLogEntries = 128
export const vst3WorkerProtocolVersion = 2
export const maxVst3WorkerStateBytes = 512 * 1024
export const maxVst3WorkerTransportSlots = 8
export const maxVst3WorkerChannels = 64
export const maxVst3WorkerFrames = 8_192
export const maxVst3WorkerEventsPerBlock = 2_048
export const nativeVst3WorkerArtifactId = 'daw-vst3-worker'
export const nativeVst3WorkerArtifactVersion = '2'
export const nativeVst3WorkerManifestVersion = 1
export const nativeVst3WorkerStartupProtocolVersion = 1
export const nativeVst3WorkerControlProtocolVersion = vst3WorkerProtocolVersion
export const nativeVst3WorkerTransportAbiVersion = 5

const requestIdSchema = z.string().min(1).max(96).regex(/^[A-Za-z0-9._-]+$/)
const uuidSchema = z.string().uuid()
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)
const unsigned64DecimalSchema = z.string().min(1).max(20).regex(/^[1-9][0-9]*$/)
  .refine((value) => BigInt(value) <= 0xffff_ffff_ffff_ffffn, 'Native graph node ID exceeds uint64.')
const finiteNumber = z.number().finite()
const scannerText = z.string().min(1).max(256)
const scannerPath = z.string().min(1).max(4096)
const compatibilitySchema = z.object({
  minimum: z.number().int().positive(),
  maximum: z.number().int().positive(),
}).strict().refine((value) => value.minimum <= value.maximum)

export const pluginIdentitySchema = z.object({
  format: z.literal('vst3'),
  classId: z.string().min(1).max(128),
  vendor: z.string().min(1).max(256),
  name: z.string().min(1).max(256),
  version: z.string().min(1).max(128),
  architecture: z.literal('arm64'),
  /* Discovery paths are local catalog data. Persisted/project identities omit
   * them and are resolved by a trusted native catalog at launch time. */
  discoveredPath: z.string().min(1).max(4096).optional(),
  binaryFingerprint: sha256Schema,
}).strict()
export type PluginIdentity = z.infer<typeof pluginIdentitySchema>

const busSchema = z.object({
  name: z.string().min(1).max(128),
  channels: z.number().int().min(0).max(64),
  enabled: z.boolean(),
}).strict()

export const pluginParameterDescriptorSchema = z.object({
  id: z.number().int().nonnegative().max(0xffff_ffff),
  title: z.string().min(1).max(256),
  unit: z.string().max(64),
  minimum: finiteNumber,
  maximum: finiteNumber,
  defaultValue: finiteNumber,
  stepCount: z.number().int().nonnegative().max(1_000_000),
  readOnly: z.boolean(),
  hidden: z.boolean(),
}).strict().superRefine((value, context) => {
  if (value.minimum > value.maximum) {
    context.addIssue({ code: 'custom', message: 'Parameter minimum exceeds maximum.' })
  }
  if (value.defaultValue < value.minimum || value.defaultValue > value.maximum) {
    context.addIssue({ code: 'custom', message: 'Parameter default is outside its range.' })
  }
})
export type PluginParameterDescriptor = z.infer<typeof pluginParameterDescriptorSchema>

export const pluginManifestSchema = z.object({
  identity: pluginIdentitySchema,
  role: z.enum(['effect', 'instrument']),
  audioInputs: z.array(busSchema).max(32),
  audioOutputs: z.array(busSchema).min(1).max(32),
  sidechainInputs: z.array(busSchema).max(16),
  parameters: z.array(pluginParameterDescriptorSchema).max(16_384)
    .refine((parameters) => new Set(parameters.map((parameter) => parameter.id)).size === parameters.length, 'Parameter IDs must be unique.'),
  latencyFrames: z.number().int().nonnegative().max(10_000_000),
  tailFrames: z.number().int().nonnegative().max(100_000_000).nullable(),
  supportsBypass: z.boolean(),
  supportsEditor: z.boolean(),
  supportsState: z.boolean(),
}).strict()
export type PluginManifest = z.infer<typeof pluginManifestSchema>

export const vst3ScannerClassResultSchema = z.object({
  classId: scannerText,
  vendor: scannerText,
  name: scannerText,
  version: scannerText,
  role: z.enum(['effect', 'instrument']),
  source: z.enum(['moduleinfo', 'factory']),
  sdkVersion: z.string().max(128).optional(),
}).strict()
export type Vst3ScannerClassResult = z.infer<typeof vst3ScannerClassResultSchema>

const scannerEnvelopeSchemaV2 = z.object({
  version: z.literal(2),
  compatibility: compatibilitySchema,
  requestId: requestIdSchema,
}).strict()

export const vst3ScannerRequestSchemaV2 = scannerEnvelopeSchemaV2.extend({
  type: z.literal('scan'),
  bundlePath: scannerPath,
}).strict()
export type Vst3ScannerRequestV2 = z.infer<typeof vst3ScannerRequestSchemaV2>

export const vst3ScannerResponseSchemaV2 = z.discriminatedUnion('type', [
  scannerEnvelopeSchemaV2.extend({
    type: z.literal('result'),
    bundlePath: scannerPath,
    scannerVersion: z.literal('1'),
    sdkVersion: scannerText,
    classes: z.array(vst3ScannerClassResultSchema).max(1024),
  }).strict(),
  scannerEnvelopeSchemaV2.extend({
    type: z.literal('error'),
    code: z.enum(['invalid-request', 'unavailable', 'faulted']),
    message: z.string().min(1).max(512),
  }).strict(),
])
export type Vst3ScannerResponseV2 = z.infer<typeof vst3ScannerResponseSchemaV2>

export const parseVst3ScannerRequestV2 = (raw: string): Vst3ScannerRequestV2 => {
  if (new TextEncoder().encode(raw).byteLength > maxPluginHostControlFrameBytes) {
    throw new Error('Plugin host control frame exceeds the maximum size.')
  }
  return vst3ScannerRequestSchemaV2.parse(JSON.parse(raw))
}

export const parseVst3ScannerResponseV2 = (raw: string): Vst3ScannerResponseV2 => {
  if (new TextEncoder().encode(raw).byteLength > maxPluginHostControlFrameBytes) {
    throw new Error('Plugin host control frame exceeds the maximum size.')
  }
  return vst3ScannerResponseSchemaV2.parse(JSON.parse(raw))
}

export const opaquePluginStateMetadataSchema = z.object({
  artifactId: uuidSchema,
  sha256: sha256Schema,
  byteLength: z.number().int().positive().max(512 * 1024 * 1024),
  artifactKind: z.enum(['plugin-state', 'plugin-freeze']),
  ownerId: z.string().min(1).max(256),
  acl: z.enum(['owner', 'project-members']),
  bucket: z.enum(['local', 'r2-plugin-artifacts']),
  location: z.string().min(1).max(1024),
}).strict()
export type OpaquePluginStateMetadata = z.infer<typeof opaquePluginStateMetadataSchema>

export const pluginHealthSchema = z.object({
  state: z.enum(['discovered', 'ready', 'unavailable', 'degraded', 'faulted', 'architecture-mismatch']),
  reason: z.string().min(1).max(512).optional(),
  updatedAt: z.number().int().nonnegative(),
}).strict()
export type PluginHealth = z.infer<typeof pluginHealthSchema>

const controlEnvelopeSchema = z.object({
  version: z.literal(1),
  compatibility: compatibilitySchema,
  requestId: requestIdSchema,
}).strict()

const instanceReferenceSchema = z.object({
  instanceId: uuidSchema,
  identity: pluginIdentitySchema,
}).strict()

export const pluginHostRequestSchema = z.discriminatedUnion('type', [
  controlEnvelopeSchema.extend({ type: z.literal('scan'), paths: z.array(z.string().min(1).max(4096)).max(16) }).strict(),
  controlEnvelopeSchema.extend({ type: z.literal('instantiate'), instance: instanceReferenceSchema }).strict(),
  controlEnvelopeSchema.extend({ type: z.literal('dispose'), instanceId: uuidSchema }).strict(),
  controlEnvelopeSchema.extend({ type: z.literal('set-parameters'), instanceId: uuidSchema, values: z.array(z.object({ id: z.number().int().nonnegative().max(0xffff_ffff), value: finiteNumber }).strict()).min(1).max(512) }).strict(),
  controlEnvelopeSchema.extend({ type: z.literal('editor'), instanceId: uuidSchema, action: z.enum(['open', 'close', 'focus']) }).strict(),
  controlEnvelopeSchema.extend({ type: z.literal('state'), instanceId: uuidSchema, action: z.enum(['save', 'load']), metadata: opaquePluginStateMetadataSchema.optional() }).strict().superRefine((value, context) => {
    if (value.action === 'load' && !value.metadata) context.addIssue({ code: 'custom', message: 'Loading state requires metadata, not state bytes.' })
  }),
])
export type PluginHostRequest = z.infer<typeof pluginHostRequestSchema>

export const pluginHostResponseSchema = z.discriminatedUnion('type', [
  controlEnvelopeSchema.extend({ type: z.literal('ok'), instanceId: uuidSchema.optional(), manifest: pluginManifestSchema.optional(), state: opaquePluginStateMetadataSchema.optional() }).strict(),
  controlEnvelopeSchema.extend({ type: z.literal('error'), code: z.enum(['invalid-request', 'unsupported', 'not-found', 'timeout', 'faulted', 'unavailable']), message: z.string().min(1).max(512) }).strict(),
])
export type PluginHostResponse = z.infer<typeof pluginHostResponseSchema>

export const parsePluginHostControlFrame = (raw: string): PluginHostRequest => {
  if (new TextEncoder().encode(raw).byteLength > maxPluginHostControlFrameBytes) {
    throw new Error('Plugin host control frame exceeds the maximum size.')
  }
  const request = pluginHostRequestSchema.parse(JSON.parse(raw))
  const compatibility = request.compatibility
  if (
    request.version < compatibility.minimum
    || request.version > compatibility.maximum
    || compatibility.maximum < pluginHostProtocolCompatibility.minimum
    || compatibility.minimum > pluginHostProtocolCompatibility.maximum
  ) {
    throw new Error('Plugin host control frame has incompatible protocol compatibility.')
  }
  return request
}

export const isPluginHostProtocolCompatible = (version: number) => (
  version >= pluginHostProtocolCompatibility.minimum
  && version <= pluginHostProtocolCompatibility.maximum
)

const workerEnvelopeSchemaV2 = z.object({
  version: z.literal(vst3WorkerProtocolVersion),
  compatibility: compatibilitySchema,
  requestId: requestIdSchema,
}).strict()

const workerInstanceSchema = z.object({
  instanceId: uuidSchema,
  identity: pluginIdentitySchema,
  launchEligibility: z.object({
    canonicalBundlePath: scannerPath,
    canonicalExecutablePath: scannerPath,
    bundleFingerprint: sha256Schema,
    binaryFingerprint: sha256Schema,
    architecture: z.literal('arm64'),
    codeSignVerifiedAtMs: z.number().int().nonnegative(),
    quarantinePresent: z.literal(false),
    scannerProtocolVersion: z.literal(2),
  }).strict(),
}).strict()

const workerSetupSchema = z.object({
  sampleRate: finiteNumber.positive().max(384_000),
  maximumBlockFrames: z.number().int().positive().max(maxVst3WorkerFrames),
  inputChannels: z.number().int().min(0).max(maxVst3WorkerChannels),
  outputChannels: z.number().int().min(1).max(maxVst3WorkerChannels),
}).strict()

export const vst3WorkerTransportDescriptorSchema = z.object({
  name: z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/),
  byteLength: z.number().int().positive().max(128 * 1024 * 1024),
  slotCount: z.number().int().min(2).max(maxVst3WorkerTransportSlots),
  maximumFrames: z.number().int().positive().max(maxVst3WorkerFrames),
  inputChannels: z.number().int().min(0).max(maxVst3WorkerChannels),
  outputChannels: z.number().int().min(1).max(maxVst3WorkerChannels),
  maximumEventsPerBlock: z.number().int().min(0).max(maxVst3WorkerEventsPerBlock),
}).strict()
export type Vst3WorkerTransportDescriptor = z.infer<typeof vst3WorkerTransportDescriptorSchema>

const nativeExternalWorkerTransportDimensionsSchema = z.object({
  slotCount: z.number().int().min(2).max(maxVst3WorkerTransportSlots),
  maximumFrames: z.number().int().positive().max(maxVst3WorkerFrames),
  inputChannels: z.number().int().min(0).max(maxVst3WorkerChannels),
  outputChannels: z.number().int().positive().max(maxVst3WorkerChannels),
  maximumEventsPerBlock: z.number().int().nonnegative().max(maxVst3WorkerEventsPerBlock),
}).strict()

const nativeVst3WorkerTransportDimensionsSchema = nativeExternalWorkerTransportDimensionsSchema.extend({
  inputChannels: z.number().int().min(0).max(maxVst3WorkerChannels),
}).strict()

const nativeVst3WorkerArtifactIdentitySchema = z.object({
  id: z.literal(nativeVst3WorkerArtifactId),
  version: z.literal(nativeVst3WorkerArtifactVersion),
}).strict()
export type NativeVst3WorkerArtifactIdentity = z.infer<typeof nativeVst3WorkerArtifactIdentitySchema>

export const nativeVst3WorkerManifestSchema = z.object({
  version: z.literal(nativeVst3WorkerManifestVersion),
  artifact: nativeVst3WorkerArtifactIdentitySchema,
  startupProtocolVersion: z.literal(nativeVst3WorkerStartupProtocolVersion),
  controlProtocolVersion: z.literal(nativeVst3WorkerControlProtocolVersion),
  transportAbiVersion: z.literal(nativeVst3WorkerTransportAbiVersion),
  architecture: z.literal('arm64'),
  role: z.enum(['effect', 'instrument']),
  inputBuses: z.array(busSchema).max(32),
  outputBuses: z.array(busSchema).min(1).max(32),
  transport: nativeVst3WorkerTransportDimensionsSchema,
  latencyFrames: z.number().int().nonnegative().max(10_000_000),
  tailFrames: z.number().int().nonnegative().max(100_000_000).nullable(),
  stateRevision: z.number().int().nonnegative().max(0x7fffffff),
  parameters: z.array(pluginParameterDescriptorSchema).max(16_384).optional(),
  supportsBypass: z.boolean().optional(),
  supportsEditor: z.boolean().optional(),
  supportsState: z.boolean().optional(),
}).strict().superRefine((value, context) => {
  const inputChannels = value.inputBuses
    .filter((bus) => bus.enabled)
    .reduce((channels, bus) => channels + bus.channels, 0)
  const outputChannels = value.outputBuses
    .filter((bus) => bus.enabled)
    .reduce((channels, bus) => channels + bus.channels, 0)
  if (inputChannels !== value.transport.inputChannels) {
    context.addIssue({ code: 'custom', path: ['transport', 'inputChannels'], message: 'Worker transport input channels do not match enabled input buses.' })
  }
  if (outputChannels !== value.transport.outputChannels) {
    context.addIssue({ code: 'custom', path: ['transport', 'outputChannels'], message: 'Worker transport output channels do not match enabled output buses.' })
  }
  if (value.role === 'instrument' && inputChannels !== 0) {
    context.addIssue({ code: 'custom', path: ['inputBuses'], message: 'Instrument workers must not expose enabled audio input buses.' })
  }
  if (value.role === 'effect' && inputChannels === 0) {
    context.addIssue({ code: 'custom', path: ['inputBuses'], message: 'Effect workers must expose an enabled audio input bus.' })
  }
})
export type NativeVst3WorkerManifest = z.infer<typeof nativeVst3WorkerManifestSchema>

export const nativeVst3WorkerHelloSchema = z.object({
  version: z.literal(1),
  type: z.literal('hello'),
  instanceId: uuidSchema,
  manifest: nativeVst3WorkerManifestSchema,
}).strict()
export type NativeVst3WorkerHello = z.infer<typeof nativeVst3WorkerHelloSchema>

export const encodeNativeVst3WorkerHello = (hello: NativeVst3WorkerHello): string => (
  JSON.stringify(nativeVst3WorkerHelloSchema.parse(hello))
)

export const decodeNativeVst3WorkerHello = (raw: string): NativeVst3WorkerHello => {
  if (new TextEncoder().encode(raw).byteLength > maxPluginHostControlFrameBytes) {
    throw new Error('Native VST3 worker hello exceeds the maximum size.')
  }
  return nativeVst3WorkerHelloSchema.parse(JSON.parse(raw))
}

export const nativeVst3PreflightProtocolVersion = 1

const nativeVst3PreflightRequirementsSchema = z.object({
  artifact: nativeVst3WorkerArtifactIdentitySchema,
  startupProtocolVersion: z.literal(nativeVst3WorkerStartupProtocolVersion),
  controlProtocolVersion: z.literal(nativeVst3WorkerControlProtocolVersion),
  transportAbiVersion: z.literal(nativeVst3WorkerTransportAbiVersion),
  architecture: z.literal('arm64'),
}).strict()

export const nativeVst3PreflightRequestSchema = z.object({
  version: z.literal(nativeVst3PreflightProtocolVersion),
  type: z.literal('preflight'),
  requestId: requestIdSchema,
  requirements: nativeVst3PreflightRequirementsSchema,
}).strict()
export type NativeVst3PreflightRequest = z.infer<typeof nativeVst3PreflightRequestSchema>

const nativeVst3PreflightResultEnvelopeSchema = z.object({
  version: z.literal(nativeVst3PreflightProtocolVersion),
  type: z.literal('preflight-result'),
  requestId: requestIdSchema,
  requirements: nativeVst3PreflightRequirementsSchema,
}).strict()

export const nativeVst3PreflightResultSchema = z.discriminatedUnion('status', [
  nativeVst3PreflightResultEnvelopeSchema.extend({
    status: z.literal('available'),
    hello: nativeVst3WorkerHelloSchema,
  }).strict(),
  nativeVst3PreflightResultEnvelopeSchema.extend({
    status: z.literal('unavailable'),
    code: z.enum(['worker-unavailable', 'worker-timeout', 'worker-crashed', 'worker-invalid-response']),
    message: z.string().min(1).max(512),
  }).strict(),
])
export type NativeVst3PreflightResult = z.infer<typeof nativeVst3PreflightResultSchema>

export const encodeNativeVst3PreflightRequest = (request: NativeVst3PreflightRequest): string => (
  JSON.stringify(nativeVst3PreflightRequestSchema.parse(request))
)

export const decodeNativeVst3PreflightRequest = (raw: string): NativeVst3PreflightRequest => {
  if (new TextEncoder().encode(raw).byteLength > maxPluginHostControlFrameBytes) {
    throw new Error('Native VST3 preflight request exceeds the maximum size.')
  }
  return nativeVst3PreflightRequestSchema.parse(JSON.parse(raw))
}

export const encodeNativeVst3PreflightResult = (result: NativeVst3PreflightResult): string => (
  JSON.stringify(nativeVst3PreflightResultSchema.parse(result))
)

export const decodeNativeVst3PreflightResult = (raw: string): NativeVst3PreflightResult => {
  if (new TextEncoder().encode(raw).byteLength > maxPluginHostControlFrameBytes) {
    throw new Error('Native VST3 preflight result exceeds the maximum size.')
  }
  return nativeVst3PreflightResultSchema.parse(JSON.parse(raw))
}

export const nativeVst3CatalogReferenceSchema = z.object({
  version: z.literal(1),
  classId: scannerText,
  vendorId: scannerText,
  architecture: z.literal('arm64'),
  bundleFingerprint: sha256Schema,
  binaryFingerprint: sha256Schema,
  scannerCatalogVersion: z.literal(vst3WorkerProtocolVersion),
}).strict()
export type NativeVst3CatalogReference = z.infer<typeof nativeVst3CatalogReferenceSchema>

export const nativeVst3InsertionPreflightRequestSchema = z.object({
  instanceId: uuidSchema,
  reference: nativeVst3CatalogReferenceSchema,
}).strict()
export type NativeVst3InsertionPreflightRequest = z.infer<typeof nativeVst3InsertionPreflightRequestSchema>

export const nativeVst3InsertionFailureCodeSchema = z.enum([
  'browser',
  'project-unavailable',
  'untrusted-catalog',
  'stale-catalog',
  'unsupported-role',
  'unsupported-bus',
  'host-unavailable',
  'worker-unavailable',
  'worker-timeout',
  'worker-crashed',
  'worker-invalid-response',
])
export type NativeVst3InsertionFailureCode = z.infer<typeof nativeVst3InsertionFailureCodeSchema>

const nativeVst3InsertionManifestSchema = z.object({
  role: z.enum(['effect', 'instrument']),
  inputBuses: z.array(busSchema).max(32),
  outputBuses: z.array(busSchema).min(1).max(32),
  latencyFrames: z.number().int().nonnegative().max(10_000_000),
  tailFrames: z.number().int().nonnegative().max(100_000_000).nullable(),
  parameters: z.array(pluginParameterDescriptorSchema).max(16_384),
  supportsBypass: z.boolean(),
  supportsEditor: z.boolean(),
  supportsState: z.boolean(),
}).strict()

export const nativeVst3InsertionPreflightResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    manifest: nativeVst3InsertionManifestSchema,
  }).strict(),
  z.object({
    ok: z.literal(false),
    code: nativeVst3InsertionFailureCodeSchema,
    message: z.string().min(1).max(512),
  }).strict(),
])
export type NativeVst3InsertionPreflightResult = z.infer<typeof nativeVst3InsertionPreflightResultSchema>

/**
 * This renderer-to-native-host plan is deliberately separate from portable
 * audio graph snapshots. Catalog resolution adds local paths only after this
 * path-free contract crosses the renderer boundary.
 */
export const nativeExternalAttachmentPlanProtocolVersion = 2
export const maxNativeExternalAttachments = 64

const nativeExternalCatalogIdentitySchema = z.object({
  format: z.literal('vst3'),
  classId: z.string().min(1).max(128),
  vendorId: z.string().min(1).max(256),
  architecture: z.literal('arm64'),
  scannerCatalogVersion: z.literal(2),
}).strict()

const nativeExternalAttachmentFields = {
  instanceId: uuidSchema,
  graphNodeId: z.string().min(1).max(256),
  nativeGraphNodeId: unsigned64DecimalSchema,
  stageIndex: z.number().int().nonnegative().max(0x7fffffff),
  sourceIndex: z.number().int().nonnegative().max(0x7fffffff).optional(),
  catalogIdentity: nativeExternalCatalogIdentitySchema,
  bundleFingerprint: sha256Schema,
  binaryFingerprint: sha256Schema,
  role: z.enum(['effect', 'instrument']),
  inputBuses: z.array(busSchema).max(32),
  outputBuses: z.array(busSchema).min(1).max(32),
  workerTransport: nativeExternalWorkerTransportDimensionsSchema,
  declaredLatencyFrames: z.number().int().nonnegative().max(10_000_000),
  declaredTailFrames: z.number().int().nonnegative().max(100_000_000).nullable(),
  bypassed: z.boolean(),
  stateRevision: z.number().int().nonnegative().max(0x7fffffff),
  parameters: z.array(pluginParameterDescriptorSchema).max(16_384).optional(),
  parameterOverrides: z.record(
    z.string().regex(/^\d+$/),
    finiteNumber.refine((value) => value >= 0 && value <= 1),
  ).optional(),
} as const

const nativeExternalAttachmentSchemaV1 = z.object(nativeExternalAttachmentFields).strict()
const nativeExternalAttachmentSchemaV2 = z.object({
  ...nativeExternalAttachmentFields,
  stageIndex: z.number().int().nonnegative().max(0x7fffffff),
}).strict()

const nativeExternalAttachmentPlanFields = {
  attachments: z.array(nativeExternalAttachmentSchemaV1).max(maxNativeExternalAttachments),
} as const

const validateNativeExternalAttachmentPlan = (
  value: { attachments: readonly z.infer<typeof nativeExternalAttachmentSchemaV1>[] },
  context: z.RefinementCtx,
) => {
  const instanceIds = new Set<string>()
  const chains = new Map<string, Array<{ index: number; nativeGraphNodeId: string; role: 'effect' | 'instrument' }>>()
  const graphNodeByNativeId = new Map<string, string>()
  for (const [index, attachment] of value.attachments.entries()) {
    const inputChannels = attachment.inputBuses
      .filter((bus) => bus.enabled)
      .reduce((channels, bus) => channels + bus.channels, 0)
    const outputChannels = attachment.outputBuses
      .filter((bus) => bus.enabled)
      .reduce((channels, bus) => channels + bus.channels, 0)
    if (inputChannels !== attachment.workerTransport.inputChannels) {
      context.addIssue({
        code: 'custom',
        path: ['attachments', index, 'workerTransport', 'inputChannels'],
        message: 'External attachment transport input channels do not match enabled input buses.',
      })
    }
    if (outputChannels !== attachment.workerTransport.outputChannels) {
      context.addIssue({
        code: 'custom',
        path: ['attachments', index, 'workerTransport', 'outputChannels'],
        message: 'External attachment transport output channels do not match enabled output buses.',
      })
    }
    if (attachment.role === 'instrument' && inputChannels !== 0) {
      context.addIssue({
        code: 'custom',
        path: ['attachments', index, 'inputBuses'],
        message: 'Instrument attachments must not expose enabled audio input buses.',
      })
    }
    if (attachment.role === 'instrument'
      && attachment.sourceIndex !== undefined
      && attachment.sourceIndex !== 0) {
      context.addIssue({
        code: 'custom',
        path: ['attachments', index, 'sourceIndex'],
        message: 'Instrument attachments must identify source index zero.',
      })
    }
    if (attachment.role === 'effect' && attachment.sourceIndex !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['attachments', index, 'sourceIndex'],
        message: 'Effect attachments must not identify an instrument source.',
      })
    }
    if (attachment.role === 'effect' && inputChannels === 0) {
      context.addIssue({
        code: 'custom',
        path: ['attachments', index, 'inputBuses'],
        message: 'Effect attachments must expose an enabled audio input bus.',
      })
    }
    if (instanceIds.has(attachment.instanceId)) {
      context.addIssue({
        code: 'custom',
        path: ['attachments', index, 'instanceId'],
        message: 'External attachment instance IDs must be unique.',
      })
    }
    instanceIds.add(attachment.instanceId)
    const chain = chains.get(attachment.graphNodeId) ?? []
    if (chain.some((candidate) => candidate.role === attachment.role && candidate.index === attachment.stageIndex)) {
      context.addIssue({
        code: 'custom',
        path: ['attachments', index, 'stageIndex'],
        message: 'External attachment chain indexes must be unique per graph node.',
      })
    }
    if (chain.some((candidate) => candidate.nativeGraphNodeId !== attachment.nativeGraphNodeId)) {
      context.addIssue({
        code: 'custom',
        path: ['attachments', index, 'nativeGraphNodeId'],
        message: 'External attachments on one graph node must share its native graph node ID.',
      })
    }
    const existingGraphNode = graphNodeByNativeId.get(attachment.nativeGraphNodeId)
    if (existingGraphNode !== undefined && existingGraphNode !== attachment.graphNodeId) {
      context.addIssue({
        code: 'custom',
        path: ['attachments', index, 'nativeGraphNodeId'],
        message: 'Native graph node IDs must identify only one graph node.',
      })
    }
    graphNodeByNativeId.set(attachment.nativeGraphNodeId, attachment.graphNodeId)
    chain.push({
      index: attachment.role === 'instrument' ? (attachment.sourceIndex ?? 0) : attachment.stageIndex,
      nativeGraphNodeId: attachment.nativeGraphNodeId,
      role: attachment.role,
    })
    chains.set(attachment.graphNodeId, chain)
  }
}

const nativeExternalAttachmentPlanSchemaV1 = z.object({
  version: z.literal(1),
  ...nativeExternalAttachmentPlanFields,
}).strict().superRefine(validateNativeExternalAttachmentPlan)

const nativeExternalAttachmentPlanSchemaV2 = z.object({
  version: z.literal(nativeExternalAttachmentPlanProtocolVersion),
  attachments: z.array(nativeExternalAttachmentSchemaV2).max(maxNativeExternalAttachments),
}).strict().superRefine((value, context) => {
  validateNativeExternalAttachmentPlan(value, context)
})

export const nativeExternalAttachmentPlanSchema = z.union([
  nativeExternalAttachmentPlanSchemaV1,
  nativeExternalAttachmentPlanSchemaV2,
])
export type NativeExternalAttachmentPlan = z.infer<typeof nativeExternalAttachmentPlanSchema>

export const encodeNativeExternalAttachmentPlan = (plan: NativeExternalAttachmentPlan): string => (
  JSON.stringify(nativeExternalAttachmentPlanSchema.parse(plan))
)

export const decodeNativeExternalAttachmentPlan = (raw: string): NativeExternalAttachmentPlan => {
  if (new TextEncoder().encode(raw).byteLength > maxPluginHostControlFrameBytes) {
    throw new Error('Native external attachment plan exceeds the maximum size.')
  }
  return nativeExternalAttachmentPlanSchema.parse(JSON.parse(raw))
}

const workerStateTransferSchema = z.object({
  byteLength: z.number().int().nonnegative().max(maxVst3WorkerStateBytes),
  sha256: sha256Schema,
  bytesBase64: z.string().max(Math.ceil(maxVst3WorkerStateBytes / 3) * 4).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
}).strict().superRefine((value, context) => {
  const padding = value.bytesBase64.endsWith('==') ? 2 : value.bytesBase64.endsWith('=') ? 1 : 0
  if ((value.bytesBase64.length / 4) * 3 - padding !== value.byteLength) {
    context.addIssue({ code: 'custom', message: 'State byte length does not match base64 payload.' })
  }
})

const workerEventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('parameter'), id: z.number().int().nonnegative().max(0xffff_ffff), value: finiteNumber, sampleOffset: z.number().int().nonnegative().max(maxVst3WorkerFrames - 1) }).strict(),
  z.object({ kind: z.literal('midi'), data: z.tuple([z.number().int().min(0).max(255), z.number().int().min(0).max(255), z.number().int().min(0).max(255)]), sampleOffset: z.number().int().nonnegative().max(maxVst3WorkerFrames - 1) }).strict(),
])

export const vst3WorkerControlRequestSchemaV2 = z.discriminatedUnion('type', [
  workerEnvelopeSchemaV2.extend({ type: z.literal('lifecycle'), action: z.enum(['hello', 'shutdown', 'restart']) }).strict(),
  workerEnvelopeSchemaV2.extend({ type: z.literal('instantiate'), instance: workerInstanceSchema }).strict(),
  workerEnvelopeSchemaV2.extend({ type: z.literal('setup'), instanceId: uuidSchema, setup: workerSetupSchema }).strict(),
  workerEnvelopeSchemaV2.extend({ type: z.literal('transport-negotiate'), instanceId: uuidSchema, transport: vst3WorkerTransportDescriptorSchema }).strict(),
  workerEnvelopeSchemaV2.extend({ type: z.literal('state-transfer'), instanceId: uuidSchema, action: z.enum(['get', 'set']), state: workerStateTransferSchema.optional() }).strict().superRefine((value, context) => {
    if (value.action === 'set' && !value.state) context.addIssue({ code: 'custom', message: 'Setting worker state requires state bytes.' })
  }),
  workerEnvelopeSchemaV2.extend({ type: z.literal('events'), instanceId: uuidSchema, events: z.array(workerEventSchema).max(maxVst3WorkerEventsPerBlock) }).strict(),
])
export type Vst3WorkerControlRequestV2 = z.infer<typeof vst3WorkerControlRequestSchemaV2>

export const vst3WorkerNotificationSchemaV2 = z.discriminatedUnion('type', [
  workerEnvelopeSchemaV2.extend({ type: z.literal('ready'), instanceId: uuidSchema.optional() }).strict(),
  workerEnvelopeSchemaV2.extend({ type: z.literal('restart'), instanceId: uuidSchema, reason: z.string().min(1).max(512) }).strict(),
  workerEnvelopeSchemaV2.extend({ type: z.literal('latency'), instanceId: uuidSchema, frames: z.number().int().nonnegative().max(10_000_000) }).strict(),
  workerEnvelopeSchemaV2.extend({ type: z.literal('buses'), instanceId: uuidSchema, inputs: z.array(busSchema).max(32), outputs: z.array(busSchema).max(32) }).strict(),
  workerEnvelopeSchemaV2.extend({ type: z.literal('health'), instanceId: uuidSchema, health: pluginHealthSchema }).strict(),
  workerEnvelopeSchemaV2.extend({ type: z.literal('fault'), instanceId: uuidSchema.optional(), code: z.enum(['invalid-request', 'transport', 'timeout', 'launch', 'state', 'faulted']), message: z.string().min(1).max(512) }).strict(),
])
export type Vst3WorkerNotificationV2 = z.infer<typeof vst3WorkerNotificationSchemaV2>

export const parseVst3WorkerControlRequestV2 = (raw: string): Vst3WorkerControlRequestV2 => {
  if (new TextEncoder().encode(raw).byteLength > maxPluginHostControlFrameBytes) {
    throw new Error('Plugin host control frame exceeds the maximum size.')
  }
  const request = vst3WorkerControlRequestSchemaV2.parse(JSON.parse(raw))
  if (request.compatibility.minimum > vst3WorkerProtocolVersion || request.compatibility.maximum < vst3WorkerProtocolVersion) {
    throw new Error('VST3 worker control frame has incompatible protocol compatibility.')
  }
  return request
}
