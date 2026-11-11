import { normalizeUtilityParamsEnvelope } from "@daw-browser/shared"
import type { NativeBuiltInParameterPayload } from "../../src/lib/desktop/native-built-in-parameter-mapper"
import { createProcessorEditRegistry } from "../../src/components/timeline/create-processor-edit-registry"
import type { TraceEvent } from "./ae-08-processor-state-fuzz-hook-checks"

// Timeline's own identity authority wrapped to record every reservation, release,
// allocation and projection of the utility member, in the order they happen.
export default function createTracedProcessorEdits(bpm: Parameters<typeof createProcessorEditRegistry>[0], mutation?: string) {
  const registry = createProcessorEditRegistry(bpm)
  const trace: TraceEvent[] = []
  const gainOf = (payload: NativeBuiltInParameterPayload) => payload.effect === "utility" ? payload.to.state.gainDb : undefined
  let projectedEdit: string | undefined
  let reserved: { signature: string; edit: NonNullable<ReturnType<typeof registry.reserve>> } | undefined
  const processorEdits = { ...registry,
    // A projection is traced by the Utility target's own latest edit, read after the registry took the projection.
    // Reading never allocates: a second allocation here would be a writer the panel never saw.
    observe: (fx: Parameters<typeof registry.observe>[0]) => {
      registry.observe(fx)
      const utility = fx.trackFx?.track?.instances.find((instance) => instance.id === "utility:1")
      if (!utility) return
      const gain = normalizeUtilityParamsEnvelope(utility.params ?? null).state.gainDb
      const edit = registry.target("track", "utility:1")?.latest
      if (edit && edit.id !== projectedEdit) {
        projectedEdit = edit.id
        trace.push({ kind: "projection", target: `${edit.target.nodeId}:${edit.target.instanceId}`, order: edit.order, id: edit.id, gain })
      }
    },
    reserve: (payload: NativeBuiltInParameterPayload) => {
      const edit = registry.reserve(payload)
      const gain = gainOf(payload)
      if (edit && gain !== undefined) {
        reserved = { signature: JSON.stringify(payload.to), edit }
        trace.push({ kind: "reserve", order: edit.order, gain })
      }
      return edit
    },
    release: (edit: NonNullable<ReturnType<typeof registry.reserve>>) => {
      trace.push({ kind: "release", order: edit.order })
      if (mutation !== "no-release") registry.release(edit)
    },
    allocate: (payload: NativeBuiltInParameterPayload) => {
      const before = registry.sequence()
      // Planted defect: the reservation outlives a newer allocation, so the
      // later replay adopts its older order.
      const retained = mutation === "retain-reservation" && reserved?.signature === JSON.stringify(payload.to) ? reserved.edit : undefined
      const edit = retained ?? registry.allocate(payload)
      const gain = gainOf(payload)
      if (edit && gain !== undefined) trace.push({ kind: "allocate", order: edit.order, gain, fresh: edit.order > before })
      return edit
    },
  }
  return { processorEdits, trace }
}
