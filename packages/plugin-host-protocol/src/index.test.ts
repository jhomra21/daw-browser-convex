import { describe, expect, test } from 'bun:test'
import {
  decodeNativeExternalAttachmentPlan,
  encodeNativeExternalAttachmentPlan,
  decodeNativeVst3PreflightRequest,
  decodeNativeVst3PreflightResult,
  decodeNativeVst3WorkerHello,
  encodeNativeVst3PreflightRequest,
  encodeNativeVst3PreflightResult,
  encodeNativeVst3WorkerHello,
  maxNativeExternalAttachments,
  maxPluginHostControlFrameBytes,
  maxVst3WorkerChannels,
  nativeVst3WorkerArtifactId,
  nativeVst3WorkerArtifactVersion,
  nativeVst3WorkerControlProtocolVersion,
  nativeVst3WorkerManifestVersion,
  nativeVst3WorkerStartupProtocolVersion,
  nativeVst3WorkerTransportAbiVersion,
  nativeVst3PreflightProtocolVersion,
  type NativeExternalAttachmentPlan,
  type NativeVst3PreflightRequest,
  type NativeVst3PreflightResult,
  type NativeVst3WorkerHello,
  parsePluginHostControlFrame,
  parseVst3WorkerControlRequestV2,
  parseVst3ScannerResponseV2,
  pluginHostProtocolCompatibility,
  pluginParameterDescriptorSchema,
  vst3WorkerProtocolVersion,
} from './index'

describe('plugin host control protocol', () => {
  test('accepts the complete unsigned VST3 ParamID range and rejects overflow', () => {
    for (const id of [0, 0x7fff_ffff, 0x8000_0000, 0xffff_ffff]) {
      expect(pluginParameterDescriptorSchema.safeParse({
        id,
        title: 'Parameter',
        unit: '',
        minimum: 0,
        maximum: 1,
        defaultValue: 0.5,
        stepCount: 1,
        readOnly: false,
        hidden: false,
      }).success).toBe(true)
    }
    expect(pluginParameterDescriptorSchema.safeParse({
      id: 0x1_0000_0000,
      title: 'Parameter',
      unit: '',
      minimum: 0,
      maximum: 1,
      defaultValue: 0.5,
      stepCount: 1,
      readOnly: false,
      hidden: false,
    }).success).toBe(false)
  })

  test('rejects oversized control frames before parsing them', () => {
    expect(() => parsePluginHostControlFrame('x'.repeat(maxPluginHostControlFrameBytes + 1))).toThrow(
      'Plugin host control frame exceeds the maximum size.',
    )
  })

  test('accepts only bounded state metadata controls', () => {
    const request = {
      version: 1,
      compatibility: pluginHostProtocolCompatibility,
      requestId: 'state-1',
      type: 'state',
      instanceId: 'a7a0b9ac-7884-492c-8b68-80f15802442c',
      action: 'load',
      metadata: {
        artifactId: 'a7a0b9ac-7884-492c-8b68-80f15802442c',
        sha256: 'a'.repeat(64),
        byteLength: 8,
        artifactKind: 'plugin-state',
        ownerId: 'user-1',
        acl: 'owner',
        bucket: 'local',
        location: 'plugin-artifacts/a7a0b9ac-7884-492c-8b68-80f15802442c',
      },
    }
    expect(parsePluginHostControlFrame(JSON.stringify(request))).toMatchObject({
      type: 'state',
      action: 'load',
    })
    expect(() => parsePluginHostControlFrame(JSON.stringify({ ...request, metadata: undefined }))).toThrow()
  })

  test('rejects envelopes whose compatibility does not contain or support their version', () => {
    const request = {
      version: 1,
      compatibility: { minimum: 2, maximum: 2 },
      requestId: 'scan-1',
      type: 'scan',
      paths: ['/Plugins'],
    }
    expect(() => parsePluginHostControlFrame(JSON.stringify(request))).toThrow(
      'incompatible protocol compatibility',
    )
    expect(() => parsePluginHostControlFrame(JSON.stringify({
      ...request,
      compatibility: { minimum: 2, maximum: 3 },
    }))).toThrow('incompatible protocol compatibility')
  })
})

test('accepts bounded multi-class scanner responses', () => {
  const response = parseVst3ScannerResponseV2(JSON.stringify({
    version: 2,
    compatibility: { minimum: 1, maximum: 2 },
    requestId: 'scan-1',
    type: 'result',
    bundlePath: '/Plugins/Example.vst3',
    scannerVersion: '1',
    sdkVersion: '3.8.0',
    classes: [
      { classId: 'effect', vendor: 'Vendor', name: 'Effect', version: '1', role: 'effect', source: 'moduleinfo' },
      { classId: 'instrument', vendor: 'Vendor', name: 'Instrument', version: '1', role: 'instrument', source: 'factory' },
    ],
  }))
  expect(response.type).toBe('result')
  if (response.type === 'result') expect(response.classes).toHaveLength(2)
})

test('keeps worker controls versioned and bounds state transfers independently from V1 metadata', () => {
  const request = parseVst3WorkerControlRequestV2(JSON.stringify({
    version: vst3WorkerProtocolVersion,
    compatibility: { minimum: 2, maximum: 2 },
    requestId: 'worker-state-1',
    type: 'state-transfer',
    instanceId: 'a7a0b9ac-7884-492c-8b68-80f15802442c',
    action: 'set',
    state: {
      byteLength: 3,
      sha256: 'a'.repeat(64),
      bytesBase64: 'AQID',
    },
  }))
  expect(request.type).toBe('state-transfer')
  expect(() => parseVst3WorkerControlRequestV2(JSON.stringify({
    version: 2,
    compatibility: { minimum: 2, maximum: 2 },
    requestId: 'worker-state-1',
    type: 'state-transfer',
    instanceId: 'a7a0b9ac-7884-492c-8b68-80f15802442c',
    action: 'set',
    state: { byteLength: 4, sha256: 'a'.repeat(64), bytesBase64: 'AQID' },
  }))).toThrow('State byte length')
  expect(() => parseVst3WorkerControlRequestV2(JSON.stringify({
    ...request,
    version: 1,
  }))).toThrow()
})

test('bounds worker events by sample offset and block capacity', () => {
  const request = {
    version: 2,
    compatibility: { minimum: 2, maximum: 2 },
    requestId: 'worker-events-1',
    type: 'events',
    instanceId: 'a7a0b9ac-7884-492c-8b68-80f15802442c',
    events: [{ kind: 'midi', data: [0x90, 60, 100], sampleOffset: 8192 }],
  }
  expect(() => parseVst3WorkerControlRequestV2(JSON.stringify(request))).toThrow()
})

const workerHello = (): NativeVst3WorkerHello => ({
  version: 1,
  type: 'hello',
  instanceId: 'a7a0b9ac-7884-492c-8b68-80f15802442c',
  manifest: {
    version: nativeVst3WorkerManifestVersion,
    artifact: {
      id: nativeVst3WorkerArtifactId,
      version: nativeVst3WorkerArtifactVersion,
    },
    startupProtocolVersion: nativeVst3WorkerStartupProtocolVersion,
    controlProtocolVersion: nativeVst3WorkerControlProtocolVersion,
    transportAbiVersion: nativeVst3WorkerTransportAbiVersion,
    architecture: 'arm64',
    role: 'effect',
    inputBuses: [{ name: 'Main Input', channels: 2, enabled: true }],
    outputBuses: [{ name: 'Main Output', channels: 2, enabled: true }],
    transport: {
      slotCount: 2,
      maximumFrames: 512,
      inputChannels: 2,
      outputChannels: 2,
      maximumEventsPerBlock: 128,
    },
    latencyFrames: 32,
    tailFrames: 480,
    stateRevision: 7,
  },
})

test('round trips the bounded native worker artifact and runtime hello contract', () => {
  const encoded = encodeNativeVst3WorkerHello(workerHello())
  expect(decodeNativeVst3WorkerHello(encoded)).toEqual(workerHello())
  expect(JSON.parse(encoded)).toMatchObject({
    manifest: {
      artifact: { id: 'daw-vst3-worker', version: '2' },
      startupProtocolVersion: 1,
      controlProtocolVersion: 2,
      transportAbiVersion: 2,
      architecture: 'arm64',
      role: 'effect',
      latencyFrames: 32,
      tailFrames: 480,
      stateRevision: 7,
    },
  })
  expect(decodeNativeVst3WorkerHello(JSON.stringify({
    ...workerHello(),
    manifest: {
      ...workerHello().manifest,
      role: 'instrument',
      inputBuses: [],
      transport: { ...workerHello().manifest.transport, inputChannels: 0 },
    },
  })).manifest.role).toBe('instrument')
})

test('rejects unknown worker identities, unbounded fields, and inconsistent bus transport dimensions', () => {
  const hello = workerHello()
  expect(() => decodeNativeVst3WorkerHello(JSON.stringify({
    ...hello,
    manifest: { ...hello.manifest, artifact: { ...hello.manifest.artifact, id: 'other-worker' } },
  }))).toThrow()
  expect(() => decodeNativeVst3WorkerHello(JSON.stringify({
    ...hello,
    manifest: { ...hello.manifest, unknown: true },
  }))).toThrow()
  expect(() => decodeNativeVst3WorkerHello(JSON.stringify({
    ...hello,
    manifest: {
      ...hello.manifest,
      inputBuses: [{ name: 'Main Input', channels: 1, enabled: true }],
    },
  }))).toThrow('do not match enabled input buses')
  expect(() => decodeNativeVst3WorkerHello(JSON.stringify({
    ...hello,
    manifest: {
      ...hello.manifest,
      transport: { ...hello.manifest.transport, maximumFrames: 8_193 },
    },
  }))).toThrow()
  expect(() => decodeNativeVst3WorkerHello('x'.repeat(maxPluginHostControlFrameBytes + 1))).toThrow(
    'Native VST3 worker hello exceeds the maximum size.',
  )
})

const preflightRequirements = (): NativeVst3PreflightRequest['requirements'] => ({
  artifact: {
    id: nativeVst3WorkerArtifactId,
    version: nativeVst3WorkerArtifactVersion,
  },
  startupProtocolVersion: nativeVst3WorkerStartupProtocolVersion,
  controlProtocolVersion: nativeVst3WorkerControlProtocolVersion,
  transportAbiVersion: nativeVst3WorkerTransportAbiVersion,
  architecture: 'arm64',
})

test('round trips path-free native preflight availability and failure results', () => {
  const request: NativeVst3PreflightRequest = {
    version: nativeVst3PreflightProtocolVersion,
    type: 'preflight',
    requestId: 'preflight-1',
    requirements: preflightRequirements(),
  }
  const result: NativeVst3PreflightResult = {
    version: nativeVst3PreflightProtocolVersion,
    type: 'preflight-result',
    requestId: request.requestId,
    status: 'available',
    hello: workerHello(),
    requirements: request.requirements,
  }
  const unavailable: NativeVst3PreflightResult = {
    version: nativeVst3PreflightProtocolVersion,
    type: 'preflight-result',
    requestId: request.requestId,
    status: 'unavailable',
    code: 'worker-timeout',
    message: 'The worker timed out.',
    requirements: request.requirements,
  }
  const encodedRequest = encodeNativeVst3PreflightRequest(request)
  const encodedResult = encodeNativeVst3PreflightResult(result)
  expect(decodeNativeVst3PreflightRequest(encodedRequest)).toEqual(request)
  expect(decodeNativeVst3PreflightResult(encodedResult)).toEqual(result)
  expect(decodeNativeVst3PreflightResult(encodeNativeVst3PreflightResult(unavailable))).toEqual(unavailable)
  expect(encodedRequest).not.toContain('path')
  expect(encodedResult).not.toContain('path')
})

test('rejects incomplete available preflight results and unknown artifact requirements', () => {
  const result = {
    version: nativeVst3PreflightProtocolVersion,
    type: 'preflight-result',
    requestId: 'preflight-1',
    status: 'unavailable',
    code: 'worker-unavailable',
    message: 'Packaged worker validation is unavailable.',
    requirements: preflightRequirements(),
  }
  expect(() => decodeNativeVst3PreflightResult(JSON.stringify({
    ...result,
    status: 'available',
  }))).toThrow()
  expect(() => decodeNativeVst3PreflightRequest(JSON.stringify({
    version: nativeVst3PreflightProtocolVersion,
    type: 'preflight',
    requestId: 'preflight-1',
    requirements: {
      ...preflightRequirements(),
      artifact: { id: 'unknown-worker', version: '1' },
    },
  }))).toThrow()
})

const attachmentPlan = (): NativeExternalAttachmentPlan => ({
  version: 1,
  attachments: [{
    instanceId: 'a7a0b9ac-7884-492c-8b68-80f15802442c',
    graphNodeId: 'track-1',
    nativeGraphNodeId: '15667978324023168200',
    chainIndex: 0,
    catalogIdentity: {
      format: 'vst3',
      classId: '0123456789abcdef0123456789abcdef',
      vendorId: 'Example Vendor',
      architecture: 'arm64',
      scannerCatalogVersion: 2,
    },
    bundleFingerprint: 'b'.repeat(64),
    binaryFingerprint: 'a'.repeat(64),
    role: 'effect',
    inputBuses: [{ name: 'Main Input', channels: 2, enabled: true }],
    outputBuses: [{ name: 'Main Output', channels: 2, enabled: true }],
    workerTransport: {
      slotCount: 2,
      maximumFrames: 512,
      inputChannels: 2,
      outputChannels: 2,
      maximumEventsPerBlock: 128,
    },
    declaredLatencyFrames: 32,
    declaredTailFrames: 480,
    bypassed: false,
    stateRevision: 7,
  }],
})

test('round trips a versioned, path-free native external attachment plan', () => {
  const encoded = encodeNativeExternalAttachmentPlan(attachmentPlan())
  const decoded = decodeNativeExternalAttachmentPlan(encoded)

  expect(decoded).toEqual(attachmentPlan())
  expect(encoded).not.toContain('path')
  expect(decoded.attachments[0]).toMatchObject({
    instanceId: 'a7a0b9ac-7884-492c-8b68-80f15802442c',
    graphNodeId: 'track-1',
    nativeGraphNodeId: '15667978324023168200',
    chainIndex: 0,
    catalogIdentity: { classId: '0123456789abcdef0123456789abcdef' },
    bundleFingerprint: 'b'.repeat(64),
    binaryFingerprint: 'a'.repeat(64),
    inputBuses: [{ name: 'Main Input', channels: 2 }],
    outputBuses: [{ name: 'Main Output', channels: 2 }],
    declaredLatencyFrames: 32,
    declaredTailFrames: 480,
    stateRevision: 7,
  })
})

test('rejects paths, invalid fingerprints, and out-of-bounds attachment dimensions', () => {
  const plan = attachmentPlan()
  const attachment = plan.attachments[0]
  expect(() => decodeNativeExternalAttachmentPlan(JSON.stringify({
    ...plan,
    attachments: [{ ...attachment, canonicalBundlePath: '/Library/Audio/Plug-Ins/VST3/Example.vst3' }],
  }))).toThrow()
  expect(() => decodeNativeExternalAttachmentPlan(JSON.stringify({
    ...plan,
    attachments: [{ ...attachment, binaryFingerprint: 'not-a-fingerprint' }],
  }))).toThrow()
  expect(() => decodeNativeExternalAttachmentPlan(JSON.stringify({
    ...plan,
    attachments: [{
      ...attachment,
      workerTransport: { ...attachment.workerTransport, outputChannels: maxVst3WorkerChannels + 1 },
    }],
  }))).toThrow()
  expect(() => decodeNativeExternalAttachmentPlan(JSON.stringify({
    ...plan,
    attachments: [{
      ...attachment,
      workerTransport: { ...attachment.workerTransport, inputChannels: 0 },
    }],
  }))).toThrow()
  expect(() => decodeNativeExternalAttachmentPlan(JSON.stringify({
    ...plan,
    attachments: [{ ...attachment, stateRevision: -1 }],
  }))).toThrow()
  expect(() => decodeNativeExternalAttachmentPlan(JSON.stringify({
    ...plan,
    attachments: [{ ...attachment, instanceId: 'not-a-uuid' }],
  }))).toThrow()
  expect(() => decodeNativeExternalAttachmentPlan(JSON.stringify({
    ...plan,
    attachments: [{ ...attachment, nativeGraphNodeId: '18446744073709551616' }],
  }))).toThrow('exceeds uint64')
  const serial = decodeNativeExternalAttachmentPlan(JSON.stringify({
    ...plan,
    attachments: [
      attachment,
      {
        ...attachment,
        instanceId: 'b7a0b9ac-7884-492c-8b68-80f15802442c',
        chainIndex: 1,
      },
    ],
  }))
  expect(serial.attachments).toHaveLength(2)
  expect(() => decodeNativeExternalAttachmentPlan(JSON.stringify({
    ...plan,
    attachments: [
      attachment,
      {
        ...attachment,
        instanceId: 'b7a0b9ac-7884-492c-8b68-80f15802442c',
        chainIndex: 2,
      },
    ],
  }))).toThrow('contiguous')
  expect(() => decodeNativeExternalAttachmentPlan(JSON.stringify({
    ...plan,
    attachments: [
      attachment,
      {
        ...attachment,
        instanceId: 'b7a0b9ac-7884-492c-8b68-80f15802442c',
        graphNodeId: 'track-2',
      },
    ],
  }))).toThrow('only one graph node')
  expect(() => decodeNativeExternalAttachmentPlan(JSON.stringify({
    ...plan,
    attachments: Array.from({ length: maxNativeExternalAttachments + 1 }, (_, index) => ({
      ...attachment,
      instanceId: `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`,
      graphNodeId: `track-${index}`,
      nativeGraphNodeId: `${index + 1}`,
    })),
  }))).toThrow()
})
