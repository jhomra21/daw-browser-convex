import { Show } from 'solid-js'
import { createDefaultChorusParams, type ChorusMode, type ChorusParams } from '@daw-browser/shared'
import EffectShell from '~/components/effects/EffectShell'
import AutomatedKnob from '~/components/effects/AutomatedKnob'
import { MixKnob, OutputKnob, SafeBassKnob, SafeBassToggle, StereoPhaseKnob, WaveformChoice, WidthKnob } from '~/components/effects/modulation-controls'
import { DeviceToggleButton } from '~/components/ui/device-control'
import { formatDeviceHertz, formatDeviceMilliseconds, formatDevicePercent } from '~/lib/device-value-format'

type ChorusProps = {
  params: ChorusParams
  onChange: (updates: Partial<ChorusParams>) => void
  onToggleEnabled: (enabled: boolean) => void
  onReset: () => void
  automationRangesByParameterId?: ReadonlyMap<string, { min: number; max: number }>
  onAutomationParameterTouch?: (parameterId: string) => void
  onManualAutomationOverride?: (parameterId: string) => void
}

const defaults = createDefaultChorusParams()

export default function Chorus(props: ChorusProps) {
  const off = () => !props.params.enabled

  const modeButton = (mode: ChorusMode, label: string) => (
    <DeviceToggleButton label={label} active={props.params.mode === mode} disabled={off()} onClick={() => props.onChange({ mode })} />
  )

  // Vibrato is the wet signal alone with no feedback, so Feedback and Dry/Wet only exist in the other modes.
  const mixes = () => props.params.mode !== 'vibrato'

  return (
    <EffectShell title="Chorus" typeLabel="Modulation" enabled={props.params.enabled} onToggleEnabled={props.onToggleEnabled} onReset={props.onReset} class="w-[360px] min-w-[360px]">
      <div class="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_4.5rem] gap-3 px-3 py-2">
        <div class="flex min-w-0 flex-col gap-2">
          <div class="grid grid-cols-3 gap-1">
            {modeButton('chorus', 'Chorus')}
            {modeButton('vibrato', 'Vibrato')}
            {modeButton('vintage', 'Vintage')}
          </div>
          <div class="grid grid-cols-[minmax(0,1fr)_4.5rem] gap-1">
            <WaveformChoice waveform={props.params.waveform} disabled={off()} onSelect={(waveform) => props.onChange({ waveform })} />
            <SafeBassToggle params={props.params} onChange={props.onChange} />
          </div>
          <div class="grid grid-cols-4 justify-items-center gap-y-1">
            <AutomatedKnob size={32} label="Delay" valueLabel={formatDeviceMilliseconds(props.params.delayMs, 1)} value={props.params.delayMs} resetValue={defaults.delayMs} min={5} max={30} step={0.1} disabled={off()} parameterId="chorus.delayMs" automation={props} onValueChange={(delayMs) => props.onChange({ delayMs })} />
            <AutomatedKnob size={32} label="Depth" valueLabel={formatDeviceMilliseconds(props.params.depthMs, 1)} value={props.params.depthMs} resetValue={defaults.depthMs} min={0} max={10} step={0.1} disabled={off()} parameterId="chorus.depthMs" automation={props} onValueChange={(depthMs) => props.onChange({ depthMs })} />
            <AutomatedKnob size={32} label="Rate" valueLabel={formatDeviceHertz(props.params.rateHz, 2)} value={props.params.rateHz} resetValue={defaults.rateHz} min={0.01} max={20} step={0.01} logarithmic disabled={off()} parameterId="chorus.rateHz" automation={props} onValueChange={(rateHz) => props.onChange({ rateHz })} />
            <Show when={mixes()} fallback={<div />}>
              <AutomatedKnob size={32} label="Feedback" valueLabel={formatDevicePercent(props.params.feedback)} value={props.params.feedback} resetValue={defaults.feedback} min={0} max={0.5} step={0.01} disabled={off()} parameterId="chorus.feedback" automation={props} onValueChange={(feedback) => props.onChange({ feedback })} />
            </Show>
            <StereoPhaseKnob parameterPrefix="chorus" params={props.params} resetValue={defaults.stereoPhase} onChange={props.onChange} automation={props} />
            <WidthKnob parameterPrefix="chorus" params={props.params} onChange={props.onChange} automation={props} />
            <SafeBassKnob parameterPrefix="chorus" params={props.params} onChange={props.onChange} automation={props} />
          </div>
        </div>
        <div class="flex flex-col items-center justify-around border-l border-border pl-2">
          <OutputKnob parameterPrefix="chorus" params={props.params} onChange={props.onChange} automation={props} />
          <Show when={mixes()}>
            <MixKnob parameterPrefix="chorus" params={props.params} resetValue={defaults.mix} onChange={props.onChange} automation={props} />
          </Show>
        </div>
      </div>
    </EffectShell>
  )
}
