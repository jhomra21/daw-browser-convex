import { contextBridge, ipcRenderer } from "electron"
import { desktopCancelSchemaV1, desktopRendererRequestSchemaV1, desktopReplySchemaV1, hostError, type DesktopRendererRequestV1 } from "@daw-browser/desktop-protocol"
import { createRequestQueue, type PreloadHostRequest, type PreloadHostResponse } from "./request-queue"

const incomingChannel = "daw:host-request"
const outgoingChannel = "daw:host-response"
const queueLimit = 32
let closeHandler: (() => Promise<{ flushed: boolean }>) | undefined

const reply = (generation: number, response: PreloadHostResponse) => {
  const parsed = desktopReplySchemaV1.safeParse({
    version: "v1",
    type: "reply",
    id: response.id,
    ...(response.error === undefined ? { result: response.result } : { error: response.error }),
  })
  if (parsed.success) ipcRenderer.send(outgoingChannel, { generation, frame: parsed.data })
}

const requestQueue = createRequestQueue({ reply, queueLimit })

const dispatchLifecycle = (generation: number, request: DesktopRendererRequestV1) => {
  if (request.operation === "lifecycle.prepareToClose") {
    void (closeHandler ? closeHandler() : Promise.resolve({ flushed: false }))
      .then((response) => reply(generation, { id: request.id, result: response }))
      .catch(() => reply(generation, { id: request.id, error: hostError("internal", "The timeline could not prepare to close.") }))
  }
}

ipcRenderer.on(incomingChannel, (_event, message: unknown) => {
  if (typeof message !== "object" || message === null || !("generation" in message) || !("frame" in message)) return
  const generation = message.generation
  if (typeof generation !== "number" || !Number.isSafeInteger(generation)) return
  const cancel = desktopCancelSchemaV1.safeParse(message.frame)
  if (cancel.success) {
    requestQueue.cancel(cancel.data.id)
    return
  }
  const parsed = desktopRendererRequestSchemaV1.safeParse(message.frame)
  if (!parsed.success) return
  if (parsed.data.operation === "lifecycle.prepareToClose") {
    dispatchLifecycle(generation, parsed.data)
    return
  }
  requestQueue.dispatch(generation, parsed.data)
})

contextBridge.exposeInMainWorld("dawDesktop", {
  setRequestHandler(next: ((request: PreloadHostRequest) => Promise<PreloadHostResponse>) | undefined) {
    requestQueue.setRequestHandler(next)
  },
  onPrepareToClose(next: typeof closeHandler) {
    closeHandler = next
  },
  async prepareToClose() {
    return closeHandler ? await closeHandler() : { flushed: false }
  },
})
