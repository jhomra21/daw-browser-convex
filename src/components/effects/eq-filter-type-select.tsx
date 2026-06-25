import { For } from 'solid-js'
import type { EqBandParams, EqBandType } from '@daw-browser/shared'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu'
import { cn } from '~/lib/utils'

type EqFilterTypeOption = {
  value: EqBandType
  label: string
  path: string
}

const EQ_FILTER_TYPE_OPTIONS: EqFilterTypeOption[] = [
  { value: 'lowpass', label: 'Low Pass', path: 'M2 4 H17 C22 4 22 12 30 12' },
  { value: 'highpass', label: 'High Pass', path: 'M2 12 C10 12 10 4 15 4 H30' },
  { value: 'bandpass', label: 'Band Pass', path: 'M2 12 C8 12 9 4 16 4 C23 4 24 12 30 12' },
  { value: 'notch', label: 'Notch', path: 'M2 4 H12 C14 4 14 12 16 12 C18 12 18 4 20 4 H30' },
  { value: 'lowshelf', label: 'Low Shelf', path: 'M2 10 H10 C15 10 15 5 20 5 H30' },
  { value: 'highshelf', label: 'High Shelf', path: 'M2 5 H12 C17 5 17 10 22 10 H30' },
  { value: 'peaking', label: 'Peaking', path: 'M2 10 C8 10 10 5 16 5 C22 5 24 10 30 10' },
  { value: 'allpass', label: 'All Pass', path: 'M2 8 H30' },
]

const eqFilterTypeOption = (type: EqBandType) =>
  EQ_FILTER_TYPE_OPTIONS.find((option) => option.value === type) ?? EQ_FILTER_TYPE_OPTIONS[6]

function EqFilterTypeIcon(props: { type: EqBandType; active: boolean; class?: string }) {
  return (
    <svg viewBox="0 0 32 16" class={cn('h-4 w-8', props.class)} aria-hidden="true">
      <path
        d={eqFilterTypeOption(props.type).path}
        fill="none"
        stroke={props.active ? '#67e8f9' : '#737373'}
        stroke-width="2"
      />
    </svg>
  )
}

type EqFilterTypeSelectProps = {
  band: EqBandParams
  enabled: boolean
  selected?: boolean
  onSelectBand: () => void
  onTypeChange: (type: EqBandType) => void
}

export default function EqFilterTypeSelect(props: EqFilterTypeSelectProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        class={cn(
          'flex h-4 w-full items-center justify-between border border-neutral-700 bg-neutral-800 px-1 text-neutral-300',
          props.selected && 'border-cyan-400 bg-cyan-500/15 text-cyan-200',
          !props.enabled && 'cursor-not-allowed opacity-60',
          props.enabled && !props.band.enabled && 'opacity-60',
        )}
        disabled={!props.enabled}
        onClick={props.onSelectBand}
        title={`${eqFilterTypeOption(props.band.type).label} filter`}
      >
        <EqFilterTypeIcon type={props.band.type} active={props.band.enabled} class="h-2.5 w-6" />
        <svg viewBox="0 0 8 8" class="h-1.5 w-1.5 shrink-0 text-neutral-400" aria-hidden="true">
          <path d="M1 3 L4 6 L7 3 Z" fill="currentColor" />
        </svg>
      </DropdownMenuTrigger>
      <DropdownMenuContent class="w-max min-w-28 border-neutral-700 bg-neutral-900 p-1">
        <For each={EQ_FILTER_TYPE_OPTIONS}>
          {(option) => (
            <DropdownMenuItem
              class={cn(
                'h-7 cursor-pointer gap-2 px-2 py-1 text-xs text-neutral-200 focus:bg-neutral-800 focus:text-neutral-50',
                option.value === props.band.type && 'bg-cyan-500/20 text-cyan-100',
              )}
              disabled={!props.enabled || !props.band.enabled}
              onSelect={() => {
                props.onSelectBand()
                if (option.value !== props.band.type) props.onTypeChange(option.value)
              }}
            >
              <EqFilterTypeIcon type={option.value} active={option.value === props.band.type} />
              <span class="min-w-0 flex-1 truncate">{option.label}</span>
            </DropdownMenuItem>
          )}
        </For>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
