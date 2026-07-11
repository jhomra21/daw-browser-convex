import { createDefaultLoFiParams, type LoFiParams } from '@daw-browser/shared'
import EffectShell from '~/components/effects/EffectShell'
import { DeviceToggleButton } from '~/components/ui/device-control'
import Knob from '~/components/ui/knob'

type LoFiProps = {
  params: LoFiParams
  onChange: (updates: Partial<LoFiParams>) => void
  onToggleEnabled: (enabled: boolean) => void
  onReset: () => void
  automationRangesByParameterId?: ReadonlyMap<string, { min: number; max: number }>
  onAutomationParameterTouch?: (parameterId: string) => void
  onManualAutomationOverride?: (parameterId: string) => void
}

const defaults = createDefaultLoFiParams()

export default function LoFi(props: LoFiProps) {
  const knob = (label: string, id: string, value: number, resetValue: number, min: number, max: number, step: number, valueLabel: string, update: (value: number) => Partial<LoFiParams>) => (
    <Knob label={label} value={value} valueLabel={valueLabel} resetValue={resetValue} min={min} max={max} step={step} disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get(id)} automated={props.automationRangesByParameterId?.has(id)} onAutomationSelect={() => props.onAutomationParameterTouch?.(id)} onValueChange={(next) => { props.onManualAutomationOverride?.(id); props.onChange(update(next)) }} />
  )
  return <EffectShell title="LoFi" typeLabel="Digital Degradation" enabled={props.params.enabled} onToggleEnabled={props.onToggleEnabled} onReset={props.onReset} class="w-[560px] min-w-[560px]"><div class="flex flex-1 gap-3 px-3 py-2">
    <div class="grid grid-cols-5 gap-2">
      {knob('Bits', 'lofi.bitDepth', props.params.bitDepth, defaults.bitDepth, 2, 24, 1, `${props.params.bitDepth} bit`, (bitDepth) => ({ bitDepth }))}
      {knob('Rate', 'lofi.sampleRateRatio', props.params.sampleRateRatio, defaults.sampleRateRatio, 0.01, 1, 0.01, `${Math.round(props.params.sampleRateRatio * 100)}%`, (sampleRateRatio) => ({ sampleRateRatio }))}
      {knob('Jitter', 'lofi.jitter', props.params.jitter, defaults.jitter, 0, 1, 0.01, `${Math.round(props.params.jitter * 100)}%`, (jitter) => ({ jitter }))}
      {knob('Noise', 'lofi.noiseDb', props.params.noiseDb, defaults.noiseDb, -120, -24, 1, `${props.params.noiseDb} dB`, (noiseDb) => ({ noiseDb }))}
      {knob('Mix', 'lofi.mix', props.params.mix, defaults.mix, 0, 1, 0.01, `${Math.round(props.params.mix * 100)}%`, (mix) => ({ mix }))}
    </div>
    <div class="grid w-24 grid-cols-1 gap-1 content-start">
      <DeviceToggleButton label="Round" active={props.params.quantization === 'round'} disabled={!props.params.enabled} onClick={() => props.onChange({ quantization: 'round' })} />
      <DeviceToggleButton label="Floor" active={props.params.quantization === 'floor'} disabled={!props.params.enabled} onClick={() => props.onChange({ quantization: 'floor' })} />
      <DeviceToggleButton label="Truncate" active={props.params.quantization === 'truncate'} disabled={!props.params.enabled} onClick={() => props.onChange({ quantization: 'truncate' })} />
    </div>
    <div class="grid w-24 grid-cols-1 gap-1 content-start">
      <DeviceToggleButton label="Dither Off" active={props.params.dither === 'off'} disabled={!props.params.enabled} onClick={() => props.onChange({ dither: 'off' })} />
      <DeviceToggleButton label="Rectangular" active={props.params.dither === 'rectangular'} disabled={!props.params.enabled} onClick={() => props.onChange({ dither: 'rectangular' })} />
      <DeviceToggleButton label="Triangular" active={props.params.dither === 'triangular'} disabled={!props.params.enabled} onClick={() => props.onChange({ dither: 'triangular' })} />
    </div>
  </div></EffectShell>
}
