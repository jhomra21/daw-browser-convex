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
  const knob = (label: string, id: string, value: number, resetValue: number, min: number, max: number, step: number, valueLabel: string, update: (value: number) => Partial<LimiterParams>, logarithmic = false) => (
    <Knob label={label} value={value} valueLabel={valueLabel} resetValue={resetValue} min={min} max={max} step={step} logarithmic={logarithmic} disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get(id)} automated={props.automationRangesByParameterId?.has(id)} onAutomationSelect={() => props.onAutomationParameterTouch?.(id)} onValueChange={(next) => { props.onManualAutomationOverride?.(id); props.onChange(update(next)) }} />
  )
  return (
    <EffectShell title="Limiter" typeLabel="Audio" enabled={props.params.enabled} onToggleEnabled={props.onToggleEnabled} onReset={props.onReset} class="w-56 min-w-56">
      <div class="grid min-h-0 flex-1 grid-rows-[1fr_auto] gap-3 px-3 py-3">
        <div class="grid grid-cols-2 place-content-center gap-x-5 gap-y-4">
          {knob('Ceiling', 'limiter.ceiling', props.params.ceilingDbtp, defaults.ceilingDbtp, -12, 0, 0.1, `${props.params.ceilingDbtp.toFixed(1)} dBTP`, (ceilingDbtp) => ({ ceilingDbtp }))}
          {knob('Release', 'limiter.release', props.params.releaseMs, defaults.releaseMs, 20, 1000, 1, `${Math.round(props.params.releaseMs)} ms`, (releaseMs) => ({ releaseMs }), true)}
          <div class="col-span-2 flex justify-center">
            {knob('Link', 'limiter.link', props.params.link, defaults.link, 0, 1, 0.01, `${Math.round(props.params.link * 100)}%`, (link) => ({ link }))}
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
