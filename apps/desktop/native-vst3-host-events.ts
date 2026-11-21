import type { DesktopVstInstanceEvent } from "@daw-browser/desktop-protocol"
import type { NativeWorkerNotification } from "./native-host-frame-decoders"
import {
  nativeVst3InstanceEvent,
  type NativeVst3Defect,
} from "./native-vst3-coordinator"

type NativeVst3HostEventOutputs = {
  sendInstanceEvent: (event: DesktopVstInstanceEvent) => void
  sendParameterEdit: (input: { projectId: string; instanceId: string; parameterId: number; normalizedValue: number }) => void
  sendEditorState: (input: { projectId: string; instanceId: string; open: boolean }) => void
  projectFor: (instanceId: string) => string | undefined
  endSession: (error: Error) => void
  reportDefect?: (defect: NativeVst3Defect) => void
}

const logWorkerIncident = (notification: Extract<NativeWorkerNotification, { value: number }>) => {
  const fault = notification.kind === "fault"
  console.error("[native-vst3-worker-incident]", JSON.stringify({
    kind: notification.kind,
    originCode: fault ? notification.value & 0xff : 0,
    childCode: fault ? (notification.value >>> 8) & 0xff : 0,
    childStatus: fault ? (notification.value >>> 16) & 0xff : 0,
    value: notification.value,
    graphRevision: notification.graphRevision,
  }))
}

export const createNativeVst3HostEventHandlers = (outputs: NativeVst3HostEventOutputs) => ({
  onNotification: (notification: NativeWorkerNotification) => {
    if (notification.kind === "fault" || notification.kind === "miss" || notification.kind === "restart") logWorkerIncident(notification)
    const instanceEvent = nativeVst3InstanceEvent(notification, outputs.reportDefect)

    if (instanceEvent) outputs.sendInstanceEvent(instanceEvent)
    const projectId = outputs.projectFor(notification.instanceId)

    if (!projectId) return

    if (notification.kind === "editor-state") {
      outputs.sendEditorState({ projectId, instanceId: notification.instanceId, open: notification.value === 1 })

      return
    }

    if (notification.kind !== "parameter-edit") return
    outputs.sendParameterEdit({
      projectId,
      instanceId: notification.instanceId,
      parameterId: notification.parameterId,
      normalizedValue: notification.normalizedValue,
    })
  },
  onLoss: outputs.endSession,
})
