import { createSignal } from "solid-js"

// Instances whose own plug-in crashed or returned an API error in this native session. They stay muted until
// the user replaces or removes them, so the device keeps showing the failure. Instance ids are UUIDs, so the
// set is safe to share across projects; a new native session loads every plug-in afresh and clears it.
const [failed, setFailed] = createSignal<ReadonlySet<string>>(new Set<string>())

export const vstInstanceFailed = (instanceId: string) => failed().has(instanceId)
export const markVstInstanceFailed = (instanceId: string) => setFailed((current) => new Set<string>(current).add(instanceId))

// The devices and tracks whose routing the native engine cannot activate (E6: MIDI expression automation, a
// sidechain), keyed by the element the routing belongs to, with the reason. This is a limitation, not a fault: the
// plug-in is untouched and the playing graph is unchanged. The newest compile decides it.
const [limits, setLimits] = createSignal<ReadonlyMap<string, string>>(new Map<string, string>())

export const instanceLimit = (id: string) => limits().get(id)
export const setInstanceLimits = (next: ReadonlyMap<string, string>) => setLimits(next)
export const addInstanceLimit = (id: string, reason: string) => setLimits((current) => new Map(current).set(id, reason))
export const clearInstanceLimits = () => setLimits(new Map<string, string>())

export const clearVstInstanceFailures = () => {
  setFailed(new Set<string>())
  clearInstanceLimits()
}
