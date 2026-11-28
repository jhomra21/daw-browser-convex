import { createDefaultAutoPanParams, type AutoPanParams } from '@daw-browser/shared'
import AmplitudeModulationControls from '~/components/effects/amplitude-modulation-controls'
import EffectShell from '~/components/effects/EffectShell'

type AutoPanProps = {
  params: AutoPanParams
  onChange: (updates: Partial<AutoPanParams>) => void
  onToggleEnabled: (enabled: boolean) => void
  onReset: () => void
  automationRangesByParameterId?: ReadonlyMap<string, { min: number; max: number }>
  onAutomationParameterTouch?: (parameterId: string) => void
  onManualAutomationOverride?: (parameterId: string) => void
}

const defaults = createDefaultAutoPanParams()

export default function AutoPan(props: AutoPanProps) {
  return (
    <EffectShell title="Auto Pan" typeLabel="Modulation" enabled={props.params.enabled} onToggleEnabled={props.onToggleEnabled} onReset={props.onReset} class="w-[300px] min-w-[300px]">
      <AmplitudeModulationControls parameterPrefix="autopan" params={props.params} defaults={defaults} onChange={props.onChange} automation={props} />
    </EffectShell>
  )
}
