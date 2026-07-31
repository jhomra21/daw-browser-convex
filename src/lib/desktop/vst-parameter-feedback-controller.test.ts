import 'fake-indexeddb/auto'
import { expect, test } from 'bun:test'
import type { DesktopVstParameterEditPayload } from '@daw-browser/desktop-protocol'
import { externalProcessorSchema } from '@daw-browser/external-plugins'
import { createLocalProject, openLocalProjectDb } from '~/lib/local-project-db'
import {
  mergeLocalExternalProcessorParameterOverride,
  setLocalExternalProcessor,
} from '~/lib/external-plugins'
import { createVstParameterFeedbackController } from './vst-parameter-feedback-controller'

const instanceId = '11111111-1111-4111-8111-111111111111'

const createProcessor = () => externalProcessorSchema.parse({
  instanceId,
  targetId: 'track-1',
  chainIndex: 0,
  manifest: {
    identity: {
      format: 'vst3',
      classId: 'class-1',
      vendor: 'Vendor',
      name: 'Fixture',
      version: '1',
      architecture: 'arm64',
      discoveredPath: '/local/Fixture.vst3',
      binaryFingerprint: 'a'.repeat(64),
    },
    role: 'effect',
    audioInputs: [{ name: 'Input', channels: 2, enabled: true }],
    audioOutputs: [{ name: 'Output', channels: 2, enabled: true }],
    sidechainInputs: [],
    parameters: [
      {
        id: 1,
        title: 'Gain',
        unit: '',
        minimum: 0,
        maximum: 1,
        defaultValue: 0.5,
        stepCount: 100,
        readOnly: false,
        hidden: false,
      },
      {
        id: 2,
        title: 'Read only',
        unit: '',
        minimum: 0,
        maximum: 1,
        defaultValue: 0,
        stepCount: 1,
        readOnly: true,
        hidden: false,
      },
    ],
    latencyFrames: 0,
    tailFrames: 0,
    supportsBypass: true,
    supportsEditor: true,
    supportsState: true,
  },
  parameterOverrides: { '1': 0.25 },
  latencyFrames: 0,
  tailFrames: 0,
  bypassed: false,
  health: { state: 'ready', updatedAt: 1 },
  updatedAt: 1,
})

const flushAsyncWork = async () => {
  for (let index = 0; index < 4; ++index) {
    await Promise.resolve()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
}

const installSubscription = () => {
  const previousWindow = globalThis.window
  let listener: ((payload: DesktopVstParameterEditPayload) => void) | undefined
  const subscription = (next: (payload: DesktopVstParameterEditPayload) => void) => {
    listener = next
    return () => {
      if (listener === next) listener = undefined
    }
  }
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { dawDesktop: { audioHost: { session: { onVstParameterEdit: subscription } } } },
  })
  return {
    emit(payload: DesktopVstParameterEditPayload) {
      if (!listener) return false
      listener(payload)
      return true
    },
    restore() {
      Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
    },
  }
}

const payload = (
  projectId: string,
  source: DesktopVstParameterEditPayload['source'],
  parameterId = 1,
  normalizedValue = 0.75,
): DesktopVstParameterEditPayload => ({
  projectId,
  source,
  instanceId,
  parameterId,
  normalizedValue,
})

test.serial('persists active playback feedback without suppressing automation or enqueueing', async () => {
  const project = await createLocalProject(`Feedback active ${crypto.randomUUID()}`)
  await setLocalExternalProcessor(project.id, createProcessor())
  const bridge = installSubscription()
  const targets: string[] = []
  const queued: unknown[] = []
  try {
    const controller = createVstParameterFeedbackController({
      projectId: () => project.id,
      mountedProjectGeneration: () => 0,
      overrideTarget: (target) => targets.push(target),
      nativeVstParameterQueue: { enqueue: async (event) => { queued.push(event); return true } },
    })
    expect(controller).toBeDefined()
    expect(bridge.emit(payload(project.id, 'active-playback', 1, 0.75))).toBeTrue()
    await flushAsyncWork()

    expect(targets).toEqual([])
    expect(queued).toEqual([])
    controller?.dispose()
  } finally {
    bridge.restore()
  }
})

test.serial('persists editor-session feedback and enqueues exactly once', async () => {
  const project = await createLocalProject(`Feedback editor ${crypto.randomUUID()}`)
  await setLocalExternalProcessor(project.id, createProcessor())
  const bridge = installSubscription()
  const targets: string[] = []
  const queued: unknown[] = []
  try {
    const controller = createVstParameterFeedbackController({
      projectId: () => project.id,
      mountedProjectGeneration: () => 0,
      overrideTarget: (target) => targets.push(target),
      nativeVstParameterQueue: {
        enqueue: async (event) => {
          queued.push(event)
          return true
        },
      },
    })
    bridge.emit(payload(project.id, 'editor-session', 1, 0.875))
    await flushAsyncWork()

    expect(targets).toHaveLength(0)
    expect(queued).toEqual([{ instanceId, id: 1, value: 0.875 }])
    controller?.dispose()
  } finally {
    bridge.restore()
  }
})

test.serial('coalesces a burst to the latest value before one editor enqueue', async () => {
  const project = await createLocalProject(`Feedback burst ${crypto.randomUUID()}`)
  await setLocalExternalProcessor(project.id, createProcessor())
  const bridge = installSubscription()
  const queued: unknown[] = []
  try {
    const controller = createVstParameterFeedbackController({
      projectId: () => project.id,
      mountedProjectGeneration: () => 0,
      overrideTarget: () => undefined,
      nativeVstParameterQueue: {
        enqueue: async (event) => {
          queued.push(event)
          return true
        },
      },
    })
    bridge.emit(payload(project.id, 'editor-session', 1, 0.25))
    bridge.emit(payload(project.id, 'editor-session', 1, 0.5))
    bridge.emit(payload(project.id, 'editor-session', 1, 0.875))
    await flushAsyncWork()
    expect(queued).toEqual([{ instanceId, id: 1, value: 0.875 }])
    controller?.dispose()
  } finally {
    bridge.restore()
  }
})

test.serial('ignores project-mismatched and disposed feedback', async () => {
  const project = await createLocalProject(`Feedback ignored ${crypto.randomUUID()}`)
  const otherProject = await createLocalProject(`Feedback other ${crypto.randomUUID()}`)
  await setLocalExternalProcessor(project.id, createProcessor())
  const bridge = installSubscription()
  const targets: string[] = []
  const queued: unknown[] = []
  try {
    const controller = createVstParameterFeedbackController({
      projectId: () => project.id,
      mountedProjectGeneration: () => 0,
      overrideTarget: (target) => targets.push(target),
      nativeVstParameterQueue: { enqueue: async (event) => { queued.push(event); return true } },
    })
    bridge.emit(payload(otherProject.id, 'editor-session'))
    controller?.dispose()
    bridge.emit(payload(project.id, 'editor-session'))
    await flushAsyncWork()

    expect(targets).toEqual([])
    expect(queued).toEqual([])
  } finally {
    bridge.restore()
  }
})

test.serial('suppresses override and enqueue when the mounted generation changes during persistence', async () => {
  const project = await createLocalProject(`Feedback generation ${crypto.randomUUID()}`)
  await setLocalExternalProcessor(project.id, createProcessor())
  const bridge = installSubscription()
  const targets: string[] = []
  const queued: unknown[] = []
  let generation = 0
  try {
    const controller = createVstParameterFeedbackController({
      projectId: () => project.id,
      mountedProjectGeneration: () => generation,
      overrideTarget: (target) => targets.push(target),
      nativeVstParameterQueue: { enqueue: async (event) => { queued.push(event); return true } },
    })
    bridge.emit(payload(project.id, 'editor-session', 1, 0.625))
    generation = 1
    await flushAsyncWork()

    const db = await openLocalProjectDb(project.id)
    const row = await db.get('entities', ['external-plugin', `external-plugin:${instanceId}`])
    expect(row?.value).toMatchObject({ parameterOverrides: { '1': 0.25 } })
    expect(targets).toEqual([])
    expect(queued).toEqual([])
    controller?.dispose()
  } finally {
    bridge.restore()
  }
})

test.serial('does not override or enqueue unknown or read-only descriptors', async () => {
  const project = await createLocalProject(`Feedback descriptors ${crypto.randomUUID()}`)
  await setLocalExternalProcessor(project.id, createProcessor())
  const bridge = installSubscription()
  const targets: string[] = []
  const queued: unknown[] = []
  try {
    const controller = createVstParameterFeedbackController({
      projectId: () => project.id,
      mountedProjectGeneration: () => 0,
      overrideTarget: (target) => targets.push(target),
      nativeVstParameterQueue: { enqueue: async (event) => { queued.push(event); return true } },
    })
    bridge.emit(payload(project.id, 'editor-session', 99, 0.4))
    bridge.emit(payload(project.id, 'editor-session', 2, 0.4))
    await flushAsyncWork()

    expect(targets).toEqual([])
    expect(queued).toEqual([])
    controller?.dispose()
  } finally {
    bridge.restore()
  }
})

test.serial('keeps persistence when native queue delivery fails', async () => {
  const project = await createLocalProject(`Feedback queue failure ${crypto.randomUUID()}`)
  await setLocalExternalProcessor(project.id, createProcessor())
  const bridge = installSubscription()
  const targets: string[] = []
  try {
    const controller = createVstParameterFeedbackController({
      projectId: () => project.id,
      mountedProjectGeneration: () => 0,
      overrideTarget: (target) => targets.push(target),
      nativeVstParameterQueue: {
        enqueue: async () => {
          throw new Error('queue unavailable')
        },
      },
    })
    bridge.emit(payload(project.id, 'editor-session', 1, 0.5))
    await flushAsyncWork()

    const persisted = await mergeLocalExternalProcessorParameterOverride(project.id, instanceId, 1, 0.5)
    expect(persisted?.current.parameterOverrides['1']).toBe(0.5)
    expect(targets).toHaveLength(0)
    controller?.dispose()
  } finally {
    bridge.restore()
  }
})

test.serial('keeps persistence when native queue rejects delivery', async () => {
  const project = await createLocalProject(`Feedback queue rejection ${crypto.randomUUID()}`)
  await setLocalExternalProcessor(project.id, createProcessor())
  const bridge = installSubscription()
  const targets: string[] = []
  try {
    const controller = createVstParameterFeedbackController({
      projectId: () => project.id,
      mountedProjectGeneration: () => 0,
      overrideTarget: (target) => targets.push(target),
      nativeVstParameterQueue: { enqueue: async () => false },
    })
    bridge.emit(payload(project.id, 'editor-session', 1, 0.375))
    await flushAsyncWork()

    const db = await openLocalProjectDb(project.id)
    const row = await db.get('entities', ['external-plugin', `external-plugin:${instanceId}`])
    expect(row?.value).toMatchObject({ parameterOverrides: { '1': 0.375 } })
    expect(targets).toHaveLength(0)
    controller?.dispose()
  } finally {
    bridge.restore()
  }
})

test.serial('does not report an automation suppression failure for persisted feedback', async () => {
  const project = await createLocalProject(`Feedback fault ${crypto.randomUUID()}`)
  await setLocalExternalProcessor(project.id, createProcessor())
  const bridge = installSubscription()
  const faults: string[] = []
  try {
    const controller = createVstParameterFeedbackController({
      projectId: () => project.id,
      mountedProjectGeneration: () => 0,
      overrideTarget: () => { throw new Error('override unavailable') },
      reportFault: (message) => faults.push(message),
    })
    bridge.emit(payload(project.id, 'active-playback', 1, 0.5))
    await flushAsyncWork()
    expect(faults).toEqual([])
    controller?.dispose()
  } finally {
    bridge.restore()
  }
})
