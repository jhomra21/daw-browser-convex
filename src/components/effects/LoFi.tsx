import { Show } from 'solid-js'
import {
  createDefaultLoFiParams,
  LOFI_SAMPLE_RATE_HZ_MAX,
  LOFI_SAMPLE_RATE_HZ_MIN,
  type LoFiDither,
  type LoFiParams,
  type LoFiQuantization,
} from '@daw-browser/shared'
import EffectShell from '~/components/effects/EffectShell'
import AutomatedKnob from '~/components/effects/AutomatedKnob'
import { ChoiceMenu, DeviceToggleButton } from '~/components/ui/device-control'
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

const QUANTIZATIONS: readonly { value: LoFiQuantization; label: string }[] = [
  { value: 'round', label: 'Round' },
  { value: 'floor', label: 'Floor' },
  { value: 'truncate', label: 'Truncate' },
]

const DITHERS: readonly { value: LoFiDither; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'rectangular', label: 'Rectangular' },
  { value: 'triangular', label: 'Triangular' },
]

// Sample rate on the left, bit depth on the right, as in Live's Redux; the quantizer and dither choosers stand where Redux has Shape.
export default function LoFi(props: LoFiProps) {
  const off = () => !props.params.enabled

  return (
    <EffectShell title="LoFi" typeLabel="Audio" enabled={props.params.enabled} onToggleEnabled={props.onToggleEnabled} onReset={props.onReset} class="w-[400px] min-w-[400px]">
      <div class="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(0,1fr)_7.5rem] gap-2 px-3 py-2">
        <section class="flex min-w-0 flex-col items-center justify-between border-r border-border pr-2" aria-label="Rate">
          <AutomatedKnob size={36} label="Rate" valueLabel={formatDeviceFrequency(props.params.sampleRateHz, 2)} value={props.params.sampleRateHz} resetValue={defaults.sampleRateHz} min={LOFI_SAMPLE_RATE_HZ_MIN} max={LOFI_SAMPLE_RATE_HZ_MAX} step={1} logarithmic disabled={off()} parameterId="lofi.sampleRateHz" automation={props} onValueChange={(sampleRateHz) => props.onChange({ sampleRateHz })} />
          <AutomatedKnob size={28} label="Jitter" valueLabel={formatDevicePercent(props.params.jitter)} value={props.params.jitter} resetValue={defaults.jitter} min={0} max={1} step={0.01} disabled={off()} parameterId="lofi.jitter" automation={props} onValueChange={(jitter) => props.onChange({ jitter })} />
          <div class="flex w-full flex-col gap-1">
            <span class="text-xs font-medium leading-none text-muted-foreground">Filter</span>
            <div class="grid grid-cols-2 gap-1">
              <DeviceToggleButton label="Pre" ariaLabel="Pre Filter" active={props.params.preFilter} disabled={off()} onClick={() => props.onChange({ preFilter: !props.params.preFilter })} />
              <DeviceToggleButton label="Post" ariaLabel="Post Filter" active={props.params.postFilter} disabled={off()} onClick={() => props.onChange({ postFilter: !props.params.postFilter })} />
            </div>
            <DeviceToggleButton label="Sub-sample" ariaLabel="Sub-sample clock" active={props.params.subSampleClock} disabled={off()} onClick={() => props.onChange({ subSampleClock: !props.params.subSampleClock })} />
          </div>
        </section>

        <section class="flex min-w-0 flex-col items-center justify-between" aria-label="Bits">
          <AutomatedKnob size={36} label="Bits" valueLabel={`${props.params.bitDepth} bit`} value={props.params.bitDepth} resetValue={defaults.bitDepth} min={2} max={24} step={1} disabled={off()} parameterId="lofi.bitDepth" automation={props} onValueChange={(bitDepth) => props.onChange({ bitDepth })} />
          <AutomatedKnob size={28} label="Noise" valueLabel={formatDeviceDb(props.params.noiseDb, 1)} value={props.params.noiseDb} resetValue={defaults.noiseDb} min={-120} max={-24} step={0.1} disabled={off()} parameterId="lofi.noiseDb" automation={props} onValueChange={(noiseDb) => props.onChange({ noiseDb })} />
          <AutomatedKnob size={28} label="Dry/Wet" valueLabel={formatDevicePercent(props.params.mix)} value={props.params.mix} resetValue={defaults.mix} min={0} max={1} step={0.01} disabled={off()} parameterId="lofi.mix" automation={props} onValueChange={(mix) => props.onChange({ mix })} />
        </section>

        <section class="flex min-w-0 flex-col justify-center gap-1" aria-label="Quantizer">
          <span class="text-xs font-medium leading-none text-muted-foreground">Quantizer</span>
          <ChoiceMenu label="Quantizer" choices={QUANTIZATIONS} value={props.params.quantization} disabled={off()} onSelect={(quantization) => props.onChange({ quantization })} />
          {/* Floor rounds every value down, and DC Fix is what centres that error, so it exists only for Floor. */}
          <Show when={props.params.quantization === 'floor'}>
            <DeviceToggleButton label="DC Fix" ariaLabel="Floor DC Fix" active={props.params.dcCorrection} disabled={off()} onClick={() => props.onChange({ dcCorrection: !props.params.dcCorrection })} />
          </Show>
          <span class="mt-2 text-xs font-medium leading-none text-muted-foreground">Dither</span>
          <ChoiceMenu label="Dither" choices={DITHERS} value={props.params.dither} disabled={off()} onSelect={(dither) => props.onChange({ dither })} />
        </section>
      </div>
    </EffectShell>
  )
}
