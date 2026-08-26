import { expect, test } from 'bun:test'

import {
  createExtensionManager,
  type AppExtensionDefinition,
} from './index'

const commandDefinition = (
  version: string,
  value: string,
): AppExtensionDefinition => ({
  id: 'test.extension',
  version,
  commands: [{
    id: 'test.command',
    contributionId: 'test.contribution',
    title: 'Test command',
  }],
  shortcuts: [],
  activate: ({ bindCommand }) => {
    bindCommand('test.command', () => value)
  },
})

const replaceableDefinition = (): AppExtensionDefinition => ({
  id: 'test.base',
  version: '1.0.0',
  commands: [{
    id: 'test.replaceable',
    contributionId: 'test.replaceable-contribution',
    title: 'Replaceable command',
    replacement: { allowed: true, contract: 'test-command-v1' },
  }],
  shortcuts: [],
  activate: ({ bindCommand }) => {
    bindCommand('test.replaceable', () => 'base')
  },
})

const replacementDefinition = (): AppExtensionDefinition => ({
  id: 'test.replacement',
  version: '1.0.0',
  commands: [{
    id: 'test.replaceable',
    contributionId: 'test.replacement-contribution',
    title: 'Replaceable command',
  }],
  shortcuts: [],
  replacements: [{
    targetContributionId: 'test.replaceable-contribution',
    contract: 'test-command-v1',
  }],
  activate: ({ bindCommand }) => {
    bindCommand('test.replaceable', () => 'replacement')
  },
})

test('registers project extensions and disposes the owned registration', async () => {
  const manager = createExtensionManager()
  const cleanup = manager.register(commandDefinition('1.0.0', 'one'), 'project')

  expect(manager.snapshot().registrations).toEqual([{
    id: 'test.extension',
    version: '1.0.0',
    source: 'project',
    enabled: false,
  }])

  await manager.enable('test.extension')
  expect(await manager.kernel.executeCommand('test.command')).toBe('one')
  expect(manager.snapshot().registrations[0]?.enabled).toBeTrue()

  await cleanup()
  expect(manager.snapshot().registrations).toEqual([])
  expect(manager.snapshot().kernel.commands).toEqual([])
  await manager.dispose()
})

test('updates enabled registrations atomically and stales the previous cleanup', async () => {
  const manager = createExtensionManager()
  const oldCleanup = manager.register(commandDefinition('1.0.0', 'one'), 'project')
  await manager.enable('test.extension')

  const currentCleanup = await manager.update(commandDefinition('2.0.0', 'two'), 'package')
  expect(await manager.kernel.executeCommand('test.command')).toBe('two')
  expect(manager.snapshot().registrations).toEqual([{
    id: 'test.extension',
    version: '2.0.0',
    source: 'package',
    enabled: true,
  }])

  await oldCleanup()
  expect(await manager.kernel.executeCommand('test.command')).toBe('two')
  expect(manager.snapshot().registrations).toHaveLength(1)

  await currentCleanup()
  expect(manager.snapshot().registrations).toEqual([])
  await manager.dispose()
})

test('keeps the previous enabled registration when a hot update fails', async () => {
  const manager = createExtensionManager()
  manager.register(commandDefinition('1.0.0', 'one'))
  await manager.enable('test.extension')

  const failed: AppExtensionDefinition = {
    ...commandDefinition('2.0.0', 'two'),
    activate: () => {
      throw new Error('failed update')
    },
  }

  await expect(manager.update(failed)).rejects.toThrow('failed update')
  expect(await manager.kernel.executeCommand('test.command')).toBe('one')
  expect(manager.snapshot().registrations[0]?.version).toBe('1.0.0')
  await manager.dispose()
})

test('uses the kernel replacement path and restores the prior provider on disable', async () => {
  const manager = createExtensionManager()
  manager.register(replaceableDefinition(), 'builtin')
  manager.register(replacementDefinition(), 'project')

  await manager.enable('test.base')
  expect(await manager.kernel.executeCommand('test.replaceable')).toBe('base')

  await manager.enable('test.replacement')
  expect(await manager.kernel.executeCommand('test.replaceable')).toBe('replacement')

  await manager.disable('test.replacement')
  expect(await manager.kernel.executeCommand('test.replaceable')).toBe('base')
  await manager.dispose()
})

test('reports kernel activation as the source of truth for enablement', async () => {
  const manager = createExtensionManager()
  const definition = commandDefinition('1.0.0', 'one')
  manager.register(definition)

  await manager.kernel.activate(definition)
  expect(manager.snapshot().registrations[0]?.enabled).toBeTrue()

  await manager.kernel.deactivate(definition.id)
  expect(manager.snapshot().registrations[0]?.enabled).toBeFalse()
  await manager.dispose()
})

test('rejects duplicate registrations and becomes inert after disposal', async () => {
  const manager = createExtensionManager()
  manager.register(commandDefinition('1.0.0', 'one'))
  expect(() => manager.register(commandDefinition('2.0.0', 'two'))).toThrow('already registered')
  await manager.dispose()
  expect(() => manager.register(commandDefinition('3.0.0', 'three'))).toThrow('disposed')
})
