import { createSignal } from "solid-js"

// Instances whose own plug-in crashed or returned an API error in this native session. They stay muted until
// the user replaces or removes them, so the device keeps showing the failure. Instance ids are UUIDs, so the
// set is safe to share across projects; a new native session loads every plug-in afresh and clears it.
const [failed, setFailed] = createSignal<ReadonlySet<string>>(new Set<string>())

export const vstInstanceFailed = (instanceId: string) => failed().has(instanceId)
export const markVstInstanceFailed = (instanceId: string) => setFailed((current) => new Set<string>(current).add(instanceId))

// Instances in a graph the native engine cannot activate (E6: MIDI expression automation, a sidechain). This is a
// limitation, not a fault: the plug-in is untouched and the playing graph is unchanged. The newest compile decides it.
const [limits, setLimits] = createSignal<ReadonlyMap<string, string>>(new Map<string, string>())

// The reason the native graph cannot carry this instance's graph, when it cannot.
export const vstInstanceLimit = (instanceId: string) => limits().get(instanceId)
export const limitVstInstances = (instanceIds: readonly string[], reason: string) =>
  setLimits(new Map(instanceIds.map((instanceId) => [instanceId, reason])))
export const clearVstInstanceLimits = () => setLimits(new Map<string, string>())

export const clearVstInstanceFailures = () => {
  setFailed(new Set<string>())
  clearVstInstanceLimits()
}
