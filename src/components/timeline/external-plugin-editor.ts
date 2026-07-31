export type NativeEditorAnchor = { x: number; y: number }

export const nativeEditorAnchorFromRect = (rect: {
  left: number
  top: number
  width: number
}): NativeEditorAnchor | undefined => {
  const x = rect.left + rect.width / 2
  const y = rect.top
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined
}

export const nativeEditorAnchorFromElement = (element: HTMLElement): NativeEditorAnchor | undefined => (
  nativeEditorAnchorFromRect(element.getBoundingClientRect())
)

export const isExternalEditorInteractiveElement = (input: {
  tagName: string
  role?: string | null
  contentEditable?: string | null
}): boolean => (
  /^(BUTTON|INPUT|SELECT|TEXTAREA)$/i.test(input.tagName)
  || input.role === "button"
  || (input.contentEditable !== null && input.contentEditable !== undefined && input.contentEditable !== "false")
)

export const isExternalEditorInteractiveTarget = (target: EventTarget | null): boolean => {
  if (typeof Element === "undefined" || !(target instanceof Element)) return false
  let element: Element | null = target
  while (element) {
    if (isExternalEditorInteractiveElement({
      tagName: element.tagName,
      role: element.getAttribute("role"),
      contentEditable: element.getAttribute("contenteditable"),
    })) return true
    element = element.parentElement
  }
  return false
}

export const nativeEditorCommandAvailable = (
  bridgeAvailable: boolean,
  preflightSupportsEditor: boolean,
  liveSupportsEditor: boolean | undefined,
): boolean => bridgeAvailable && (liveSupportsEditor ?? preflightSupportsEditor)

export const nativeEditorAvailabilityMessage = (input: {
  bridgeAvailable: boolean
  preflightSupportsEditor: boolean
  liveSupportsEditor: boolean | undefined
}): string => {
  if (!input.bridgeAvailable) return 'Native editor unavailable in this environment.'
  if (input.liveSupportsEditor === false) return 'This plug-in does not provide a native editor.'
  if (!input.preflightSupportsEditor) return 'This plug-in does not provide a native editor.'
  return 'Native editor available.'
}
