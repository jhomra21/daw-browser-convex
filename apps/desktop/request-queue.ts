import { hostError, type DesktopOperationV1, type DesktopRequestV1, type HostErrorV1 } from "@daw-browser/desktop-protocol"

export type PreloadHostRequest = {
  id: string
  operation: DesktopOperationV1
  input: unknown
  signal: AbortSignal
}

export type PreloadHostResponse = {
  id: string
  result?: unknown
  error?: HostErrorV1
}

type QueuedRequest = {
  generation: number
  request: DesktopRequestV1
  deadlineAt: number
}

type RequestQueueOptions = {
  reply: (generation: number, response: PreloadHostResponse) => void
  now?: () => number
  queueLimit: number
}

type RequestHandler = (request: PreloadHostRequest) => Promise<PreloadHostResponse>

const deadlineExceeded = (id: string): PreloadHostResponse => ({
  id,
  error: hostError("deadline-exceeded", "The request deadline elapsed."),
})

const cancelled = (id: string): PreloadHostResponse => ({
  id,
  error: hostError("cancelled", "The request was cancelled."),
})

const failed = (id: string): PreloadHostResponse => ({
  id,
  error: hostError("internal", "The timeline operation failed."),
})

export const createRequestQueue = ({ reply, now = Date.now, queueLimit }: RequestQueueOptions) => {
  const queued = new Map<string, QueuedRequest>()
  const active = new Map<string, AbortController>()
  let handler: RequestHandler | undefined

  const dispatch = (entry: QueuedRequest) => {
    if (entry.deadlineAt <= now()) {
      reply(entry.generation, deadlineExceeded(entry.request.id))
      return
    }
    if (!handler) {
      if (queued.size >= queueLimit) {
        reply(entry.generation, { id: entry.request.id, error: hostError("unavailable", "The timeline controller is not ready.") })
        return
      }
      queued.set(entry.request.id, entry)
      return
    }
    const controller = new AbortController()
    active.set(entry.request.id, controller)
    void handler({
      id: entry.request.id,
      operation: entry.request.operation,
      input: entry.request.input,
      signal: controller.signal,
    }).then(
      (response) => {
        if (!controller.signal.aborted) reply(entry.generation, response)
      },
      () => {
        if (!controller.signal.aborted) reply(entry.generation, failed(entry.request.id))
      },
    ).finally(() => {
      if (active.get(entry.request.id) === controller) active.delete(entry.request.id)
    })
  }

  return {
    dispatch(generation: number, request: DesktopRequestV1) {
      dispatch({
        generation,
        request,
        deadlineAt: request.deadlineMs === undefined ? Number.POSITIVE_INFINITY : now() + request.deadlineMs,
      })
    },
    cancel(id: string) {
      const entry = queued.get(id)
      if (entry) {
        queued.delete(id)
        reply(entry.generation, cancelled(id))
        return
      }
      active.get(id)?.abort()
    },
    setRequestHandler(next: RequestHandler | undefined) {
      handler = next
      if (!handler) return
      const entries = [...queued.values()]
      queued.clear()
      for (const entry of entries) dispatch(entry)
    },
  }
}
