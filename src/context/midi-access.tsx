import { createContext, createEffect, createSignal, onCleanup, type ParentComponent, useContext } from "solid-js"
import { assertDefined } from "@daw-browser/shared"
import {
  createMidiAccessController,
  type MidiAccessContextValue,
  type MidiAccessStatus,
  type MidiInputDescriptor,
} from "~/lib/midi/midi-access"
import { useAppPreferences } from "./app-preferences"

const MidiAccessContext = createContext<MidiAccessContextValue | null>(null)

export const MidiAccessProvider: ParentComponent = (props) => {
  const appPreferences = useAppPreferences()
  const getNavigator = () => "navigator" in globalThis ? globalThis.navigator : undefined

  const isMidiSupported = () => {
    const browserNavigator = getNavigator()

    return browserNavigator !== undefined && "requestMIDIAccess" in browserNavigator
  }

  const [status, setStatus] = createSignal<MidiAccessStatus>(
    isMidiSupported() ? "idle" : "unsupported"
  )

  const [inputs, setInputs] = createSignal<MidiInputDescriptor[]>([])

  const controller = createMidiAccessController({
    isSupported: isMidiSupported,
    requestAccess: () => {
      const browserNavigator = getNavigator()

      if (!browserNavigator || !("requestMIDIAccess" in browserNavigator)) {
        return Promise.reject(new Error("Web MIDI is not supported."))
      }

      return browserNavigator.requestMIDIAccess({ sysex: false })
    },
    initialSelectedInputIds: appPreferences.midi.selectedInputIds(),
    onSelectedInputIdsChange: appPreferences.midi.setSelectedInputIds,
    onStatusChange: setStatus,
    onInputsChange: setInputs,
  })

  createEffect(
    () => appPreferences.midi.selectedInputIds(),
    (selectedInputIds) => {
      controller.setSelectedInputIds(selectedInputIds)
    },
  )

  onCleanup(controller.dispose)

  return (
    <MidiAccessContext value={{
      status,
      inputs,
      requestAccess: controller.requestAccess,
      setInputSelected: controller.setInputSelected,
      subscribe: controller.subscribe,
      subscribeSourceReset: controller.subscribeSourceReset,
      panic: controller.panic,
    }}>
      {props.children}
    </MidiAccessContext>
  )
}

export const useMidiAccess = () => {
  const context = useContext(MidiAccessContext)

  return assertDefined(context, "useMidiAccess must be used within MidiAccessProvider.")
}
