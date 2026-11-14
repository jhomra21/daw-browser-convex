import { z } from "zod"
import { isProcessorWaitTimer } from "./ae-08-processor-state-fuzz-virtual-time"

// Observation only. Never computes a product winner or drives a scheduler.
export default function createWitnessObserver() {
  const events: { event?: string; site?: string; kind?: string; name?: string; id?: number }[] = []
  let start = 0
  let gain = 0
  let waiterIds: number[] = []
  let applied = 0
  const eventSchema = z.object({ event: z.string().optional(), site: z.string().optional(),
    kind: z.string().optional(), name: z.string().optional(), id: z.number().optional() })
  return {
    record<Value>(value: Value) {
      const parsed = eventSchema.safeParse(value)
      if (parsed.success) events.push(parsed.data)
    },
    capture(value: number, ids: number[], applicationCount: number) {
      start = events.length; gain = value; waiterIds = ids; applied = applicationCount
    },
    state: () => ({ gain, waiterIds, applied, events: events.slice(start),
      processorTimers: events.slice(start).filter((event) => event.event === "virtual-work-fired" && event.kind === "fire-timer"
        && event.site !== undefined && isProcessorWaitTimer(event.site)).length }),
    // Allocation, not firing: a timer that was cancelled before it fired was still a timeout the path was prepared to take.
    processorTimerAllocations: () => events.filter((event) => event.event === "virtual-work-scheduled" && event.kind === "fire-timer"
      && event.site !== undefined && isProcessorWaitTimer(event.site)).length,
    pauseCompletions: () => events.filter((event) => event.event === "latency-transition-complete-on-pause").length,
  }
}
