import {
  nativeProcessorLatencyForState,
  nativeProcessorLayoutsForState,
  serializeNativeProcessorStatePatch,
} from "@daw-browser/audio-engine/native-host-wire"
import { resolveGraphProcessor } from "@daw-browser/audio-engine/mixer/resolve-graph-processor"
import type { AudioCoreGraphSnapshot } from "@daw-browser/audio-core-contract"
import type { LivePlaybackSnapshot } from "~/lib/live-playback-snapshot"
import type { ProcessorDeliveryOutcome } from "~/lib/live-processor-control"
import type { DesktopBridge, NativeProcessorPatchReply } from "~/types/desktop-bridge"
import {
  timedProcessorDesired,
  type createNativeProcessorStateOwner,
  type PatchExecution,
  type PatchReply,
  type ProcessorDesired,
  type ProcessorReconcile,
} from "./native-processor-state-owner"
import type { ScheduleRevisionCandidate } from "./native-schedule-publication"

type NativeStatePatchHost = {
  bridge: { session: { queueProcessorStatePatch?: NonNullable<DesktopBridge["audioHost"]>["session"]["queueProcessorStatePatch"] } } | undefined
  processorState: ReturnType<typeof createNativeProcessorStateOwner<ScheduleRevisionCandidate>>
  // The controller's prepared session as it stands now.
  session: () => { prepared: boolean; sampleRate: number; graph: AudioCoreGraphSnapshot | undefined; snapshot: LivePlaybackSnapshot | undefined }
  setPreparedGraph: (graph: AudioCoreGraphSnapshot) => void
  isRetiredTarget: (edit: PatchExecution["edit"], instanceId: string) => boolean
  executeReconcile: (reconcile: readonly ProcessorReconcile[]) => void
  // A prepare, a publication or a staged candidate the controller has outstanding.
  outstandingOperation: () => boolean
  requestLatencyPublication: () => Promise<{ handled: true } | { handled: false; reason: string }>
  queueTransition: <T>(task: () => Promise<T>) => Promise<T>
}

// Built-in processor state patches: native applies one while no core is prepared, so they run one at a time in the
// prepared transport lane, which also serializes this controller's own prepare, publish and adoption.
export const createNativeStatePatches = (host: NativeStatePatchHost) => {
  const { processorState } = host
  let draining = false

  const patchReplyOf = (reply: NativeProcessorPatchReply): PatchReply => {
    if (!reply.ok) return reply.kind === "refused" ? { kind: "refused", refusal: "native-refused", transient: false } : { kind: reply.kind }

    switch (reply.outcome) {
      case "applied": return { kind: "applied" }
      case "claimed": return { kind: "claimed", token: BigInt(reply.token) }
      case "refused": {
        if (reply.refusal === "unavailable") return { kind: "unavailable" }
        // A refusal over a prepare, a publication or a transition this controller has outstanding is offered again at
        // that operation's end; with none outstanding it is definite.
        const transient = (reply.refusal === "preparing" || reply.refusal === "stale-revision") && host.outstandingOperation()

        return { kind: "refused", refusal: reply.refusal, transient, ...(reply.token !== undefined && { token: BigInt(reply.token) }) }
      }
    }
  }

  const runBuiltInStatePatch = async ({ execution, desired: materialized }: { execution: PatchExecution; desired: ProcessorDesired }) => {
    const unsent = (outcome?: ProcessorDeliveryOutcome) => host.executeReconcile(processorState.abandon(execution, outcome))
    const bridge = host.bridge
    const { prepared, graph, snapshot } = host.session()

    if (!bridge || !prepared || !graph || !snapshot) return unsent()
    const queueProcessorStatePatch = bridge.session.queueProcessorStatePatch
    const { instanceId } = materialized.target

    if (host.isRetiredTarget(execution.edit, instanceId)) return host.executeReconcile(processorState.cancel(execution, true))
    const match = resolveGraphProcessor(graph, instanceId)

    if (!match) return unsent()
    const { state } = materialized.content
    const layouts = nativeProcessorLayoutsForState(match.node, instanceId, state)

    if (!layouts || materialized.bypassed !== match.processor.bypassed
      || layouts.output !== nativeProcessorLayoutsForState(match.node, instanceId, match.processor.state)?.output) {
      return unsent({ state: "refused", reason: "unsupported" })
    }

    if (nativeProcessorLatencyForState(match.processor, state) !== match.processor.latencyFrames) {
      // The publication folds the ledger, which holds this patch's newest content, and settles its record. A transport
      // that cancels it requeues the record, which can be dispatched again before this answer: only this dispatch acts.
      const { attempt } = execution
      void host.requestLatencyPublication().then(result => {
        if (!result.handled && execution.attempt === attempt && execution.state !== "cancelled" && execution.state !== "applied")
          host.executeReconcile(result.reason === "unprepared"
            ? processorState.abandon(execution)
            : processorState.patchReplied(execution, { kind: "refused", refusal: "stage-failed", transient: false }))
      })

      return
    }

    if (!queueProcessorStatePatch) return unsent()

    const patch = serializeNativeProcessorStatePatch({
      graphRevision: graph.revision,
      nodeId: match.node.id,
      instanceId: match.processor.instanceId,
      kindId: match.processor.kindId,
      stateVersion: match.processor.stateVersion,
      state,
      bypassed: match.processor.bypassed,
      inputLayout: layouts.input,
      outputLayout: layouts.output,
      parameterTargets: [...match.parameterTargets.values()],
      latencyFrames: match.processor.latencyFrames,
      tailFrames: materialized.tailFrames,
    })

    const reply = await queueProcessorStatePatch(patch).catch((error): NativeProcessorPatchReply => ({
      ok: false,
      kind: "unconfirmed",
      error: error instanceof Error ? error.message : "Native built-in processor state patch failed.",
    }))

    const current = host.session().graph

    if (reply.ok && reply.outcome === "applied" && current) {
      host.setPreparedGraph({
        ...current,
        nodes: current.nodes.map((node) => ({
          ...node,
          processorOrder: node.processorOrder.map((processor) => {
            if (processor.id !== instanceId) return processor
            const { tailKind: _tailKind, ...withoutTailKind } = processor

            return { ...withoutTailKind, state: state.slice(), tailFrames: materialized.tailFrames,
              ...(materialized.tailKind && { tailKind: materialized.tailKind }) }
          }),
        })),
      })
    }

    host.executeReconcile(processorState.patchReplied(execution, patchReplyOf(reply)))
  }

  // Native refuses a patch while a core is prepared (QueueProcessorStatePatch). The lane serializes this controller's own
  // prepare, publish and adoption with patches, so the one prepared core a patch can meet is a rolled-back
  // publication native still holds as publish-pending; every patch waits for its owner's terminal. One
  // that changes latency also waits while an adoption attempt runs: it folds the latest desired content into its own
  // seam, and the lane would otherwise publish a revision against it. A retained candidate left by a refusal holds nothing.
  const runNext = async () => {
    const next = processorState.nextPatch((desired) => {
      if (processorState.publication()) return undefined
      const { graph, snapshot, sampleRate } = host.session()
      const match = graph && resolveGraphProcessor(graph, desired.target.instanceId)
      const pending = processorState.compiling() || processorState.adoptionRunning()

      if (pending && !!match
        && nativeProcessorLatencyForState(match.processor, desired.content.state) !== match.processor.latencyFrames) return undefined

      // Its parameters give the enabled flag and tail at the tempo now, not those of the edit it was queued for.
      return snapshot ? timedProcessorDesired(desired, sampleRate, snapshot.bpm) : desired
    })

    if (!next) {
      draining = false

      return false
    }

    await runBuiltInStatePatch(next)

    return true
  }

  return {
    runNext,
    // `nextPatch` runs in the lane task that sends what it returns: nothing is sent between the content it picks and
    // the send. The flag is cleared in the task that finds nothing, so a patch queued after it starts a new drain.
    drain: async () => {
      if (draining) return
      draining = true

      while (await host.queueTransition(runNext)) continue
    },
  }
}
