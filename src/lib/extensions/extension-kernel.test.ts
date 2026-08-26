import { expect, test } from 'bun:test'

import {
  ExtensionKernelError,
  createExtensionKernel,
  normalizeShortcutChord,
  type AppExtensionDefinition,
} from './index'
import { createBuiltinExtensionManager } from './builtin-manager'

const definition = (
  id: string,
  commandId: string,
  contributionId: string,
  activate: AppExtensionDefinition['activate'],
  replacement?: AppExtensionDefinition['replacements'],
  shortcuts: AppExtensionDefinition['shortcuts'] = [{
    id: `${id}.shortcut`,
    commandId,
    chord: { mod: true, key: 'K' },
  }],
): AppExtensionDefinition => ({
  id,
  version: '1.0.0',
  commands: [{ id: commandId, contributionId, title: commandId }],
  shortcuts,
  replacements: replacement,
  activate,
})

test('publishes only after complete activation and preserves the old registry on failure', async () => {
  const kernel = createExtensionKernel()
  await kernel.activate(definition('core.base', 'core.command', 'core.contribution', ({ bindCommand }) => {
    bindCommand('core.command', () => 'base')
  }))
  await expect(kernel.activate(definition('other.failed', 'other.command', 'other.contribution', () => {
    throw new Error('nope')
  }))).rejects.toThrow('nope')
  expect(kernel.snapshot().commands.map((command) => command.id)).toEqual(['core.command'])
  expect(await kernel.executeCommand('core.command')).toBe('base')
  await kernel.dispose()
})

test('rejects undeclared, duplicate, and missing bindings', async () => {
  const kernel = createExtensionKernel()
  await expect(kernel.activate(definition('bad.undeclared', 'bad.command', 'bad.contribution', ({ bindCommand }) => {
    bindCommand('bad.other', () => undefined)
  }))).rejects.toBeInstanceOf(ExtensionKernelError)
  await expect(kernel.activate(definition('bad.missing', 'bad.command', 'bad.missing-contribution', () => undefined)))
    .rejects.toThrow('Every declared command')
  await expect(kernel.activate(definition('bad.duplicate', 'bad.command', 'bad.duplicate-contribution', ({ bindCommand }) => {
    bindCommand('bad.command', () => undefined)
    bindCommand('bad.command', () => undefined)
  }))).rejects.toThrow('only be bound once')
  await kernel.dispose()
})

test('replaces an allowed command and restores it after replacement deactivation', async () => {
  const kernel = createExtensionKernel()
  let originalSignal: AbortSignal | undefined
  let originalCleanupCount = 0
  let replacementCleanupCount = 0
  await kernel.activate({
    ...definition('core.base', 'core.command', 'core.contribution', (context) => {
      originalSignal = context.signal
      context.addCleanup(() => { originalCleanupCount += 1 })
      const { bindCommand } = context
      bindCommand('core.command', () => 'base')
    }),
    commands: [{
      id: 'core.command',
      contributionId: 'core.contribution',
      title: 'core.command',
      replacement: { allowed: true, contract: 'command-v1' },
    }],
  })
  await kernel.replace(definition(
    'other.replacement',
    'core.command',
    'other.contribution',
    (context) => {
      context.addCleanup(() => { replacementCleanupCount += 1 })
      context.bindCommand('core.command', () => 'replacement')
    },
    [{ targetContributionId: 'core.contribution', contract: 'command-v1' }],
    [],
  ))
  expect(await kernel.executeCommand('core.command')).toBe('replacement')
  expect(originalSignal?.aborted).toBeFalse()
  expect(originalCleanupCount).toBe(0)
  expect(kernel.snapshot().extensions.map((extension) => extension.id)).toEqual([
    'core.base',
    'other.replacement',
  ])
  await expect(kernel.deactivate('core.base')).rejects.toThrow('must remain')
  await kernel.deactivate('other.replacement')
  expect(await kernel.executeCommand('core.command')).toBe('base')
  expect(kernel.snapshot().commands).toEqual([{
    id: 'core.command',
    contributionId: 'core.contribution',
    providerId: 'core.base',
    title: 'core.command',
  }])
  expect(replacementCleanupCount).toBe(1)
  expect(originalSignal?.aborted).toBeFalse()
  expect(originalCleanupCount).toBe(0)
  await kernel.dispose()
  expect(originalSignal?.aborted).toBeTrue()
  expect(originalCleanupCount).toBe(1)
})

test('failed replacement preserves the original live provider', async () => {
  const kernel = createExtensionKernel()
  let signal: AbortSignal | undefined
  let cleanupCount = 0
  await kernel.activate({
    ...definition('core.base', 'core.command', 'core.contribution', (context) => {
      signal = context.signal
      context.addCleanup(() => { cleanupCount += 1 })
      context.bindCommand('core.command', () => 'base')
    }),
    commands: [{
      id: 'core.command',
      contributionId: 'core.contribution',
      title: 'core.command',
      replacement: { allowed: true, contract: 'command-v1' },
    }],
  })
  await expect(kernel.replace(definition(
    'other.failed-replacement',
    'core.command',
    'other.contribution',
    () => { throw new Error('replacement failed') },
    [{ targetContributionId: 'core.contribution', contract: 'command-v1' }],
    [],
  ))).rejects.toThrow('replacement failed')
  expect(await kernel.executeCommand('core.command')).toBe('base')
  expect(signal?.aborted).toBeFalse()
  expect(cleanupCount).toBe(0)
  await kernel.dispose()
})

test('reload swaps atomically and cleans the old generation once', async () => {
  const kernel = createExtensionKernel()
  let oldSignal: AbortSignal | undefined
  let oldCleanupCount = 0
  await kernel.activate(definition('core.reloadable', 'core.command', 'core.contribution', (context) => {
    oldSignal = context.signal
    context.addCleanup(() => { oldCleanupCount += 1 })
    context.bindCommand('core.command', () => 'old')
  }))
  const oldGeneration = kernel.snapshot().generation
  await kernel.reload(definition('core.reloadable', 'core.command', 'core.contribution', (context) => {
    context.bindCommand('core.command', () => 'new')
  }, undefined, []))
  expect(await kernel.executeCommand('core.command')).toBe('new')
  expect(kernel.snapshot().generation).toBeGreaterThan(oldGeneration)
  expect(oldSignal?.aborted).toBeTrue()
  expect(oldCleanupCount).toBe(1)
  await kernel.reload(definition('core.reloadable', 'core.command', 'core.contribution', (context) => {
    context.bindCommand('core.command', () => 'newer')
  }, undefined, []))
  expect(oldCleanupCount).toBe(1)
  await kernel.dispose()
})

test('failed reload preserves the old generation and resources', async () => {
  const kernel = createExtensionKernel()
  let signal: AbortSignal | undefined
  let cleanupCount = 0
  await kernel.activate(definition('core.reloadable', 'core.command', 'core.contribution', (context) => {
    signal = context.signal
    context.addCleanup(() => { cleanupCount += 1 })
    context.bindCommand('core.command', () => 'old')
  }))
  const before = kernel.snapshot()
  await expect(kernel.reload(definition('core.reloadable', 'core.command', 'core.contribution', () => {
    throw new Error('reload failed')
  }, undefined, []))).rejects.toThrow('reload failed')
  expect(await kernel.executeCommand('core.command')).toBe('old')
  expect(kernel.snapshot().commands).toEqual(before.commands)
  expect(signal?.aborted).toBeFalse()
  expect(cleanupCount).toBe(0)
  await kernel.dispose()
})

test('stale reload continuation cannot publish after disposal', async () => {
  const kernel = createExtensionKernel()
  await kernel.activate(definition('core.reloadable', 'core.command', 'core.contribution', ({ bindCommand }) => {
    bindCommand('core.command', () => 'old')
  }))
  let release: (() => void) | undefined
  const reloading = kernel.reload(definition(
    'core.reloadable',
    'core.command',
    'core.contribution',
    async (context) => {
      await new Promise<void>((resolve) => { release = resolve })
      context.bindCommand('core.command', () => 'stale')
    },
    undefined,
    [],
  ))
  await Promise.resolve()
  await kernel.dispose()
  release?.()
  await expect(reloading).rejects.toThrow('stale')
  expect(kernel.snapshot().commands).toEqual([])
})

test('normal activation cannot replace and shortcut resolution is deterministic', async () => {
  const kernel = createExtensionKernel()
  await kernel.activate(definition('core.base', 'core.command', 'core.contribution', ({ bindCommand }) => {
    bindCommand('core.command', () => undefined)
  }))
  await expect(kernel.activate(definition(
    'other.replacement',
    'core.command',
    'other.contribution',
    ({ bindCommand }) => { bindCommand('core.command', () => undefined) },
    [{ targetContributionId: 'core.contribution', contract: 'missing' }],
  ))).rejects.toThrow('replace()')
  expect(kernel.resolveShortcuts(normalizeShortcutChord({ mod: true, key: 'k' }))).toHaveLength(1)
  await kernel.dispose()
})

test('rejects duplicate shortcut IDs, chord conflicts, and invalid replacement targets', async () => {
  const kernel = createExtensionKernel()
  const duplicateShortcuts = [
    { id: 'other.one', commandId: 'other.command', chord: { mod: true, key: 'x' } },
    { id: 'other.one', commandId: 'other.command', chord: { mod: true, key: 'y' } },
  ]
  await expect(kernel.activate(definition(
    'other.duplicate',
    'other.command',
    'other.contribution',
    ({ bindCommand }) => { bindCommand('other.command', () => undefined) },
    undefined,
    duplicateShortcuts,
  ))).rejects.toThrow('Shortcut IDs')
  await kernel.activate(definition('core.base', 'core.command', 'core.contribution', ({ bindCommand }) => {
    bindCommand('core.command', () => undefined)
  }))
  await expect(kernel.activate(definition(
    'other.conflict',
    'other.command',
    'other.other-contribution',
    ({ bindCommand }) => { bindCommand('other.command', () => undefined) },
  ))).rejects.toThrow('Shortcut chord')
  await expect(kernel.replace(definition(
    'other.absent',
    'other.command',
    'other.absent-contribution',
    ({ bindCommand }) => { bindCommand('other.command', () => undefined) },
    [{ targetContributionId: 'missing.target', contract: 'v1' }],
    [],
  ))).rejects.toThrow('not active')
  await kernel.dispose()
})

test('stale async activation cannot publish and receives abort on disposal', async () => {
  const kernel = createExtensionKernel()
  let release: (() => void) | undefined
  let signal: AbortSignal | undefined
  const activation = kernel.activate(definition(
    'async.pending',
    'async.command',
    'async.contribution',
    async (context) => {
      signal = context.signal
      await new Promise<void>((resolve) => { release = resolve })
      context.bindCommand('async.command', () => undefined)
    },
    undefined,
    [],
  ))
  await Promise.resolve()
  await kernel.dispose()
  release?.()
  await expect(activation).rejects.toThrow('stale')
  expect(signal?.aborted).toBeTrue()
  expect(kernel.snapshot().commands).toEqual([])
})

test('aborts stale contexts and cleans resources in reverse order, isolating failures', async () => {
  const kernel = createExtensionKernel()
  const cleanupOrder: string[] = []
  let signal: AbortSignal | undefined
  await kernel.activate(definition('core.base', 'core.command', 'core.contribution', (context) => {
    signal = context.signal
    context.addCleanup(() => { cleanupOrder.push('first') })
    context.addCleanup(() => { cleanupOrder.push('second'); throw new Error('cleanup') })
    context.addCleanup(() => { cleanupOrder.push('third') })
    context.bindCommand('core.command', () => undefined)
  }))
  await kernel.deactivate('core.base')
  expect(signal?.aborted).toBeTrue()
  expect(cleanupOrder).toEqual(['third', 'second', 'first'])
  expect(kernel.snapshot().diagnostics.some((entry) => entry.code === 'cleanup-failed')).toBeTrue()
  await kernel.dispose()
})

test('supports subscriber snapshots and idempotent disposal', async () => {
  const kernel = createExtensionKernel()
  const generations: number[] = []
  const unsubscribe = kernel.subscribe((current) => generations.push(current.generation))
  await kernel.activate(definition('core.base', 'core.command', 'core.contribution', ({ bindCommand }) => {
    bindCommand('core.command', () => undefined)
  }))
  unsubscribe()
  await kernel.dispose()
  await kernel.dispose()
  expect(generations.length).toBe(3)
})

test('isolates subscriber failures across every lifecycle transition', async () => {
  const kernel = createExtensionKernel()
  const snapshots: Array<{ generation: number; extensions: readonly string[]; commands: readonly string[] }> = []
  const initialFailingUnsubscribe = kernel.subscribe(() => {
    throw new Error('subscriber failure')
  })
  expect(initialFailingUnsubscribe()).toBeFalse()
  kernel.subscribe((current) => {
    snapshots.push({
      generation: current.generation,
      extensions: current.extensions.map((extension) => extension.id),
      commands: current.commands.map((command) => command.providerId),
    })
    if (current.generation > 0) throw new Error('transition subscriber failure')
  })
  let cleanupCount = 0
  await kernel.activate({
    ...definition('core.base', 'core.command', 'core.contribution', (context) => {
    context.addCleanup(() => { cleanupCount += 1 })
    context.bindCommand('core.command', () => undefined)
    }),
    commands: [{
      id: 'core.command',
      contributionId: 'core.contribution',
      title: 'core.command',
      replacement: { allowed: true, contract: 'command-v1' },
    }],
  })
  await kernel.replace(definition(
    'other.replacement',
    'core.command',
    'other.contribution',
    (context) => {
      context.addCleanup(() => { cleanupCount += 1 })
      context.bindCommand('core.command', () => 'replacement')
    },
    [{ targetContributionId: 'core.contribution', contract: 'command-v1' }],
    [],
  ))
  await kernel.deactivate('other.replacement')
  await kernel.reload(definition('core.base', 'core.command', 'core.contribution', (context) => {
    context.addCleanup(() => { cleanupCount += 1 })
    context.bindCommand('core.command', () => 'reloaded')
  }, undefined, []))
  await kernel.deactivate('core.base')
  await kernel.dispose()
  expect(snapshots.at(-1)?.extensions).toEqual([])
  expect(snapshots.some((snapshot) => snapshot.extensions.includes('other.replacement'))).toBeTrue()
  expect(snapshots.some((snapshot) => snapshot.commands.includes('core.base'))).toBeTrue()
  expect(cleanupCount).toBe(3)
  expect(kernel.snapshot().diagnostics.some((entry) => entry.code === 'subscriber-failed')).toBeTrue()
})

test('replacement keeps the target public contribution identity and title', async () => {
  const kernel = createExtensionKernel()
  await kernel.activate({
    ...definition('core.base', 'core.command', 'core.contribution', ({ bindCommand }) => {
      bindCommand('core.command', () => 'base')
    }),
    commands: [{
      id: 'core.command',
      contributionId: 'core.contribution',
      title: 'Stable title',
      replacement: { allowed: true, contract: 'command-v1' },
    }],
  })
  await kernel.replace({
    ...definition('other.replacement', 'core.command', 'other.internal-contribution', ({ bindCommand }) => {
      bindCommand('core.command', () => 'replacement')
    }, [{ targetContributionId: 'core.contribution', contract: 'command-v1' }], []),
    commands: [{
      id: 'core.command',
      contributionId: 'other.internal-contribution',
      title: 'Stable title',
    }],
  })
  expect(kernel.snapshot().commands).toEqual([{
    id: 'core.command',
    contributionId: 'core.contribution',
    providerId: 'other.replacement',
    title: 'Stable title',
  }])
  await kernel.dispose()
})

test('manages trusted static built-ins with immutable ordered state', async () => {
  const kernel = createExtensionKernel()
  const manager = createBuiltinExtensionManager([
    definition('builtin.one', 'builtin.one.command', 'builtin.one.contribution', ({ bindCommand }) => {
      bindCommand('builtin.one.command', () => 'one')
    }),
  ], kernel)
  await manager.enable('builtin.one')
  const state = manager.snapshot()
  expect(state.enabled).toEqual(['builtin.one'])
  expect(Object.isFrozen(state.enabled)).toBeTrue()
  await manager.disable('builtin.one')
  expect(manager.snapshot().enabled).toEqual([])
  await manager.dispose()
})
