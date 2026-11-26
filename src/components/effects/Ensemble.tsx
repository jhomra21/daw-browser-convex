import { Show } from 'solid-js'
import { createDefaultEnsembleParams, type EnsembleParams } from '@daw-browser/shared'
import EffectShell from '~/components/effects/EffectShell'
import AutomatedKnob from '~/components/effects/AutomatedKnob'
import { MixKnob, OutputKnob, SafeBassKnob, SafeBassToggle, WaveformChoice, WidthKnob } from '~/components/effects/modulation-controls'
import { formatDeviceHertz, formatDeviceMilliseconds, formatDevicePercent } from '~/lib/device-value-format'

type EnsembleProps = {
  params: EnsembleParams
  onChange: (updates: Partial<EnsembleParams>) => void
  onToggleEnabled: (enabled: boolean) => void
  onReset: () => void
  automationRangesByParameterId?: ReadonlyMap<string, { min: number; max: number }>
  onAutomationParameterTouch?: (parameterId: string) => void
  onManualAutomationOverride?: (parameterId: string) => void
}

const defaults = createDefaultEnsembleParams()

export default function Ensemble(props: EnsembleProps) {
  const off = () => !props.params.enabled

  return (
    <EffectShell title="Ensemble" typeLabel="3 Voices" enabled={props.params.enabled} onToggleEnabled={props.onToggleEnabled} onReset={props.onReset} class="w-[360px] min-w-[360px]">
      <div class="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_4.5rem] gap-3 px-3 py-2">
        <div class="flex min-w-0 flex-col gap-2">
          <div class="grid grid-cols-[minmax(0,1fr)_4.5rem] gap-1">
            <WaveformChoice waveform={props.params.waveform} disabled={off()} onSelect={(waveform) => props.onChange({ waveform })} />
            <SafeBassToggle params={props.params} onChange={props.onChange} />
          </div>
          <div class="grid grid-cols-4 justify-items-center gap-y-1">
            <AutomatedKnob size={32} label="Delay" valueLabel={formatDeviceMilliseconds(props.params.delayMs, 1)} value={props.params.delayMs} resetValue={defaults.delayMs} min={10} max={30} step={0.1} disabled={off()} parameterId="ensemble.delayMs" automation={props} onValueChange={(delayMs) => props.onChange({ delayMs })} />
            <AutomatedKnob size={32} label="Depth" valueLabel={formatDeviceMilliseconds(props.params.depthMs, 1)} value={props.params.depthMs} resetValue={defaults.depthMs} min={1} max={12} step={0.1} disabled={off()} parameterId="ensemble.depthMs" automation={props} onValueChange={(depthMs) => props.onChange({ depthMs })} />
            <AutomatedKnob size={32} label="Rate" valueLabel={formatDeviceHertz(props.params.rateHz, 2)} value={props.params.rateHz} resetValue={defaults.rateHz} min={0.05} max={5} step={0.01} logarithmic disabled={off()} parameterId="ensemble.rateHz" automation={props} onValueChange={(rateHz) => props.onChange({ rateHz })} />
            <AutomatedKnob size={32} label="Spread" valueLabel={formatDevicePercent(props.params.spread)} value={props.params.spread} resetValue={defaults.spread} min={0} max={1} step={0.01} disabled={off()} parameterId="ensemble.spread" automation={props} onValueChange={(spread) => props.onChange({ spread })} />
            <AutomatedKnob size={32} label="Fast Depth" valueLabel={formatDeviceMilliseconds(props.params.fastDepthMs, 1)} value={props.params.fastDepthMs} resetValue={defaults.fastDepthMs} min={0} max={4} step={0.1} disabled={off()} parameterId="ensemble.fastDepthMs" automation={props} onValueChange={(fastDepthMs) => props.onChange({ fastDepthMs })} />
            {/* The fast LFO is silent at zero depth, so its rate only exists once Fast Depth is up. */}
            <Show when={props.params.fastDepthMs > 0} fallback={<div />}>
              <AutomatedKnob size={32} label="Fast Rate" valueLabel={formatDeviceHertz(props.params.fastRateHz, 2)} value={props.params.fastRateHz} resetValue={defaults.fastRateHz} min={0.5} max={12} step={0.01} logarithmic disabled={off()} parameterId="ensemble.fastRateHz" automation={props} onValueChange={(fastRateHz) => props.onChange({ fastRateHz })} />
            </Show>
            <WidthKnob parameterPrefix="ensemble" params={props.params} onChange={props.onChange} automation={props} />
            <SafeBassKnob parameterPrefix="ensemble" params={props.params} onChange={props.onChange} automation={props} />
          </div>
        </div>
        <div class="flex flex-col items-center justify-around border-l border-border pl-2">
          <OutputKnob parameterPrefix="ensemble" params={props.params} onChange={props.onChange} automation={props} />
          <MixKnob parameterPrefix="ensemble" params={props.params} resetValue={defaults.mix} onChange={props.onChange} automation={props} />
        </div>
      </div>
    </EffectShell>
  )
}
