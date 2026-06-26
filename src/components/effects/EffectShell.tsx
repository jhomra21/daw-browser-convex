import { Show, type JSX } from 'solid-js'
import { cn } from '~/lib/utils'

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
  children: JSX.Element
}

export default function EffectShell(props: EffectShellProps) {
  const hasActions = () => props.actionsBeforeReset || props.onReset || props.onToggleEnabled

  return (
    <div class={cn('flex h-full flex-col border border-neutral-800 bg-neutral-900 text-neutral-100', props.class)}>
      <div class="flex items-stretch justify-between border-b border-neutral-800 px-2 py-1">
        <div class="flex min-w-0 items-center gap-2">
          <span class="truncate text-xs font-semibold">{props.title}</span>
          <Show when={props.typeLabel}>
            <span class="shrink-0 text-[10px] text-neutral-500">{props.typeLabel}</span>
          </Show>
          {props.titleActions}
        </div>
        <Show when={hasActions()}>
          <div class="-my-1 -mr-2 flex shrink-0 items-stretch border-l border-neutral-800">
            {props.actionsBeforeReset}
            <Show when={props.onReset} keyed>
              {(onReset) => (
                <button
                  class="bg-transparent px-2 text-xs text-neutral-300 hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={props.disabled}
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
                    'flex w-9 items-center justify-center border-l border-neutral-800 text-xs disabled:cursor-not-allowed disabled:opacity-50',
                    props.enabled
                      ? 'bg-cyan-500/10 text-cyan-300 hover:bg-cyan-500/15'
                      : 'bg-transparent text-neutral-400 hover:bg-neutral-800',
                  )}
                  disabled={props.disabled}
                  onClick={() => onToggleEnabled(!props.enabled)}
                  title={props.enabled ? `Disable ${props.title}` : `Enable ${props.title}`}
                >
                  {props.enabled ? 'On' : 'Off'}
                </button>
              )}
            </Show>
          </div>
        </Show>
      </div>

      {props.children}
    </div>
  )
}
