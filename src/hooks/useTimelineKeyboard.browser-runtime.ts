import { createComponent, createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import * as Dialog from '@kobalte/core/dialog'
import { useTimelineKeyboard } from './useTimelineKeyboard'

const calls: string[] = []
const record = (name: string) => () => { calls.push(name) }
const [open, setOpen] = createSignal(false)
const arrangement = document.createElement('div')
arrangement.tabIndex = 0
arrangement.id = 'arrangement'
const button = document.createElement('button')
button.id = 'ordinary-button'
button.textContent = 'Ordinary button'
button.onclick = record('ordinary-click')
const modalButton = document.createElement('button')
modalButton.id = 'modal-button'
modalButton.textContent = 'Modal button'
modalButton.onclick = record('modal-click')
const input = document.createElement('input')
input.id = 'modal-input'
const host = document.createElement('div')
const shadow = host.attachShadow({ mode: 'open' })
const shadowInput = document.createElement('input')
shadow.append(shadowInput)
const modalChildren = document.createElement('div')
modalChildren.append(modalButton, input, host)
const root = document.createElement('div')
document.body.append(arrangement, button, root)

const dispose = render(() => {
  useTimelineKeyboard({
    enabled: () => true,
    onSpace: record('space'),
    onDelete: record('delete'),
    onDuplicate: record('duplicate'),
    onCopy: () => { calls.push('copy'); return true },
    onPaste: () => { calls.push('paste'); return true },
    onAddAudioTrack: record('audio'),
    onAddReturnTrack: record('return'),
    onAddGroupTrack: record('group'),
    onGroupSelectedTracks: record('group-selected'),
    onUngroupSelectedTrack: record('ungroup'),
    onAddInstrumentTrack: record('instrument'),
    onOpenExport: record('export'),
    onToggleFollow: record('follow'),
    executeExtensionShortcut: () => { calls.push('extension'); return true },
    onUndo: record('undo'),
    onRedo: record('redo'),
  })
  return createComponent(Dialog.Root, {
    get open() { return open() },
    onOpenChange: setOpen,
    get children() {
      return createComponent(Dialog.Portal, {
        get children() {
          return createComponent(Dialog.Content, { children: modalChildren })
        },
      })
    },
  })
}, root)

const send = (target: Element, init: KeyboardEventInit) => {
  const event = new KeyboardEvent('keydown', { bubbles: true, composed: true, cancelable: true, ...init })
  target.dispatchEvent(event)
  return event.defaultPrevented
}

const scenarios = () => {
  const results: Record<string, boolean> = {}
  const check = (name: string, target: Element, init: KeyboardEventInit, expected: string[]) => {
    calls.length = 0
    const prevented = send(target, init)
    results[name] = JSON.stringify(calls) === JSON.stringify(expected)
      && prevented === (expected.length > 0)
  }
  setOpen(true)
  results.portalledDialog = modalButton.closest('[role="dialog"]') !== null && !root.contains(modalButton)
  for (const [name, target] of Object.entries({ button: modalButton, input, shadowInput })) {
    for (const init of [
      { key: 'Delete' }, { key: 'Backspace' }, { key: 'd', ctrlKey: true },
      { key: 'z', metaKey: true }, { key: 'Z', metaKey: true, shiftKey: true },
      { key: 'y', ctrlKey: true }, { key: ' ', code: 'Space' },
      { key: 'b', ctrlKey: true, altKey: true },
    ]) check(`modal-${name}-${JSON.stringify(init)}`, target, init, [])
  }
  setOpen(false)
  for (const modifier of [{ ctrlKey: true }, { metaKey: true }]) {
    check(`undo-${JSON.stringify(modifier)}`, arrangement, { key: 'z', ...modifier }, ['undo'])
    check(`redo-shift-${JSON.stringify(modifier)}`, arrangement, { key: 'Z', shiftKey: true, ...modifier }, ['redo'])
    check(`redo-y-${JSON.stringify(modifier)}`, arrangement, { key: 'y', ...modifier }, ['redo'])
  }
  check('delete', arrangement, { key: 'Delete' }, ['delete'])
  check('backspace', arrangement, { key: 'Backspace' }, ['delete'])
  check('duplicate', arrangement, { key: 'd', ctrlKey: true }, ['duplicate'])
  check('transport', arrangement, { key: ' ', code: 'Space' }, ['space'])
  check('follow-shortcut', arrangement, { key: 'F', altKey: true, shiftKey: true }, ['follow'])
  check('follow-windows-shortcut', arrangement, { key: 'F', ctrlKey: true, shiftKey: true }, ['follow'])
  check('button-space', button, { key: ' ', code: 'Space' }, ['space'])
  check('button-duplicate', button, { key: 'd', ctrlKey: true }, ['duplicate'])
  arrangement.setAttribute('data-timeline-keyboard-local', 'true')
  check('local-delete', arrangement, { key: 'Delete' }, [])
  arrangement.removeAttribute('data-timeline-keyboard-local')
  const editable = document.createElement('div')
  editable.contentEditable = 'true'
  arrangement.append(editable, host)
  check('contenteditable', editable, { key: 'z', ctrlKey: true }, [])
  check('shadow-editable', shadowInput, { key: ' ', code: 'Space' }, [])
  calls.length = 0
  return results
}

Object.assign(window, {
  keyboardRegression: {
    scenarios,
    calls,
    open: () => { setOpen(true); modalButton.focus() },
    close: () => { setOpen(false); arrangement.focus() },
    dispose,
  },
})
