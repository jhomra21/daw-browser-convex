import { describe, expect, test } from "bun:test"
import {
  canonicalControlCapabilitiesSchema,
  canonicalProjectSnapshotSchema,
  controlOperationCatalog,
  localControlCapabilitiesV1,
  localControlCapabilitiesV2,
} from "@daw-browser/control"
import {
  desktopControlOperationSchemaV1,
  desktopControlOperationDescriptorsV1,
  desktopHelloSchemaV2,
  desktopHelloAckSchemaV2,
  desktopHelloSchemaV1,
  desktopHelloAckSchemaV1,
  desktopOperationSchemaV1,
  desktopHostVstInstancesInputSchemaV1,
  desktopHostVstParametersInputSchemaV1,
  desktopHostVstInstancesResultSchemaV1,
  desktopHostVstParametersResultSchemaV1,
  desktopRendererRequestSchemaV1,
  desktopRendererExportInputSchemaV1,
  desktopTrustedRendererRequestSchemaV1,
  desktopVstParameterEditPayloadSchema,
  desktopRequestSchemaV1,
  desktopRequestSchemaV2,
  maxDesktopFrameBytes,
  parseDesktopReplyError,
  parseDesktopResult,
} from "./index"
import { createDesktopFrameDecoder as createDecoder, encodeDesktopFrame as encodeFrame } from "./socket"

const actorSubject = "local:123e4567-e89b-42d3-a456-426614174000"
const vstParameterEditPayload = {
  projectId: "project-1",
  source: "editor-session",
  instanceId: "11111111-1111-4111-8111-111111111111",
  parameterId: 42,
  normalizedValue: 0.625,
}
const controlAction = { kind: "project.rename", name: "Project" }
const controlRequestInputs = [
  ["control.capabilities", {}],
  ["control.snapshot", { projectId: "project-1" }],
  ["control.preview", { version: "v1", projectId: "project-1", actions: [controlAction] }],
  ["control.commit", { version: "v1", projectId: "project-1", actions: [controlAction], idempotencyKey: "request1" }],
  ["control.requestApproval", { version: "v1", projectId: "project-1", actions: [controlAction] }],
  ["control.history", { projectId: "project-1" }],
  ["control.recoveries", { projectId: "project-1" }],
]

const snapshot = {
  version: "v1",
  project: {
    id: "project-1",
    name: "Project",
    revision: 0,
    tempoBpm: 120,
    timeSignature: { numerator: 4, denominator: 4 },
    loop: { enabled: false, startSec: 0, endSec: 0 },
    masterVolume: 1,
    updatedAt: 0,
  },
  tracks: [],
  clips: [],
  processors: [],
  automation: [],
  sidechains: [],
  assets: [],
  assetFolders: [],
}
const planningResult = {
  version: "v1",
  projectId: "project-1",
  priorRevision: 0,
  revision: 0,
  applied: false,
  requestDigest: "0".repeat(64),
  resolvedRefs: [],
  warnings: [],
  changeSummary: { actionCount: 0, changes: [] },
}

describe("desktop protocol v1", () => {
  test("projects every represented canonical catalog schema through the legacy desktop adapter", () => {
    for (const operation of desktopControlOperationSchemaV1.options) {
      const desktopDescriptor = desktopControlOperationDescriptorsV1[operation]
      const canonicalDescriptor = controlOperationCatalog[operation]
      expect(desktopDescriptor.canonicalInput).toBe(canonicalDescriptor.input)
      expect(desktopDescriptor.canonicalInput.safeParse({}).success).toBe(
        canonicalDescriptor.input.safeParse({}).success,
      )
      expect(desktopDescriptor.canonicalOutput).toBe(
        operation === "control.capabilities"
          ? canonicalControlCapabilitiesSchema
          : operation === "control.snapshot"
            ? canonicalProjectSnapshotSchema
            : canonicalDescriptor.output,
      )
    }
  })

  test("accepts only declared operations and bounded correlation IDs", () => {
    expect(desktopRequestSchemaV1.safeParse({ version: "v1", type: "request", id: "request-1", operation: "transport.seek", input: { seconds: 1 } }).success).toBe(true)
    expect(desktopRequestSchemaV1.safeParse({ version: "v1", type: "request", id: "request-1", operation: "transport.seek", input: { seconds: 86_401 } }).success).toBe(false)
    expect(desktopRequestSchemaV1.safeParse({ version: "v1", type: "request", id: "request-1", operation: "filesystem.read", input: {} }).success).toBe(false)
    expect(desktopRequestSchemaV1.safeParse({ version: "v1", type: "request", id: "request-1", operation: "lifecycle.prepareToClose", input: {} }).success).toBe(false)
    expect(desktopRequestSchemaV1.safeParse({ version: "v1", type: "request", id: "x".repeat(97), operation: "host.status", input: {} }).success).toBe(false)
  })

  test("validates bounded host media requests", () => {
    const exportRequest = {
      version: "v1",
      type: "request",
      id: "request-1",
      operation: "host.export.run",
      input: {
        mode: "mixdown",
        format: "wav",
        destination: { kind: "file", path: "/tmp/output.wav" },
        range: { mode: "custom", startSec: 0, endSec: 1 },
        render: {
          sampleRate: 44100,
          channels: 2,
          normalization: { mode: "none" },
          tail: { mode: "none" },
        },
        encoding: { wav: { codec: "pcm-s16", dither: "none" } },
      },
    }
    expect(desktopRequestSchemaV1.safeParse(exportRequest).success).toBe(true)
    expect(desktopRequestSchemaV1.safeParse({
      ...exportRequest,
      input: { ...exportRequest.input, range: { mode: "loop", startSec: 1, endSec: 1 } },
    }).success).toBe(false)
    expect(desktopRequestSchemaV1.safeParse({
      ...exportRequest,
      input: { ...exportRequest.input, format: "flac" },
    }).success).toBe(false)
  })

  test("accepts renderer-only export preflight metadata without exposing it externally", () => {
    const input = {
      mode: "mixdown",
      format: "wav",
      destination: {
        kind: "capability-file",
        token: "0".repeat(64),
        basename: "preflight.wav",
      },
      range: { mode: "whole" },
      render: {
        sampleRate: 44100,
        channels: 2,
        normalization: { mode: "none" },
        tail: { mode: "none" },
      },
      encoding: { wav: { codec: "pcm-s16", dither: "none" } },
      canceled: false,
      preflightOnly: true,
    }
    expect(desktopRendererExportInputSchemaV1.safeParse(input).success).toBe(true)
    expect(desktopRequestSchemaV1.safeParse({
      version: "v1",
      type: "request",
      id: "request-1",
      operation: "host.export.run",
      input,
    }).success).toBe(false)
  })

  test("strictly validates canceled renderer exports", () => {
    for (const mode of ["mixdown", "stems"]) {
      expect(desktopRendererExportInputSchemaV1.safeParse({ canceled: true, mode }).success).toBe(true)
      expect(desktopRendererExportInputSchemaV1.safeParse({
        canceled: true,
        mode,
        destination: { kind: "capability-file", token: "0".repeat(64), basename: "output.wav" },
      }).success).toBe(false)
      expect(desktopRendererExportInputSchemaV1.safeParse({ canceled: true, mode, preflightOnly: true }).success).toBe(false)
    }
  })

  test("requires matching renderer mixdown capability extensions", () => {
    for (const [format, basename] of [
      ["wav", "output.wav"],
      ["mp3", "output.mp3"],
      ["flac", "output.flac"],
      ["ogg-opus", "output.ogg"],
    ]) {
      const input = {
        mode: "mixdown",
        format,
        destination: { kind: "capability-file", token: "0".repeat(64), basename },
        range: { mode: "whole" },
        render: { sampleRate: 44100, channels: 2, normalization: { mode: "none" }, tail: { mode: "none" } },
        encoding: { wav: { codec: "pcm-s16", dither: "none" } },
        canceled: false,
      }
      expect(desktopRendererExportInputSchemaV1.safeParse(input).success).toBe(true)
      expect(desktopRendererExportInputSchemaV1.safeParse({
        ...input,
        destination: { ...input.destination, basename: "output.mp3" },
      }).success).toBe(format === "mp3")
    }
  })

  test("requires protocol version and validates hello secrets", () => {
    expect(desktopHelloSchemaV1.safeParse({ version: "v1", type: "hello", secret: "a".repeat(64), client: "test", actorId: "123e4567-e89b-42d3-a456-426614174000" }).success).toBe(true)
    expect(desktopHelloSchemaV1.safeParse({ version: "v2", type: "hello", secret: "a".repeat(64), client: "test", actorId: "123e4567-e89b-42d3-a456-426614174000" }).success).toBe(false)
    expect(desktopHelloSchemaV1.safeParse({ version: "v1", type: "hello", secret: "a".repeat(64), client: "test", actorId: "123E4567-E89B-42D3-A456-426614174000" }).success).toBe(false)
    expect(desktopHelloSchemaV1.safeParse({ version: "v1", type: "hello", secret: "a".repeat(64), client: "test", actorId: "not-a-uuid" }).success).toBe(false)
  })

  test("keeps the V1 hello acknowledgment operation set exact", () => {
    expect(desktopOperationSchemaV1.options).toHaveLength(20)
    expect(desktopHelloAckSchemaV1.safeParse({
      version: "v1",
      type: "helloAck",
      sessionId: "session-12345678",
      capabilities: desktopOperationSchemaV1.options,
    }).success).toBe(true)
    expect(desktopHelloAckSchemaV1.safeParse({
      version: "v1",
      type: "helloAck",
      sessionId: "session-12345678",
      capabilities: [...desktopOperationSchemaV1.options, "host.status"],
    }).success).toBe(false)
  })

  test("validates paginated VST discovery without leaking catalog fields", () => {
    const instanceInput = { projectId: "project-1", cursor: "0", limit: 50 }
    const parameterInput = { projectId: "project-1", instanceId: "123e4567-e89b-42d3-a456-426614174000", cursor: "10", limit: 100 }
    expect(desktopHostVstInstancesInputSchemaV1.parse(instanceInput)).toEqual(instanceInput)
    expect(desktopHostVstParametersInputSchemaV1.parse(parameterInput)).toEqual(parameterInput)
    expect(desktopHostVstInstancesInputSchemaV1.safeParse({ ...instanceInput, cursor: "00" }).success).toBe(false)
    expect(desktopHostVstInstancesInputSchemaV1.safeParse({ ...instanceInput, cursor: "99999999999" }).success).toBe(false)
    expect(desktopHostVstParametersInputSchemaV1.safeParse({ ...parameterInput, cursor: "4294967295" }).success).toBe(true)
    expect(desktopHostVstParametersInputSchemaV1.safeParse({ ...parameterInput, cursor: "4294967296" }).success).toBe(false)
    expect(desktopHostVstParametersInputSchemaV1.safeParse({ ...parameterInput, cursor: "99999999999" }).success).toBe(false)
    expect(desktopHostVstInstancesInputSchemaV1.safeParse({ ...instanceInput, unexpected: true }).success).toBe(false)
    expect(desktopHostVstParametersInputSchemaV1.safeParse({ ...parameterInput, unexpected: true }).success).toBe(false)
    const instanceResult = {
      projectId: "project-1",
      instances: [{
        instanceId: "123e4567-e89b-42d3-a456-426614174000",
        targetId: "track-1",
        stageIndex: 0,
        identity: {
          format: "vst3",
          classId: "class-1",
          vendor: "Vendor",
          name: "Plugin",
          version: "1",
          architecture: "arm64",
          discoveredPath: "/private/plugin.vst3",
          binaryFingerprint: "a".repeat(64),
        },
        role: "effect",
        bypassed: false,
        health: { state: "ready", updatedAt: 1 },
        parameterCount: 1,
        supportsEditor: false,
        supportsState: true,
      }],
      nextCursor: null,
    }
    expect(desktopHostVstInstancesResultSchemaV1.safeParse(instanceResult).success).toBe(false)
    const safeInstances = {
      projectId: "project-1",
      instances: [{
        instanceId: "123e4567-e89b-42d3-a456-426614174000",
        targetId: "track-1",
        stageIndex: 0,
        identity: {
          format: "vst3",
          classId: "class-1",
          vendor: "Vendor",
          name: "Plugin",
          version: "1",
          architecture: "arm64",
        },
        role: "effect",
        bypassed: false,
        health: { state: "ready", updatedAt: 1 },
        parameterCount: 1,
        supportsEditor: false,
        supportsState: true,
      }],
      nextCursor: null,
    }
    expect(desktopHostVstInstancesResultSchemaV1.safeParse(safeInstances).success).toBe(true)
    expect(parseDesktopResult("host.vst.instances", safeInstances)).toEqual(safeInstances)
    expect(desktopHostVstParametersResultSchemaV1.safeParse({
      projectId: "project-1",
      instanceId: "123e4567-e89b-42d3-a456-426614174000",
      parameters: [{
        id: 1,
        title: "Gain",
        unit: "",
        minimum: 0,
        maximum: 1,
        defaultValue: 0.5,
        stepCount: 100,
        readOnly: false,
        hidden: true,
        currentValue: 0.25,
      }],
      nextCursor: "1",
    }).success).toBe(true)
    expect(desktopHostVstParametersResultSchemaV1.safeParse({
      projectId: "project-1",
      instanceId: "123e4567-e89b-42d3-a456-426614174000",
      parameters: [{
        id: 1,
        title: "Gain",
        unit: "",
        minimum: 0,
        maximum: 1,
        defaultValue: 0.5,
        stepCount: 100,
        readOnly: false,
        hidden: true,
        currentValue: 1.1,
      }],
      nextCursor: null,
    }).success).toBe(false)
    expect(desktopHostVstParametersResultSchemaV1.safeParse({
      projectId: "project-1",
      instanceId: "123e4567-e89b-42d3-a456-426614174000",
      parameters: [],
      nextCursor: "01",
    }).success).toBe(false)
  })

  test("uses separate V2 hello, acknowledgement, and control read schemas", () => {
    expect(desktopHelloSchemaV2.safeParse({
      version: "v2",
      type: "hello",
      secret: "a".repeat(64),
      client: "test",
      actorId: "123e4567-e89b-42d3-a456-426614174000",
      supportedVersions: ["v1", "v2"],
    }).success).toBe(true)
    expect(desktopHelloAckSchemaV2.safeParse({
      version: "v2",
      type: "helloAck",
      selectedVersion: "v2",
      sessionId: "session-12345678",
      capabilities: desktopOperationSchemaV1.options,
    }).success).toBe(true)
    expect(desktopRequestSchemaV1.safeParse({
      version: "v1", type: "request", id: "read-v1", operation: "control.capabilities", input: { readVersion: "v2" },
    }).success).toBe(false)
    expect(desktopRequestSchemaV2.safeParse({
      version: "v2", type: "request", id: "read-v2", operation: "control.capabilities", input: {},
    }).success).toBe(true)
  })

  test("directly validates all shared control request inputs", () => {
    expect(controlRequestInputs).toHaveLength(7)
    for (const [operation, input] of controlRequestInputs) {
      const request = { version: "v1", type: "request", id: "control-1", operation, input }
      expect(desktopRequestSchemaV1.safeParse(request).success).toBe(true)
      expect(desktopRequestSchemaV1.safeParse({ ...request, input: { malformed: true } }).success).toBe(false)
    }
  })

  test("keeps external and renderer actor boundaries strict", () => {
    for (const [operation, input] of controlRequestInputs) {
      const request = { version: "v1", type: "request", id: "control-1", operation, input }
      expect(desktopTrustedRendererRequestSchemaV1.safeParse(request).success).toBe(false)
      expect(desktopTrustedRendererRequestSchemaV1.safeParse({ ...request, actorSubject }).success).toBe(true)
      expect(desktopRequestSchemaV1.safeParse({ ...request, actorSubject }).success).toBe(false)
    }

    const controlRequest = {
      version: "v1",
      type: "request",
      id: "control-1",
      operation: "control.capabilities",
      input: {},
    }
    for (const invalidActorSubject of [
      "123e4567-e89b-42d3-a456-426614174000",
      "local:123E4567-E89B-42D3-A456-426614174000",
      "local:123e4567-e89b-42d3-7456-426614174000",
    ]) {
      expect(desktopTrustedRendererRequestSchemaV1.safeParse({
        ...controlRequest,
        actorSubject: invalidActorSubject,
      }).success).toBe(false)
    }

    const rendererRequest = {
      version: "v1",
      type: "request",
      id: "renderer-1",
      operation: "transport.play",
      input: {},
    }
    expect(desktopRendererRequestSchemaV1.safeParse(rendererRequest).success).toBe(true)
    expect(desktopTrustedRendererRequestSchemaV1.safeParse(rendererRequest).success).toBe(true)
    expect(desktopRendererRequestSchemaV1.safeParse({ ...rendererRequest, actorSubject }).success).toBe(false)
    expect(desktopTrustedRendererRequestSchemaV1.safeParse({ ...rendererRequest, actorSubject }).success).toBe(false)

    const lifecycleRequest = {
      version: "v1",
      type: "request",
      id: "lifecycle-1",
      operation: "lifecycle.prepareToClose",
      input: {},
    }
    expect(desktopRendererRequestSchemaV1.safeParse(lifecycleRequest).success).toBe(true)
    expect(desktopRendererRequestSchemaV1.safeParse({ ...lifecycleRequest, actorSubject }).success).toBe(false)
  })

  test("parses minimum valid results for all control operations", () => {
    const results = [
      ["control.capabilities", localControlCapabilitiesV1],
      ["control.snapshot", snapshot],
      ["control.preview", planningResult],
      ["control.commit", { ...planningResult, idempotencyReplay: false, recoveries: [], restored: [] }],
      ["control.requestApproval", {
        version: "v1",
        approvalToken: "a".repeat(32),
        requestDigest: "0".repeat(64),
        baseRevision: 0,
        actionIndexes: [0],
        expiresAt: 0,
      }],
      ["control.history", { entries: [], continueCursor: "end", isDone: true }],
      ["control.recoveries", { entries: [], continueCursor: "end", isDone: true }],
    ]
    expect(results).toHaveLength(7)
    for (const [operation, result] of results) {
      const parsedOperation = desktopControlOperationSchemaV1.parse(operation)
      expect(parseDesktopResult(parsedOperation, result)).toEqual(result)
      expect(() => parseDesktopResult(parsedOperation, {})).toThrow()
    }
    expect(parseDesktopResult("control.capabilities", localControlCapabilitiesV1, {}, "v2")).toEqual(localControlCapabilitiesV1)
    expect(parseDesktopResult("control.snapshot", snapshot, { projectId: "project-1" }, "v2")).toEqual(snapshot)
    expect(parseDesktopResult("control.capabilities", localControlCapabilitiesV2, { readVersion: "v2" }, "v2")).toEqual(localControlCapabilitiesV2)
    expect(parseDesktopResult("control.snapshot", { ...snapshot, version: "v2" }, { projectId: "project-1", readVersion: "v2" }, "v2"))
      .toEqual({ ...snapshot, version: "v2" })
  })

  test("parses only the operation error family and preserves control metadata", () => {
    const controlError = {
      version: "v1",
      code: "validation",
      message: "Invalid action.",
      actionIndex: 2,
      details: { field: "name" },
    }
    expect(parseDesktopReplyError("control.commit", controlError)).toEqual({
      version: "v1",
      code: "validation",
      message: "Invalid action.",
      actionIndex: 2,
      details: { field: "name" },
    })
    expect(() => parseDesktopReplyError("host.status", controlError)).toThrow()

    const hostError = { version: "v1", code: "unavailable", message: "Host unavailable." }
    expect(parseDesktopReplyError("host.status", hostError)).toEqual({
      version: "v1",
      code: "unavailable",
      message: "Host unavailable.",
    })
    expect(parseDesktopReplyError("control.commit", hostError)).toEqual({
      version: "v1",
      code: "unavailable",
      message: "Host unavailable.",
    })
  })

  test("bounds framed payloads before parsing", () => {
    const frames: unknown[] = []
    const decode = createDecoder((frame) => frames.push(frame))
    const encoded = encodeFrame({ version: "v1", type: "cancel", id: "request-1" })
    decode(encoded.slice(0, 2))
    decode(encoded.slice(2))
    expect(frames).toHaveLength(1)
    const oversized = new Uint8Array(4)
    new DataView(oversized.buffer).setUint32(0, maxDesktopFrameBytes + 1)
    expect(() => decode(oversized)).toThrow("size limit")
  })

  test("rejects invalid UTF-8 frame payloads before JSON parsing", () => {
    const decode = createDecoder(() => undefined)
    const frame = new Uint8Array(5)
    new DataView(frame.buffer).setUint32(0, 1)
    frame[4] = 0xff
    expect(() => decode(frame)).toThrow("not JSON")
  })
})

test("strictly validates VST parameter edit payloads", () => {
  expect(desktopVstParameterEditPayloadSchema.safeParse(vstParameterEditPayload).success).toBe(true)
  expect(desktopVstParameterEditPayloadSchema.safeParse({
    ...vstParameterEditPayload,
    normalizedValue: 2,
  }).success).toBe(false)
  expect(desktopVstParameterEditPayloadSchema.safeParse({
    ...vstParameterEditPayload,
    instanceId: "instance-1",
  }).success).toBe(false)
})
