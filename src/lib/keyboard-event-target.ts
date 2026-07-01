const editableKeyboardTargetTags = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

export const isEditableKeyboardTarget = (target: EventTarget | null) => (
  target instanceof HTMLElement
  && (editableKeyboardTargetTags.has(target.tagName) || target.isContentEditable)
)

export const isLocalTimelineKeyboardTarget = (target: EventTarget | null) => (
  target instanceof Element
  && target.closest('[data-timeline-keyboard-local="true"]') !== null
)
