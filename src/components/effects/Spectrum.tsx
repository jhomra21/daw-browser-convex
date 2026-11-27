import { SPECTRUM_BLOCK_SIZES, type SpectrumChannel, type SpectrumParams } from '@daw-browser/shared'
import type { SpectrumFrame } from '@daw-browser/audio-engine/audio-engine'
import EffectShell from '~/components/effects/EffectShell'
import SpectrumView, { SpectrumViewToggle } from '~/components/effects/SpectrumView'
import { ChoiceMenu, DeviceToggleButton } from '~/components/ui/device-control'

type SpectrumProps = {
  params: SpectrumParams
  frame: SpectrumFrame | null
  onChange: (updates: Partial<SpectrumParams>) => void
  onToggleEnabled: (enabled: boolean) => void
  onReset: () => void
}

const blockChoices = SPECTRUM_BLOCK_SIZES.map((size) => ({ value: size, label: String(size) }))

const channelChoices: readonly { value: SpectrumChannel; label: string }[] = [
  { value: 'both', label: 'L+R' },
  { value: 'left', label: 'Left' },
  { value: 'right', label: 'Right' },
]

export default function Spectrum(props: SpectrumProps) {
  const off = () => !props.params.enabled

  return (
    <EffectShell title="Spectrum" typeLabel="Audio" enabled={props.params.enabled} onToggleEnabled={props.onToggleEnabled} onReset={props.onReset} class="w-96 min-w-96">
      <div class="flex min-h-0 flex-1 flex-col gap-2 px-3 py-3">
        <SpectrumViewToggle view={props.params.view} disabled={off()} onChange={(view) => props.onChange({ view })} />
        <div class="min-h-0 flex-1">
          <SpectrumView frame={props.params.enabled ? props.frame : null} view={props.params.view} maxHold={props.params.maxHold} />
        </div>
        <div class="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_3rem] items-end gap-2">
          <div class="flex flex-col gap-1">
            <span class="text-2xs text-muted-foreground">Block</span>
            <ChoiceMenu label="Block" choices={blockChoices} value={props.params.block} disabled={off()} onSelect={(block) => props.onChange({ block })} />
          </div>
          <div class="flex flex-col gap-1">
            <span class="text-2xs text-muted-foreground">Channel</span>
            <ChoiceMenu label="Channel" choices={channelChoices} value={props.params.channel} disabled={off()} onSelect={(channel) => props.onChange({ channel })} />
          </div>
          <DeviceToggleButton label="Max" ariaLabel="Max hold" active={props.params.maxHold} disabled={off()} onClick={() => props.onChange({ maxHold: !props.params.maxHold })} />
        </div>
      </div>
    </EffectShell>
  )
}
