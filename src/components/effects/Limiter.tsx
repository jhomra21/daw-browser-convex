import { createDefaultLimiterParams, LIMITER_LOOKAHEAD_STEPS_MS, type LimiterParams } from '@daw-browser/shared'
import EffectShell from '~/components/effects/EffectShell'
import AutomatedKnob from '~/components/effects/AutomatedKnob'
import { DeviceToggleButton } from '~/components/ui/device-control'
import { formatDeviceDb, formatDeviceMilliseconds, formatDevicePercent } from '~/lib/device-value-format'
import type { AudioEngine } from '@daw-browser/audio-engine/audio-engine'
import { createEffect, createSignal, For } from 'solid-js'

type LimiterProps = {
  params: LimiterParams
  audioEngine?: AudioEngine
  targetId: string
  effectInstanceId: string
  onChange: (updates: Partial<LimiterParams>) => void
  onToggleEnabled: (enabled: boolean) => void
  onReset: () => void
  automationRangesByParameterId?: ReadonlyMap<string, { min: number; max: number }>
  onAutomationParameterTouch?: (parameterId: string) => void
  onManualAutomationOverride?: (parameterId: string) => void
}

const defaults = createDefaultLimiterParams()

export default function Limiter(props: LimiterProps) {
  const [gainReductionDb, setGainReductionDb] = createSignal(0)
  createEffect(
    () => {
      const audioEngine = props.audioEngine

      if (!audioEngine) return undefined

      return { audioEngine, targetId: props.targetId, effectInstanceId: props.effectInstanceId }
    },
    (meter) => {
      setGainReductionDb(0)

      if (!meter) return

      const { audioEngine, targetId, effectInstanceId } = meter

      const unsubscribe = targetId === 'master'
        ? audioEngine.masterFx.subscribeLimiterMeter(effectInstanceId, (frame) => setGainReductionDb(frame.gainReductionDb))
        : audioEngine.mixer.subscribeTrackLimiterMeter(targetId, effectInstanceId, (frame) => setGainReductionDb(frame.gainReductionDb))

      return unsubscribe
    },
  )

  return (
    <EffectShell title="Limiter" typeLabel="Audio" enabled={props.params.enabled} onToggleEnabled={props.onToggleEnabled} onReset={props.onReset} class="w-72 min-w-72">
      <div class="device-controls-with-footer grid min-h-0 flex-1 gap-3 px-3 py-3">
        <div class="grid grid-cols-3 place-content-center gap-x-4 gap-y-3">
          <AutomatedKnob label="Gain" value={props.params.gainDb} valueLabel={formatDeviceDb(props.params.gainDb, 1)} resetValue={defaults.gainDb} min={-12} max={24} step={0.1} disabled={!props.params.enabled} parameterId="limiter.gainDb" automation={props} onValueChange={(gainDb) => props.onChange({ gainDb })} />
          <AutomatedKnob label="Ceiling" value={props.params.ceilingDbtp} valueLabel={`${props.params.ceilingDbtp.toFixed(1)} dBTP`} resetValue={defaults.ceilingDbtp} min={-12} max={0} step={0.1} disabled={!props.params.enabled} parameterId="limiter.ceiling" automation={props} onValueChange={(ceilingDbtp) => props.onChange({ ceilingDbtp })} />
          <AutomatedKnob label="Release" value={props.params.releaseMs} valueLabel={formatDeviceMilliseconds(props.params.releaseMs, 0)} resetValue={defaults.releaseMs} min={20} max={1000} step={1} logarithmic disabled={!props.params.enabled || props.params.autoRelease} parameterId="limiter.release" automation={props} onValueChange={(releaseMs) => props.onChange({ releaseMs })} />
          <div class="col-start-3 grid">
            <DeviceToggleButton label="Auto" active={props.params.autoRelease} disabled={!props.params.enabled} onClick={() => props.onChange({ autoRelease: !props.params.autoRelease })} />
          </div>
          <AutomatedKnob label="Link" value={props.params.link} valueLabel={formatDevicePercent(props.params.link)} resetValue={defaults.link} min={0} max={1} step={0.01} disabled={!props.params.enabled} parameterId="limiter.link" automation={props} onValueChange={(link) => props.onChange({ link })} />
          <div class="col-span-2 grid gap-1">
            <span class="text-center text-2xs uppercase leading-none text-muted-foreground">Lookahead</span>
            <div class="grid grid-cols-3 gap-1">
              <For each={LIMITER_LOOKAHEAD_STEPS_MS}>{(lookaheadMs) => (
                <DeviceToggleButton label={formatDeviceMilliseconds(lookaheadMs, 1)} active={props.params.lookaheadMs === lookaheadMs} disabled={!props.params.enabled} onClick={() => props.onChange({ lookaheadMs })} />
              )}</For>
            </div>
          </div>
        </div>
        <div class="border border-border bg-background/80 px-1.5 py-1 text-center text-2xs text-muted-foreground">
          Gain reduction <span class="text-yellow-300">{formatDeviceDb(-gainReductionDb(), 1)}</span>
        </div>
      </div>
    </EffectShell>
  )
}
