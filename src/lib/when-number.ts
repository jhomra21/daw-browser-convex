// A cleared number field is not a typed 0: Number("") would otherwise commit the minimum as an edit.
// The field first goes back to the committed value. An entry that changes the model is then shown by the input's own
// value binding, so a clamped, no-op or cleared entry does not linger in the field.
export const whenNumber = (input: HTMLInputElement, apply: (value: number) => void, committed: number) => {
  const typed = input.value.trim() !== "" && Number.isFinite(input.valueAsNumber) ? input.valueAsNumber : undefined
  input.value = String(committed)
  if (typed !== undefined) apply(typed)
}
