const fallbackElement = () =>
  typeof document === "undefined" ? null : document.documentElement

export type CssVariableFallback = {
  name: string
  fallback: string
}

export const readCssVariables = (variables: readonly CssVariableFallback[], element: Element | null = fallbackElement()) => {
  const values = new Map<string, string>()
  if (!element || typeof window === "undefined") {
    for (const variable of variables) values.set(variable.name, variable.fallback)
    return values
  }

  const styles = window.getComputedStyle(element)
  for (const variable of variables) {
    const value = styles.getPropertyValue(variable.name).trim()
    values.set(variable.name, value.length > 0 ? value : variable.fallback)
  }
  return values
}
