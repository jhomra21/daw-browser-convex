import { getAutomationParameterOptions } from '@daw-browser/shared'

type AutomationParameterPickerProps = {
  value: string
  automatedParameterIds?: ReadonlySet<string>
  onChange: (parameterId: string) => void
}

const optionLabel = (label: string, parameterId: string, automatedParameterIds: ReadonlySet<string> | undefined) => (
  automatedParameterIds?.has(parameterId) ? `● ${label}` : label
)

const parameterOptions = getAutomationParameterOptions()

export default function AutomationParameterPicker(props: AutomationParameterPickerProps) {
  return (
    <select
      class="h-7 w-full rounded border border-red-500/40 bg-neutral-950/90 px-2 py-1 text-[11px] text-red-100 outline-none"
      value={props.value}
      onChange={(event) => props.onChange(event.currentTarget.value)}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {parameterOptions.map((option) => (
        <option value={option.id}>{optionLabel(option.label, option.id, props.automatedParameterIds)}</option>
      ))}
    </select>
  )
}
