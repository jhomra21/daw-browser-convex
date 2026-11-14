import { createContext, createEffect, on, onCleanup, useContext, type JSX } from 'solid-js'
import { ParameterGestureHolder, type ParameterGestureHandle } from '~/components/timeline/parameter-gesture-owner'

// One interaction model for every device control: a control opens a gesture on its owner, ticks values while it
// lasts and ends it. The owner is the only holder of "open", so a control asks it and never keeps its own copy.
const ParameterGestureContext = createContext<ParameterGestureHandle>()

export function ParameterGestureProvider(props: { owner: ParameterGestureHandle, children: JSX.Element }) {
  return (
    <ParameterGestureContext.Provider value={props.owner}>
      {props.children}
    </ParameterGestureContext.Provider>
  )
}

export function useParameterGesture(options: { idleMs?: number, onClosed?: () => void } = {}) {
  const owner = useContext(ParameterGestureContext)
  const holder = new ParameterGestureHolder()
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  const stopIdle = () => {
    clearTimeout(idleTimer)
    idleTimer = undefined
  }
  const isOpen = () => owner?.isOpen(holder) ?? false
  const open = () => owner?.open(holder)
  const end = () => {
    stopIdle()
    owner?.end(holder)
  }
  const cancel = () => {
    stopIdle()
    owner?.cancel(holder)
  }
  // The value is written inside the owner's tick, so a holder the owner no longer knows writes nothing. The wheel's
  // deadline is re-armed on every accepted tick, cleared by end/cancel and on cleanup.
  const tick = (emit: () => void) => {
    if (!owner) return emit()
    if (!owner.tick(holder, emit) || !options.idleMs) return
    stopIdle()
    idleTimer = setTimeout(end, options.idleMs)
  }
  const once = (emit: () => void) => {
    if (owner) owner.once(emit)
    else emit()
  }
  if (owner) {
    const { closed } = owner
    // An owner-side close ends this holder's wheel deadline through the same transition as end and cancel.
    createEffect(on(closed, () => {
      stopIdle()
      options.onClosed?.()
    }, { defer: true }))
  }
  onCleanup(end)
  return {
    owned: owner !== undefined,
    isOpen,
    open,
    tick,
    end,
    cancel,
    once,
  }
}

