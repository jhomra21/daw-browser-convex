import { Show, onCleanup, type JSX } from 'solid-js'
import { cn } from '~/lib/utils'
import {
  recognizeDeviceDoubleTap,
  cancelDeviceDoubleTapOnMove,
  devicePointerIdentity,
  useDeviceCollapseContext,
  type DeviceCollapseGesture,
} from '~/components/timeline/create-effects-panel-device-collapse'
import { isDeviceHeaderTarget, isDeviceInteractiveTarget } from '~/components/timeline/device-interaction'

type EffectShellProps = {
  title: string
  typeLabel?: string
  enabled?: boolean
  onToggleEnabled?: (enabled: boolean) => void
  onReset?: () => void
  disabled?: boolean
  class?: string
  titleActions?: JSX.Element
  actionsBeforeReset?: JSX.Element
  onPointerDown?: (event: PointerEvent) => void
  children: JSX.Element
}

export default function EffectShell(props: EffectShellProps) {
  const collapse = useDeviceCollapseContext()
  const collapsed = () => collapse?.collapsed() ?? false
  const hasActions = () => props.actionsBeforeReset || props.onReset || props.onToggleEnabled
  let lastTouchTap: DeviceCollapseGesture
  const contentId = () => collapse?.contentId()
  const canWrite = () => collapse?.canWrite() ?? true
  let touchPointerId: number | undefined
  let touchStart: { x: number; y: number } | undefined
  const clearTouchTracking = () => {
    window.removeEventListener('pointermove', handleTouchMove)
    window.removeEventListener('pointerup', clearTouchTracking)
    window.removeEventListener('pointercancel', clearTouchTracking)
    touchPointerId = undefined
    touchStart = undefined
  }
  const handleTouchMove = (event: PointerEvent) => {
    if (event.pointerId !== touchPointerId || !touchStart) return
    lastTouchTap = cancelDeviceDoubleTapOnMove(
      lastTouchTap,
      touchStart,
      { x: event.clientX, y: event.clientY },
    )
  }
  onCleanup(clearTouchTracking)
  const isDisabled = () => props.disabled || !canWrite()
  const toggleFromHeader = (event: PointerEvent) => {
    if (!collapse || event.pointerType === 'mouse' || !isDeviceHeaderTarget(event.target) || isDeviceInteractiveTarget(event.target)) return
    clearTouchTracking()
    touchPointerId = event.pointerId
    touchStart = { x: event.clientX, y: event.clientY }
    window.addEventListener('pointermove', handleTouchMove)
    window.addEventListener('pointerup', clearTouchTracking)
    window.addEventListener('pointercancel', clearTouchTracking)
    const result = recognizeDeviceDoubleTap(lastTouchTap, {
      identity: collapse.contentId(),
      at: performance.now(),
      x: event.clientX,
      y: event.clientY,
      pointerType: event.pointerType,
      deviceId: devicePointerIdentity({
        pointerType: event.pointerType,
        persistentDeviceId: (() => {
          const value = Reflect.get(event, 'persistentDeviceId')
          return typeof value === 'string' ? value : undefined
        })(),
      }),
    })
    lastTouchTap = result.next
    if (!result.recognized) return
    event.preventDefault()
    event.stopPropagation()
    collapse.toggle()
  }
  const toggleFromDoubleClick = (event: MouseEvent) => {
    if (!collapse || isDeviceInteractiveTarget(event.target)) return
    event.preventDefault()
    event.stopPropagation()
    collapse.toggle()
  }

  return (
    <div
      class={cn(
        'effect-shell flex h-full self-stretch flex-col overflow-hidden border border-border bg-app-surface text-foreground',
        props.class,
      )}
      data-device-collapsed={collapsed()}
      onPointerDown={(event) => props.onPointerDown?.(event)}
    >
      <div
        data-effect-shell-header="true"
        class="flex items-stretch justify-between border-b border-border"
        classList={{
          'px-2 py-1': !collapsed(),
          'h-full min-h-0 flex-col items-center justify-start gap-2': collapsed(),
        }}
        onPointerDown={toggleFromHeader}
        onDblClick={toggleFromDoubleClick}
      >
        <Show when={collapse}>
          <button
            type="button"
            data-device-interactive="true"
            class="effect-shell-chevron flex size-6 shrink-0 items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-cyan-300/70"
            classList={{
              '-my-1 -ml-2 border-r border-border': !collapsed(),
            }}
            aria-expanded={!collapsed()}
            aria-controls={contentId()}
            aria-label={collapsed() ? 'Unfold device' : 'Fold device'}
            title={collapsed() ? 'Unfold device' : 'Fold device'}
            onClick={(event) => {
              event.stopPropagation()
              collapse?.toggle()
            }}
          >
            <svg
              aria-hidden="true"
              class="effect-shell-chevron-icon size-3.5"
              viewBox="0 0 16 16"
              fill="none"
            >
              <path
                d="m6 3 5 5-5 5"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>
        </Show>
        <div
          class="flex min-w-0 items-center gap-2"
          classList={{
            'flex-1': !collapsed(),
            'min-h-0 flex-1 flex-col gap-1': collapsed(),
          }}
        >
          <span
            class="truncate text-xs font-semibold"
            classList={{ 'max-w-full [writing-mode:vertical-rl] rotate-180': collapsed() }}
          >
            {props.title}
          </span>
          <Show when={!collapsed() && props.typeLabel}>
            <span class="shrink-0 text-[10px] text-muted-foreground">{props.typeLabel}</span>
          </Show>
          <Show when={!collapsed()}>{props.titleActions}</Show>
        </div>
        <Show when={!collapsed() && hasActions()}>
          <div
            class="-my-1 -mr-2 flex shrink-0 items-stretch"
            classList={{ 'border-l border-border': Boolean(props.actionsBeforeReset || props.onReset) }}
            inert={!canWrite()}
          >
            {props.actionsBeforeReset}
            <Show when={props.onReset} keyed>
              {(onReset) => (
                <button
                  class="bg-transparent px-2 text-xs text-muted-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={isDisabled()}
                  onClick={() => onReset()}
                >
                  Reset
                </button>
              )}
            </Show>
            <Show when={props.onToggleEnabled} keyed>
              {(onToggleEnabled) => (
                <button
                  class={cn(
                    'flex w-9 items-center justify-center border-l border-border text-xs disabled:cursor-not-allowed disabled:opacity-50',
                    props.enabled
                      ? 'bg-cyan-500/10 text-cyan-300 hover:bg-cyan-500/15'
                      : 'bg-transparent text-muted-foreground hover:bg-muted',
                  )}
                  disabled={isDisabled()}
                  onClick={() => onToggleEnabled(!props.enabled)}
                  title={props.enabled ? `Disable ${props.title}` : `Enable ${props.title}`}
                >
                  {props.enabled ? 'On' : 'Off'}
                </button>
              )}
            </Show>
          </div>
        </Show>
        <Show when={collapsed() && props.onToggleEnabled} keyed>
          {(onToggleEnabled) => (
            <button
              type="button"
              data-device-interactive="true"
              class={cn(
                'flex min-h-6 min-w-6 shrink-0 items-center justify-center border-t border-border text-[10px] [writing-mode:vertical-rl] disabled:cursor-not-allowed disabled:opacity-50',
                props.enabled
                  ? 'bg-cyan-500/10 text-cyan-300'
                  : 'bg-transparent text-muted-foreground',
              )}
              disabled={isDisabled()}
              aria-label={props.enabled ? `Disable ${props.title}` : `Enable ${props.title}`}
              onClick={() => onToggleEnabled(!props.enabled)}
            >
              {props.enabled ? 'On' : 'Off'}
            </button>
          )}
        </Show>
      </div>

      <div
        id={contentId()}
        data-effect-shell-content="true"
        class="flex min-h-0 flex-1 flex-col"
        classList={{ 'pointer-events-none': !canWrite() }}
        hidden={collapsed()}
        inert={!canWrite()}
      >
        {props.children}
      </div>
    </div>
  )
}
