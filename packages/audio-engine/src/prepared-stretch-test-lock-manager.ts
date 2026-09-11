import type { PreparedStretchArtifactLockManager } from './prepared-stretch-store'

type LockMode = 'shared' | 'exclusive'
type PendingRequest = {
  mode: LockMode
  run: () => Promise<void>
}
type LockState = {
  name: string
  shared: number
  exclusive: boolean
  queue: PendingRequest[]
}

const states = new Map<string, LockState>()

const canStart = (state: LockState, mode: LockMode) => (
  !state.exclusive
  && (mode === 'shared' || state.shared === 0)
)

const drain = (state: LockState) => {
  if (state.exclusive || state.queue.length === 0) return
  const first = state.queue[0]
  if (first?.mode === 'exclusive') {
    if (state.shared > 0) return
    state.queue.shift()
    state.exclusive = true
    void first.run().finally(() => {
      state.exclusive = false
      drain(state)
    })
    return
  }
  while (state.queue[0]?.mode === 'shared' && !state.exclusive) {
    const request = state.queue.shift()
    if (!request) break
    state.shared += 1
    void request.run().finally(() => {
      state.shared -= 1
      drain(state)
    })
  }
}

export const preparedStretchTestLockManager: PreparedStretchArtifactLockManager = {
  request: <Value>(
    name: string,
    options: { ifAvailable?: boolean; mode?: 'shared' | 'exclusive' },
    callback: (lock: { name: string } | null) => Promise<Value>,
  ) => {
    const mode = options.mode ?? 'exclusive'
    const state = states.get(name) ?? { name, shared: 0, exclusive: false, queue: [] }
    states.set(name, state)
    if (options.ifAvailable === true && (
      !canStart(state, mode) || state.queue.length > 0
    )) return callback(null)
    let value: Value
    const completion = new Promise<void>((resolve, reject) => {
      state.queue.push({
        mode,
        run: async () => {
          try {
            value = await callback({ name })
            resolve()
          } catch (error) {
            reject(error)
          }
        },
      })
      drain(state)
    })
    return completion.then(() => value).finally(() => {
      if (state.shared === 0 && !state.exclusive && state.queue.length === 0) states.delete(name)
    })
  },
}
