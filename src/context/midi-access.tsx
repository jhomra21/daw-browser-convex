import { createContext, createEffect, createSignal, onCleanup, type ParentComponent, useContext } from "solid-js"
import { assert } from "@daw-browser/shared"
import {
  createMidiAccessController,
  type MidiAccessStatus,
  type MidiInputDescriptor,
} from "~/lib/midi/midi-access"
import type { MidiInputEvent, MidiSourceReset } from "~/lib/midi/midi-input"
import { useAppPreferences } from "./app-preferences"

export type MidiAccessContextValue = {
  status: () => MidiAccessStatus
  inputs: () => readonly MidiInputDescriptor[]
  requestAccess: () => Promise<void>
  setInputSelected: (id: string, selected: boolean) => void
  subscribe: (subscriber: (event: MidiInputEvent) => void) => () => void
  subscribeSourceReset: (subscriber: (event: MidiSourceReset) => void) => () => void
  panic: () => void
}

const MidiAccessContext = createContext<MidiAccessContextValue | null>(null)

export const MidiAccessProvider: ParentComponent = (props) => {
  const appPreferences = useAppPreferences()
  const [status, setStatus] = createSignal<MidiAccessStatus>(
    typeof navigator !== "undefined" && "requestMIDIAccess" in navigator ? "idle" : "unsupported"
  )
  const [inputs, setInputs] = createSignal<MidiInputDescriptor[]>([])
  const controller = createMidiAccessController({
    isSupported: () => typeof navigator !== "undefined" && "requestMIDIAccess" in navigator,
    requestAccess: () => navigator.requestMIDIAccess({ sysex: false }),
    initialSelectedInputIds: appPreferences.midi.selectedInputIds(),
    onSelectedInputIdsChange: appPreferences.midi.setSelectedInputIds,
    onStatusChange: setStatus,
    onInputsChange: setInputs,
  })

  createEffect(() => {
    controller.setSelectedInputIds(appPreferences.midi.selectedInputIds())
  })

  onCleanup(controller.dispose)

  return (
    <MidiAccessContext.Provider value={{
      status,
      inputs,
      requestAccess: controller.requestAccess,
      setInputSelected: controller.setInputSelected,
      subscribe: controller.subscribe,
      subscribeSourceReset: controller.subscribeSourceReset,
      panic: controller.panic,
    }}>
      {props.children}
    </MidiAccessContext.Provider>
  )
}

export const useMidiAccess = () => {
  const context = useContext(MidiAccessContext)
  assert(context, "useMidiAccess must be used within MidiAccessProvider.")
  return context
}
