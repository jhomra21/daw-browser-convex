import {
  sessionSetSpectrumNodeChannel,
  sessionSetTransportChannel,
} from "@daw-browser/desktop-protocol/ipc-channels"
import type { NativeHostTransport } from "@daw-browser/audio-engine/native-host-wire"
import { z } from "zod"
import { nativeSessionEnvelopeSchema, unsigned32Schema } from "../native-session-schemas"
import type { NativeSessionEvent, NativeSessionIpcHandler } from "./native-session-access"
import type { nativeSessionFailure } from "../audio-host"

const spectrumEnvelope = nativeSessionEnvelopeSchema(z.bigint().positive().nullable())
const transportSchema = z.object({
  epoch: unsigned32Schema,
  running: z.boolean(),
  frame: z.number().int().safe(),
  bpm: z.number().finite().positive().optional(),
  timeSignatureNumerator: z.number().int().positive().optional(),
  timeSignatureDenominator: z.number().int().positive().optional(),
  cycleActive: z.boolean().optional(),
  cycleStartSec: z.number().finite().min(0).optional(),
  cycleEndSec: z.number().finite().min(0).optional(),
  transitionId: z.bigint().positive().max(0xffff_ffff_ffff_ffffn).optional(),
}).passthrough().refine((value) => (
  (value.cycleStartSec === undefined && value.cycleEndSec === undefined)
  || (
    value.cycleStartSec !== undefined
    && value.cycleEndSec !== undefined
    && value.cycleEndSec > value.cycleStartSec
  )
)).refine((value) => (
  (!Object.hasOwn(value, "bpm") || value.bpm !== undefined)
  && (!Object.hasOwn(value, "timeSignatureNumerator") || value.timeSignatureNumerator !== undefined)
  && (!Object.hasOwn(value, "timeSignatureDenominator") || value.timeSignatureDenominator !== undefined)
  && (!Object.hasOwn(value, "cycleActive") || value.cycleActive !== undefined)
  && (!Object.hasOwn(value, "cycleStartSec") || value.cycleStartSec !== undefined)
  && (!Object.hasOwn(value, "cycleEndSec") || value.cycleEndSec !== undefined)
))
const transportEnvelope = nativeSessionEnvelopeSchema(transportSchema)

export const registerNativeSessionTransportIpc = (dependencies: {
  ipcMain: { handle: (channel: string, listener: NativeSessionIpcHandler) => void }
  allowed: (event: NativeSessionEvent) => boolean
  supervisor: () => {
    setSpectrumNode: (nodeId: bigint | null) => Promise<void>
    setTransport: (transport: NativeHostTransport, transactionToken?: string) => Promise<void>
  } | undefined
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- nativeSessionFailure classifies thrown values at this boundary.
  fail: (error?: unknown) => ReturnType<typeof nativeSessionFailure>
}) => {
  dependencies.ipcMain.handle(sessionSetSpectrumNodeChannel, async (event, value) => {
    const supervisor = dependencies.allowed(event) ? dependencies.supervisor() : undefined
    const envelope = spectrumEnvelope.safeParse(value)
    if (!supervisor || !envelope.success || envelope.data.transactionToken !== undefined) return dependencies.fail()
    try {
      await supervisor.setSpectrumNode(envelope.data.value)
      return { ok: true as const }
    } catch (error) {
      return dependencies.fail(error)
    }
  })
  dependencies.ipcMain.handle(sessionSetTransportChannel, async (event, value) => {
    const supervisor = dependencies.allowed(event) ? dependencies.supervisor() : undefined
    const envelope = transportEnvelope.safeParse(value)
    if (!supervisor || !envelope.success) return dependencies.fail()
    const value_ = envelope.data.value
    const transport: NativeHostTransport = {
      epoch: value_.epoch,
      running: value_.running,
      frame: value_.frame,
      bpm: value_.bpm,
      timeSignatureNumerator: value_.timeSignatureNumerator,
      timeSignatureDenominator: value_.timeSignatureDenominator,
      cycleActive: value_.cycleActive,
      cycleStartSec: value_.cycleStartSec,
      cycleEndSec: value_.cycleEndSec,
      transitionId: value_.transitionId,
    }
    try {
      await supervisor.setTransport(transport, envelope.data.transactionToken)
      return { ok: true as const }
    } catch (error) {
      return dependencies.fail(error)
    }
  })
}
