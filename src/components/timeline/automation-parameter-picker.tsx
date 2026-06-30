import { createEqBandParameterId } from '@daw-browser/shared'

type AutomationParameterPickerProps = {
  value: string
  onChange: (parameterId: string) => void
}

export default function AutomationParameterPicker(props: AutomationParameterPickerProps) {
  return (
    <select
      class="rounded border border-red-500/40 bg-neutral-950/90 px-2 py-1 text-[11px] text-red-100 outline-none"
      value={props.value}
      onChange={(event) => props.onChange(event.currentTarget.value)}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <option value="volume">Volume</option>
      <option value={createEqBandParameterId('low', 'frequencyHz')}>EQ Low Frequency</option>
      <option value={createEqBandParameterId('low', 'gainDb')}>EQ Low Gain</option>
      <option value={createEqBandParameterId('low', 'q')}>EQ Low Q</option>
      <option value={createEqBandParameterId('mid', 'frequencyHz')}>EQ Mid Frequency</option>
      <option value={createEqBandParameterId('mid', 'gainDb')}>EQ Mid Gain</option>
      <option value={createEqBandParameterId('mid', 'q')}>EQ Mid Q</option>
      <option value={createEqBandParameterId('high', 'frequencyHz')}>EQ High Frequency</option>
      <option value={createEqBandParameterId('high', 'gainDb')}>EQ High Gain</option>
      <option value={createEqBandParameterId('high', 'q')}>EQ High Q</option>
    </select>
  )
}
