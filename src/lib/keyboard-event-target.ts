const editableKeyboardTargetTags = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

export const isEditableKeyboardTarget = (target: EventTarget | null) => (
  target instanceof HTMLElement
  && (editableKeyboardTargetTags.has(target.tagName) || target.isContentEditable)
)
