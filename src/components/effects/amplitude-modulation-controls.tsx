import { Show } from 'solid-js'
import { AUTO_FILTER_LFO_DIVISIONS, type TremoloParams } from '@daw-browser/shared'
import AutomatedKnob from '~/components/effects/AutomatedKnob'
import { formatDegrees, StereoPhaseKnob, WaveformChoice, type ModulationAutomation } from '~/components/effects/modulation-controls'
import { ChoiceMenu, DeviceToggleButton } from '~/components/ui/device-control'
import { formatDeviceHertz, formatDevicePercent } from '~/lib/device-value-format'

const DIVISIONS = AUTO_FILTER_LFO_DIVISIONS.map((label, index) => ({ value: index, label }))

// The controls Tremolo and Auto Pan share: one LFO driving gain, where Auto Pan drives the two channels in opposition.
export default function AmplitudeModulationControls(props: {
  parameterPrefix: 'tremolo' | 'autopan'
  params: TremoloParams
  defaults: TremoloParams
  onChange: (updates: Partial<TremoloParams>) => void
  automation: ModulationAutomation
}) {
  const off = () => !props.params.enabled

  return (
    <div class="flex min-h-0 flex-1 flex-col gap-2 px-3 py-2">
      <div class="grid grid-cols-[minmax(0,1fr)_3.5rem_3.5rem] gap-1">
        <WaveformChoice waveform={props.params.waveform} disabled={off()} onSelect={(waveform) => props.onChange({ waveform })} />
        <DeviceToggleButton label="Invert" active={props.params.invert} disabled={off()} onClick={() => props.onChange({ invert: !props.params.invert })} />
        <DeviceToggleButton label="Sync" active={props.params.sync} disabled={off()} onClick={() => props.onChange({ sync: !props.params.sync })} />
      </div>
      <div class="grid grid-cols-3 items-center justify-items-center gap-y-2">
        {/* Synced to the tempo, the LFO runs at a note division and the free rate no longer applies. */}
        <Show
          when={props.params.sync}
          fallback={
            <AutomatedKnob size={32} label="Rate" valueLabel={formatDeviceHertz(props.params.rateHz, 2)} value={props.params.rateHz} resetValue={props.defaults.rateHz} min={0.01} max={20} step={0.01} logarithmic disabled={off()} parameterId={`${props.parameterPrefix}.rateHz`} automation={props.automation} onValueChange={(rateHz) => props.onChange({ rateHz })} />
          }
        >
          <div class="flex w-full flex-col items-center gap-1 px-1">
            <span class="text-xs font-medium leading-none text-muted-foreground">Rate</span>
            <ChoiceMenu label="Rate division" choices={DIVISIONS} value={props.params.division} disabled={off()} onSelect={(division) => props.onChange({ division })} />
          </div>
        </Show>
        <AutomatedKnob size={32} label="Depth" valueLabel={formatDevicePercent(props.params.depth)} value={props.params.depth} resetValue={props.defaults.depth} min={0} max={1} step={0.01} disabled={off()} parameterId={`${props.parameterPrefix}.depth`} automation={props.automation} onValueChange={(depth) => props.onChange({ depth })} />
        <AutomatedKnob size={32} label="Shape" valueLabel={formatDevicePercent(props.params['shape'])} value={props.params['shape']} resetValue={props.defaults['shape']} min={0} max={1} step={0.01} disabled={off()} parameterId={`${props.parameterPrefix}.shape`} automation={props.automation} onValueChange={(amount) => props.onChange({ ['shape']: amount })} />
        <StereoPhaseKnob parameterPrefix={props.parameterPrefix} params={props.params} resetValue={props.defaults.stereoPhase} onChange={props.onChange} automation={props.automation} />
        <AutomatedKnob size={32} label="Offset" valueLabel={formatDegrees(props.params.phase)} value={props.params.phase} resetValue={props.defaults.phase} min={0} max={1} step={0.01} disabled={off()} parameterId={`${props.parameterPrefix}.phase`} automation={props.automation} onValueChange={(phase) => props.onChange({ phase })} />
      </div>
    </div>
  )
}
