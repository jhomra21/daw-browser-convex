import { omit } from 'solid-js'
import type { ComponentProps } from '@solidjs/web'
import Knob from '~/components/ui/knob'

type AutomatedKnobProps = Omit<ComponentProps<typeof Knob>, 'automationRange' | 'automated' | 'onAutomationSelect'> & {
  parameterId: string
  automation: {
    automationRangesByParameterId?: ReadonlyMap<string, { min: number; max: number }>
    onAutomationParameterTouch?: (parameterId: string) => void
    onManualAutomationOverride?: (parameterId: string) => void
  }
}

export default function AutomatedKnob(props: AutomatedKnobProps) {
  const knob = omit(props, 'parameterId', 'automation', 'onValueChange')

  return (
    <Knob
      {...knob}
      automationRange={props.automation.automationRangesByParameterId?.get(props.parameterId)}
      automated={props.automation.automationRangesByParameterId?.has(props.parameterId)}
      onAutomationSelect={() => props.automation.onAutomationParameterTouch?.(props.parameterId)}
      onValueChange={(value) => {
        props.automation.onManualAutomationOverride?.(props.parameterId)
        props.onValueChange(value)
      }}
    />
  )
}
