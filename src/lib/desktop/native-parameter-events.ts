import {
  serializeNativeInstrumentEvents,
  serializeNativeProcessorEvents,
} from "@daw-browser/audio-engine/native-host-wire"
import type { NativeInstrumentEvent } from "@daw-browser/audio-engine/native-host-wire"
import { resolveGraphProcessor } from "@daw-browser/audio-engine/mixer/resolve-graph-processor"
import type { AudioCoreGraphSnapshot } from "@daw-browser/audio-core-contract"
import type { LivePlaybackSnapshot } from "~/lib/live-playback-snapshot"
import type { DesktopBridge, NativeDeliveryReply } from "~/types/desktop-bridge"
import type { createNativeProcessorStateOwner, DispatchExecution } from "./native-processor-state-owner"
import type { ScheduleRevisionCandidate } from "./native-schedule-publication"

// Admission is bridge evidence, never an application receipt. Validation can also stop a send locally.
export type ParameterReply = NativeDeliveryReply
  | { ok: false; kind: "not-sent"; reason: "unavailable" | "unsupported" | "stale" }

type NativeParameterEventsHost = {
  bridge: { session: Pick<NonNullable<DesktopBridge["audioHost"]>["session"], "queueInstrumentEvents" | "queueParameterEvents"> } | undefined
  processorState: ReturnType<typeof createNativeProcessorStateOwner<ScheduleRevisionCandidate>>
  // The controller's prepared session as it stands now.
  state: () => { prepared: boolean; graph: AudioCoreGraphSnapshot | undefined; snapshot: LivePlaybackSnapshot | undefined; transportEpoch: number }
  observeControl: <T>(operation: Promise<T>) => Promise<T>
  // Synth parameters travel as instrument events, which share one sequence counter with live MIDI.
  nextEventSequence: () => number
  lastEventSequence: () => number
  // Names the record behind each processor parameter batch for acceptance attribution.
  observer: { processorDispatch?: (event: { key: string; editId: string; attempt: number; sequence: bigint }) => void } | undefined
}

export const createNativeParameterEvents = (host: NativeParameterEventsHost) => {
  const { processorState } = host
  return async (request: {
    instanceId: string
    values: readonly { parameterId: string; value: number }[]
    revision?: number
    epoch?: number
    sequence?: number
    // The registered record of this send. Its sequences are allocated, and it becomes provable, only when
    // the batch is handed to the bridge.
    execution?: DispatchExecution
  }): Promise<ParameterReply> => {
    const bridge = host.bridge
    if (!bridge) return { ok: false, kind: "not-sent", reason: "unavailable" }
    const { prepared, graph, snapshot, transportEpoch } = host.state()
    if (!prepared || !graph) return { ok: false, kind: "not-sent", reason: "unavailable" }
    const instrumentEntry = Object.entries(snapshot?.mixer.fx.trackFx ?? {})
      .find(([, fx]) => fx.instrument?.instanceId === request.instanceId)
    if (instrumentEntry) {
      const node = graph.nodes.find((entry) => entry.id === instrumentEntry[0])
      if (node?.instrument?.kind !== "synth") return { ok: false, kind: "not-sent", reason: "unsupported" }
      const targets = new Map(node.instrument.parameterTargets.map((entry) => [entry.id, entry.target]))
      const parameters: { target: number; value: number }[] = []
      for (const value of request.values) {
        const target = targets.get(value.parameterId)
        if (target === undefined || !Number.isFinite(value.value)) return { ok: false, kind: "not-sent", reason: "unsupported" }
        parameters.push({ target, value: value.value })
      }
      try {
        if (parameters.length === 0) return { ok: true }
        const events: NativeInstrumentEvent[] = parameters.map(({ target, value }) => ({
          nodeId: node.id, type: "parameter", noteId: 1, sequence: host.nextEventSequence(), frameOffset: 0, channel: 0, note: target, value,
        }))
        if (request.execution && !processorState.send(request.execution, request.execution.sequence, host.lastEventSequence()))
          return { ok: false, kind: "not-sent", reason: "stale" }
        return await host.observeControl(bridge.session.queueInstrumentEvents(serializeNativeInstrumentEvents(transportEpoch, events)))
      } catch (error) {
        return { ok: false, kind: "unconfirmed", error: String(error) }
      }
    }
    const processor = resolveGraphProcessor(graph, request.instanceId)
    if (!processor) return { ok: false, kind: "not-sent", reason: "unsupported" }
    const events = []
    for (const value of request.values) {
      const parameterTarget = processor.parameterTargets.get(value.parameterId)
      if (parameterTarget === undefined || !Number.isFinite(value.value)) {
        return { ok: false, kind: "not-sent", reason: "unsupported" }
      }
      events.push({
        processorInstanceId: processor.processor.instanceId,
        parameterTarget,
        frameOffset: 0,
        value: value.value,
      })
    }
    if (events.length === 0) return { ok: true }
    try {
      const { sequence } = request
      if (request.execution && sequence !== undefined && !processorState.send(request.execution, sequence)) return { ok: false, kind: "not-sent", reason: "stale" }
      const batch = request.revision === undefined || request.epoch === undefined || sequence === undefined
        ? undefined
        : {
            revision: request.revision,
            epoch: request.epoch,
            sequence,
          }
      if (request.execution && batch) {
        const { key, editId, attempt } = request.execution
        host.observer?.processorDispatch?.({ key, editId, attempt, sequence: BigInt(batch.sequence) })
      }
      return await host.observeControl(bridge.session.queueParameterEvents(serializeNativeProcessorEvents(events, batch)))
    } catch (error) {
      // A thrown or lost reply says nothing about whether native took the batch.
      return {
        ok: false,
        kind: "unconfirmed",
        error: error instanceof Error ? error.message : "Native built-in parameter queue failed.",
      }
    }
  }
}
