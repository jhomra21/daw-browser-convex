import { expect, test } from 'bun:test'
import { ExtensionKernelError } from './extension-kernel'
import { createWorkspaceContributionRegistry } from './workspace-contributions'

const browser = {
  id: 'workspace.browser',
  kind: 'panel' as const,
  title: 'Browser',
  slot: 'left',
  order: 10,
}

test('registers and lists workspace contributions deterministically', () => {
  const registry = createWorkspaceContributionRegistry<string>()

  registry.register('core.browser', { ...browser, value: 'browser' })
  registry.register('core.timeline', {
    id: 'workspace.timeline',
    kind: 'view',
    title: 'Timeline',
    slot: 'center',
    order: 0,
    value: 'timeline',
  })
  registry.register('core.inspector', {
    id: 'workspace.inspector',
    kind: 'panel',
    title: 'Inspector',
    slot: 'right',
    order: 0,
    value: 'inspector',
  })

  expect(registry.list().map((entry) => entry.id)).toEqual([
    'workspace.timeline',
    'workspace.browser',
    'workspace.inspector',
  ])
  expect(registry.list('panel').map((entry) => entry.id)).toEqual([
    'workspace.browser',
    'workspace.inspector',
  ])
  expect(registry.snapshot().contributions.map((entry) => entry.providerId)).toEqual([
    'core.timeline',
    'core.browser',
    'core.inspector',
  ])
})

test('fails closed on duplicate workspace contribution IDs', () => {
  const registry = createWorkspaceContributionRegistry<string>()
  registry.register('core.browser', { ...browser, value: 'browser' })

  expect(() => registry.register('plugin.browser', { ...browser, value: 'replacement' })).toThrow(
    ExtensionKernelError,
  )
  expect(registry.get(browser.id)?.value).toBe('browser')
})

test('replaces an allowed contribution without changing its public surface', () => {
  const registry = createWorkspaceContributionRegistry<string>()
  const removeBase = registry.register('core.browser', {
    ...browser,
    replacement: { allowed: true, contract: 'workspace.panel.v1' },
    value: 'browser',
  })
  const removeReplacement = registry.register('plugin.alt-browser', {
    ...browser,
    replaces: { contract: 'workspace.panel.v1' },
    value: 'alt-browser',
  })

  expect(registry.get(browser.id)).toEqual({
    ...browser,
    providerId: 'plugin.alt-browser',
    value: 'alt-browser',
  })

  removeReplacement()
  expect(registry.get(browser.id)).toEqual({
    ...browser,
    providerId: 'core.browser',
    value: 'browser',
  })

  removeBase()
  expect(registry.get(browser.id)).toBeUndefined()
})

test('rejects contract mismatches, surface changes, and nested replacement', () => {
  const registry = createWorkspaceContributionRegistry<string>()
  registry.register('core.browser', {
    ...browser,
    replacement: { allowed: true, contract: 'workspace.panel.v1' },
    value: 'browser',
  })

  expect(() => registry.register('plugin.wrong-contract', {
    ...browser,
    replaces: { contract: 'workspace.panel.v2' },
    value: 'wrong',
  })).toThrow('contract does not match')

  expect(() => registry.register('plugin.wrong-surface', {
    ...browser,
    title: 'Different browser',
    replaces: { contract: 'workspace.panel.v1' },
    value: 'wrong',
  })).toThrow('preserve the target surface')

  registry.register('plugin.alt-browser', {
    ...browser,
    replaces: { contract: 'workspace.panel.v1' },
    value: 'alt-browser',
  })

  expect(() => registry.register('plugin.third-browser', {
    ...browser,
    replaces: { contract: 'workspace.panel.v1' },
    value: 'third-browser',
  })).toThrow('Nested workspace replacement')
})

test('removing a replaced provider fails closed instead of leaving an orphan replacement', () => {
  const registry = createWorkspaceContributionRegistry<string>()
  registry.register('core.browser', {
    ...browser,
    replacement: { allowed: true, contract: 'workspace.panel.v1' },
    value: 'browser',
  })
  registry.register('plugin.alt-browser', {
    ...browser,
    replaces: { contract: 'workspace.panel.v1' },
    value: 'alt-browser',
  })

  registry.unregisterProvider('core.browser')

  expect(registry.get(browser.id)).toBeUndefined()
  expect(registry.snapshot().contributions).toEqual([])
})

test('publishes bounded snapshots when the active workspace changes', () => {
  const registry = createWorkspaceContributionRegistry<string>()
  const generations: number[] = []
  const unsubscribe = registry.subscribe((snapshot) => generations.push(snapshot.generation))
  const cleanup = registry.register('core.browser', { ...browser, value: 'browser' })

  cleanup()
  unsubscribe()
  registry.register('core.timeline', {
    id: 'workspace.timeline',
    kind: 'view',
    title: 'Timeline',
    slot: 'center',
    value: 'timeline',
  })

  expect(generations).toEqual([1, 2])
})
