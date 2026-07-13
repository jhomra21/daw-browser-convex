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
  return <EffectShell title="LoFi" typeLabel="Digital Degradation" enabled={props.params.enabled} onToggleEnabled={props.onToggleEnabled} onReset={props.onReset} class="device-lofi"><div class="device-lofi-grid grid min-h-0 flex-1 gap-3 px-3 py-3">
    <div class="grid grid-cols-2 place-content-center gap-x-8 gap-y-4 border-r border-border pr-3">
      <Knob label="Bits" value={props.params.bitDepth} valueLabel={`${props.params.bitDepth} bit`} resetValue={defaults.bitDepth} min={2} max={24} step={1} disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get("lofi.bitDepth")} automated={props.automationRangesByParameterId?.has("lofi.bitDepth")} onAutomationSelect={() => props.onAutomationParameterTouch?.("lofi.bitDepth")} onValueChange={(bitDepth) => { props.onManualAutomationOverride?.("lofi.bitDepth"); props.onChange({ bitDepth }) }} />
      <Knob label="Rate" value={props.params.sampleRateRatio} valueLabel={`${Math.round(props.params.sampleRateRatio * 100)}%`} resetValue={defaults.sampleRateRatio} min={0.01} max={1} step={0.01} logarithmic disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get("lofi.sampleRateRatio")} automated={props.automationRangesByParameterId?.has("lofi.sampleRateRatio")} onAutomationSelect={() => props.onAutomationParameterTouch?.("lofi.sampleRateRatio")} onValueChange={(sampleRateRatio) => { props.onManualAutomationOverride?.("lofi.sampleRateRatio"); props.onChange({ sampleRateRatio }) }} />
      <Knob label="Jitter" value={props.params.jitter} valueLabel={`${Math.round(props.params.jitter * 100)}%`} resetValue={defaults.jitter} min={0} max={1} step={0.01} disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get("lofi.jitter")} automated={props.automationRangesByParameterId?.has("lofi.jitter")} onAutomationSelect={() => props.onAutomationParameterTouch?.("lofi.jitter")} onValueChange={(jitter) => { props.onManualAutomationOverride?.("lofi.jitter"); props.onChange({ jitter }) }} />
      <Knob label="Noise" value={props.params.noiseDb} valueLabel={`${props.params.noiseDb.toFixed(1)} dB`} resetValue={defaults.noiseDb} min={-120} max={-24} step={0.1} disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get("lofi.noiseDb")} automated={props.automationRangesByParameterId?.has("lofi.noiseDb")} onAutomationSelect={() => props.onAutomationParameterTouch?.("lofi.noiseDb")} onValueChange={(noiseDb) => { props.onManualAutomationOverride?.("lofi.noiseDb"); props.onChange({ noiseDb }) }} />
      <div class="col-span-2 flex justify-center">
        <Knob label="Mix" value={props.params.mix} valueLabel={`${Math.round(props.params.mix * 100)}%`} resetValue={defaults.mix} min={0} max={1} step={0.01} disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get("lofi.mix")} automated={props.automationRangesByParameterId?.has("lofi.mix")} onAutomationSelect={() => props.onAutomationParameterTouch?.("lofi.mix")} onValueChange={(mix) => { props.onManualAutomationOverride?.("lofi.mix"); props.onChange({ mix }) }} />
      </div>
    </div>
    <div class="grid content-center gap-1">
      <span class="mb-1 text-2xs uppercase text-muted-foreground">Quantize</span>
      <DeviceToggleButton label="Round" active={props.params.quantization === 'round'} disabled={!props.params.enabled} onClick={() => props.onChange({ quantization: 'round' })} />
      <DeviceToggleButton label="Floor" active={props.params.quantization === 'floor'} disabled={!props.params.enabled} onClick={() => props.onChange({ quantization: 'floor' })} />
      <DeviceToggleButton label="Truncate" active={props.params.quantization === 'truncate'} disabled={!props.params.enabled} onClick={() => props.onChange({ quantization: 'truncate' })} />
      <span class="mb-1 mt-3 text-2xs uppercase text-muted-foreground">Dither</span>
      <DeviceToggleButton label="Dither Off" active={props.params.dither === 'off'} disabled={!props.params.enabled} onClick={() => props.onChange({ dither: 'off' })} />
      <DeviceToggleButton label="Rectangular" active={props.params.dither === 'rectangular'} disabled={!props.params.enabled} onClick={() => props.onChange({ dither: 'rectangular' })} />
      <DeviceToggleButton label="Triangular" active={props.params.dither === 'triangular'} disabled={!props.params.enabled} onClick={() => props.onChange({ dither: 'triangular' })} />
    </div>
  </div></EffectShell>
}
