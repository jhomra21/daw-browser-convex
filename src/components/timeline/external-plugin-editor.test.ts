import { expect, test } from 'bun:test'
import {
  isExternalEditorInteractiveElement,
  isExternalEditorInteractiveTarget,
  nativeEditorAnchorFromRect,
  nativeEditorAvailabilityMessage,
  nativeEditorCommandAvailable,
} from './external-plugin-editor'

test('exposes the native editor command only when editor support is reported', () => {
  expect(nativeEditorCommandAvailable(true, true, undefined)).toBe(true)
  expect(nativeEditorCommandAvailable(true, false, undefined)).toBe(false)
  expect(nativeEditorCommandAvailable(true, true, false)).toBe(false)
  expect(nativeEditorCommandAvailable(false, true, undefined)).toBe(false)
})

test('reports unsupported editors from preflight without offering a test action', () => {
  expect(nativeEditorAvailabilityMessage({
    bridgeAvailable: true,
    preflightSupportsEditor: false,
    liveSupportsEditor: undefined,
  })).toBe('This plug-in does not provide a native editor.')
})

test('reports live editor support after the worker responds', () => {
  expect(nativeEditorAvailabilityMessage({
    bridgeAvailable: true,
    preflightSupportsEditor: false,
    liveSupportsEditor: false,
  })).toBe('This plug-in does not provide a native editor.')
})

test('reports a supported editor after preflight and live checks', () => {
  expect(nativeEditorAvailabilityMessage({
    bridgeAvailable: true,
    preflightSupportsEditor: true,
    liveSupportsEditor: true,
  })).toBe('Native editor available.')
})

test('computes an editor anchor from the external card bounds', () => {
  expect(nativeEditorAnchorFromRect({ left: 10, top: 20, width: 80 })).toEqual({ x: 50, y: 20 })
})

test('recognizes interactive editor card targets', () => {
  expect(isExternalEditorInteractiveElement({ tagName: "BUTTON" })).toBe(true)
  expect(isExternalEditorInteractiveElement({ tagName: "SPAN" })).toBe(false)
  expect(isExternalEditorInteractiveElement({ tagName: "DIV", role: "button" })).toBe(true)
  expect(isExternalEditorInteractiveTarget(null)).toBe(false)
})
