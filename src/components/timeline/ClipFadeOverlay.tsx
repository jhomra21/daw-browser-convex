import { createMemo, createSignal, onCleanup, Show, type Accessor, type Component } from 'solid-js'

import { fadeGainAtClipTime, getClipFadeBezierControlPoint, normalizeClipFades, type ClipFades, type NormalizedClipFades } from '@daw-browser/timeline-core/clip-fades'
import {
  canStartFadeInteraction,
  relatedTargetStaysWithinFadeHoverRegion,
  type FadeInteractionMode,
  updateFadeDraft,
} from './clip-fade-interaction'

type ClipFadeOverlayProps = {
  clip: { duration: number; fades?: ClipFades; midi?: unknown }
  canEdit: Accessor<boolean>
  onCommit: (fades: ClipFades, baseline: ClipFades) => void
}

const ClipFadeOverlay: Component<ClipFadeOverlayProps> = (props) => {
  const [dragging, setDragging] = createSignal(false)
  const [draftFades, setDraftFades] = createSignal<NormalizedClipFades>()
  const [hoveredSide, setHoveredSide] = createSignal<'fadeIn' | 'fadeOut'>()
  let overlay: HTMLDivElement | undefined
  let active:
    | { pointerId: number; captureTarget: Element; side: 'fadeIn' | 'fadeOut'; mode: FadeInteractionMode; width: number; height: number; baseline: NormalizedClipFades }
    | undefined

  const currentFades = createMemo(() => (
    draftFades() ?? normalizeClipFades(props.clip.fades, props.clip.duration)
  ))
  const clear = (commit: boolean) => {
    const interaction = active
    const finalFades = interaction ? draftFades() ?? interaction.baseline : undefined
    active = undefined
    setDragging(false)
    setDraftFades()
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up, true)
    window.removeEventListener('pointercancel', cancel, true)
    window.removeEventListener('blur', cancel)
    if (interaction) {
      try {
        if (interaction.captureTarget.hasPointerCapture(interaction.pointerId)) {
          interaction.captureTarget.releasePointerCapture(interaction.pointerId)
        }
      } catch {}
    }
    if (!interaction) return
    if (commit && finalFades) props.onCommit(finalFades, interaction.baseline)
  }
  const move = (event: PointerEvent) => {
    if (!active || event.pointerId !== active.pointerId) return
    event.preventDefault()
    setDraftFades(updateFadeDraft({
      baseline: active.baseline,
      side: active.side,
      mode: active.mode,
      duration: props.clip.duration,
      overlayWidth: active.width,
      overlayHeight: active.height,
      currentX: event.clientX - (overlay?.getBoundingClientRect().left ?? 0),
      currentY: event.clientY - (overlay?.getBoundingClientRect().top ?? 0),
    }))
  }
  const up = (event: PointerEvent) => {
    if (!active || event.pointerId !== active.pointerId) return
    clear(true)
  }
  const cancel = () => clear(false)
  onCleanup(() => clear(false))

  const begin = (side: 'fadeIn' | 'fadeOut', mode: FadeInteractionMode, event: PointerEvent) => {
    const width = overlay?.clientWidth ?? 0
    const height = overlay?.clientHeight ?? 0
    if (!canStartFadeInteraction({
      canEdit: props.canEdit(),
      isMidi: Boolean(props.clip.midi),
      button: event.button,
      mode,
      overlayWidth: width,
      overlayHeight: height,
    })) return
    const target = event.currentTarget
    if (!(target instanceof Element)) return
    event.preventDefault()
    event.stopPropagation()
    const baseline = currentFades()
    active = {
      pointerId: event.pointerId,
      captureTarget: target,
      side,
      mode,
      width,
      height,
      baseline,
    }
    try {
      target.setPointerCapture(event.pointerId)
    } catch {}
    setDragging(true)
    setDraftFades(baseline)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up, true)
    window.addEventListener('pointercancel', cancel, true)
    window.addEventListener('blur', cancel)
  }

  const point = (time: number) => (time / Math.max(props.clip.duration, 0.000001)) * 100
  const path = (side: 'fadeIn' | 'fadeOut') => {
    const fades = currentFades()
    const start = side === 'fadeIn'
      ? fades.fadeInStartSec
      : props.clip.duration - fades.fadeOutSec
    const end = side === 'fadeIn'
      ? fades.fadeInSec
      : props.clip.duration - fades.fadeOutEndSec
    if (end <= start) return ''
    const parts: string[] = []
    for (let index = 0; index <= 16; index += 1) {
      const time = start + ((end - start) * index) / 16
      const isolated = side === 'fadeIn'
        ? { ...fades, fadeOutSec: 0, fadeOutEndSec: 0 }
        : { ...fades, fadeInStartSec: 0, fadeInSec: 0 }
      const gain = fadeGainAtClipTime(isolated, props.clip.duration, time)
      parts.push(`${index === 0 ? 'M' : 'L'} ${point(time)} ${100 - gain * 100}`)
    }
    return parts.join(' ')
  }
  const fadePaths = createMemo(() => ({
    fadeIn: path('fadeIn'),
    fadeOut: path('fadeOut'),
  }))
  const endpointPosition = (mode: Exclude<FadeInteractionMode, 'curve'>) => {
    const fades = currentFades()
    if (mode === 'fadeInStart') return point(fades.fadeInStartSec)
    if (mode === 'fadeInEnd') return point(fades.fadeInSec)
    if (mode === 'fadeOutStart') return point(props.clip.duration - fades.fadeOutSec)
    return point(props.clip.duration - fades.fadeOutEndSec)
  }
  const curvePosition = (side: 'fadeIn' | 'fadeOut') => {
    const control = getClipFadeBezierControlPoint(currentFades(), props.clip.duration, side)
    return { left: `${point(control.x)}%`, top: `${100 - control.y * 100}%` }
  }
  const showCurveHandle = (side: 'fadeIn' | 'fadeOut') => {
    return hoveredSide() === side || (active?.side === side && active.mode === 'curve')
  }
  const clearHoverOnExit = (side: 'fadeIn' | 'fadeOut', event: PointerEvent) => {
    if (!relatedTargetStaysWithinFadeHoverRegion(side, event.relatedTarget)) {
      setHoveredSide()
    }
  }

  return (
    <Show when={!props.clip.midi}>
      <div
        ref={(element) => { overlay = element }}
        class="pointer-events-none absolute inset-0 z-30 opacity-0 group-hover:opacity-100"
        classList={{ 'opacity-100': dragging() }}
      >
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" class="absolute inset-0 size-full overflow-visible">
          <path d={fadePaths().fadeIn} fill="none" stroke="currentColor" stroke-width="1.5" vector-effect="non-scaling-stroke" class="text-foreground/80 pointer-events-none" />
          <path d={fadePaths().fadeOut} fill="none" stroke="currentColor" stroke-width="1.5" vector-effect="non-scaling-stroke" class="text-foreground/80 pointer-events-none" />
          <Show when={props.canEdit()}>
            <path d={fadePaths().fadeIn} fill="none" stroke="transparent" stroke-width="12" vector-effect="non-scaling-stroke" class="pointer-events-auto cursor-pointer touch-none" data-fade-hover-side="fadeIn" on:pointerenter={() => setHoveredSide('fadeIn')} on:pointerleave={(event) => clearHoverOnExit('fadeIn', event)} />
            <path d={fadePaths().fadeOut} fill="none" stroke="transparent" stroke-width="12" vector-effect="non-scaling-stroke" class="pointer-events-auto cursor-pointer touch-none" data-fade-hover-side="fadeOut" on:pointerenter={() => setHoveredSide('fadeOut')} on:pointerleave={(event) => clearHoverOnExit('fadeOut', event)} />
          </Show>
        </svg>
        <Show when={props.canEdit()}>
          <button
            type="button"
            aria-label="Adjust fade in start"
            class="pointer-events-auto absolute bottom-0 z-40 size-4 -translate-x-1/2 translate-y-1/2 cursor-ew-resize rounded-full bg-transparent touch-none"
            style={{ left: `${endpointPosition('fadeInStart')}%` }}
            on:pointerdown={(event) => begin('fadeIn', 'fadeInStart', event)}
          >
            <span class="absolute left-1/2 top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground pointer-events-none" />
          </button>
          <button
            type="button"
            aria-label="Adjust fade in end"
            class="pointer-events-auto absolute top-0 z-40 size-4 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize rounded-full bg-transparent touch-none"
            style={{ left: `${endpointPosition('fadeInEnd')}%` }}
            on:pointerdown={(event) => begin('fadeIn', 'fadeInEnd', event)}
          >
            <span class="absolute left-1/2 top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground pointer-events-none" />
          </button>
          <button
            type="button"
            aria-label="Adjust fade out start"
            class="pointer-events-auto absolute top-0 z-40 size-4 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize rounded-full bg-transparent touch-none"
            style={{ left: `${endpointPosition('fadeOutStart')}%` }}
            on:pointerdown={(event) => begin('fadeOut', 'fadeOutStart', event)}
          >
            <span class="absolute left-1/2 top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground pointer-events-none" />
          </button>
          <button
            type="button"
            aria-label="Adjust fade out end"
            class="pointer-events-auto absolute bottom-0 z-40 size-4 -translate-x-1/2 translate-y-1/2 cursor-ew-resize rounded-full bg-transparent touch-none"
            style={{ left: `${endpointPosition('fadeOutEnd')}%` }}
            on:pointerdown={(event) => begin('fadeOut', 'fadeOutEnd', event)}
          >
            <span class="absolute left-1/2 top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground pointer-events-none" />
          </button>
          <Show when={showCurveHandle('fadeIn')}>
            <button
              type="button"
              aria-label="Adjust fade in curve"
              class="pointer-events-auto absolute z-40 size-4 -translate-x-1/2 -translate-y-1/2 cursor-move rounded-full bg-transparent touch-none"
              style={curvePosition('fadeIn')}
              data-fade-hover-side="fadeIn"
              on:pointerenter={() => setHoveredSide('fadeIn')}
              on:pointerleave={(event) => clearHoverOnExit('fadeIn', event)}
              on:pointerdown={(event) => begin('fadeIn', 'curve', event)}
            >
              <span class="absolute left-1/2 top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-foreground bg-timeline-background pointer-events-none" />
            </button>
          </Show>
          <Show when={showCurveHandle('fadeOut')}>
            <button
              type="button"
              aria-label="Adjust fade out curve"
              class="pointer-events-auto absolute z-40 size-4 -translate-x-1/2 -translate-y-1/2 cursor-move rounded-full bg-transparent touch-none"
              style={curvePosition('fadeOut')}
              data-fade-hover-side="fadeOut"
              on:pointerenter={() => setHoveredSide('fadeOut')}
              on:pointerleave={(event) => clearHoverOnExit('fadeOut', event)}
              on:pointerdown={(event) => begin('fadeOut', 'curve', event)}
            >
              <span class="absolute left-1/2 top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-foreground bg-timeline-background pointer-events-none" />
            </button>
          </Show>
        </Show>
      </div>
    </Show>
  )
}

export default ClipFadeOverlay
