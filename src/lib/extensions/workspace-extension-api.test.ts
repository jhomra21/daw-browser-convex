import { expect, test } from 'bun:test'
import type { Cleanup } from './extension-kernel'
import { contributeWorkspace } from './workspace-extension-api'
import { createWorkspaceContributionRegistry } from './workspace-contributions'

test('binds workspace contribution cleanup to the extension lifecycle', () => {
  const registry = createWorkspaceContributionRegistry<string>()
  const cleanups: Cleanup[] = []

  const cleanup = contributeWorkspace(
    {
      extensionId: 'core.browser',
      addCleanup: (entry) => cleanups.push(entry),
    },
    registry,
    {
      id: 'workspace.browser',
      kind: 'panel',
      title: 'Browser',
      slot: 'left',
      value: 'browser',
    },
  )

  expect(cleanups).toEqual([cleanup])
  expect(registry.get('workspace.browser')?.value).toBe('browser')

  cleanup()
  expect(registry.get('workspace.browser')).toBeUndefined()

  for (const entry of cleanups) entry()
  expect(registry.snapshot().contributions).toEqual([])
})
