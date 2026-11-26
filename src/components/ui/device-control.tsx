import { For } from 'solid-js'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '~/components/ui/dropdown-menu'
import { cn } from '~/lib/utils'

type DeviceToggleButtonProps = {
  label: string
  ariaLabel?: string
  active?: boolean
  disabled?: boolean
  class?: string
  onClick: () => void
}

export function DeviceToggleButton(props: DeviceToggleButtonProps) {
  return (
    <button
      type="button"
      class={cn(
        'whitespace-nowrap border border-border px-1 py-1 text-center text-2xs font-medium leading-none disabled:cursor-not-allowed disabled:opacity-50',
        props.active ? 'bg-amber-400 text-black' : 'bg-secondary text-foreground',
        props.class,
      )}
      disabled={props.disabled}
      aria-pressed={props.active === true ? "true" : "false"}
      aria-label={props.ariaLabel}
      onClick={() => props.onClick()}
    >
      {props.label}
    </button>
  )
}

type DeviceValueStripProps = {
  value: string
  class?: string
  valueClass?: string
}

export function DeviceValueStrip(props: DeviceValueStripProps) {
  return (
    <div class={cn('flex overflow-hidden border border-border bg-muted-foreground font-mono text-2xs leading-none text-background', props.class)}>
      <div class={cn('min-w-0 flex-1 overflow-hidden whitespace-nowrap bg-orange-400 px-1 py-1', props.valueClass)}>{props.value}</div>
      <div class="w-2 shrink-0" />
    </div>
  )
}

type Choice<Value> = { value: Value; label: string }

// A drop-down that shows the current choice, like Ableton's chooser fields.
export function ChoiceMenu<Value extends string | number>(props: {
  label: string
  choices: readonly Choice<Value>[]
  value: Value
  disabled: boolean
  onSelect: (value: Value) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        class="flex h-5 w-full items-center justify-between gap-1 border border-border bg-muted px-1 text-2xs text-foreground disabled:cursor-not-allowed disabled:opacity-50"
        disabled={props.disabled}
        aria-label={props.label}
        title={props.label}
      >
        <span class="truncate">{props.choices.find((choice) => choice.value === props.value)?.label}</span>
        <svg viewBox="0 0 8 8" class="h-1.5 w-1.5 shrink-0 text-muted-foreground" aria-hidden="true"><path d="M1 3 L4 6 L7 3 Z" fill="currentColor" /></svg>
      </DropdownMenuTrigger>
      <DropdownMenuContent class="w-max min-w-24 border-border bg-app-surface p-1">
        <For each={props.choices}>
          {(choice) => (
            <DropdownMenuItem
              class={cn('h-6 cursor-pointer px-2 py-1 text-xs text-foreground focus:bg-muted focus:text-foreground', choice.value === props.value && 'bg-cyan-500/20 text-cyan-100')}
              onSelect={() => props.onSelect(choice.value)}
            >
              {choice.label}
            </DropdownMenuItem>
          )}
        </For>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
