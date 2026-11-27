import { Show } from 'solid-js'
import {
  createDefaultUtilityParams,
  UTILITY_BASS_MONO_HZ_MAX,
  UTILITY_BASS_MONO_HZ_MIN,
  UTILITY_GAIN_DB_MAX,
  UTILITY_GAIN_DB_MIN,
  type UtilityChannelMode,
  type UtilityMatrix,
  type UtilityParams,
} from '@daw-browser/shared'
import EffectShell from '~/components/effects/EffectShell'
import AutomatedKnob from '~/components/effects/AutomatedKnob'
import { ChoiceMenu, DeviceToggleButton } from '~/components/ui/device-control'
import { formatDeviceDb, formatDeviceFrequency, formatDevicePercent } from '~/lib/device-value-format'

type UtilityProps = {
  params: UtilityParams
  onChange: (updates: Partial<UtilityParams>) => void
  onToggleEnabled: (enabled: boolean) => void
  onReset: () => void
  automationRangesByParameterId?: ReadonlyMap<string, { min: number; max: number }>
  onAutomationParameterTouch?: (parameterId: string) => void
  onManualAutomationOverride?: (parameterId: string) => void
}

const defaults = createDefaultUtilityParams()

const CHANNEL_MODES: readonly { value: UtilityChannelMode; label: string }[] = [
  { value: 'both', label: 'Stereo' },
  { value: 'left', label: 'Left' },
  { value: 'right', label: 'Right' },
  { value: 'swap', label: 'Swap' },
]

const MATRICES: readonly { value: UtilityMatrix; label: string }[] = [
  { value: 'stereo', label: 'L/R' },
  { value: 'mid-side-encode', label: 'M/S Encode' },
  { value: 'mid-side-decode', label: 'M/S Decode' },
]

// A gain at the minimum is minus infinity: silence, as the kernel treats it.
const formatGain = (gainDb: number) => gainDb <= UTILITY_GAIN_DB_MIN ? '-inf dB' : formatDeviceDb(gainDb, 2, true)

const formatBalance = (balance: number) => {
  const percent = Math.round(Math.abs(balance) * 100)

  return percent === 0 ? 'C' : `${percent}${balance < 0 ? 'L' : 'R'}`
}

export default function Utility(props: UtilityProps) {
  const off = () => !props.params.enabled
  // Left and Right play one channel on both outputs, so Width and Mid/Side have nothing to act on.
  const widthActs = () => props.params.channelMode === 'both' || props.params.channelMode === 'swap'

  return (
    <EffectShell title="Utility" typeLabel="Audio" enabled={props.params.enabled} onToggleEnabled={props.onToggleEnabled} onReset={props.onReset} class="w-[420px] min-w-[420px]">
      <div class="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] gap-2 px-3 py-2">
        <section class="flex min-w-0 flex-col gap-1 border-r border-border pr-2" aria-label="Input">
          <h3 class="h-4 text-center text-xs font-semibold leading-none text-muted-foreground">Input</h3>
          <div class="grid grid-cols-2 gap-1">
            <DeviceToggleButton label="Ø L" ariaLabel="Phase L" active={props.params.phaseLeft} disabled={off()} onClick={() => props.onChange({ phaseLeft: !props.params.phaseLeft })} />
            <DeviceToggleButton label="Ø R" ariaLabel="Phase R" active={props.params.phaseRight} disabled={off()} onClick={() => props.onChange({ phaseRight: !props.params.phaseRight })} />
          </div>
          <ChoiceMenu label="Channel Mode" choices={CHANNEL_MODES} value={props.params.channelMode} disabled={off()} onSelect={(channelMode) => props.onChange({ channelMode })} />
          <ChoiceMenu label="Matrix" choices={MATRICES} value={props.params.matrix} disabled={off()} onSelect={(matrix) => props.onChange({ matrix })} />
          <DeviceToggleButton label="Mono" active={props.params.inputMode === 'mono-sum'} disabled={off()} onClick={() => props.onChange({ inputMode: props.params.inputMode === 'mono-sum' ? 'stereo' : 'mono-sum' })} />
        </section>

        <section class="flex min-w-0 flex-col items-center gap-1 border-r border-border pr-2" aria-label="Stereo">
          <h3 class="h-4 text-center text-xs font-semibold leading-none text-muted-foreground">Stereo</h3>
          <Show when={widthActs()}>
            <Show
              when={props.params.widthMode === 'mid-side'}
              fallback={
                <AutomatedKnob size={32} label="Width" valueLabel={formatDevicePercent(props.params.width)} value={props.params.width} resetValue={defaults.width} min={0} max={2} step={0.01} disabled={off()} parameterId="utility.width" automation={props} onValueChange={(width) => props.onChange({ width })} />
              }
            >
              <AutomatedKnob size={32} label="Mid/Side" valueLabel={formatDevicePercent(props.params.midSide)} value={props.params.midSide} resetValue={defaults.midSide} min={-1} max={1} step={0.01} bipolar disabled={off()} parameterId="utility.midSide" automation={props} onValueChange={(midSide) => props.onChange({ midSide })} />
            </Show>
            <DeviceToggleButton class="w-full" label="Mid/Side" ariaLabel="Mid/Side mode" active={props.params.widthMode === 'mid-side'} disabled={off()} onClick={() => props.onChange({ widthMode: props.params.widthMode === 'mid-side' ? 'stereo' : 'mid-side' })} />
          </Show>
          <DeviceToggleButton class="w-full" label="Bass Mono" active={props.params.bassMono} disabled={off()} onClick={() => props.onChange({ bassMono: !props.params.bassMono })} />
          {/* The crossover frequency and the audition of the lows exist only while Bass Mono is on. */}
          <Show when={props.params.bassMono}>
            <div class="flex w-full items-center justify-between gap-1">
              <AutomatedKnob size={24} label="Freq" ariaLabel="Bass Mono Frequency" valueLabel={formatDeviceFrequency(props.params.bassMonoHz, 0)} value={props.params.bassMonoHz} resetValue={defaults.bassMonoHz} min={UTILITY_BASS_MONO_HZ_MIN} max={UTILITY_BASS_MONO_HZ_MAX} step={1} logarithmic disabled={off()} parameterId="utility.bassMonoHz" automation={props} onValueChange={(bassMonoHz) => props.onChange({ bassMonoHz })} />
              <DeviceToggleButton label="Audition" ariaLabel="Audition Bass Mono" active={props.params.bassMonoAudition} disabled={off()} onClick={() => props.onChange({ bassMonoAudition: !props.params.bassMonoAudition })} />
            </div>
          </Show>
        </section>

        <section class="flex min-w-0 flex-col items-center gap-1" aria-label="Output">
          <h3 class="h-4 text-center text-xs font-semibold leading-none text-muted-foreground">Output</h3>
          <AutomatedKnob size={32} label="Gain" valueLabel={formatGain(props.params.gainDb)} value={props.params.gainDb} resetValue={defaults.gainDb} min={UTILITY_GAIN_DB_MIN} max={UTILITY_GAIN_DB_MAX} step={0.1} bipolar disabled={off()} parameterId="utility.gainDb" automation={props} onValueChange={(gainDb) => props.onChange({ gainDb })} />
          <AutomatedKnob size={32} label="Balance" valueLabel={formatBalance(props.params.balance)} value={props.params.balance} resetValue={defaults.balance} min={-1} max={1} step={0.01} bipolar disabled={off()} parameterId="utility.balance" automation={props} onValueChange={(balance) => props.onChange({ balance })} />
          <div class="mt-auto grid w-full grid-cols-2 gap-1">
            <DeviceToggleButton label="Mute" active={props.params.mute} disabled={off()} onClick={() => props.onChange({ mute: !props.params.mute })} />
            <DeviceToggleButton label="DC" ariaLabel="DC Block" active={props.params.dcBlock} disabled={off()} onClick={() => props.onChange({ dcBlock: !props.params.dcBlock })} />
          </div>
        </section>
      </div>
    </EffectShell>
  )
}
