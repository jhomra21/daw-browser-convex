import { createDefaultPhaserParams, type PhaserParams, type PhaserStages } from '@daw-browser/shared'
import EffectShell from '~/components/effects/EffectShell'
import AutomatedKnob from '~/components/effects/AutomatedKnob'
import { MixKnob, OutputKnob, SafeBassKnob, SafeBassToggle, StereoPhaseKnob, WaveformChoice } from '~/components/effects/modulation-controls'
import { DeviceToggleButton } from '~/components/ui/device-control'
import { formatDeviceFrequency, formatDeviceHertz, formatDevicePercent } from '~/lib/device-value-format'

type PhaserProps = {
  params: PhaserParams
  onChange: (updates: Partial<PhaserParams>) => void
  onToggleEnabled: (enabled: boolean) => void
  onReset: () => void
  automationRangesByParameterId?: ReadonlyMap<string, { min: number; max: number }>
  onAutomationParameterTouch?: (parameterId: string) => void
  onManualAutomationOverride?: (parameterId: string) => void
}

const defaults = createDefaultPhaserParams()

export default function Phaser(props: PhaserProps) {
  const off = () => !props.params.enabled

  const stagesButton = (stages: PhaserStages) => (
    <DeviceToggleButton label={String(stages)} ariaLabel={`${stages} stages`} active={props.params.stages === stages} disabled={off()} onClick={() => props.onChange({ stages })} />
  )

  return (
    <EffectShell title="Phaser" typeLabel="Modulation" enabled={props.params.enabled} onToggleEnabled={props.onToggleEnabled} onReset={props.onReset} class="w-[360px] min-w-[360px]">
      <div class="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_4.5rem] gap-3 px-3 py-2">
        <div class="flex min-w-0 flex-col gap-2">
          <div class="grid grid-cols-4 gap-1">
            {stagesButton(4)}
            {stagesButton(6)}
            {stagesButton(8)}
            {stagesButton(12)}
          </div>
          <div class="grid grid-cols-[minmax(0,1fr)_4.5rem] gap-1">
            <WaveformChoice waveform={props.params.waveform} disabled={off()} onSelect={(waveform) => props.onChange({ waveform })} />
            <SafeBassToggle params={props.params} onChange={props.onChange} />
          </div>
          <div class="grid grid-cols-4 justify-items-center gap-y-2">
            <AutomatedKnob size={32} label="Center" valueLabel={formatDeviceFrequency(props.params.centerHz, 2)} value={props.params.centerHz} resetValue={defaults.centerHz} min={100} max={8000} step={1} logarithmic disabled={off()} parameterId="phaser.centerHz" automation={props} onValueChange={(centerHz) => props.onChange({ centerHz })} />
            <AutomatedKnob size={32} label="Depth" valueLabel={`${props.params.depthOctaves.toFixed(2)} oct`} value={props.params.depthOctaves} resetValue={defaults.depthOctaves} min={0} max={5} step={0.01} disabled={off()} parameterId="phaser.depthOctaves" automation={props} onValueChange={(depthOctaves) => props.onChange({ depthOctaves })} />
            <AutomatedKnob size={32} label="Rate" valueLabel={formatDeviceHertz(props.params.rateHz, 2)} value={props.params.rateHz} resetValue={defaults.rateHz} min={0.01} max={20} step={0.01} logarithmic disabled={off()} parameterId="phaser.rateHz" automation={props} onValueChange={(rateHz) => props.onChange({ rateHz })} />
            <AutomatedKnob size={32} label="Feedback" valueLabel={formatDevicePercent(props.params.feedback)} value={props.params.feedback} resetValue={defaults.feedback} min={-0.95} max={0.95} step={0.01} bipolar disabled={off()} parameterId="phaser.feedback" automation={props} onValueChange={(feedback) => props.onChange({ feedback })} />
            <StereoPhaseKnob parameterPrefix="phaser" params={props.params} resetValue={defaults.stereoPhase} onChange={props.onChange} automation={props} />
            <AutomatedKnob size={32} label="Spread" valueLabel={`${props.params.spreadOctaves.toFixed(2)} oct`} value={props.params.spreadOctaves} resetValue={defaults.spreadOctaves} min={0} max={4} step={0.01} disabled={off()} parameterId="phaser.spreadOctaves" automation={props} onValueChange={(spreadOctaves) => props.onChange({ spreadOctaves })} />
            <AutomatedKnob size={32} label="Blend" valueLabel={formatDevicePercent(props.params.blend)} value={props.params.blend} resetValue={defaults.blend} min={0} max={1} step={0.01} disabled={off()} parameterId="phaser.blend" automation={props} onValueChange={(blend) => props.onChange({ blend })} />
            <SafeBassKnob parameterPrefix="phaser" params={props.params} onChange={props.onChange} automation={props} />
          </div>
        </div>
        <div class="flex flex-col items-center justify-around border-l border-border pl-2">
          <OutputKnob parameterPrefix="phaser" params={props.params} onChange={props.onChange} automation={props} />
          <MixKnob parameterPrefix="phaser" params={props.params} resetValue={defaults.mix} onChange={props.onChange} automation={props} />
        </div>
      </div>
    </EffectShell>
  )
}
