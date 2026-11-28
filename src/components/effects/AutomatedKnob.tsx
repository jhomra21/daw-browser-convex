import { splitProps, type ComponentProps } from 'solid-js'
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
  const [local, knob] = splitProps(props, ['parameterId', 'automation', 'onValueChange'])

  return (
    <Knob
      {...knob}
      automationRange={local.automation.automationRangesByParameterId?.get(local.parameterId)}
      automated={local.automation.automationRangesByParameterId?.has(local.parameterId)}
      onAutomationSelect={() => local.automation.onAutomationParameterTouch?.(local.parameterId)}
      onValueChange={(value) => {
        local.automation.onManualAutomationOverride?.(local.parameterId)
        local.onValueChange(value)
      }}
    />
  )
}
