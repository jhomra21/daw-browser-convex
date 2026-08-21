import { hostError, type DesktopOperationV1, type DesktopTrustedRendererRequestV1, type HostErrorV1, type ControlErrorV1 } from "@daw-browser/desktop-protocol"

export type PreloadHostRequest = {
  id: string
  operation: DesktopOperationV1
  input: unknown
  trustedActorSubject?: string
}

export type PreloadHostResponse = {
  id: string
  result?: unknown
  error?: HostErrorV1 | ControlErrorV1
}

type QueuedRequest = {
  generation: number
  request: Exclude<DesktopTrustedRendererRequestV1, { operation: "lifecycle.prepareToClose" }>
  deadlineAt: number
  trustedActorSubject?: string
}

type RequestQueueOptions = {
  reply: (generation: number, response: PreloadHostResponse) => void
  now?: () => number
  queueLimit: number
}

type RequestHandler = (request: PreloadHostRequest) => Promise<PreloadHostResponse>
type RequestCancellationHandler = (requestId: string) => void

const errorFor = (_operation: DesktopOperationV1, code: HostErrorV1["code"], message: string): HostErrorV1 | ControlErrorV1 => hostError(code, message)
const deadlineExceeded = (id: string, operation: DesktopOperationV1): PreloadHostResponse => ({
  id,
  error: errorFor(operation, "deadline-exceeded", "The request deadline elapsed."),
})

const cancelled = (id: string, operation: DesktopOperationV1): PreloadHostResponse => ({
  id,
  error: errorFor(operation, "cancelled", "The request was cancelled."),
})

const failed = (id: string, operation: DesktopOperationV1): PreloadHostResponse => ({
  id,
  error: errorFor(operation, "internal", "The timeline operation failed."),
})

const duplicate = (id: string, operation: DesktopOperationV1): PreloadHostResponse => ({
  id,
  error: errorFor(operation, "invalid-request", "A request with this id is already pending."),
})

export const createRequestQueue = ({ reply, now = Date.now, queueLimit }: RequestQueueOptions) => {
  const queued = new Map<string, QueuedRequest>()
  const active = new Map<string, { controller: AbortController; entry: QueuedRequest }>()
  let handler: RequestHandler | undefined
  let cancelHandler: RequestCancellationHandler | undefined
  let currentGeneration = 0
  const cancelActive = (id: string, controller: AbortController) => {
    controller.abort()
    try {
      cancelHandler?.(id)
    } catch {}
  }
  const cancelAll = () => {
    for (const entry of queued.values()) reply(entry.generation, cancelled(entry.request.id, entry.request.operation))
    queued.clear()
    for (const { controller, entry } of active.values()) {
      cancelActive(entry.request.id, controller)
      reply(entry.generation, cancelled(entry.request.id, entry.request.operation))
    }
    active.clear()
  }
  const advance = (nextGeneration: number) => {
    if (nextGeneration <= currentGeneration) return
    currentGeneration = nextGeneration
    cancelAll()
  }

  const dispatch = (entry: QueuedRequest) => {
    if (queued.has(entry.request.id) || active.has(entry.request.id)) {
      reply(entry.generation, duplicate(entry.request.id, entry.request.operation))
      return
    }
    if (entry.deadlineAt <= now()) {
      reply(entry.generation, deadlineExceeded(entry.request.id, entry.request.operation))
      return
    }
    if (!handler) {
      if (queued.size >= queueLimit) {
        reply(entry.generation, { id: entry.request.id, error: errorFor(entry.request.operation, "unavailable", "The timeline controller is not ready.") })
        return
      }
      queued.set(entry.request.id, entry)
      return
    }
    const controller = new AbortController()
    active.set(entry.request.id, { controller, entry })
    const settle = () => {
      if (active.get(entry.request.id)?.controller === controller) active.delete(entry.request.id)
    }
    void handler({
      id: entry.request.id,
      operation: entry.request.operation,
      input: entry.request.input,
      trustedActorSubject: entry.trustedActorSubject,
    }).then(
      (response) => {
        if (controller.signal.aborted) return
        settle()
        reply(entry.generation, response)
      },
      () => {
        if (controller.signal.aborted) return
        settle()
        reply(entry.generation, failed(entry.request.id, entry.request.operation))
      },
    ).finally(() => {
      settle()
    })
  }

  return {
    dispatch(
      generation: number,
      request: Exclude<DesktopTrustedRendererRequestV1, { operation: "lifecycle.prepareToClose" }>,
      trustedActorSubject?: string,
    ) {
      if (generation < currentGeneration) return
      advance(generation)
      dispatch({
        generation,
        request,
        deadlineAt: request.deadlineMs === undefined ? Number.POSITIVE_INFINITY : now() + request.deadlineMs,
        trustedActorSubject,
      })
    },
    reset(nextGeneration: number) {
      advance(nextGeneration)
    },
    cancel(id: string) {
      const entry = queued.get(id)
      if (entry) {
        queued.delete(id)
        reply(entry.generation, cancelled(id, entry.request.operation))
        return
      }
      const current = active.get(id)
      if (!current) return
      cancelActive(id, current.controller)
      active.delete(id)
      reply(current.entry.generation, cancelled(id, current.entry.request.operation))
    },
    setRequestHandler(next: RequestHandler | undefined, onCancel?: RequestCancellationHandler) {
      if (!next) {
        handler = undefined
        cancelAll()
        cancelHandler = undefined
        return
      }
      handler = next
      cancelHandler = onCancel
      const entries = [...queued.values()]
      queued.clear()
      for (const entry of entries) dispatch(entry)
    },
  }
}
