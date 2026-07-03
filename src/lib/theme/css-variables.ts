const fallbackElement = () =>
  typeof document === "undefined" ? null : document.documentElement

export type CssVariableFallback = {
  name: string
  fallback: string
}

export const readCssVariable = (name: string, fallback: string, element: Element | null = fallbackElement()) => {
  if (!element || typeof window === "undefined") return fallback
  const value = window.getComputedStyle(element).getPropertyValue(name).trim()
  return value.length > 0 ? value : fallback
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
