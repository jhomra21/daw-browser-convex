import type {
  NativeVstEditorAnchor,
  NativeVstEditorCommand,
  NativeVstEditorStatus,
  NativeAudioHostSupervisor,
  NativeWorkerNotification,
} from "./audio-host"
import { coordinateNativeVst3Attachments } from "./native-vst3-coordinator"
import type { PluginCatalogData } from "./plugin-catalog"

type EditorSessionSupervisor = Pick<
  NativeAudioHostSupervisor,
  | "beginTransaction"
  | "configure"
  | "commitTransaction"
  | "rollbackTransaction"
  | "startDiagnosticAudio"
  | "executeVstEditorCommand"
  | "teardown"
  | "attachVst"
  | "onWorkerNotification"
>

type EditorSessionInput = {
  workerPath: string
  catalogStore: { reload(): Promise<PluginCatalogData> }
  createSupervisor: () => EditorSessionSupervisor
  coordinate?: typeof coordinateNativeVst3Attachments
  onEditorInteraction?: (input: { projectId: string; instanceId: string }) => void
  onParameterEdit?: (input: { projectId: string; instanceId: string; parameterId: number; normalizedValue: number }) => void
}

type EditorCommandInput = {
  projectId: string
  instanceId: string
  command: NativeVstEditorCommand
  serializedPlan?: string
  width?: number
  height?: number
  anchor?: NativeVstEditorAnchor
}

const diagnosticConfiguration = {
  deviceId: "coreaudio:editor",
  sampleRateHz: 44_100,
  maxFramesPerBlock: 8_192,
  channelCount: 2,
  revision: 1,
} as const

const closedStatus: NativeVstEditorStatus = {
  success: false,
  owned: false,
  supported: false,
  open: false,
  width: 0,
  height: 0,
}

type EditorSessionEntry = {
  supervisor?: EditorSessionSupervisor
  unsubscribeInteraction?: () => void
  projectId?: string
  queue: Promise<void>
}

const initializationCommand = (command: NativeVstEditorCommand) => (
  command === "open" || command === "focus" || command === "status"
)

export type NativeVst3EditorSessionManager = {
  execute(input: EditorCommandInput): Promise<NativeVstEditorStatus>
  teardownAll(): Promise<void>
}

export const createNativeVst3EditorSessionManager = (
  input: EditorSessionInput,
): NativeVst3EditorSessionManager => {
  const entries = new Map<string, EditorSessionEntry>()
  let shuttingDown = false

  const teardownEntry = async (entry: EditorSessionEntry) => {
    const supervisor = entry.supervisor
    entry.unsubscribeInteraction?.()
    entry.unsubscribeInteraction = undefined
    entry.supervisor = undefined
    await supervisor?.teardown()
  }

  const initialize = async (
    instanceId: string,
    entry: EditorSessionEntry,
    projectId: string,
    serializedPlan: string,
  ) => {
    const supervisor = input.createSupervisor()
    entry.supervisor = supervisor
    entry.projectId = projectId
    entry.unsubscribeInteraction = supervisor.onWorkerNotification((notification: NativeWorkerNotification) => {
      if (notification.kind === "editor-interaction" && notification.instanceId === instanceId) {
        input.onEditorInteraction?.({ projectId, instanceId })
      }
      if (notification.kind === "parameter-edit" && notification.instanceId === instanceId) {
        input.onParameterEdit?.({
          projectId,
          instanceId,
          parameterId: notification.parameterId,
          normalizedValue: notification.normalizedValue,
        })
      }
    })
    let transactionOpen = false
    let transactionToken: string | undefined
    try {
      transactionToken = await supervisor.beginTransaction()
      transactionOpen = true
      await supervisor.configure(diagnosticConfiguration, transactionToken)
      const result = await (input.coordinate ?? coordinateNativeVst3Attachments)({
        serializedPlan,
        sampleRateHz: diagnosticConfiguration.sampleRateHz,
        workerPath: input.workerPath,
        catalogStore: input.catalogStore,
        audioHost: supervisor,
        transactionToken,
      })
      if (!result.ok) throw new Error(result.message)
      await supervisor.commitTransaction(transactionToken)
      transactionOpen = false
      transactionToken = undefined
      await supervisor.startDiagnosticAudio()
    } catch (error) {
      if (transactionOpen) {
        try {
          if (transactionToken) await supervisor.rollbackTransaction(transactionToken)
        } catch {
          // The original initialization failure remains authoritative.
        }
      }
      await teardownEntry(entry)
      throw error
    }
  }

  const enqueue = <T>(instanceId: string, operation: (entry: EditorSessionEntry) => Promise<T>) => {
    const entry = entries.get(instanceId) ?? { queue: Promise.resolve() }
    entries.set(instanceId, entry)
    const result = entry.queue.then(() => operation(entry))
    const removeClosedEntry = () => {
      if (entries.get(instanceId) === entry && entry.queue === tail && !entry.supervisor) entries.delete(instanceId)
    }
    const tail = result.then(removeClosedEntry, removeClosedEntry)
    entry.queue = tail
    return result
  }

  return {
    execute(inputCommand) {
      if (shuttingDown) return Promise.reject(new Error("The native VST editor session is shutting down."))
      return enqueue(inputCommand.instanceId, async (entry) => {
        if (inputCommand.command === "close") {
          let status = closedStatus
          try {
            if (entry.supervisor) {
              if (entry.projectId !== inputCommand.projectId) throw new Error("The native VST editor project binding changed.")
              const { projectId: _projectId, ...nativeCommand } = inputCommand
              status = await entry.supervisor.executeVstEditorCommand(nativeCommand)
            }
          } finally {
            await teardownEntry(entry)
          }
          return status
        }
        if (entry.projectId !== undefined && entry.projectId !== inputCommand.projectId) {
          throw new Error("The native VST editor project binding changed.")
        }
        if (!entry.supervisor) {
          if (!initializationCommand(inputCommand.command) || inputCommand.serializedPlan === undefined) {
            throw new Error("The native VST editor session is unavailable.")
          }
          await initialize(inputCommand.instanceId, entry, inputCommand.projectId, inputCommand.serializedPlan)
        }
        if (!entry.supervisor) throw new Error("The native VST editor session is unavailable.")
        try {
          const { projectId: _projectId, ...nativeCommand } = inputCommand
          return await entry.supervisor.executeVstEditorCommand(nativeCommand)
        } catch (error) {
          await teardownEntry(entry)
          throw error
        }
      })
    },
    async teardownAll() {
      shuttingDown = true
      const currentEntries = [...entries.entries()]
      await Promise.all(currentEntries.map(async ([, entry]) => {
        await entry.queue
        await teardownEntry(entry)
      }))
      entries.clear()
    },
  }
}
