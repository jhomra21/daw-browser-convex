import { cn } from '~/lib/utils'

type DeviceToggleButtonProps = {
  label: string
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
        'whitespace-nowrap border border-neutral-700 px-1 py-1 text-center text-2xs font-medium leading-none disabled:cursor-not-allowed disabled:opacity-50',
        props.active ? 'bg-amber-400 text-neutral-950' : 'bg-neutral-700 text-neutral-200',
        props.class,
      )}
      disabled={props.disabled}
      aria-pressed={props.active === true}
      onClick={props.onClick}
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
    <div class={cn('flex overflow-hidden border border-neutral-700 bg-neutral-300 font-mono text-2xs leading-none text-neutral-950', props.class)}>
      <div class={cn('min-w-0 flex-1 overflow-hidden whitespace-nowrap bg-orange-400 px-1 py-1', props.valueClass)}>{props.value}</div>
      <div class="w-2 shrink-0" />
    </div>
  )
}
