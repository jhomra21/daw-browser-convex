import { expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import {
  nativeEditorAnchorFromRect,
  nativeEditorAvailabilityMessage,
  nativeEditorCommandAvailable,
} from './external-plugin-editor'

test('exposes an editor probe until live support is known', () => {
  expect(nativeEditorCommandAvailable(true, true, undefined)).toBe(true)
  expect(nativeEditorCommandAvailable(true, false, undefined)).toBe(true)
  expect(nativeEditorCommandAvailable(true, true, false)).toBe(false)
  expect(nativeEditorCommandAvailable(true, false, true)).toBe(true)
  expect(nativeEditorCommandAvailable(false, true, undefined)).toBe(false)
})

test('treats old unsupported preflight metadata as unverified', () => {
  expect(nativeEditorAvailabilityMessage({
    bridgeAvailable: true,
    preflightSupportsEditor: false,
    liveSupportsEditor: undefined,
  })).toBe('Native editor availability has not been verified.')
})

test('reports live editor support after the worker responds', () => {
  expect(nativeEditorAvailabilityMessage({
    bridgeAvailable: true,
    preflightSupportsEditor: false,
    liveSupportsEditor: false,
  })).toBe('This plug-in does not provide a native editor.')
})

test('reports authoritative live editor loss over stale preflight support', () => {
  expect(nativeEditorAvailabilityMessage({
    bridgeAvailable: true,
    preflightSupportsEditor: true,
    liveSupportsEditor: false,
  })).toBe('This plug-in does not provide a native editor.')
})

test('restores availability when live support supersedes an old preflight', () => {
  expect(nativeEditorAvailabilityMessage({
    bridgeAvailable: true,
    preflightSupportsEditor: false,
    liveSupportsEditor: true,
  })).toBe('Native editor available.')
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

test('consumes an auto-open request only after issuing editor IPC', async () => {
  const source = await readFile(new URL('./external-plugin-card.tsx', import.meta.url), 'utf8')
  const autoOpenStart = source.indexOf('setAutoOpenStarted(true);')
  const handled = source.indexOf('props.onAutoOpenHandled?.', autoOpenStart)
  const editorOpen = source.indexOf('void editor("open")', autoOpenStart)

  expect(autoOpenStart).toBeGreaterThanOrEqual(0)
  expect(handled).toBeGreaterThan(editorOpen)
})

test('does not turn a close response into a capability loss', async () => {
  const source = await readFile(new URL('./external-plugin-card.tsx', import.meta.url), 'utf8')
  expect(source).toContain('if (command !== "close") setLiveEditorSupported(result.status.supported);')
})
