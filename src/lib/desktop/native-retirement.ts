import type { NativeScheduleProgress } from "@daw-browser/audio-engine/native-host-wire"
import type { NativeRevisionReply } from "@daw-browser/desktop-protocol/native-revision"
import type { DesktopBridge } from "~/types/desktop-bridge"
import type { createNativeProcessorStateOwner, RetirementObligation } from "./native-processor-state-owner"
import type { ScheduleRevisionCandidate } from "./native-schedule-publication"

type NativeRetirementHost = {
  processorState: ReturnType<typeof createNativeProcessorStateOwner<ScheduleRevisionCandidate>>
  revisions: NonNullable<DesktopBridge["audioHost"]>["session"]["revisions"] | undefined
  // The controller's session as it stands now.
  state: () => {
    lifecycleGeneration: number
    prepared: boolean
    hostLost: boolean
    preparedProjectId: string | undefined
    transportEpoch: number
    latestScheduleProgress: NativeScheduleProgress | undefined
  }
}

// Retiring the revision a publication replaced: native answers once no reader can still hold it, so the request is
// offered again at every event that can change that, one at a time.
export const createNativeRetirement = (host: NativeRetirementHost) => {
  const { processorState } = host
  const retirementAlive = (held: RetirementObligation) => {
    const now = host.state()
    return processorState.retirement() === held && held.sessionGeneration === now.lifecycleGeneration
      && now.prepared && !now.hostLost && held.binding.projectId === now.preparedProjectId
  }
  const dispatchRetirement = () => {
    const held = processorState.retirement()
    const revisions = host.revisions
    if (!held || !revisions || !retirementAlive(held) || held.running || held.attempted === held.opportunity) return
    held.attempted = held.opportunity
    held.running = true
    void (async () => {
      try {
        if (held.uncertain) {
          const proof = await revisions.inspect(held.binding)
          if (!retirementAlive(held)) return
          processorState.observeRetirement(proof)
          if (!retirementAlive(held) || !proof.ok || proof.hostPid !== held.hostPid
            || proof.hostGeneration !== held.binding.hostGeneration || proof.revision.status === "publish-pending") return
          held.uncertain = false
        }
        if (!retirementAlive(held)) return
        const reply = await revisions.retire(held.binding)
        if (retirementAlive(held)) {
          held.uncertain = !reply.ok && reply.kind === "unconfirmed"
          held.waitingControl = !reply.ok && reply.kind === "unavailable"
          // Native samples the reader check and reply epoch separately
          // (audio-host.cpp:3174, 3194). The first crossing needs one more
          // frame-driven proof: only a serialized Retire dispatched after that
          // observation cannot be reader-blocked by the monotonic counter.
          // Then not-safe means latency pending; later transport epochs still wake.
          if (reply.ok && reply.revision.status === "retirement-not-safe"
            && reply.revision.progressFrame !== undefined) {
            const now = host.state()
            const epoch = reply.revision.transportEpoch ?? now.transportEpoch
            const progress = now.latestScheduleProgress
            const newerProgress = progress && (progress.epoch > epoch
              || (progress.epoch === epoch && progress.renderedThroughFrame > reply.revision.progressFrame))
            const renderEpoch = held.readerPoint?.renderEpoch ?? reply.revision.renderEpoch
            const crossed = held.readerPoint?.crossed ?? false
            held.readerPoint = { epoch: newerProgress ? progress.epoch : epoch,
              frame: newerProgress ? progress.renderedThroughFrame : reply.revision.progressFrame,
              renderEpoch, crossed: crossed || reply.revision.renderEpoch > renderEpoch }
            held.readerPassed = crossed
          }
          processorState.observeRetirement(reply)
        }
      } catch {
        held.uncertain = true
        // Lost/unavailable cleanup is still owed. Only an external opportunity
        // can retry it; the retirement reply itself never supplies one.
      } finally {
        held.running = false
        // Only an external event received during this request can leave a
        // newer opportunity. Our own reply never increments the counter.
        if (retirementAlive(held) && held.attempted !== held.opportunity) dispatchRetirement()
      }
    })()
  }
  const opportunity = () => {
    const held = processorState.retirement()
    if (!held) return
    held.opportunity++
    dispatchRetirement()
  }
  return {
    opportunity,
    // A control request native could not take yet is retried as a retirement opportunity once it settles.
    observeControl: <T>(operation: Promise<T>) => {
      const generation = host.state().lifecycleGeneration
      const completed = () => {
        const held = processorState.retirement()
        if (generation !== host.state().lifecycleGeneration || !held || !held.waitingControl || !retirementAlive(held)) return
        held.waitingControl = false
        opportunity()
      }
      void operation.then(completed, completed)
      return operation
    },
    hold: (proof: Extract<NativeRevisionReply, { ok: true }>, projectId: string,
      release: () => Promise<void> = async () => {}) => {
      processorState.observeRetirement(proof)
      const revision = proof.revision.retiredRevision
      if (!revision) { processorState.releaseRetirementResources(release); return }
      processorState.holdRetirement({ binding: { projectId, revision, hostGeneration: proof.hostGeneration },
        hostPid: proof.hostPid, sessionGeneration: host.state().lifecycleGeneration, release,
        opportunity: 0, attempted: -1, running: false, uncertain: false, readerPassed: false, waitingControl: false })
      dispatchRetirement()
    },
  }
}
