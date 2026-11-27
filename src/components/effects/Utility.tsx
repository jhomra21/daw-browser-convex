import { createDefaultUtilityParams, UTILITY_GAIN_DB_MAX, UTILITY_GAIN_DB_MIN, type UtilityParams } from '@daw-browser/shared'
import EffectShell from '~/components/effects/EffectShell'
import { DeviceToggleButton } from '~/components/ui/device-control'
import AutomatedKnob from '~/components/effects/AutomatedKnob'
import { formatDeviceDb, formatDevicePercent } from '~/lib/device-value-format'

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
  return (
    <EffectShell title="Utility" typeLabel="Audio" enabled={props.params.enabled} onToggleEnabled={props.onToggleEnabled} onReset={props.onReset} class="w-[360px] min-w-[360px]">
      <div class="grid min-h-0 flex-1 grid-rows-[1fr_auto] gap-3 px-3 py-3">
        <div class="grid grid-cols-2 place-content-center gap-x-8 gap-y-4">
          <AutomatedKnob label="Gain" value={props.params.gainDb} valueLabel={formatDeviceDb(props.params.gainDb, 1)} resetValue={defaults.gainDb} min={UTILITY_GAIN_DB_MIN} max={UTILITY_GAIN_DB_MAX} step={0.1} bipolar disabled={!props.params.enabled} parameterId='utility.gainDb' automation={props} onValueChange={(gainDb) => props.onChange({ gainDb })} />
          <AutomatedKnob label="Balance" value={props.params.balance} valueLabel={`${Math.round(props.params.balance * 100)}`} resetValue={defaults.balance} min={-1} max={1} step={0.01} bipolar disabled={!props.params.enabled} parameterId='utility.balance' automation={props} onValueChange={(balance) => props.onChange({ balance })} />
          <AutomatedKnob label="Width" value={props.params.width} valueLabel={formatDevicePercent(props.params.width)} resetValue={defaults.width} min={0} max={2} step={0.01} disabled={!props.params.enabled} parameterId='utility.width' automation={props} onValueChange={(width) => props.onChange({ width })} />
        </div>
        <div class="grid grid-cols-3 gap-1 border-t border-border pt-3">
          <DeviceToggleButton label="Phase L" active={props.params.phaseLeft} onClick={() => props.onChange({ phaseLeft: !props.params.phaseLeft })} />
          <DeviceToggleButton label="Phase R" active={props.params.phaseRight} onClick={() => props.onChange({ phaseRight: !props.params.phaseRight })} />
          <DeviceToggleButton label="Stereo" active={props.params.inputMode === 'stereo'} onClick={() => props.onChange({ inputMode: 'stereo' })} />
          <DeviceToggleButton label="Mono" active={props.params.inputMode === 'mono-sum'} onClick={() => props.onChange({ inputMode: 'mono-sum' })} />
          <DeviceToggleButton label="L/R" active={props.params.matrix === 'stereo'} onClick={() => props.onChange({ matrix: 'stereo' })} />
          <DeviceToggleButton label="M/S Enc" active={props.params.matrix === 'mid-side-encode'} onClick={() => props.onChange({ matrix: 'mid-side-encode' })} />
          <DeviceToggleButton label="M/S Dec" active={props.params.matrix === 'mid-side-decode'} onClick={() => props.onChange({ matrix: 'mid-side-decode' })} />
          <DeviceToggleButton label="Swap" active={props.params.channelMode === 'swap'} onClick={() => props.onChange({ channelMode: props.params.channelMode === 'swap' ? 'both' : 'swap' })} />
          <DeviceToggleButton label="DC Block" active={props.params.dcBlock} onClick={() => props.onChange({ dcBlock: !props.params.dcBlock })} />
        </div>
      </div>
    </EffectShell>
  )
}
