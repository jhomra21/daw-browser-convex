import {
  sessionConfigureInstrumentStatesChannel,
  sessionCreateMappedAssetChannel,
  sessionDetachVstChannel,
  sessionInstallAssetChannel,
  sessionPrepareMappedAssetRangeChannel,
  sessionPublishGraphChannel,
  sessionQueueInstrumentEventsChannel,
  sessionQueueParameterEventsChannel,
  sessionQueueProcessorStatePatchChannel,
  sessionQueueScheduleWindowChannel,
  sessionQueueSourceEventsChannel,
  sessionQueueVstParameterEventsChannel,
  sessionReenableVstScheduleAutomationChannel,
  sessionReleaseAssetChannel,
  sessionReleaseMappedAssetChannel,
  sessionWriteMappedAssetPageChannel,
} from "@daw-browser/desktop-protocol/ipc-channels"
import { nativeAudioHostMaximumMappedAssetPageBytes } from "@daw-browser/desktop-protocol/native-audio-host"
import { unsigned32Schema, unsigned64Max, uuidSchema } from "@daw-browser/desktop-protocol/wire-patterns"
import { z } from "zod"
import { nativeSessionEnvelopeSchema } from "../native-session-schemas"

const positiveUnsigned32Schema = unsigned32Schema.min(1)

export const nativeSessionAssetSchema = z.object({
  sessionAssetId: unsigned32Schema,
  frameCount: unsigned32Schema,
  sampleRateHz: unsigned32Schema,
  channelCount: unsigned32Schema,
  planarPcm: z.instanceof(Uint8Array),
  contentHashPrefix: z.instanceof(Uint8Array).optional(),
}).strict()

const bytes = z.instanceof(Uint8Array)

// Each envelope operation once: the channel the preload invokes and main handles, and the request main parses.
// The operations with their own guards (configure, editor, transactions, recording, revisions, stop, teardown) keep their handlers.
export const nativeSessionOperations = {
  installAsset: { channel: sessionInstallAssetChannel, request: nativeSessionEnvelopeSchema(nativeSessionAssetSchema) },
  releaseAsset: { channel: sessionReleaseAssetChannel, request: nativeSessionEnvelopeSchema(positiveUnsigned32Schema) },
  createMappedAsset: {
    channel: sessionCreateMappedAssetChannel,
    request: nativeSessionEnvelopeSchema(z.object({
      sessionAssetId: positiveUnsigned32Schema,
      frameCount: z.number().int().positive().safe(),
      sampleRateHz: positiveUnsigned32Schema,
      channelCount: positiveUnsigned32Schema.max(64),
      contentHashPrefix: z.bigint().nonnegative().max(unsigned64Max).optional(),
      preparedStretchArtifactId: z.string().min(1).max(512).optional(),
    }).strict()),
  },
  writeMappedAssetPage: {
    channel: sessionWriteMappedAssetPageChannel,
    request: nativeSessionEnvelopeSchema(z.object({
      sessionAssetId: positiveUnsigned32Schema,
      startFrame: z.number().int().nonnegative().safe(),
      frameCount: positiveUnsigned32Schema,
      planarPcm: bytes.refine((value) => value.byteLength > 0 && value.byteLength <= nativeAudioHostMaximumMappedAssetPageBytes),
    }).strict()),
  },
  prepareMappedAssetRange: {
    channel: sessionPrepareMappedAssetRangeChannel,
    request: nativeSessionEnvelopeSchema(z.object({
      sessionAssetId: positiveUnsigned32Schema,
      startFrame: z.number().int().nonnegative().safe(),
      frameCount: z.number().int().positive().safe(),
    }).strict()),
  },
  releaseMappedAsset: { channel: sessionReleaseMappedAssetChannel, request: nativeSessionEnvelopeSchema(positiveUnsigned32Schema) },
  detachVst: { channel: sessionDetachVstChannel, request: nativeSessionEnvelopeSchema(uuidSchema) },
  publishGraph: { channel: sessionPublishGraphChannel, request: nativeSessionEnvelopeSchema(bytes) },
  configureInstrumentStates: { channel: sessionConfigureInstrumentStatesChannel, request: nativeSessionEnvelopeSchema(bytes) },
  queueParameterEvents: { channel: sessionQueueParameterEventsChannel, request: nativeSessionEnvelopeSchema(bytes) },
  queueProcessorStatePatch: { channel: sessionQueueProcessorStatePatchChannel, request: nativeSessionEnvelopeSchema(bytes) },
  queueVstParameterEvents: { channel: sessionQueueVstParameterEventsChannel, request: nativeSessionEnvelopeSchema(bytes) },
  queueInstrumentEvents: { channel: sessionQueueInstrumentEventsChannel, request: nativeSessionEnvelopeSchema(bytes) },
  queueScheduleWindow: { channel: sessionQueueScheduleWindowChannel, request: nativeSessionEnvelopeSchema(bytes) },
  reenableVstScheduleAutomation: { channel: sessionReenableVstScheduleAutomationChannel, request: nativeSessionEnvelopeSchema(bytes) },
  queueSourceEvents: { channel: sessionQueueSourceEventsChannel, request: nativeSessionEnvelopeSchema(bytes) },
} as const

