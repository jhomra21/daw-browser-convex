type NativeEditorAnchor = { x: number; y: number }

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

// Main's command schema refuses an own key whose value is undefined, so absent fields stay absent.
type NativeEditorCommand = {
  projectId: string
  instanceId: string
  command: 'open' | 'close' | 'focus'
  requiresState: boolean
  captureState: boolean
  serializedPlan?: string
  initialState?: { bytes: Uint8Array; sha256: string }
  anchor?: NativeEditorAnchor
}

export const nativeEditorCommand = (
  input: Omit<NativeEditorCommand, 'serializedPlan' | 'initialState' | 'anchor'>
    & { [Key in 'serializedPlan' | 'initialState' | 'anchor']: NativeEditorCommand[Key] | undefined },
): NativeEditorCommand => {
  const { serializedPlan, initialState, anchor, ...required } = input
  const command: NativeEditorCommand = required

  if (serializedPlan !== undefined) command.serializedPlan = serializedPlan

  if (initialState !== undefined) command.initialState = initialState

  if (anchor !== undefined) command.anchor = anchor

  return command
}

export const nativeEditorCommandAvailable = (
  bridgeAvailable: boolean,
  _preflightSupportsEditor: boolean,
  liveSupportsEditor: boolean | undefined,
): boolean => bridgeAvailable && liveSupportsEditor !== false

export const nativeEditorAvailabilityMessage = (input: {
  bridgeAvailable: boolean
  preflightSupportsEditor: boolean
  liveSupportsEditor: boolean | undefined
}): string => {
  if (!input.bridgeAvailable) return 'Native editor unavailable in this environment.'

  if (input.liveSupportsEditor === false) return 'This plug-in does not provide a native editor.'

  if (input.liveSupportsEditor) return 'Native editor available.'

  if (!input.preflightSupportsEditor) return 'Native editor availability has not been verified.'

  return 'Native editor available.'
}
