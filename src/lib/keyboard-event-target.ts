const editableKeyboardTargetTags = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

export const isEditableKeyboardTarget = (target: EventTarget | null) => (
  target instanceof HTMLElement
  && (editableKeyboardTargetTags.has(target.tagName) || target.isContentEditable)
)

export const isLocalTimelineKeyboardTarget = (target: EventTarget | null) => (
  target instanceof Element
  && target.closest('[data-timeline-keyboard-local="true"]') !== null
)

// Kobalte dialog content is portalled and has role="dialog", without aria-modal.
// Inspect event ancestry, never unrelated dialogs elsewhere in the document.
export const isDialogKeyboardTarget = (target: EventTarget | null) => (
  target instanceof Element
  && target.closest('[role="dialog"], [role="alertdialog"], dialog') !== null
)

export const isMenuKeyboardTarget = (target: EventTarget | null) => (
  target instanceof Element
  && target.closest('[role="menu"], [role="menubar"]') !== null
)

// Who owns a keyboard event's composed path: a text field, an overlay, or (null) the timeline.
export const keyboardTargetOwner = (path: readonly EventTarget[]): "editable" | "overlay" | null => {
  if (path.some(isEditableKeyboardTarget)) return "editable"
  if (path.some(isDialogKeyboardTarget) || path.some(isMenuKeyboardTarget)) return "overlay"
  return null
}

export const isKeyboardEventOwnedByOverlay = (event: KeyboardEvent) => (
  keyboardTargetOwner(event.composedPath().filter((target): target is EventTarget => target != null)) !== null
)

export const isButtonKeyboardTarget = (target: EventTarget | null) => (
  target instanceof Element
  && target.closest('button, [role="button"]') !== null
)
