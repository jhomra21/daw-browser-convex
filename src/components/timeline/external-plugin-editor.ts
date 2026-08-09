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
