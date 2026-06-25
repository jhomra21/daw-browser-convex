import EffectShell from '~/components/effects/EffectShell'
import { DeviceToggleButton } from '~/components/ui/device-control'
import Knob from '~/components/ui/knob'
import {
  createDefaultDelayParams,
  DELAY_DRY_WET_MAX,
  DELAY_DRY_WET_MIN,
  DELAY_FEEDBACK_MAX,
  DELAY_FEEDBACK_MIN,
  DELAY_HIGH_CUT_HZ_MAX,
  DELAY_HIGH_CUT_HZ_MIN,
  DELAY_LOW_CUT_HZ_MAX,
  DELAY_LOW_CUT_HZ_MIN,
  DELAY_TIME_MS_MAX,
  DELAY_TIME_MS_MIN,
  type DelayParams,
  type DelaySyncDivision,
} from '@daw-browser/shared'
import { cn } from '~/lib/utils'

type DelayProps = {
  params: DelayParams
  onChange: (updates: Partial<DelayParams>) => void
  onToggleEnabled?: (enabled: boolean) => void
  onReset?: () => void
  class?: string
}

const DEFAULT_PARAMS = createDefaultDelayParams()
const DIVISIONS: DelaySyncDivision[] = ['1/16', '1/8', '1/4', '1/2', '1/1']

const formatPercent = (value: number) => `${Math.round(value * 100)}%`
const formatMs = (value: number) => `${Math.round(value)} ms`
const formatFrequency = (value: number) => value >= 1000 ? `${(value / 1000).toFixed(1)} kHz` : `${Math.round(value)} Hz`

export default function Delay(props: DelayProps) {
  const timeMode = () => props.params.mode === 'time'

  return (
    <EffectShell
      title="Delay"
      typeLabel="Stereo"
      enabled={props.params.enabled}
      onToggleEnabled={props.onToggleEnabled}
      onReset={props.onReset}
      class={cn('w-[500px] min-w-[500px]', props.class)}
    >
      <div class={cn('grid min-h-0 flex-1 grid-cols-[90px_72px_repeat(6,48px)] items-end gap-3 px-3 py-3', !props.params.enabled && 'opacity-70')}>
        <div class="flex h-full flex-col justify-between gap-2">
          <div class="text-xs font-semibold text-neutral-400">Mode</div>
          <div class="grid grid-cols-2 gap-1">
            <DeviceToggleButton label="Sync" active={!timeMode()} disabled={!props.params.enabled} onClick={() => props.onChange({ mode: 'sync' })} />
            <DeviceToggleButton label="Time" active={timeMode()} disabled={!props.params.enabled} onClick={() => props.onChange({ mode: 'time' })} />
          </div>
          <div class="grid grid-cols-1 gap-1">
            {DIVISIONS.map((syncDivision) => (
              <DeviceToggleButton
                label={syncDivision}
                active={!timeMode() && props.params.syncDivision === syncDivision}
                disabled={!props.params.enabled || timeMode()}
                onClick={() => props.onChange({ syncDivision })}
              />
            ))}
          </div>
        </div>
        <Knob label="Time" valueLabel={formatMs(props.params.timeMs)} value={props.params.timeMs} resetValue={DEFAULT_PARAMS.timeMs} min={DELAY_TIME_MS_MIN} max={DELAY_TIME_MS_MAX} step={1} disabled={!props.params.enabled || !timeMode()} onValueChange={(timeMs) => props.onChange({ timeMs })} />
        <Knob label="Feedback" valueLabel={formatPercent(props.params.feedback)} value={props.params.feedback} resetValue={DEFAULT_PARAMS.feedback} min={DELAY_FEEDBACK_MIN} max={DELAY_FEEDBACK_MAX} step={0.01} disabled={!props.params.enabled} onValueChange={(feedback) => props.onChange({ feedback })} />
        <Knob label="Dry/Wet" valueLabel={formatPercent(props.params.dryWet)} value={props.params.dryWet} resetValue={DEFAULT_PARAMS.dryWet} min={DELAY_DRY_WET_MIN} max={DELAY_DRY_WET_MAX} step={0.01} disabled={!props.params.enabled} onValueChange={(dryWet) => props.onChange({ dryWet })} />
        <div class="flex h-full flex-col justify-end gap-2">
          <DeviceToggleButton label="Ping Pong" active={props.params.pingPong} disabled={!props.params.enabled} onClick={() => props.onChange({ pingPong: !props.params.pingPong })} />
          <DeviceToggleButton label="Filter" active={props.params.filterEnabled} disabled={!props.params.enabled} onClick={() => props.onChange({ filterEnabled: !props.params.filterEnabled })} />
        </div>
        <Knob label="Low Cut" valueLabel={formatFrequency(props.params.lowCutHz)} value={props.params.lowCutHz} resetValue={DEFAULT_PARAMS.lowCutHz} min={DELAY_LOW_CUT_HZ_MIN} max={DELAY_LOW_CUT_HZ_MAX} step={1} logarithmic disabled={!props.params.enabled || !props.params.filterEnabled} onValueChange={(lowCutHz) => props.onChange({ lowCutHz })} />
        <Knob label="High Cut" valueLabel={formatFrequency(props.params.highCutHz)} value={props.params.highCutHz} resetValue={DEFAULT_PARAMS.highCutHz} min={DELAY_HIGH_CUT_HZ_MIN} max={DELAY_HIGH_CUT_HZ_MAX} step={1} logarithmic disabled={!props.params.enabled || !props.params.filterEnabled} onValueChange={(highCutHz) => props.onChange({ highCutHz })} />
      </div>
    </EffectShell>
  )
}
