import {
  sessionConfigureRecordingChannel,
  sessionStartRecordingChannel,
  sessionStopRecordingChannel,
} from "@daw-browser/desktop-protocol/ipc-channels"
import { nativeRecordingSpoolImportVersion } from "@daw-browser/desktop-protocol/native-audio-host"
import type { NativeHostRecordingConfiguration } from "@daw-browser/audio-engine/native-host-wire"
import { projectIdSchemaV1 } from "@daw-browser/desktop-protocol"
import { z } from "zod"
import { nativeSessionEnvelopeSchema, unsigned32Schema } from "../native-session-schemas"
import type {
  RecordingConfigureRequest,
  RecordingStartRequest,
  createRecordingSessionOwner,
} from "../recording-session-owner"
import type { nativeSessionFailure } from "../audio-host"
import type { NativeSessionEvent, NativeSessionIpcHandler } from "./native-session-access"

export type RecordingSessionOwner = Pick<ReturnType<typeof createRecordingSessionOwner>, "configure" | "start" | "stop">

type RecordingSupervisor = Parameters<ReturnType<typeof createRecordingSessionOwner>["configure"]>[1]

const positiveUnsigned32Schema = unsigned32Schema.min(1)

const recordingConfigurationSchema = z.object({
  projectId: projectIdSchemaV1,
  projectGeneration: unsigned32Schema,
  spoolImportVersion: z.literal(nativeRecordingSpoolImportVersion).optional(),
  deviceUid: z.string(),
  generation: positiveUnsigned32Schema,
  sessionId: z.bigint().positive(),
  channelCount: z.union([z.literal(1), z.literal(2)]),
  inputChannels: z.array(unsigned32Schema),
  gain: z.number().finite().min(0),
  polarity: z.union([z.literal(1), z.literal(-1)]),
  punchStartFrame: z.number().int().safe().min(0),
  punchEndFrame: z.number().int().safe().min(0).nullable(),
  monitoring: z.boolean(),
  targetNodeId: z.bigint().positive().max(0xffff_ffff_ffff_ffffn),
}).strict().refine((value) => (
  value.inputChannels.length === value.channelCount
  && (value.punchEndFrame === null || value.punchEndFrame >= value.punchStartFrame)
))

const configureEnvelope = nativeSessionEnvelopeSchema(recordingConfigurationSchema)

const startEnvelope = nativeSessionEnvelopeSchema(z.object({
  projectId: projectIdSchemaV1,
  projectGeneration: unsigned32Schema,
  generation: unsigned32Schema,
  sessionId: z.bigint().positive(),
}).strict())

const stopEnvelope = nativeSessionEnvelopeSchema(z.number().int().safe().min(0).optional())

const recordingConfiguration = (value: z.infer<typeof recordingConfigurationSchema>): NativeHostRecordingConfiguration => ({
  projectId: value.projectId,
  projectGeneration: value.projectGeneration,
  deviceUid: value.deviceUid,
  generation: value.generation,
  sessionId: value.sessionId,
  channelCount: value.channelCount,
  inputChannels: value.inputChannels,
  gain: value.gain,
  polarity: value.polarity,
  punchStartFrame: value.punchStartFrame,
  punchEndFrame: value.punchEndFrame,
  monitoring: value.monitoring,
  targetNodeId: value.targetNodeId,
})

export const registerNativeSessionRecordingIpc = (dependencies: {
  ipcMain: { handle: (channel: string, listener: NativeSessionIpcHandler) => void }
  allowed: (event: NativeSessionEvent) => boolean
  supervisor: () => RecordingSupervisor | undefined
  owner: RecordingSessionOwner
  rendererGeneration: () => number
  hostGeneration: () => number
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- nativeSessionFailure classifies thrown values at this boundary.
  fail: (error?: unknown) => ReturnType<typeof nativeSessionFailure>
}) => {
  dependencies.ipcMain.handle(sessionConfigureRecordingChannel, (event, value) => {
    const supervisor = dependencies.allowed(event) ? dependencies.supervisor() : undefined
    const envelope = configureEnvelope.safeParse(value)

    const request: RecordingConfigureRequest | undefined = envelope.success
      && envelope.data.transactionToken === undefined
      && event.senderFrame === event.sender.mainFrame
      ? {
        configuration: recordingConfiguration(envelope.data.value),
        projectId: envelope.data.value.projectId,
        projectGeneration: envelope.data.value.projectGeneration,
        spoolImportVersion: envelope.data.value.spoolImportVersion,
      }
      : undefined

    return dependencies.owner.configure({
      rendererGeneration: dependencies.rendererGeneration(),
      hostGeneration: dependencies.hostGeneration(),
      senderAllowed: () => dependencies.allowed(event),
      fail: dependencies.fail,
    }, supervisor, request)
  })
  dependencies.ipcMain.handle(sessionStartRecordingChannel, (event, value) => {
    const supervisor = dependencies.allowed(event) ? dependencies.supervisor() : undefined
    const envelope = startEnvelope.safeParse(value)

    const request: RecordingStartRequest | undefined = envelope.success
      && envelope.data.transactionToken === undefined
      && event.senderFrame === event.sender.mainFrame
      ? envelope.data.value
      : undefined

    return dependencies.owner.start({
      rendererGeneration: dependencies.rendererGeneration(),
      fail: dependencies.fail,
    }, supervisor, request)
  })
  dependencies.ipcMain.handle(sessionStopRecordingChannel, (event, value) => {
    const supervisor = dependencies.allowed(event) ? dependencies.supervisor() : undefined
    const envelope = stopEnvelope.safeParse(value)

    const request = envelope.success && envelope.data.transactionToken === undefined
      ? { endFrame: envelope.data.value }
      : undefined

    return dependencies.owner.stop({ fail: dependencies.fail }, supervisor, request)
  })
}
