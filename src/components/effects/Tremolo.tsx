import { createDefaultTremoloParams, type TremoloParams } from '@daw-browser/shared'
import AmplitudeModulationControls from '~/components/effects/amplitude-modulation-controls'
import EffectShell from '~/components/effects/EffectShell'

type TremoloProps = {
  params: TremoloParams
  onChange: (updates: Partial<TremoloParams>) => void
  onToggleEnabled: (enabled: boolean) => void
  onReset: () => void
  automationRangesByParameterId?: ReadonlyMap<string, { min: number; max: number }>
  onAutomationParameterTouch?: (parameterId: string) => void
  onManualAutomationOverride?: (parameterId: string) => void
}

const defaults = createDefaultTremoloParams()

export default function Tremolo(props: TremoloProps) {
  return (
    <EffectShell title="Tremolo" typeLabel="Modulation" enabled={props.params.enabled} onToggleEnabled={props.onToggleEnabled} onReset={props.onReset} class="w-[300px] min-w-[300px]">
      <AmplitudeModulationControls parameterPrefix="tremolo" params={props.params} defaults={defaults} onChange={props.onChange} automation={props} />
    </EffectShell>
  )
}
