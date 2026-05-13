export function hasAncestorDatasetValue(
  target: HTMLElement,
  readValue: (element: HTMLElement) => string | undefined,
  value: string,
): boolean {
  let element: HTMLElement | null = target
  while (element) {
    if (readValue(element) === value) return true
    element = element.parentElement
  }
  return false
}
