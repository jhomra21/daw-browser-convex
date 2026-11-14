import type { AudioEffectRuntimeInstance } from './effects/runtime-instance'

type Install<Result> = (instances: AudioEffectRuntimeInstance[]) => Promise<Result>

// The one way an effect chain reaches an install, for the track and master runtimes. It keeps the chain last asked for
// (the intent) apart from the work installing it, so the two cannot be mistaken for each other:
// - a request with nothing to install it on (no audio context) records the intent and is never install work;
// - an equal request joins work that is still running, and only that: finished work leaves no slot behind;
// - a context replay and an ordinary request take the same path, so they join each other instead of installing twice.
// `joined` maps the result of the work a request joined to that request's own result.
export function createChainAdmission<Result>(joined: (underlying: Result) => Result) {
  let intent: AudioEffectRuntimeInstance[] | undefined
  let awaitingContext = false
  let work: { id: number; key: string; promise: Promise<Result> } | undefined
  let lastWorkId = 0

  const admit = (instances: AudioEffectRuntimeInstance[], install: Install<Result> | undefined, dropped: Result): Promise<Result> => {
    const key = JSON.stringify(instances)
    intent = instances
    if (!install) {
      awaitingContext = true
      work = undefined
      return Promise.resolve(dropped)
    }
    awaitingContext = false
    if (work?.key === key) return work.promise.then(joined)
    const id = ++lastWorkId
    const run = async () => {
      try {
        return await install(instances)
      } finally {
        if (work?.id === id) work = undefined
      }
    }
    const promise = run()
    work = { id, key, promise }
    return promise
  }

  return {
    admit,
    // The chain last asked for, whether or not it is installed, failed or superseded.
    intent: (): readonly AudioEffectRuntimeInstance[] | undefined => intent,
    // Takes the intent over without asking for an install: the runtime changed the chain itself (a faulted effect left it).
    adopt: (instances: AudioEffectRuntimeInstance[]) => {
      intent = instances
    },
    // Starts the install of a chain that was asked for while there was no context. Undefined when nothing waits.
    replay: (install: Install<Result>, dropped: Result): Promise<Result> | undefined => (
      awaitingContext && intent ? admit(intent, install, dropped) : undefined
    ),
    reset: () => {
      intent = undefined
      awaitingContext = false
      work = undefined
    },
  }
}
