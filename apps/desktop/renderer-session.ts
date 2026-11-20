import type { BrowserWindow } from "electron"
import {
  desktopProtocolVersion,
  desktopRendererRequestSchemaV1,
  desktopTrustedRendererRequestSchemaV1,
  isDesktopControlOperation,
  type DesktopFrameV1,
  type DesktopOperationV1,
  type DesktopRendererRequestV1,
  type DesktopTrustedRendererRequestV1,
} from "@daw-browser/desktop-protocol"
import { hostRequestChannel } from "@daw-browser/desktop-protocol/ipc-channels"
import { createDiagnosticsTrace } from "./diagnostics-trace"
import { deliverToRenderer } from "./renderer-delivery"
import { createRendererLifecycleOwner } from "./renderer-lifecycle"
import { desktopEnv } from "./env"
import type { createAe08Evidence } from "./ae08-evidence"

type PendingRendererRequest = {
  generation: number
  resolve: (frame: Extract<DesktopFrameV1, { type: "reply" }>) => void
  reject: (error: Error) => void
}

export type RendererRequestInput = Parameters<typeof desktopRendererRequestSchemaV1.parse>[0]

/** The main process's view of the one trusted renderer: its window, document generation, in-flight requests and quit state. */
export const createRendererSession = (options: {
  sameAppOrigin: (url: string) => boolean
  ae08Evidence: ReturnType<typeof createAe08Evidence>
}) => {
  const { sameAppOrigin, ae08Evidence } = options
  let window_: BrowserWindow | undefined
  let finishingQuit = false

  const pendingEditorStateAcks = new Map<string, {
    resolve: () => void
    reject: (error: Error) => void
  }>()

  const rendererLifecycle = createRendererLifecycleOwner()
  let currentGeneration = rendererLifecycle.generation()
  const rendererPending = new Map<string, PendingRendererRequest>()

  const diagnosticsTraceEnabled = desktopEnv.diagnosticsV2Trace()
  const diagnosticsTrace = createDiagnosticsTrace(diagnosticsTraceEnabled, console.error)
  const diagnosticsStarts = new Map<string, number>()

  const sendRendererMessage = (channel: string, ...args: unknown[]) => {
    ae08Evidence?.rendererSend()

    return deliverToRenderer({
      getTarget: () => window_?.webContents,
      channel,
      args,
      sameOrigin: sameAppOrigin,
      isFinishingQuit: () => finishingQuit,
    })
  }

  const cancelRendererRequest = (id: string, requestGeneration: number) => {
    sendRendererMessage(hostRequestChannel, {
      generation: requestGeneration,
      frame: { version: desktopProtocolVersion, type: "cancel", id },
    })
  }

  const rejectRendererPending = (message: string) => {
    for (const [id, pending] of rendererPending) {
      cancelRendererRequest(id, pending.generation)
      pending.reject(new Error(message))
    }

    rendererPending.clear()
  }

  const rejectEditorStateAcks = (message: string) => {
    for (const pending of pendingEditorStateAcks.values()) pending.reject(new Error(message))
    pendingEditorStateAcks.clear()
  }

  const rejectRendererRequest = (id: string, message: string) => {
    const pending = rendererPending.get(id)

    if (!pending) return
    rendererPending.delete(id)
    cancelRendererRequest(id, pending.generation)
    pending.reject(new Error(message))
  }

  const sendToRenderer = (
    request: DesktopRendererRequestV1 | DesktopTrustedRendererRequestV1,
    trustedActorSubject?: string,
  ) => new Promise<Extract<DesktopFrameV1, { type: "reply" }>>((resolve, reject) => {
    if (rendererPending.has(request.id)) {
      reject(new Error("Duplicate request ID."))

      return
    }

    const expectedGeneration = currentGeneration
    rendererPending.set(request.id, { generation: expectedGeneration, resolve, reject })

    if (request.operation === "diagnostics.snapshot.v2") diagnosticsTrace.mark(diagnosticsStarts.get(request.id) ?? diagnosticsTrace.start(), "renderer-dispatched")

    if (!sendRendererMessage(hostRequestChannel, {
      generation: expectedGeneration,
      frame: request,
      trustedActorSubject,
      diagnosticsTrace: diagnosticsTraceEnabled && request.operation === "diagnostics.snapshot.v2",
    })) {
      rendererPending.delete(request.id)
      reject(new Error("Renderer unavailable."))
    }
  })

  const renderRequest = async (operation: DesktopOperationV1 | "lifecycle.prepareToClose", input: RendererRequestInput, id: string, deadlineMs = 10_000, actorSubject?: string) => {
    const request = { version: desktopProtocolVersion, type: "request" as const, id, operation, input, deadlineMs }

    const parsed = operation !== "lifecycle.prepareToClose" && isDesktopControlOperation(operation)
      ? desktopTrustedRendererRequestSchemaV1.parse({ ...request, actorSubject })
      : desktopRendererRequestSchemaV1.parse(request)

    // This is a bounded deadline guard for a renderer IPC round trip; it is always cleared on completion.
    let timeout: ReturnType<typeof setTimeout> | undefined
    let deadlineElapsed = false

    try {
      return await Promise.race([
        sendToRenderer(parsed, actorSubject),
        new Promise<Extract<DesktopFrameV1, { type: "reply" }>>((_resolve, reject) => {
          timeout = setTimeout(() => {
            deadlineElapsed = true

            if (operation === "diagnostics.snapshot.v2") diagnosticsTrace.mark(diagnosticsStarts.get(id) ?? diagnosticsTrace.start(), "renderer-deadline")
            reject(new Error("Renderer deadline exceeded."))
          }, deadlineMs)
        }),
      ])
    } finally {
      if (timeout) clearTimeout(timeout)
      const pending = rendererPending.get(id)

      if (deadlineElapsed && pending) cancelRendererRequest(id, pending.generation)
      rendererPending.delete(id)
    }
  }

  return {
    lifecycle: rendererLifecycle,
    pending: rendererPending,
    editorStateAcks: pendingEditorStateAcks,
    diagnostics: { enabled: diagnosticsTraceEnabled, trace: diagnosticsTrace, starts: diagnosticsStarts },
    window: () => window_,
    setWindow: (next: BrowserWindow | undefined) => { window_ = next },
    finishingQuit: () => finishingQuit,
    beginQuit: () => { finishingQuit = true },
    generation: () => currentGeneration,
    advanceGeneration: (next: number) => { currentGeneration = next },
    send: sendRendererMessage,
    request: renderRequest,
    cancel: cancelRendererRequest,
    reject: rejectRendererRequest,
    rejectAllPending: rejectRendererPending,
    rejectEditorStateAcks,
  }
}

export type RendererSession = ReturnType<typeof createRendererSession>
