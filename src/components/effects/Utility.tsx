import { createDefaultUtilityParams, type UtilityParams } from '@daw-browser/shared'
import EffectShell from '~/components/effects/EffectShell'
import { DeviceToggleButton } from '~/components/ui/device-control'
import Knob from '~/components/ui/knob'

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

export default function Utility(props: UtilityProps) {
  const automated = (id: string, updates: Partial<UtilityParams>) => {
    props.onManualAutomationOverride?.(id)
    props.onChange(updates)
  }
  return (
    <EffectShell title="Utility" typeLabel="Audio" enabled={props.params.enabled} onToggleEnabled={props.onToggleEnabled} onReset={props.onReset} class="w-[420px] min-w-[420px]">
      <div class="grid flex-1 grid-cols-[repeat(4,64px)_1fr] gap-2 px-3 py-2">
        <Knob label="Gain" value={props.params.gainDb} valueLabel={`${props.params.gainDb.toFixed(1)} dB`} resetValue={defaults.gainDb} min={-60} max={24} step={0.1} bipolar disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get('utility.gainDb')} automated={props.automationRangesByParameterId?.has('utility.gainDb')} onAutomationSelect={() => props.onAutomationParameterTouch?.('utility.gainDb')} onValueChange={(gainDb) => automated('utility.gainDb', { gainDb })} />
        <Knob label="Pan" value={props.params.pan} valueLabel={`${Math.round(props.params.pan * 100)}`} resetValue={defaults.pan} min={-1} max={1} step={0.01} bipolar disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get('utility.pan')} automated={props.automationRangesByParameterId?.has('utility.pan')} onAutomationSelect={() => props.onAutomationParameterTouch?.('utility.pan')} onValueChange={(pan) => automated('utility.pan', { pan })} />
        <Knob label="Balance" value={props.params.balance} valueLabel={`${Math.round(props.params.balance * 100)}`} resetValue={defaults.balance} min={-1} max={1} step={0.01} bipolar disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get('utility.balance')} automated={props.automationRangesByParameterId?.has('utility.balance')} onAutomationSelect={() => props.onAutomationParameterTouch?.('utility.balance')} onValueChange={(balance) => automated('utility.balance', { balance })} />
        <Knob label="Width" value={props.params.width} valueLabel={`${Math.round(props.params.width * 100)}%`} resetValue={defaults.width} min={0} max={2} step={0.01} disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get('utility.width')} automated={props.automationRangesByParameterId?.has('utility.width')} onAutomationSelect={() => props.onAutomationParameterTouch?.('utility.width')} onValueChange={(width) => automated('utility.width', { width })} />
        <div class="grid grid-cols-2 gap-1">
          <DeviceToggleButton label="Normal" active={props.params.polarity === 'normal'} onClick={() => props.onChange({ polarity: 'normal' })} />
          <DeviceToggleButton label="Invert" active={props.params.polarity === 'invert'} onClick={() => props.onChange({ polarity: 'invert' })} />
          <DeviceToggleButton label="Stereo" active={props.params.inputMode === 'stereo'} onClick={() => props.onChange({ inputMode: 'stereo' })} />
          <DeviceToggleButton label="Mono" active={props.params.inputMode === 'mono-sum'} onClick={() => props.onChange({ inputMode: 'mono-sum' })} />
          <DeviceToggleButton label="L/R" active={props.params.matrix === 'stereo'} onClick={() => props.onChange({ matrix: 'stereo' })} />
          <DeviceToggleButton label="M/S Enc" active={props.params.matrix === 'mid-side-encode'} onClick={() => props.onChange({ matrix: 'mid-side-encode' })} />
          <DeviceToggleButton label="M/S Dec" active={props.params.matrix === 'mid-side-decode'} onClick={() => props.onChange({ matrix: 'mid-side-decode' })} />
          <DeviceToggleButton label="Swap" active={props.params.swap} onClick={() => props.onChange({ swap: !props.params.swap })} />
          <DeviceToggleButton label="DC Block" active={props.params.dcBlock} onClick={() => props.onChange({ dcBlock: !props.params.dcBlock })} />
        </div>
      </div>
    </EffectShell>
  )
}
