import { createDefaultLoFiParams, LOFI_SAMPLE_RATE_HZ_MAX, LOFI_SAMPLE_RATE_HZ_MIN, type LoFiParams } from '@daw-browser/shared'
import EffectShell from '~/components/effects/EffectShell'
import { DeviceToggleButton } from '~/components/ui/device-control'
import AutomatedKnob from '~/components/effects/AutomatedKnob'
import { formatDeviceDb, formatDeviceFrequency, formatDevicePercent } from '~/lib/device-value-format'

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
      <AutomatedKnob label="Bits" value={props.params.bitDepth} valueLabel={`${props.params.bitDepth} bit`} resetValue={defaults.bitDepth} min={2} max={24} step={1} disabled={!props.params.enabled} parameterId="lofi.bitDepth" automation={props} onValueChange={(bitDepth) => props.onChange({ bitDepth })} />
      <AutomatedKnob label="Rate" value={props.params.sampleRateHz} valueLabel={formatDeviceFrequency(props.params.sampleRateHz, 1)} resetValue={defaults.sampleRateHz} min={LOFI_SAMPLE_RATE_HZ_MIN} max={LOFI_SAMPLE_RATE_HZ_MAX} step={1} logarithmic disabled={!props.params.enabled} parameterId="lofi.sampleRateHz" automation={props} onValueChange={(sampleRateHz) => props.onChange({ sampleRateHz })} />
      <AutomatedKnob label="Jitter" value={props.params.jitter} valueLabel={formatDevicePercent(props.params.jitter)} resetValue={defaults.jitter} min={0} max={1} step={0.01} disabled={!props.params.enabled} parameterId="lofi.jitter" automation={props} onValueChange={(jitter) => props.onChange({ jitter })} />
      <AutomatedKnob label="Noise" value={props.params.noiseDb} valueLabel={formatDeviceDb(props.params.noiseDb, 1)} resetValue={defaults.noiseDb} min={-120} max={-24} step={0.1} disabled={!props.params.enabled} parameterId="lofi.noiseDb" automation={props} onValueChange={(noiseDb) => props.onChange({ noiseDb })} />
      <div class="col-span-2 flex justify-center">
        <AutomatedKnob label="Mix" value={props.params.mix} valueLabel={formatDevicePercent(props.params.mix)} resetValue={defaults.mix} min={0} max={1} step={0.01} disabled={!props.params.enabled} parameterId="lofi.mix" automation={props} onValueChange={(mix) => props.onChange({ mix })} />
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
      <span class="mb-1 mt-3 text-2xs uppercase text-muted-foreground">Filters</span>
      <DeviceToggleButton label="Pre Filter" active={props.params.preFilter} disabled={!props.params.enabled} onClick={() => props.onChange({ preFilter: !props.params.preFilter })} />
      <DeviceToggleButton label="Post Filter" active={props.params.postFilter} disabled={!props.params.enabled} onClick={() => props.onChange({ postFilter: !props.params.postFilter })} />
      <DeviceToggleButton label="Floor DC Fix" active={props.params.dcCorrection} disabled={!props.params.enabled} onClick={() => props.onChange({ dcCorrection: !props.params.dcCorrection })} />
    </div>
  </div></EffectShell>
}
