import { createEffect, createSignal, on, untrack, type Accessor } from 'solid-js'

type UseTransportTempoControllerOptions = {
  bpm: Accessor<number>
  onChangeBpm: (next: number) => void
}

type UseTransportTempoControllerReturn = {
  tempoDraft: Accessor<string>
  setTempoDraft: (value: string) => void
  tempoEditing: Accessor<boolean>
  setTempoEditing: (value: boolean) => void
  commitTempo: () => void
  beginTempoDrag: (event: PointerEvent) => void
  updateTempoDrag: (event: PointerEvent) => void
  endTempoDrag: (event: PointerEvent) => void
}

export function useTransportTempoController(
  options: UseTransportTempoControllerOptions,
): UseTransportTempoControllerReturn {
  const [tempoDraft, setTempoDraft] = createSignal(String(options.bpm()))
  const [tempoEditing, setTempoEditing] = createSignal(false)
  const [tempoDragActive, setTempoDragActive] = createSignal(false)
  let tempoDragStartY = 0
  let tempoDragStartValue = 0

  createEffect(on(options.bpm, (value) => {
    if (!untrack(() => tempoEditing())) {
      setTempoDraft(String(value))
    }
  }))

  const sanitizeTempo = (value: number) => {
    if (!Number.isFinite(value)) return options.bpm()
    return Math.min(300, Math.max(30, Math.round(value)))
  }

  const commitTempo = () => {
    const raw = tempoDraft().trim()
    if (!raw) {
      setTempoDraft(String(options.bpm()))
      return
    }
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) {
      setTempoDraft(String(options.bpm()))
      return
    }
    const sanitized = sanitizeTempo(parsed)
    setTempoDraft(String(sanitized))
    if (sanitized !== options.bpm()) {
      options.onChangeBpm(sanitized)
    }
  }

  const beginTempoDrag = (event: PointerEvent) => {
    const target = event.currentTarget
    if (!(target instanceof HTMLInputElement) || tempoDragActive()) return
    const parsedDraft = Number(tempoDraft())
    tempoDragStartValue = Number.isFinite(parsedDraft) ? sanitizeTempo(parsedDraft) : options.bpm()
    tempoDragStartY = event.clientY
    setTempoDragActive(true)
    setTempoEditing(true)
    try {
      target.setPointerCapture(event.pointerId)
    } catch {}
    target.classList.add('cursor-ns-resize')
  }

  const updateTempoDrag = (event: PointerEvent) => {
    if (!tempoDragActive()) return
    event.preventDefault()
    const deltaY = tempoDragStartY - event.clientY
    const sensitivity = event.shiftKey ? 0.2 : 0.8
    const next = sanitizeTempo(tempoDragStartValue + deltaY * sensitivity)
    if (next === options.bpm()) return
    setTempoDraft(String(next))
    options.onChangeBpm(next)
  }

  const endTempoDrag = (event: PointerEvent) => {
    if (!tempoDragActive()) return
    const target = event.currentTarget
    if (target instanceof HTMLInputElement) {
      try {
        target.releasePointerCapture(event.pointerId)
      } catch {}
      target.classList.remove('cursor-ns-resize')
    }
    setTempoDragActive(false)
    commitTempo()
    setTempoEditing(false)
  }

  return {
    tempoDraft,
    setTempoDraft,
    tempoEditing,
    setTempoEditing,
    commitTempo,
    beginTempoDrag,
    updateTempoDrag,
    endTempoDrag,
  }
}
