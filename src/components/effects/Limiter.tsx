import { createDefaultLimiterParams, type LimiterParams } from '@daw-browser/shared'
import EffectShell from '~/components/effects/EffectShell'
import Knob from '~/components/ui/knob'
import type { AudioEngine } from '@daw-browser/audio-engine/audio-engine'
import { createEffect, createSignal, onCleanup } from 'solid-js'

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
  createEffect(() => {
    setGainReductionDb(0)
    if (!props.audioEngine) return
    const unsubscribe = props.targetId === 'master'
      ? props.audioEngine.subscribeMasterGateMeter(props.effectInstanceId, (frame) => setGainReductionDb(frame.gainReductionDb))
      : props.audioEngine.subscribeTrackGateMeter(props.targetId, props.effectInstanceId, (frame) => setGainReductionDb(frame.gainReductionDb))
    onCleanup(unsubscribe)
  })
  return (
    <EffectShell title="Limiter" typeLabel="Audio" enabled={props.params.enabled} onToggleEnabled={props.onToggleEnabled} onReset={props.onReset} class="w-56 min-w-56">
      <div class="device-controls-with-footer grid min-h-0 flex-1 gap-3 px-3 py-3">
        <div class="grid grid-cols-2 place-content-center gap-x-5 gap-y-4">
          <Knob label="Ceiling" value={props.params.ceilingDbtp} valueLabel={`${props.params.ceilingDbtp.toFixed(1)} dBTP`} resetValue={defaults.ceilingDbtp} min={-12} max={0} step={0.1} disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get("limiter.ceiling")} automated={props.automationRangesByParameterId?.has("limiter.ceiling")} onAutomationSelect={() => props.onAutomationParameterTouch?.("limiter.ceiling")} onValueChange={(ceilingDbtp) => { props.onManualAutomationOverride?.("limiter.ceiling"); props.onChange({ ceilingDbtp }) }} />
          <Knob label="Release" value={props.params.releaseMs} valueLabel={`${Math.round(props.params.releaseMs)} ms`} resetValue={defaults.releaseMs} min={20} max={1000} step={1} logarithmic disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get("limiter.release")} automated={props.automationRangesByParameterId?.has("limiter.release")} onAutomationSelect={() => props.onAutomationParameterTouch?.("limiter.release")} onValueChange={(releaseMs) => { props.onManualAutomationOverride?.("limiter.release"); props.onChange({ releaseMs }) }} />
          <div class="col-span-2 flex justify-center">
            <Knob label="Link" value={props.params.link} valueLabel={`${Math.round(props.params.link * 100)}%`} resetValue={defaults.link} min={0} max={1} step={0.01} disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get("limiter.link")} automated={props.automationRangesByParameterId?.has("limiter.link")} onAutomationSelect={() => props.onAutomationParameterTouch?.("limiter.link")} onValueChange={(link) => { props.onManualAutomationOverride?.("limiter.link"); props.onChange({ link }) }} />
          </div>
        </div>
        <div class="grid divide-y divide-border border border-border bg-background/80 text-center text-2xs text-muted-foreground">
          <span class="px-1 py-1.5">Gain reduction <span class="text-yellow-300">{gainReductionDb().toFixed(1)} dB</span></span>
          <div class="grid grid-cols-2 divide-x divide-border">
            <span class="px-1 py-1.5">5 ms latency</span>
            <span class="px-1 py-1.5">4x true peak</span>
          </div>
        </div>
      </div>
    </EffectShell>
  )
}
