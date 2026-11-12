import { createSignal } from "solid-js"

// Instances whose own plug-in crashed or returned an API error in this native session. They stay muted until
// the user replaces or removes them, so the device keeps showing the failure. Instance ids are UUIDs, so the
// set is safe to share across projects; a new native session loads every plug-in afresh and clears it.
const [failed, setFailed] = createSignal<ReadonlySet<string>>(new Set<string>())

export const vstInstanceFailed = (instanceId: string) => failed().has(instanceId)
export const markVstInstanceFailed = (instanceId: string) => setFailed((current) => new Set<string>(current).add(instanceId))
export const clearVstInstanceFailures = () => setFailed(new Set<string>())
